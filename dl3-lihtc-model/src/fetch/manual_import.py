"""Manual import: archive a file a person saved from their own browser, with the same record-keeping
as an automatic download.

Use this when a site does not allow automated access (robots.txt says keep out, or it blocks bots).
A person opening the page in a normal browser and saving the file is fine; a crawler is not.

    python -m src.fetch.manual_import --list
        Sources and agency sites waiting for a manual import.

    python -m src.fetch.manual_import ~/Downloads/2026-QAP.pdf \\
        --url https://housing.nv.gov/programs/lihtc/2026-QAP.pdf \\
        --jurisdiction NV --doc-type qap_doc --title "Nevada 2026 QAP" --by "Your Name"
        New source: added to config/source_register.csv as a manual source, then archived.

    python -m src.fetch.manual_import ~/Downloads/page.html --source-id P6 --by "Your Name"
        Existing source that failed automatically: archived under that source.

The file gets the same checks as a download (allowed file types, content matches type, size cap, not a
bot-check page), the same archive path and SHA-256 record, and retrieval_method = manual with your name.
It is then compared with the previous version and scanned for candidate rule pages. Imported files are
data: nothing in them is executed.
"""
from __future__ import annotations

import argparse
import csv
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

from ..extract import locate
from . import archive, diff, fetch

ROOT = Path(__file__).resolve().parents[2]

EXT_TYPES = {
    ".pdf": "application/pdf",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xlsm": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xls": "application/vnd.ms-excel",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".doc": "application/msword",
    ".csv": "text/csv",
    ".html": "text/html",
    ".htm": "text/html",
}


class ImportError_(Exception):
    """A manual import was refused; the message says why in plain words."""


def detect_type(path: Path, data: bytes) -> str:
    """Content type from the bytes first, the file extension second. Unknown types are refused."""
    head = data.lstrip(b"\xef\xbb\xbf \t\r\n")[:1024]
    ext = path.suffix.lower()
    if head.startswith(b"%PDF-"):
        return "application/pdf"
    if head.startswith(b"PK\x03\x04") or head.startswith(b"\xd0\xcf\x11\xe0"):
        ct = EXT_TYPES.get(ext)
        if ct and fetch.content_matches_type(data, ct) and ct in fetch.MAGIC:
            return ct
        raise ImportError_(f"{path.name} is an Office/zip file but its extension '{ext}' is not .xlsx, .xls, "
                           ".docx or .doc. Save it with the right extension.")
    low = head.lower()
    if low.startswith(b"<!doctype html") or low.startswith(b"<html") or b"<html" in low:
        return "text/html"
    if ext == ".csv":
        try:
            data[:4096].decode("utf-8")
        except UnicodeDecodeError as e:
            raise ImportError_(f"{path.name} is not readable text, so it is not a CSV") from e
        return "text/csv"
    raise ImportError_(f"{path.name}: file type not recognised. Allowed: PDF, Excel, Word, CSV, saved web page.")


def read_register(path: Path) -> tuple[list[str], list[dict]]:
    with open(path, newline="", encoding="utf-8") as fh:
        reader = csv.DictReader(fh)
        return list(reader.fieldnames), list(reader)


def write_register(path: Path, fields: list[str], rows: list[dict]) -> None:
    with open(path, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=fields)
        w.writeheader()
        w.writerows({f: r.get(f, "") for f in fields} for r in rows)


def _jurisdiction(jid: str, jurisdictions_path: Path | None):
    from ..inventory import crawl
    by = {j["jurisdiction_id"]: j for j in crawl.load_jurisdictions(jurisdictions_path)}
    if jid not in by:
        raise ImportError_(f"'{jid}' is not in config/jurisdictions.csv")
    return by[jid], crawl.hosts_for(by[jid])


def import_file(
    file: Path, *, by: str, db_path: Path, archive_root: Path, register_path: Path, settings: dict,
    source_id: str | None = None, url: str | None = None, jurisdiction: str | None = None,
    doc_type: str | None = None, title: str | None = None, status: str = "unknown", critical: bool | None = None,
    retrieved_on: str | None = None, note: str | None = None, third_party_host: bool = False,
    manual_only: bool = False, jurisdictions_path: Path | None = None,
) -> dict:
    by = (by or "").strip()
    if not by:
        raise ImportError_("--by is required: the name of the person who saved the file")
    file = Path(file).expanduser()
    if not file.is_file():
        raise ImportError_(f"file not found: {file}")
    if status not in ("draft", "final", "unknown"):
        raise ImportError_("--status must be draft, final or unknown")
    cfg = settings["fetch"]
    if file.stat().st_size > cfg["max_bytes"]:
        raise ImportError_(f"{file.name} is larger than the {cfg['max_bytes'] // 1_048_576} MB limit")
    data = file.read_bytes()
    if not data:
        raise ImportError_(f"{file.name} is empty")
    ct = detect_type(file, data)
    if ct not in cfg["allowed_content_types"]:
        raise ImportError_(f"{ct} files are not on the allowed list in config/settings.yaml")
    if fetch.looks_like_challenge(data, ct):
        raise ImportError_(f"{file.name} is a 'checking your browser' page, not the document. Open the real page "
                           "and save it again.")

    when = archive.utcnow()
    if retrieved_on:
        try:
            when = datetime.strptime(retrieved_on, "%Y-%m-%d").replace(hour=12, tzinfo=timezone.utc)
        except ValueError as e:
            raise ImportError_("--retrieved-on must look like 2026-11-10") from e
        if when > archive.utcnow():
            raise ImportError_("--retrieved-on is in the future")

    fields, rows = read_register(register_path)
    existing = next((r for r in rows if r["source_id"] == source_id), None) if source_id else None
    check_url = url or (existing["url"] if existing else None)
    if check_url:
        pu = urlparse(check_url)
        if pu.scheme not in ("http", "https") or not pu.hostname:
            raise ImportError_("--url must be the full web address the file came from (https://...)")
    notes = []
    if existing:
        src = existing
        url = url or existing["url"]
        if manual_only and "retrieval" in fields:
            existing["retrieval"] = "manual"
            write_register(register_path, fields, rows)
    else:
        missing = [n for n, v in (("--url", url), ("--jurisdiction", jurisdiction), ("--doc-type", doc_type),
                                  ("--title", title)) if not v]
        if source_id and missing:
            raise ImportError_(f"source '{source_id}' is not in the register. To add it, also give: {', '.join(missing)}")
        if missing:
            raise ImportError_(f"a new source needs: {', '.join(missing)} (or --source-id of an existing source)")
        j, hosts = _jurisdiction(jurisdiction.upper(), jurisdictions_path)
        host = (urlparse(url).hostname or "").lower()
        if host not in hosts:
            if not third_party_host:
                raise ImportError_(
                    f"{host} is not {j['allocating_agency']}'s own website ({', '.join(sorted(hosts))}). Official "
                    "sources are preferred. If this really is where the agency publishes it, add --third-party-host.")
            notes.append(f"not the agency's own site ({host})")
        source_id = source_id or f"{j['jurisdiction_id']}_{doc_type.upper()}_{archive.sha256_bytes(url.encode())[:6]}"
        if any(r["source_id"] == source_id for r in rows):
            raise ImportError_(f"source_id {source_id} already exists; pass --source-id {source_id} to add a new version")
        # The importer's name stays in the local database only: the register is committed to a public repo.
        notes.insert(0, f"manual source added {archive.utcnow():%Y-%m-%d}")
        src = {"source_id": source_id, "jurisdiction": j["allocating_agency"], "state": j["state"],
               "doc_type": doc_type, "title": title, "url": url, "status": status,
               "critical": "true" if (critical if critical is not None else doc_type.startswith(("qap", "underwriting"))) else "false",
               "notes": "; ".join(notes), "retrieval": "manual"}
        if "retrieval" not in fields:
            fields.append("retrieval")
        rows.append(src)
        write_register(register_path, fields, rows)
    conn = archive.connect(db_path)
    row = {k: src.get(k) for k in fetch.FIELDS}
    row["critical"] = 1 if str(src.get("critical", "")).strip().lower() in ("1", "true", "yes") else 0
    row["status"] = (src.get("status") or "unknown").strip().lower()
    archive.upsert_source(conn, row)
    res = archive.store_snapshot(
        conn, archive_root, source=row, data=data, requested_url=url, final_url=url, content_type=ct,
        http_status=0, retrieved_at=when, retrieval_method="manual", retrieved_by=by,
        import_note="; ".join(x for x in (f"file: {file.name}", note) if x))
    cleared = conn.execute("UPDATE fetch_failure SET manual_review_queued=0 WHERE source_id=? AND manual_review_queued=1",
                           (row["source_id"],)).rowcount
    conn.commit()
    snap = conn.execute("SELECT * FROM snapshot WHERE snapshot_id=?", (res.snapshot_id,)).fetchone()
    located = locate.locate_snapshot(conn, archive_root, snap, locate.load_topics())
    change = diff.compare_latest_for(conn, archive_root, snap)
    conn.close()
    return {"source_id": row["source_id"], "snapshot_id": res.snapshot_id, "sha256": res.sha256,
            "archive_path": res.archive_path, "content_type": ct, "doc_status": row["status"],
            "result": "first version" if res.first_snapshot else ("changed" if res.changed else "same as last version"),
            "change": change, "candidate_pages": located.get("candidates", 0),
            "needs_ocr_pages": located.get("needs_ocr_pages", []), "queue_cleared": cleared,
            "new_register_row": existing is None}


def queue(db_path: Path) -> dict:
    """What is waiting for a person: failed sources with no newer copy, and agency sites the crawl could not read."""
    conn = archive.connect(db_path)
    sources = [dict(r) for r in conn.execute(
        "SELECT f.source_id, src.title, f.url, f.error, MAX(f.attempted_at) AS last_failed, "
        "(SELECT MAX(retrieved_at) FROM snapshot s WHERE s.source_id=f.source_id) AS last_good "
        "FROM fetch_failure f JOIN source src USING(source_id) WHERE f.manual_review_queued=1 "
        "GROUP BY f.source_id HAVING last_good IS NULL OR last_good < last_failed ORDER BY f.source_id")]
    sites = [dict(r) for r in conn.execute(
        "SELECT c.jurisdiction_id, c.start_error FROM crawl_status c WHERE c.pages_fetched=0 AND c.finished_at="
        "(SELECT MAX(finished_at) FROM crawl_status WHERE jurisdiction_id=c.jurisdiction_id) ORDER BY c.jurisdiction_id")]
    conn.close()
    return {"sources": sources, "agency_sites": sites}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("file", nargs="?", help="the file you saved from your browser")
    ap.add_argument("--list", action="store_true", help="show what is waiting for a manual import")
    ap.add_argument("--by", help="your name (recorded with the file)")
    ap.add_argument("--source-id", help="an existing source in config/source_register.csv")
    ap.add_argument("--url", help="the web address the file came from")
    ap.add_argument("--jurisdiction", help="state or city code for a new source, e.g. NV")
    ap.add_argument("--doc-type", help="for a new source: qap_doc, underwriting, award_list, application, qap_page ...")
    ap.add_argument("--title", help="for a new source, e.g. \"Nevada 2026 QAP\"")
    ap.add_argument("--status", default="unknown", help="draft, final or unknown (default unknown; do not guess final)")
    ap.add_argument("--retrieved-on", help="date you saved it, YYYY-MM-DD (default: today)")
    ap.add_argument("--note", help="anything worth recording")
    ap.add_argument("--third-party-host", action="store_true", help="allow a URL that is not on the agency's own site")
    ap.add_argument("--manual-only", action="store_true",
                    help="existing source: stop trying to download it automatically from now on")
    ap.add_argument("--db", default=str(ROOT / "data" / "dl3.db"))
    ap.add_argument("--archive", default=str(ROOT / "archive"))
    ap.add_argument("--register", default=str(ROOT / "config" / "source_register.csv"))
    a = ap.parse_args(argv)

    if a.list:
        q = queue(Path(a.db))
        if not q["sources"] and not q["agency_sites"]:
            print("Nothing is waiting for a manual import.")
        if q["sources"]:
            print("Sources that failed and have no newer copy:")
            for s in q["sources"]:
                print(f"  {s['source_id']:14} {s['title'][:50]:50} {s['error'][:70]}\n{'':17}{s['url']}")
            print('  Import: python -m src.fetch.manual_import <file> --source-id <ID> --by "Your Name"\n')
        if q["agency_sites"]:
            print("Agency sites the crawl could not read (find the QAP in your browser, save it, then import it):")
            for s in q["agency_sites"]:
                print(f"  {s['jurisdiction_id']:5} {(s['start_error'] or '')[:100]}")
            print('  Import: python -m src.fetch.manual_import <file> --url <address> --jurisdiction <CODE> '
                  '--doc-type qap_doc --title "<State> <year> QAP" --by "Your Name"')
        return 0
    if not a.file:
        ap.error("give the file to import, or --list")
    try:
        r = import_file(Path(a.file), by=a.by or "", db_path=Path(a.db), archive_root=Path(a.archive),
                        register_path=Path(a.register), settings=fetch.load_settings(), source_id=a.source_id,
                        url=a.url, jurisdiction=a.jurisdiction, doc_type=a.doc_type, title=a.title, status=a.status,
                        retrieved_on=a.retrieved_on, note=a.note, third_party_host=a.third_party_host,
                        manual_only=a.manual_only)
    except ImportError_ as e:
        print(f"Not imported: {e}")
        return 1
    print(f"Imported {r['source_id']} ({r['result']}) -> archive/{r['archive_path']}")
    print(f"  SHA-256 {r['sha256'][:16]}..., status {r['doc_status']}, {r['candidate_pages']} candidate rule pages found")
    if r["needs_ocr_pages"]:
        print(f"  Pages with no readable text (scanned): {r['needs_ocr_pages'][:15]}. These need OCR before extraction.")
    if r["change"].get("text_diff"):
        d = r["change"]["text_diff"]
        print(f"  Changed since last version: {d['added_lines']} lines added, {d['removed_lines']} removed")
    if r["new_register_row"]:
        print("  Added to config/source_register.csv as a manual source (run_all.py will not try to download it).")
    print(f"  Next: python -m src.extract.extract --only {r['source_id']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
