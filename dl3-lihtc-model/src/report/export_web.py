"""Export what the website needs as plain files (CSV + JSON). The website is static: it cannot run this
pipeline or read the database, so collection runs on a computer and the site reads these files.

    python -m src.report.export_web            # writes data/web/

Files:
- awards.csv   one row per award line, in the column layout the site's ranking page already uses
               (src/ranking/data/awards.csv on the website branch)
- rules.csv    extracted QAP rule values with page, quote, source and review state
- sources.csv  every source: last retrieved, hash, draft/final, freshness
- manifest.json  when it was made, from which code version, and row counts

Only public agency information is written. Reviewer and importer names stay in the local database: the
repository is public. Unknown values are written as UNKNOWN, never filled in.
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import subprocess
from pathlib import Path

from ..fetch import archive, fetch

ROOT = Path(__file__).resolve().parents[2]
UNKNOWN = "UNKNOWN"
AWARD_COLS = ["state", "pathway", "year", "project", "parent_project", "city", "total_units", "new_construction",
              "age_restricted_or_assisted_living", "credits_awarded", "round_or_list", "source_url", "retrieved", "notes"]
RULE_COLS = ["state", "source_id", "document", "doc_status", "topic", "field", "value", "units", "applies_to", "page",
             "section", "quote", "review_state", "reviewed_on", "value_as_extracted", "checks", "source_url",
             "retrieved", "sha256"]
SOURCE_COLS = ["source_id", "state", "jurisdiction", "doc_type", "title", "url", "doc_status", "critical",
               "last_retrieved", "retrieval_method", "sha256", "age_days", "stale", "blocks_recommendation",
               "last_error"]
NEW = re.compile(r"\bnew\b", re.I)
NOT_NEW = re.compile(r"rehab|preserv|acqui|adaptive|renovat", re.I)


def _num(v):
    if v is None:
        return UNKNOWN
    return int(v) if float(v).is_integer() else v


def new_construction(project_type: str | None) -> str:
    """yes / no only when the file's own project-type text is unambiguous; otherwise UNKNOWN."""
    t = project_type or ""
    is_new, not_new = bool(NEW.search(t)), bool(NOT_NEW.search(t))
    return "yes" if is_new and not not_new else "no" if not_new and not is_new else UNKNOWN


def award_rows(conn):
    q = ("SELECT a.*, src.title, s.final_url, s.retrieved_at FROM award_row a JOIN snapshot s USING(snapshot_id) "
         "JOIN source src ON src.source_id=a.source_id WHERE a.snapshot_id IN "
         "(SELECT MAX(snapshot_id) FROM snapshot GROUP BY source_id) ORDER BY a.state, a.award_year, a.source_id, "
         "a.sheet_name, a.row_number")
    for r in conn.execute(q):
        notes = [f"sheet '{r['sheet_name']}' row {r['row_number']}"]
        if r["section"]:
            notes.append(f"section: {r['section']}")
        if r["status"]:
            notes.append(f"status as printed: {r['status']}")
        if r["set_aside"]:
            notes.append(f"set-aside: {r['set_aside']}")
        if r["annual_credit"] is None and r["credit_unlabeled"] is not None:
            notes.append(f"credit column not labelled annual: {_num(r['credit_unlabeled'])} (not used as credits_awarded)")
        for label, col in (("ten-year credit", "ten_year_credit"), ("equity", "equity"), ("credit requested", "credit_requested")):
            if r[col] is not None:
                notes.append(f"{label}: {_num(r[col])}")
        if r["credit_type"] != "unknown":
            notes.append(f"pathway from {r['credit_type_basis']}")
        if r["award_year"] is not None:
            notes.append(f"year from {r['award_year_basis']}")
        if r["flags"]:
            notes.append(f"CHECK: {r['flags']}")
        if r["doc_status"] == "draft":
            notes.append("source marked draft")
        yield {"state": r["state"] or UNKNOWN, "pathway": r["credit_type"] if r["credit_type"] != "unknown" else UNKNOWN,
               "year": r["award_year"] if r["award_year"] is not None else UNKNOWN, "project": r["project_name"] or "",
               "parent_project": r["project_name"] or "", "city": r["city"] or "", "total_units": _num(r["total_units"]),
               "new_construction": new_construction(r["project_type"]), "age_restricted_or_assisted_living": UNKNOWN,
               "credits_awarded": _num(r["annual_credit"]), "round_or_list": r["title"] or r["source_id"],
               "source_url": r["final_url"], "retrieved": r["retrieved_at"][:10], "notes": "; ".join(notes)}


def rule_rows(conn, include_pending: bool = True):
    statuses = ("approved", "pending_review") if include_pending else ("approved",)
    q = (f"SELECT e.*, src.state, src.title, s.final_url, s.retrieved_at, s.sha256 FROM extraction e JOIN snapshot s "
         f"USING(snapshot_id) JOIN source src ON src.source_id=e.source_id WHERE e.field<>'award_row' AND e.status IN "
         f"({','.join('?' * len(statuses))}) AND e.snapshot_id IN (SELECT MAX(snapshot_id) FROM snapshot GROUP BY source_id) "
         f"ORDER BY src.state, e.source_id, e.topic, e.field, e.page")
    for r in conn.execute(q, statuses):
        approved = r["status"] == "approved"
        yield {"state": r["state"], "source_id": r["source_id"], "document": r["title"], "doc_status": r["doc_status"],
               "topic": r["topic"], "field": r["field"],
               "value": (r["reviewer_value"] or r["value"]) if approved else r["value"], "units": r["units"] or "",
               "applies_to": r["applies_to"] or "unknown", "page": r["page"], "section": r["section"] or "",
               "quote": r["quote"],
               "review_state": "approved" if approved else "not reviewed: do not use in calculations",
               "reviewed_on": (r["reviewed_at"] or "")[:10], "value_as_extracted": r["value"],
               "checks": r["validation_note"] or "", "source_url": r["final_url"], "retrieved": r["retrieved_at"][:10],
               "sha256": r["sha256"]}


def source_rows(conn, limit_days: int):
    for s in conn.execute("SELECT * FROM source ORDER BY source_id"):
        if ":" in s["source_id"]:
            continue  # documents discovered under a landing page are listed with their parent in the database
        snap = archive.latest_snapshot(conn, s["source_id"])
        fr = archive.freshness(conn, s["source_id"], bool(s["critical"]), limit_days)
        err = conn.execute("SELECT error FROM fetch_failure WHERE source_id=? ORDER BY failure_id DESC LIMIT 1",
                           (s["source_id"],)).fetchone()
        failed_since = err and (snap is None or conn.execute(
            "SELECT 1 FROM fetch_failure WHERE source_id=? AND attempted_at>?", (s["source_id"], snap["retrieved_at"])).fetchone())
        yield {"source_id": s["source_id"], "state": s["state"], "jurisdiction": s["jurisdiction"], "doc_type": s["doc_type"],
               "title": s["title"], "url": s["url"], "doc_status": snap["doc_status"] if snap else s["status"],
               "critical": "yes" if s["critical"] else "no", "last_retrieved": snap["retrieved_at"][:10] if snap else "",
               "retrieval_method": (snap["retrieval_method"] or "http") if snap else "",
               "sha256": snap["sha256"] if snap else "", "age_days": fr["age_days"] if fr["age_days"] is not None else "",
               "stale": "yes" if fr["stale"] else "no", "blocks_recommendation": "yes" if fr["blocks_recommendation"] else "no",
               "last_error": (err["error"][:200] if failed_since else "")}


def _write(path: Path, cols: list[str], rows) -> int:
    n = 0
    with open(path, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=cols)
        w.writeheader()
        for r in rows:
            w.writerow(r)
            n += 1
    return n


def code_version() -> str:
    try:
        return subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, capture_output=True, text=True,
                              check=True).stdout.strip()
    except Exception:
        return "unknown"


def export(db_path: Path, out_dir: Path, settings: dict | None = None) -> dict:
    settings = settings or fetch.load_settings()
    conn = archive.connect(db_path)
    out_dir.mkdir(parents=True, exist_ok=True)
    counts = {"awards": _write(out_dir / "awards.csv", AWARD_COLS, award_rows(conn)),
              "rules": _write(out_dir / "rules.csv", RULE_COLS, rule_rows(conn)),
              "sources": _write(out_dir / "sources.csv", SOURCE_COLS, source_rows(conn, settings["freshness_days"]))}
    approved = conn.execute("SELECT COUNT(*) FROM extraction WHERE status='approved' AND field<>'award_row'").fetchone()[0]
    conn.close()
    manifest = {"generated_at": archive.utcnow().isoformat(), "code_version": code_version(), "counts": counts,
                "rules_approved": approved, "freshness_days": settings["freshness_days"],
                "note": "Auto-collected public agency information. Rules marked 'not reviewed' and award rows with "
                        "CHECK notes must not feed a score. UNKNOWN means not stated in the source."}
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return manifest


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db", default=str(ROOT / "data" / "dl3.db"))
    ap.add_argument("--out", default=str(ROOT / "data" / "web"))
    a = ap.parse_args(argv)
    m = export(Path(a.db), Path(a.out))
    print(f"Wrote {a.out}: {m['counts']} ({m['rules_approved']} rules approved)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
