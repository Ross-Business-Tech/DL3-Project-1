"""Collection coverage: for each jurisdiction, what has been collected and what is still missing.

This is the "is scraping done?" checklist. It reads the database only; it scores nothing.

    python -m src.report.coverage MI OH NYC      # prints a checklist, writes outputs/coverage/coverage.csv

A source belongs to the jurisdiction whose ID prefixes its source_id (MI_QAP_CURRENT -> MI).
"""
from __future__ import annotations

import argparse
import csv
from pathlib import Path

from ..fetch import archive, fetch

ROOT = Path(__file__).resolve().parents[2]
RULE_TOPICS = ["fee_rule", "unit_credit_caps", "set_asides", "deadlines", "sponsor_eligibility",
               "scoring_criteria", "credit_availability"]
QAP_TYPES = ("qap", "qap_doc", "qap_page_doc")


def jurisdiction_coverage(conn, jid: str, settings: dict) -> dict:
    first, last = settings["award_years"]["first"], settings["award_years"]["last"]
    limit = settings["freshness_days"]
    like = jid + r"\_%"
    sources = [dict(r) for r in conn.execute(
        "SELECT * FROM source WHERE source_id LIKE ? ESCAPE '\\' ORDER BY source_id", (like,))]
    items, missing = [], []

    def item(name, value, ok, detail=""):
        items.append({"jurisdiction_id": jid, "item": name, "value": value, "ok": "yes" if ok else "no", "detail": detail})
        if not ok:
            missing.append(f"{name}: {detail or value}")

    archived, stale, never = {}, [], []
    for s in sources:
        snap = archive.latest_snapshot(conn, s["source_id"])
        if snap is None:
            never.append(s["source_id"])
            continue
        archived[s["source_id"]] = (s, snap)
        if archive.freshness(conn, s["source_id"], bool(s["critical"]), limit)["stale"]:
            stale.append(s["source_id"])
    item("sources registered", len(sources), bool(sources), "run: python -m src.inventory.promote " + jid)
    item("sources never retrieved", len(never), not never, ", ".join(never))
    item("sources older than freshness limit", len(stale), not stale, ", ".join(stale))

    qaps = [(s, snap) for s, snap in archived.values() if s["doc_type"] in QAP_TYPES]
    item("QAP archived", len(qaps), bool(qaps), "no QAP document in the archive")
    nondraft = [s["source_id"] for s, snap in qaps if snap["doc_status"] != "draft"]
    item("QAP that is not a draft", len(nondraft), bool(nondraft), "only draft QAPs archived")
    confirmed_final = [s["source_id"] for s, snap in qaps if snap["doc_status"] == "final"]
    item("QAP confirmed final by a person", len(confirmed_final), bool(confirmed_final),
         "set status to final in config/source_register.csv once checked")
    uw = [sid for sid, (s, _) in archived.items() if s["doc_type"] == "underwriting"]
    item("underwriting manual archived", len(uw), bool(uw), "none (some states put this inside the QAP)")
    for doc_type, label in (("bond_page", "bond / 4% page archived"), ("news_page", "news page archived")):
        n = [sid for sid, (s, _) in archived.items() if s["doc_type"] == doc_type]
        item(label, len(n), bool(n), "none")

    for topic in RULE_TOPICS:
        counts = {r[0]: r[1] for r in conn.execute(
            "SELECT status, COUNT(*) FROM extraction WHERE source_id LIKE ? ESCAPE '\\' AND topic=? GROUP BY status",
            (like, topic))}
        ran = conn.execute("SELECT COUNT(*) FROM llm_call WHERE topic=? AND error IS NULL AND snapshot_id IN "
                           "(SELECT snapshot_id FROM snapshot WHERE source_id LIKE ? ESCAPE '\\')", (topic, like)).fetchone()[0]
        approved, pending = counts.get("approved", 0), counts.get("pending_review", 0)
        detail = ("not extracted yet" if not ran else "extracted but nothing found" if not (approved or pending)
                  else f"{pending} waiting for review" if not approved else "")
        item(f"rules: {topic}", f"{approved} approved, {pending} to review, "
             f"{counts.get('rejected_validation', 0)} failed quote check", approved > 0, detail)

    errs = conn.execute("SELECT COUNT(*) FROM llm_call c WHERE error IS NOT NULL AND snapshot_id IN (SELECT snapshot_id "
                        "FROM snapshot WHERE source_id LIKE ? ESCAPE '\\') AND NOT EXISTS (SELECT 1 FROM llm_call d WHERE "
                        "d.snapshot_id=c.snapshot_id AND d.topic=c.topic AND d.error IS NULL)", (like,)).fetchone()[0]
    item("extraction calls still failing", errs, errs == 0, "rerun: python -m src.extract.extract --force")

    by_year = {}
    for r in conn.execute(
            "SELECT award_year, credit_type, COUNT(*) n, SUM(flags IS NOT NULL) f FROM award_row WHERE source_id LIKE ? "
            "ESCAPE '\\' AND snapshot_id IN (SELECT MAX(snapshot_id) FROM snapshot GROUP BY source_id) "
            "GROUP BY award_year, credit_type", (like,)):
        by_year.setdefault(r["award_year"], []).append(f"{r['n']} {r['credit_type']}" + (f" ({r['f']} flagged)" if r["f"] else ""))
    pdf_rows = {}
    for r in conn.execute("SELECT value, row_json, status FROM extraction WHERE field='award_row' AND status IN "
                          "('approved','pending_review') AND source_id LIKE ? ESCAPE '\\'", (like,)):
        pdf_rows["from PDF"] = pdf_rows.get("from PDF", 0) + 1
    for y in range(first, last + 1):
        got = by_year.get(y, [])
        item(f"awards {y}", "; ".join(got) or "0 rows", bool(got),
             "no spreadsheet rows for this year" + (f" ({pdf_rows['from PDF']} PDF rows not yet assigned a year)" if pdf_rows else ""))
    if None in by_year:
        item("award rows with no year", "; ".join(by_year[None]), False, "year not stated in the file: check and fix the source title")
    no_table = conn.execute("SELECT COUNT(*) FROM award_sheet WHERE header_row IS NULL AND source_id LIKE ? ESCAPE '\\'",
                            (like,)).fetchone()[0]
    parsed_sheets = conn.execute("SELECT COUNT(*) FROM award_sheet WHERE header_row IS NOT NULL AND source_id LIKE ? ESCAPE '\\'",
                                 (like,)).fetchone()[0]
    if no_table and not parsed_sheets:
        item("award spreadsheets with no table found", no_table, False, "add header patterns to config/award_columns.yaml")
    return {"jurisdiction_id": jid, "items": items, "missing": missing}


def run(ids: list[str], db_path: Path, out_dir: Path, settings: dict | None = None) -> tuple[Path, list[dict]]:
    settings = settings or fetch.load_settings()
    conn = archive.connect(db_path)
    results = [jurisdiction_coverage(conn, j, settings) for j in ids]
    conn.close()
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "coverage.csv"
    with open(path, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=["jurisdiction_id", "item", "value", "ok", "detail"])
        w.writeheader()
        for r in results:
            w.writerows(r["items"])
    return path, results


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("ids", nargs="+", help="jurisdiction codes, e.g. MI OH NYC")
    ap.add_argument("--db", default=str(ROOT / "data" / "dl3.db"))
    a = ap.parse_args(argv)
    path, results = run([i.upper() for i in a.ids], Path(a.db), ROOT / "outputs" / "coverage")
    for r in results:
        done = sum(1 for i in r["items"] if i["ok"] == "yes")
        print(f"\n{r['jurisdiction_id']}: {done} of {len(r['items'])} items collected")
        for i in r["items"]:
            print(f"  [{'x' if i['ok'] == 'yes' else ' '}] {i['item']:38} {i['value']}" + (f"  <- {i['detail']}" if i["ok"] == "no" and i["detail"] else ""))
    print(f"\nWrote {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
