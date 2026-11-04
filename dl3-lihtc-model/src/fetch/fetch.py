"""Fetch public source documents listed in config/source_register.csv.

Rules (guide Sections 9, 10): allowlisted hosts only, respect robots.txt, polite rate limit,
bounded retries then stale-flag + manual-review queue, downloaded content is data and is never executed.
"""
from __future__ import annotations

import argparse
import csv
import json
import os
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
DOC_EXTS = (".pdf", ".xlsx", ".xls", ".docx", ".doc", ".csv")


class FetchError(Exception):
    """Permanent or exhausted failure for one URL."""


@dataclass
class Response:
    body: bytes
    status: int
    content_type: str | None
    final_url: str


@dataclass
class RunSummary:
    fetched: int = 0
    changed: int = 0
    unchanged: int = 0
    failed: int = 0
    discovered: int = 0
    details: list = field(default_factory=list)


def load_settings(path: Path | None = None) -> dict:
    return yaml.safe_load((path or ROOT / "config" / "settings.yaml").read_text())


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


class Fetcher:
    def __init__(self, settings: dict, allowed: set[str], session: requests.Session | None = None,
                 sleep=time.sleep, clock=time.monotonic):
        self.cfg = settings["fetch"]
        self.allowed = {h.lower() for h in allowed}
        self.session = session or requests.Session()
        self.session.headers["User-Agent"] = user_agent()
        self._sleep, self._clock = sleep, clock
        self._last_hit: dict[str, float] = {}
        self._robots: dict[str, urllib.robotparser.RobotFileParser | None] = {}

    # -- guards -------------------------------------------------------------
    def check_allowed(self, url: str) -> None:
        p = urlparse(url)
        if p.scheme not in ("http", "https"):
            raise FetchError(f"blocked scheme: {p.scheme}")
        if (p.hostname or "").lower() not in self.allowed:
            raise FetchError(f"host not on allowlist: {p.hostname}")

    def _robots_ok(self, url: str) -> bool:
        if not self.cfg.get("respect_robots_txt", True):
            return True
        p = urlparse(url)
        base = f"{p.scheme}://{p.netloc}"
        if base not in self._robots:
            rp = urllib.robotparser.RobotFileParser()
            try:
                r = self.session.get(base + "/robots.txt", timeout=self.cfg["timeout_seconds"])
                if r.status_code == 200:
                    rp.parse(r.text.splitlines())
                    self._robots[base] = rp
                elif r.status_code in (401, 403):
                    rp.disallow_all = True
                    self._robots[base] = rp
                else:
                    self._robots[base] = None  # no robots file: allowed
            except requests.RequestException:
                self._robots[base] = None
        rp = self._robots[base]
        return True if rp is None else rp.can_fetch(self.session.headers["User-Agent"], url)

    def _throttle(self, host: str) -> None:
        gap = self.cfg["min_seconds_between_requests_per_host"]
        last = self._last_hit.get(host)
        if last is not None:
            wait = gap - (self._clock() - last)
            if wait > 0:
                self._sleep(wait)
        self._last_hit[host] = self._clock()

    # -- one request with retries ------------------------------------------
    def get(self, url: str) -> tuple[Response, int]:
        """Return (response, attempts). Raises FetchError after bounded retries."""
        self.check_allowed(url)
        if not self._robots_ok(url):
            raise FetchError("disallowed by robots.txt")
        retries, backoff = self.cfg["max_retries"], self.cfg["backoff_seconds"]
        last_err = "unknown error"
        for attempt in range(retries + 1):
            if attempt:
                self._sleep(backoff[min(attempt - 1, len(backoff) - 1)])
            self._throttle(urlparse(url).hostname or "")
            try:
                r = self.session.get(url, timeout=self.cfg["timeout_seconds"], stream=True, allow_redirects=True)
                self.check_allowed(r.url)  # redirects may not leave the allowlist
                if r.status_code in (429, 500, 502, 503, 504):
                    last_err = f"HTTP {r.status_code}"
                    continue
                if r.status_code != 200:
                    raise FetchError(f"HTTP {r.status_code}")  # 4xx/3xx: permanent, no retry
                ct = (r.headers.get("Content-Type") or "").split(";")[0].strip().lower() or None
                if ct and ct not in self.cfg["allowed_content_types"]:
                    raise FetchError(f"content type not allowed: {ct}")
                body = bytearray()
                for chunk in r.iter_content(65536):
                    body += chunk
                    if len(body) > self.cfg["max_bytes"]:
                        raise FetchError(f"exceeds max_bytes ({self.cfg['max_bytes']})")
                return Response(bytes(body), r.status_code, ct, r.url), attempt + 1
            except FetchError:
                raise
            except requests.RequestException as e:
                last_err = f"{type(e).__name__}: {e}"
        raise FetchError(f"gave up after {retries + 1} attempts: {last_err}")


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
        follow_documents: bool = False) -> RunSummary:
    conn = archive.connect(db_path)
    fetcher = fetcher or Fetcher(settings, allowed_hosts(register))
    summary = RunSummary()
    for src in register:
        if only and src["source_id"] not in only:
            continue
        archive.upsert_source(conn, {k: src.get(k) for k in
                              ("source_id", "jurisdiction", "state", "doc_type", "title", "url", "status", "critical", "notes")})
        _fetch_one(conn, fetcher, archive_root, src, src["url"], None, summary)
        if follow_documents:
            snap = archive.latest_snapshot(conn, src["source_id"])
            if snap and snap["content_type"] == "text/html":
                html = (archive_root / snap["archive_path"]).read_bytes()
                for url, text in discover_links(html, snap["final_url"], fetcher.allowed):
                    cur = conn.execute("INSERT OR IGNORE INTO discovered_link (parent_source_id, url, link_text, first_seen_at)"
                                       " VALUES (?,?,?,?)", (src["source_id"], url, text, archive.utcnow().isoformat()))
                    summary.discovered += cur.rowcount
                    child = dict(src, source_id=f"{src['source_id']}:{archive.sha256_bytes(url.encode())[:8]}",
                                 title=text or url, url=url, doc_type=src["doc_type"] + "_doc")
                    archive.upsert_source(conn, {k: child.get(k) for k in
                                          ("source_id", "jurisdiction", "state", "doc_type", "title", "url", "status", "critical", "notes")})
                    _fetch_one(conn, fetcher, archive_root, child, url, src["source_id"], summary)
                conn.commit()
    conn.close()
    return summary


def _fetch_one(conn, fetcher, archive_root, src, url, parent_id, summary: RunSummary) -> None:
    sid = src["source_id"]
    try:
        resp, attempts = fetcher.get(url)
    except FetchError as e:
        archive.record_failure(conn, sid, url, fetcher.cfg["max_retries"] + 1, str(e))
        summary.failed += 1
        summary.details.append({"source_id": sid, "result": "failed", "error": str(e)})
        return
    res = archive.store_snapshot(conn, archive_root, source=src, data=resp.body, requested_url=url,
                                 final_url=resp.final_url, content_type=resp.content_type,
                                 http_status=resp.status, parent_source_id=parent_id)
    summary.fetched += 1
    summary.changed += int(res.changed)
    summary.unchanged += int(not res.changed)
    summary.details.append({"source_id": sid, "result": "new" if res.first_snapshot else
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
    s = run(load_register(Path(args.register)), load_settings(), Path(args.db), Path(args.archive),
            only=set(args.only) if args.only else None, follow_documents=args.follow_documents)
    print(json.dumps({"fetched": s.fetched, "changed": s.changed, "unchanged": s.unchanged,
                      "failed": s.failed, "discovered": s.discovered, "details": s.details}, indent=2))
    return 1 if s.failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
