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
    rules["_follow"], rules["_skip"] = c(rules["follow"]), c(rules["skip"])
    rules["_context"], rules["_draft"] = c(rules["lihtc_context"]), c(rules["draft_markers"])
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


def file_format(url: str) -> str | None:
    path = urlparse(url).path.lower()
    return next((fmt for ext, fmt in DOC_FORMATS.items() if path.endswith(ext)), None)


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


def _follow_score(text: str, url: str, rules: dict) -> int:
    return sum(len(rx.findall(f"{text} {urlparse(url).path}")) for rx in rules["_follow"])


def crawl_jurisdiction(j: dict, rules: dict, fetcher: fetch.Fetcher) -> CrawlResult:
    res = CrawlResult(j["jurisdiction_id"])
    limits = rules["crawl"]
    prefix = (j.get("path_prefix") or "").rstrip("/")
    hosts = hosts_for(j)
    start = j["agency_url"]
    queue: list = [(0, 0, 0, start)]   # (-follow_score, depth, tiebreak, url)
    queued, tiebreak = {start}, 0
    seen_cands: set = set()

    while queue and len(res.pages) < limits["max_pages_per_jurisdiction"]:
        _, depth, _, url = heapq.heappop(queue)
        try:
            resp, _ = fetcher.get(url)
        except fetch.FetchError as e:
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
        for c in classify(f"{title} {heading}", resp.final_url, page_context, rules):
            key = (c["category"], resp.final_url)
            if key not in seen_cands:
                seen_cands.add(key)
                res.candidates.append({**c, "url": resp.final_url, "link_text": heading or title, "kind": "page",
                                       "file_format": "html", "found_on_url": resp.final_url,
                                       "found_on_sha256": sha, "years": years_in(f"{title} {heading}"),
                                       "draft_marker": any(rx.search(f"{title} {heading}") for rx in rules["_draft"]),
                                       "offsite": False, "depth": depth, "retrieved_at": now})

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
                res.candidates.append({**c, "url": link, "link_text": text, "kind": "document" if fmt else "page",
                                       "file_format": fmt or "html", "found_on_url": resp.final_url,
                                       "found_on_sha256": sha,
                                       # years from link text and file name only: folder dates are upload dates
                                       "years": years_in(f"{text} {filename}"),
                                       "draft_marker": any(rx.search(f"{text} {filename}") for rx in rules["_draft"]),
                                       "offsite": not onsite, "depth": depth + 1, "retrieved_at": now})
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
    conn.execute("INSERT OR REPLACE INTO crawl_status VALUES (?,?,?,?,?,?)",
                 (run_id, jid, len(res.pages), len(res.errors),
                  res.errors[0]["error"][:500] if res.errors else None, archive.utcnow().isoformat()))
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
                res = CrawlResult(jid, errors=[{"url": "", "error": f"crawler error: {type(e).__name__}: {e}"}])
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
