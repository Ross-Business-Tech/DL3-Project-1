"""Focused crawl of each allocating agency's website to discover inventory sources.

For every jurisdiction in config/jurisdictions.csv, start at the agency homepage, follow the links most
likely to lead to LIHTC material (bounded pages and depth, same site only), and record every link that
looks like a QAP, award list, underwriting manual, application/round page, or bond program page.

Output is *candidates with evidence* (link text, page found on, page hash, time). Nothing here is treated
as verified: the inventory build marks every auto-found value "needs verification" until a reviewer
confirms it in config/inventory_overrides.csv. Link text and pages are data, never instructions.

    python -m src.inventory.crawl                 # all jurisdictions, then builds the inventory
    python -m src.inventory.crawl --only MI CHI   # a few
"""
from __future__ import annotations

import argparse
import csv
import heapq
import re
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urljoin, urlparse

import yaml
from bs4 import BeautifulSoup

from ..fetch import archive, fetch

ROOT = Path(__file__).resolve().parents[2]
DOC_FORMATS = {".pdf": "pdf", ".xlsx": "xlsx", ".xls": "xls", ".xlsm": "xlsx", ".docx": "docx",
               ".doc": "doc", ".csv": "csv", ".zip": "zip"}
YEAR_RANGE = re.compile(r"\b(20[0-3]\d)\s*[-–/]\s*(20[0-3]\d|[0-3]\d)\b")
YEAR = re.compile(r"\b(20[0-3]\d)\b")


def load_jurisdictions(path: Path | None = None) -> list[dict]:
    with open(path or ROOT / "config" / "jurisdictions.csv", newline="", encoding="utf-8") as fh:
        return list(csv.DictReader(fh))


def load_rules(path: Path | None = None) -> dict:
    rules = yaml.safe_load((path or ROOT / "config" / "inventory_keywords.yaml").read_text())
    c = lambda pats: [re.compile(p, re.I) for p in pats]  # noqa: E731
    rules["_strong"], rules["_weak"] = c(rules["follow_strong"]), c(rules["follow_weak"])
    rules["_skip"] = c(rules["skip"])
    rules["_context"], rules["_draft"] = c(rules["lihtc_context"]), c(rules["draft_markers"])
    rules["_exclude_hosts"] = {h.lower() for h in rules.get("exclude_hosts", [])}
    rules["_exclude_text"], rules["_ancillary"] = c(rules.get("exclude_text", [])), c(rules.get("ancillary", []))
    rules["_cats"] = {k: (c(v["patterns"]), bool(v.get("needs_context"))) for k, v in rules["categories"].items()}
    return rules


def hosts_for(j: dict) -> set[str]:
    hosts = {urlparse(j["agency_url"]).hostname or ""}
    hosts |= {h.strip() for h in (j.get("extra_hosts") or "").split(";") if h.strip()}
    out = set()
    for h in hosts:
        h = h.lower().removeprefix("www.")
        if h:
            out |= {h, "www." + h}
    return out


def years_in(text: str) -> list[int]:
    """Years named in text. Ranges like 2027-2028 or 2027-28 expand to both years."""
    ys = set()
    for a, b in YEAR_RANGE.findall(text):
        a = int(a)
        b = int(b) if len(b) == 4 else (a // 100) * 100 + int(b)
        if a <= b <= a + 5:
            ys.update(range(a, b + 1))
    ys.update(int(y) for y in YEAR.findall(text))
    return sorted(y for y in ys if 2000 <= y <= 2035)


def plan_years(text: str) -> list[int]:
    """Plan years a QAP title names: the first range if there is one ("2027-2028 QAP, changes from 2026"
    is a 2027-2028 plan), otherwise the latest single year."""
    m = YEAR_RANGE.search(text)
    if m:
        a, b = int(m.group(1)), m.group(2)
        b = int(b) if len(b) == 4 else (a // 100) * 100 + int(b)
        if a <= b <= a + 5:
            return list(range(a, b + 1))
    ys = years_in(text)
    return ys[-1:] if ys else []


DOWNLOAD_PATH = re.compile(r"(/download/?$|/download_file/|/-/media/|/getattachment/|/documentcenter/view/)", re.I)


def file_format(url: str) -> str | None:
    """File type from the URL. CMS download links without an extension (".../download",
    "download_file/view/...") are documents of unknown type: "file"."""
    path = urlparse(url).path.lower()
    fmt = next((fmt for ext, fmt in DOC_FORMATS.items() if path.endswith(ext)), None)
    if fmt is None and DOWNLOAD_PATH.search(path):
        return "file"
    return fmt


def jurisdiction_rules(j: dict, rules: dict) -> dict:
    """Add this jurisdiction's own names for its QAP (e.g. California "TCAC Regulations")."""
    aliases = [a.strip() for a in (j.get("qap_aliases") or "").split(";") if a.strip()]
    if not aliases:
        return rules
    cats = dict(rules["_cats"])
    pats, needs = cats["qap"]
    cats["qap"] = (pats + [re.compile(a, re.I) for a in aliases], needs)
    return {**rules, "_cats": cats}


def classify(text: str, url: str, page_context: str, rules: dict) -> list[dict]:
    """Categories a link belongs to, with a score. Link text counts double; URL path counts once."""
    path = urlparse(url).path
    has_context = any(rx.search(f"{text} {path} {page_context}") for rx in rules["_context"])
    out = []
    for cat, (patterns, needs_context) in rules["_cats"].items():
        if needs_context and not has_context:
            continue
        score = sum(2 * len(rx.findall(text)) + len(rx.findall(path)) for rx in patterns)
        if score:
            out.append({"category": cat, "score": score})
    return out


@dataclass
class CrawlResult:
    jurisdiction_id: str
    pages: list = field(default_factory=list)
    candidates: list = field(default_factory=list)
    errors: list = field(default_factory=list)
    start_error: str | None = None
    moved_to: str | None = None
    start_method: str | None = None


def _follow_score(text: str, url: str, rules: dict) -> int:
    t = f"{text} {urlparse(url).path}"
    return 5 * sum(len(rx.findall(t)) for rx in rules["_strong"]) + sum(len(rx.findall(t)) for rx in rules["_weak"])


LOC = re.compile(rb"<loc>\s*([^<\s]+)\s*</loc>", re.I)


def sitemap_urls(fetcher: fetch.Fetcher, base: str, limit: int) -> list[str]:
    """Page URLs from the site's sitemap(s): robots.txt Sitemap: lines, else /sitemap.xml. One index level."""
    rp, _ = fetcher.robots(base)
    maps = list((rp.site_maps() if rp else None) or []) or [base + "/sitemap.xml"]
    urls, seen_maps = [], set()
    while maps and len(seen_maps) < 8 and len(urls) < limit:
        m = maps.pop(0)
        if m in seen_maps or m.endswith(".gz"):
            continue
        seen_maps.add(m)
        try:
            resp, _ = fetcher.get(m)
        except fetch.FetchError:
            continue
        locs = [u.decode("utf-8", "replace") for u in LOC.findall(resp.body)]
        if b"<sitemapindex" in resp.body[:2000]:
            maps.extend(locs)
        else:
            urls.extend(locs)
    return urls[:limit]


def crawl_jurisdiction(j: dict, rules: dict, fetcher: fetch.Fetcher) -> CrawlResult:
    try:
        return _crawl(j, jurisdiction_rules(j, rules), fetcher)
    finally:
        fetcher.close()


def _candidate(c, url, text, kind, fmt, found_on, sha, years, draft, offsite, depth, now):
    return {**c, "url": url, "link_text": text, "kind": kind, "file_format": fmt, "found_on_url": found_on,
            "found_on_sha256": sha, "years": years, "draft_marker": draft, "offsite": offsite,
            "depth": depth, "retrieved_at": now}


def _crawl(j: dict, rules: dict, fetcher: fetch.Fetcher) -> CrawlResult:
    res = CrawlResult(j["jurisdiction_id"])
    limits = rules["crawl"]
    prefix = (j.get("path_prefix") or "").rstrip("/")
    hosts = hosts_for(j)
    start = j["agency_url"]

    # 1. Homepage. A redirect to a new site means the agency moved: adopt that site and report it.
    try:
        resp, _ = fetcher.get(start, allow_offsite_redirect=True)
    except fetch.FetchError as e:
        res.start_error = str(e)
        res.errors.append({"url": start, "error": str(e)})
        return res
    res.start_method = resp.method
    new_host = (urlparse(resp.final_url).hostname or "").lower()
    if new_host and new_host not in hosts:
        res.moved_to = resp.final_url
        bare = new_host.removeprefix("www.")
        hosts |= {bare, "www." + bare}
        fetcher.allowed |= {bare, "www." + bare}
        if prefix and not urlparse(resp.final_url).path.startswith(prefix):
            prefix = ""  # old path prefix does not apply on the new site
    # JS-built homepage: almost no links in the raw HTML. Try a real browser once.
    if resp.method == "http" and resp.content_type == "text/html" and fetcher.browser is not None:
        if len(BeautifulSoup(resp.body, "lxml").find_all("a", href=True)) < 5:
            try:
                resp, _ = fetcher.get(resp.final_url, force_browser=True)
                res.start_method = "browser (page built with JavaScript)"
            except fetch.FetchError as e:
                res.errors.append({"url": start, "error": f"JavaScript page, browser failed: {e}"})

    queue: list = []
    queued, tiebreak = {start, resp.final_url}, 0
    seen_cands: set = set()
    first = resp

    # 2. Sitemap: lets the crawl jump straight to deep LIHTC pages instead of wandering menus.
    p0 = urlparse(resp.final_url)
    for u in sitemap_urls(fetcher, f"{p0.scheme}://{p0.netloc}", limits.get("max_sitemap_urls", 5000)):
        pu = urlparse(u)
        if (pu.hostname or "").lower() not in hosts or file_format(u) or u in queued:
            continue
        if prefix and not pu.path.startswith(prefix):
            continue
        if any(rx.search(u) for rx in rules["_skip"]):
            continue
        score = 5 * sum(len(rx.findall(pu.path)) for rx in rules["_strong"])
        if score:
            queue.append((score, u))
    queue.sort(key=lambda x: (-x[0], len(x[1])))
    seeded = queue[: limits.get("sitemap_seed_pages", 15)]
    queue = []
    for score, u in seeded:
        tiebreak += 1
        queued.add(u)
        heapq.heappush(queue, (-score, 1, tiebreak, u))

    # Extra starting pages a person found for this jurisdiction (e.g. by web search): crawl these first.
    for u in [x.strip() for x in (j.get("extra_start_urls") or "").split(";") if x.strip()]:
        if (urlparse(u).hostname or "").lower() in hosts and u not in queued:
            queued.add(u)
            tiebreak += 1
            heapq.heappush(queue, (-1000, 1, tiebreak, u))

    # 3. Focused crawl, best-scoring links first.
    pending_first = True
    while (pending_first or queue) and len(res.pages) < limits["max_pages_per_jurisdiction"]:
        if pending_first:
            pending_first, depth, url = False, 0, start
            resp = first
        else:
            _, depth, _, url = heapq.heappop(queue)
            try:
                resp, _ = fetcher.get(url)
            except fetch.FetchError as e:
                if not str(e).startswith("content type not allowed"):  # image/video links: not a failure
                    res.errors.append({"url": url, "error": str(e)})
                continue
        if resp.content_type != "text/html":
            continue
        now = archive.utcnow().isoformat()
        sha = archive.sha256_bytes(resp.body)
        soup = BeautifulSoup(resp.body, "lxml")
        title = " ".join((soup.title.get_text() if soup.title else "").split())[:300]
        h1 = soup.find("h1")
        heading = " ".join(h1.get_text().split())[:300] if h1 else ""
        res.pages.append({"url": url, "final_url": resp.final_url, "title": title, "sha256": sha,
                          "depth": depth, "retrieved_at": now})
        page_context = f"{title} {heading} {urlparse(resp.final_url).path}"

        # The page itself can be the QAP / award / program landing page.
        page_text = f"{title} {heading}"
        for c in classify(page_text, resp.final_url, page_context, rules):
            key = (c["category"], resp.final_url)
            if key not in seen_cands:
                seen_cands.add(key)
                res.candidates.append(_candidate(
                    c, resp.final_url, heading or title, "page", "html", resp.final_url, sha, years_in(page_text),
                    any(rx.search(page_text) for rx in rules["_draft"]), False, depth, now))

        for t in soup(["script", "style", "noscript"]):
            t.decompose()
        for a in soup.find_all("a", href=True):
            href = a["href"].strip()
            if any(rx.search(href) for rx in rules["_skip"][:3]):  # mailto/tel/javascript
                continue
            link = urljoin(resp.final_url, href).split("#")[0]
            p = urlparse(link)
            if p.scheme not in ("http", "https"):
                continue
            host = (p.hostname or "").lower()
            text = " ".join(a.get_text(" ").split())[:300] or (a.get("title") or "")
            fmt = file_format(link)
            onsite = host in hosts
            filename = p.path.rsplit("/", 1)[-1]
            for c in classify(text, link, page_context, rules):
                key = (c["category"], link)
                if key in seen_cands:
                    continue
                seen_cands.add(key)
                # years from link text and file name only: folder dates are upload dates
                res.candidates.append(_candidate(
                    c, link, text, "document" if fmt else "page", fmt or "html", resp.final_url, sha,
                    years_in(f"{text} {filename}"), any(rx.search(f"{text} {filename}") for rx in rules["_draft"]),
                    not onsite, depth + 1, now))
            if fmt or not onsite or link in queued or depth + 1 > limits["max_depth"]:
                continue
            if prefix and not p.path.startswith(prefix):
                continue
            if any(rx.search(link) for rx in rules["_skip"]):
                continue
            score = _follow_score(text, link, rules)
            if score == 0 and depth >= 1:
                continue  # stay focused below the homepage
            queued.add(link)
            tiebreak += 1
            heapq.heappush(queue, (-score, depth + 1, tiebreak, link))
    return res


def save(conn, run_id: str, res: CrawlResult) -> None:
    jid = res.jurisdiction_id
    conn.executemany("INSERT INTO crawl_page VALUES (?,?,?,?,?,?,?,?)",
                     [(run_id, jid, p["url"], p["final_url"], p["title"], p["sha256"], p["depth"],
                       p["retrieved_at"]) for p in res.pages])
    conn.executemany(
        "INSERT INTO inventory_candidate VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [(run_id, jid, c["category"], c["url"], c["link_text"], c["kind"], c["file_format"], c["found_on_url"],
          c["found_on_sha256"], c["score"], ",".join(map(str, c["years"])), int(c["draft_marker"]),
          int(c["offsite"]), c["depth"], c["retrieved_at"]) for c in res.candidates])
    conn.execute("INSERT OR REPLACE INTO crawl_status (run_id, jurisdiction_id, pages_fetched, errors, first_error, "
                 "finished_at, start_error, moved_to, start_method) VALUES (?,?,?,?,?,?,?,?,?)",
                 (run_id, jid, len(res.pages), len(res.errors),
                  res.errors[0]["error"][:500] if res.errors else None, archive.utcnow().isoformat(),
                  (res.start_error or "")[:500] or None, res.moved_to, res.start_method))
    conn.commit()


def crawl_all(jurisdictions: list[dict], settings: dict, rules: dict, db_path: Path,
              fetcher_factory=None, run_id: str | None = None, workers: int | None = None,
              progress=print) -> str:
    run_id = run_id or "inv_" + uuid.uuid4().hex[:8]
    conn = archive.connect(db_path)
    archive.start_run(conn, run_id)
    fetcher_factory = fetcher_factory or (lambda hosts: fetch.Fetcher(settings, hosts))
    workers = workers or rules["crawl"]["workers"]

    def one(j):
        return crawl_jurisdiction(j, rules, fetcher_factory(hosts_for(j)))

    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(one, j): j["jurisdiction_id"] for j in jurisdictions}
        for fut in as_completed(futures):
            jid = futures[fut]
            try:
                res = fut.result()
            except Exception as e:  # one bad site must not stop the other 54
                msg = f"crawler error: {type(e).__name__}: {e}"
                res = CrawlResult(jid, errors=[{"url": "", "error": msg}], start_error=msg)
            save(conn, run_id, res)  # database writes stay on the main thread
            progress(f"{jid}: {len(res.pages)} pages, {len(res.candidates)} candidates, {len(res.errors)} errors")
    archive.finish_run(conn, run_id)
    conn.close()
    return run_id


def main(argv=None) -> int:
    from . import build
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--only", nargs="*", help="jurisdiction_ids, e.g. MI CHI NYC")
    ap.add_argument("--workers", type=int)
    ap.add_argument("--db", default=str(ROOT / "data" / "dl3.db"))
    a = ap.parse_args(argv)
    fetch.use_os_trust_store()
    js = load_jurisdictions()
    if a.only:
        wanted = {x.upper() for x in a.only}
        js = [j for j in js if j["jurisdiction_id"] in wanted]
    run_id = crawl_all(js, fetch.load_settings(), load_rules(), Path(a.db), workers=a.workers)
    out = build.build(db_path=Path(a.db))
    print(f"Crawl run {run_id} done. Inventory: {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
