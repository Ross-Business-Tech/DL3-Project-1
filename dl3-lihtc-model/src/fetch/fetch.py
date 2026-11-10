"""Fetch public source documents listed in config/source_register.csv.

Rules (guide Sections 9, 10): allowlisted hosts only, respect robots.txt, polite rate limit,
bounded retries then stale-flag + manual-review queue, downloaded content is data and is never executed.
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import time
import urllib.robotparser
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urljoin, urlparse

import requests
import yaml
from bs4 import BeautifulSoup

from . import archive

ROOT = Path(__file__).resolve().parents[2]
FIELDS = ("source_id", "jurisdiction", "state", "doc_type", "title", "url", "status", "critical", "notes",
          *archive.OPTIONAL_SOURCE_FIELDS)
DOC_EXTS = (".pdf", ".xlsx", ".xls", ".docx", ".doc", ".csv")


MAGIC = {  # declared type -> required leading bytes; mismatches are quarantined (not archived)
    "application/pdf": (b"%PDF-",),
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": (b"PK\x03\x04",),
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": (b"PK\x03\x04",),
    "application/vnd.ms-excel": (b"\xd0\xcf\x11\xe0", b"PK\x03\x04"),
    "application/msword": (b"\xd0\xcf\x11\xe0",),
}


def content_matches_type(body: bytes, content_type: str | None) -> bool:
    sigs = MAGIC.get(content_type or "")
    return True if sigs is None else body.lstrip(b"\xef\xbb\xbf")[:8].startswith(sigs) or body[:8].startswith(sigs)


class FetchError(Exception):
    """Permanent or exhausted failure for one URL."""

    def __init__(self, message: str, attempts: int = 1, browser_eligible: bool = False):
        super().__init__(message)
        self.attempts = attempts
        # True when a real browser could plausibly succeed: bot-check holding pages (202/403),
        # incomplete TLS certificate chains (browsers fetch the missing certificate), or JS-only pages.
        self.browser_eligible = browser_eligible


@dataclass
class Response:
    body: bytes
    status: int
    content_type: str | None
    final_url: str
    method: str = "http"   # http | browser


# Bot-check / "please wait" holding pages. Never archived as if they were the document.
CHALLENGE_MARKERS = re.compile(
    rb"(enable javascript|checking your browser|just a moment|request unsuccessful|incapsula|"
    rb"captcha|challenge-platform|_cf_chl|bm-verify|akamai)", re.I)


def looks_like_challenge(body: bytes, content_type: str | None) -> bool:
    return content_type == "text/html" and len(body) < 20000 and bool(CHALLENGE_MARKERS.search(body[:20000]))


@dataclass
class RunSummary:
    fetched: int = 0
    changed: int = 0
    unchanged: int = 0
    failed: int = 0
    discovered: int = 0
    manual: int = 0
    details: list = field(default_factory=list)


def load_settings(path: Path | None = None) -> dict:
    return yaml.safe_load((path or ROOT / "config" / "settings.yaml").read_text())


def use_os_trust_store() -> bool:
    """Verify TLS with the operating system's certificate store (macOS Keychain / Windows), like a browser.

    Fixes sites that send an incomplete certificate chain (seen: ilga.gov, dca.ga.gov) without ever
    turning verification off. No-op if the optional `truststore` package is missing.
    """
    try:
        import truststore
    except ImportError:
        return False
    truststore.inject_into_ssl()
    return True


def load_register(path: Path | None = None) -> list[dict]:
    with open(path or ROOT / "config" / "source_register.csv", newline="", encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh))
    for r in rows:
        r["critical"] = 1 if str(r.get("critical", "")).strip().lower() in ("1", "true", "yes") else 0
        r["status"] = (r.get("status") or "unknown").strip().lower()
    return rows


def allowed_hosts(register: list[dict], extra: set[str] | None = None) -> set[str]:
    """Allowlist = hosts of registered sources. Discovered links only fetch if their host is already here."""
    hosts = {urlparse(r["url"]).hostname for r in register if r.get("url")}
    return {h.lower() for h in hosts if h} | (extra or set())


def user_agent() -> str:
    contact = os.environ.get("DL3_CONTACT", "")
    return f"DL3-LIHTC-Research-Bot/0.1 (UMich AI Sprint; {contact})" if contact else "DL3-LIHTC-Research-Bot/0.1 (UMich AI Sprint)"


class Browser:
    """Lazily started headless Chromium (Playwright), one per Fetcher/thread. Used only as a fallback."""

    def __init__(self, timeout_s: float):
        self.timeout_ms = int(timeout_s * 1000)
        self._pw = self._browser = self._ctx = None
        self.unavailable: str | None = None

    def _start(self):
        if self._ctx is None:
            try:
                from playwright.sync_api import sync_playwright
            except ImportError as e:
                raise FetchError("browser fallback needs Playwright: pip install playwright && "
                                 "python -m playwright install chromium") from e
            try:
                self._pw = sync_playwright().start()
                exe = os.environ.get("DL3_CHROMIUM_PATH") or None
                self._browser = self._pw.chromium.launch(executable_path=exe)
                self._ctx = self._browser.new_context(accept_downloads=False)
            except Exception as e:
                self.close()
                first = str(e).splitlines()[0][:200]
                raise FetchError(f"browser could not start ({first}); run: python -m playwright install chromium") from e
        return self._ctx

    def get(self, url: str) -> Response:
        if self.unavailable:
            raise FetchError(self.unavailable)
        try:
            ctx = self._start()
        except FetchError as e:
            self.unavailable = str(e)  # do not try to launch again for every page
            raise
        page = ctx.new_page()
        try:
            resp = page.goto(url, timeout=self.timeout_ms, wait_until="domcontentloaded")
            try:  # let JS-built menus and bot checks finish; fine if the network never goes fully idle
                page.wait_for_load_state("networkidle", timeout=min(self.timeout_ms, 15000))
            except Exception:
                pass
            if resp is None:
                raise FetchError("browser: no response")
            ct = (resp.headers.get("content-type") or "").split(";")[0].strip().lower() or None
            if ct != "text/html":
                raise FetchError(f"browser fallback only handles web pages, got {ct}")
            body = page.content().encode("utf-8")
            if resp.status >= 400:
                raise FetchError(f"browser: HTTP {resp.status}")
            if looks_like_challenge(body, ct):
                raise FetchError("browser: still on a bot-check page")
            return Response(body, resp.status, ct, page.url, method="browser")
        except FetchError:
            raise
        except Exception as e:
            raise FetchError(f"browser: {type(e).__name__}: {str(e).splitlines()[0][:200]}") from e
        finally:
            page.close()

    def close(self):
        for obj in (self._ctx, self._browser):
            try:
                obj and obj.close()
            except Exception:
                pass
        if self._pw:
            try:
                self._pw.stop()
            except Exception:
                pass
        self._pw = self._browser = self._ctx = None


class Fetcher:
    def __init__(self, settings: dict, allowed: set[str], session: requests.Session | None = None,
                 sleep=time.sleep, clock=time.monotonic):
        self.cfg = settings["fetch"]
        self.allowed = {h.lower() for h in allowed}
        self.session = session or requests.Session()
        self.session.headers["User-Agent"] = user_agent()
        self._sleep, self._clock = sleep, clock
        self._last_hit: dict[str, float] = {}
        self._robots: dict[str, tuple[urllib.robotparser.RobotFileParser | None, str]] = {}
        self.browser = Browser(self.cfg["timeout_seconds"]) if self.cfg.get("browser_fallback") else None

    def close(self) -> None:
        if self.browser:
            self.browser.close()

    # -- guards -------------------------------------------------------------
    def check_allowed(self, url: str) -> None:
        p = urlparse(url)
        if p.scheme not in ("http", "https"):
            raise FetchError(f"blocked scheme: {p.scheme}")
        if (p.hostname or "").lower() not in self.allowed:
            raise FetchError(f"host not on allowlist: {p.hostname}")

    def robots(self, base: str) -> tuple[urllib.robotparser.RobotFileParser | None, str]:
        """Parsed robots.txt per RFC 9309: 2xx parsed; 4xx (incl. 401/403) = no rules; 5xx/unreachable = disallow."""
        if base not in self._robots:
            rp = urllib.robotparser.RobotFileParser()
            try:
                r = self.session.get(base + "/robots.txt", timeout=self.cfg["timeout_seconds"])
                if 200 <= r.status_code < 300:
                    rp.parse(r.text.splitlines())
                    self._robots[base] = (rp, f"robots.txt rules at {base}/robots.txt")
                elif 400 <= r.status_code < 500:
                    self._robots[base] = (None, f"robots.txt unavailable (HTTP {r.status_code}): no rules apply")
                else:
                    rp.disallow_all = True
                    self._robots[base] = (rp, f"robots.txt server error (HTTP {r.status_code}): treated as disallow")
            except requests.exceptions.SSLError:
                self._robots[base] = (None, "robots.txt TLS error: page fetch will report it")
            except requests.RequestException as e:
                rp.disallow_all = True
                self._robots[base] = (rp, f"robots.txt unreachable ({type(e).__name__}): treated as disallow")
        return self._robots[base]

    def _robots_ok(self, url: str) -> tuple[bool, str]:
        if not self.cfg.get("respect_robots_txt", True):
            return True, "robots.txt checking off"
        p = urlparse(url)
        rp, why = self.robots(f"{p.scheme}://{p.netloc}")
        return (True, why) if rp is None else (rp.can_fetch(self.session.headers["User-Agent"], url), why)

    def _throttle(self, host: str) -> None:
        gap = self.cfg["min_seconds_between_requests_per_host"]
        last = self._last_hit.get(host)
        if last is not None:
            wait = gap - (self._clock() - last)
            if wait > 0:
                self._sleep(wait)
        self._last_hit[host] = self._clock()

    # -- one request with retries ------------------------------------------
    def get(self, url: str, allow_offsite_redirect: bool = False, force_browser: bool = False) -> tuple[Response, int]:
        """Return (response, attempts). Raises FetchError after bounded retries.

        allow_offsite_redirect: accept a redirect to a host outside the allowlist (used only for an agency's
        own homepage, which tells us where the agency moved). The caller decides whether to adopt that host.
        """
        self.check_allowed(url)
        ok, why = self._robots_ok(url)
        if not ok:
            raise FetchError(f"disallowed by robots.txt ({why})")
        if force_browser:
            return self._via_browser(url, allow_offsite_redirect, FetchError("forced", 0, True))
        try:
            return self._via_http(url, allow_offsite_redirect)
        except FetchError as e:
            if e.browser_eligible and self.browser is not None:
                return self._via_browser(url, allow_offsite_redirect, e)
            raise

    def _via_browser(self, url, allow_offsite_redirect, original: FetchError) -> tuple[Response, int]:
        if self.browser is None:
            raise original
        self._throttle(urlparse(url).hostname or "")
        try:
            resp = self.browser.get(url)
        except FetchError as be:
            raise FetchError(f"{original}; browser retry failed: {be}", original.attempts + 1) from be
        if not allow_offsite_redirect:
            self.check_allowed(resp.final_url)
        ok, why = self._robots_ok(resp.final_url)
        if not ok:
            raise FetchError(f"disallowed by robots.txt after redirect ({why})", original.attempts + 1)
        return resp, original.attempts + 1

    def _via_http(self, url: str, allow_offsite_redirect: bool) -> tuple[Response, int]:
        retries, backoff = self.cfg["max_retries"], self.cfg["backoff_seconds"]
        last_err, eligible = "unknown error", False
        for attempt in range(retries + 1):
            if attempt:
                self._sleep(backoff[min(attempt - 1, len(backoff) - 1)])
            self._throttle(urlparse(url).hostname or "")
            n = attempt + 1
            try:
                r = self.session.get(url, timeout=self.cfg["timeout_seconds"], stream=True, allow_redirects=True)
                if not allow_offsite_redirect:
                    self.check_allowed(r.url)  # redirects may not leave the allowlist
                elif r.url != url:
                    ok, why = self._robots_ok(r.url)
                    if not ok:
                        raise FetchError(f"disallowed by robots.txt after redirect ({why})", n)
                if r.status_code in (429, 500, 502, 503, 504):
                    last_err, eligible = f"HTTP {r.status_code}", r.status_code in (429, 503)
                    continue
                if r.status_code != 200:  # 202 = bot-check holding page; 401/403 often bot protection
                    raise FetchError(f"HTTP {r.status_code}", n, browser_eligible=r.status_code in (202, 401, 403))
                ct = (r.headers.get("Content-Type") or "").split(";")[0].strip().lower() or None
                if ct and ct not in self.cfg["allowed_content_types"]:
                    raise FetchError(f"content type not allowed: {ct}", n)
                body = bytearray()
                for chunk in r.iter_content(65536):
                    body += chunk
                    if len(body) > self.cfg["max_bytes"]:
                        raise FetchError(f"exceeds max_bytes ({self.cfg['max_bytes']})", n)
                if not content_matches_type(bytes(body), ct):
                    raise FetchError(f"quarantined: content does not look like declared type {ct}", n)
                if looks_like_challenge(bytes(body), ct):
                    raise FetchError("bot-check page instead of content", n, browser_eligible=True)
                return Response(bytes(body), r.status_code, ct, r.url), n
            except FetchError:
                raise
            except requests.exceptions.SSLError as e:
                # Not retried: a bad certificate chain will not fix itself in 8 seconds.
                raise FetchError(f"TLS certificate problem: {str(e)[:300]}", n, browser_eligible=True) from e
            except requests.RequestException as e:
                last_err, eligible = f"{type(e).__name__}: {e}", False
        raise FetchError(f"gave up after {retries + 1} attempts: {last_err}", retries + 1, browser_eligible=eligible)


def discover_links(html: bytes, base_url: str, allowed: set[str]) -> list[tuple[str, str]]:
    """Document links on a landing page, restricted to allowlisted hosts. Link text is data only."""
    soup = BeautifulSoup(html, "lxml")
    seen, out = set(), []
    for a in soup.find_all("a", href=True):
        url = urljoin(base_url, a["href"]).split("#")[0]
        p = urlparse(url)
        if p.scheme in ("http", "https") and p.path.lower().endswith(DOC_EXTS) \
                and (p.hostname or "").lower() in allowed and url not in seen:
            seen.add(url)
            out.append((url, " ".join(a.get_text().split())[:200]))
    return out


def run(register: list[dict], settings: dict, db_path: Path, archive_root: Path,
        fetcher: Fetcher | None = None, only: set[str] | None = None,
        follow_documents: bool = False, run_id: str | None = None) -> RunSummary:
    conn = archive.connect(db_path)
    own_fetcher = fetcher is None
    fetcher = fetcher or Fetcher(settings, allowed_hosts(register))
    summary = RunSummary()
    for src in register:
        if only and src["source_id"] not in only:
            continue
        archive.upsert_source(conn, {k: src.get(k) for k in
                              FIELDS})
        if (src.get("retrieval") or "").strip().lower() == "manual":
            # The site does not allow automated access; a person imports the file (src/fetch/manual_import.py).
            summary.manual += 1
            summary.details.append({"source_id": src["source_id"], "result": "manual source: not fetched automatically"})
            continue
        _fetch_one(conn, fetcher, archive_root, src, src["url"], None, summary, run_id)
        if follow_documents:
            snap = archive.latest_snapshot(conn, src["source_id"])
            if snap and snap["content_type"] == "text/html":
                html = (archive_root / snap["archive_path"]).read_bytes()
                for url, text in discover_links(html, snap["final_url"], fetcher.allowed):
                    cur = conn.execute("INSERT OR IGNORE INTO discovered_link (parent_source_id, url, link_text, first_seen_at)"
                                       " VALUES (?,?,?,?)", (src["source_id"], url, text, archive.utcnow().isoformat()))
                    summary.discovered += cur.rowcount
                    child = dict(src, source_id=f"{src['source_id']}:{archive.sha256_bytes(url.encode())[:8]}",
                                 title=text or url, url=url, doc_type=src["doc_type"] + "_doc",
                                 status="unknown")  # never inherit a parent page's draft/final status
                    archive.upsert_source(conn, {k: child.get(k) for k in
                                          FIELDS})
                    _fetch_one(conn, fetcher, archive_root, child, url, src["source_id"], summary, run_id)
                conn.commit()
    conn.close()
    if own_fetcher:
        fetcher.close()
    return summary


def _fetch_one(conn, fetcher, archive_root, src, url, parent_id, summary: RunSummary, run_id=None) -> None:
    sid = src["source_id"]
    try:
        resp, attempts = fetcher.get(url)
    except FetchError as e:
        archive.record_failure(conn, sid, url, e.attempts, str(e), run_id=run_id)
        summary.failed += 1
        summary.details.append({"source_id": sid, "result": "failed", "error": str(e)})
        return
    res = archive.store_snapshot(conn, archive_root, source=src, data=resp.body, requested_url=url,
                                 final_url=resp.final_url, content_type=resp.content_type,
                                 http_status=resp.status, parent_source_id=parent_id, run_id=run_id,
                                 retrieval_method=resp.method)
    summary.fetched += 1
    summary.changed += int(res.changed)
    summary.unchanged += int(not res.changed)
    summary.details.append({"source_id": sid, "method": resp.method, "result": "new" if res.first_snapshot else
                            ("changed" if res.changed else "unchanged"), "sha256": res.sha256[:8], "path": res.archive_path})


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Fetch and archive registered LIHTC sources.")
    ap.add_argument("--only", nargs="*", help="source_ids to fetch (default: all)")
    ap.add_argument("--follow-documents", action="store_true",
                    help="also fetch PDF/XLSX/DOCX links found on registered landing pages (allowlisted hosts only)")
    ap.add_argument("--db", default=str(ROOT / "data" / "dl3.db"))
    ap.add_argument("--archive", default=str(ROOT / "archive"))
    ap.add_argument("--register", default=str(ROOT / "config" / "source_register.csv"))
    args = ap.parse_args(argv)
    use_os_trust_store()
    s = run(load_register(Path(args.register)), load_settings(), Path(args.db), Path(args.archive),
            only=set(args.only) if args.only else None, follow_documents=args.follow_documents)
    print(json.dumps({"fetched": s.fetched, "changed": s.changed, "unchanged": s.unchanged,
                      "failed": s.failed, "discovered": s.discovered, "details": s.details}, indent=2))
    return 1 if s.failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
