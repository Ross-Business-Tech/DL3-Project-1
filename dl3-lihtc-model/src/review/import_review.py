"""Apply reviewer decisions from returned packets (review/returned/*.xlsx or *.csv).

Only rows with decision approve/reject and a reviewer name change anything. An approval is refused for a
finding whose quote failed verification, or that a different reviewer already decided.

    python -m src.review.import_review [files...]
"""
from __future__ import annotations

import argparse
import csv
from pathlib import Path

from ..fetch import archive

ROOT = Path(__file__).resolve().parents[2]


def read_rows(path: Path) -> list[dict]:
    if path.suffix.lower() == ".csv":
        with open(path, newline="", encoding="utf-8") as fh:
            return list(csv.DictReader(fh))
    from openpyxl import load_workbook
    ws = load_workbook(path, read_only=True)["Review"]
    it = ws.iter_rows(values_only=True)
    header = [str(h) for h in next(it)]
    return [{h: ("" if v is None else str(v)) for h, v in zip(header, r)} for r in it]


def apply(conn, rows: list[dict]) -> dict:
    out = {"approved": 0, "rejected": 0, "unchanged": 0, "errors": []}
    now = archive.utcnow().isoformat()
    for r in rows:
        decision = (r.get("decision") or "").strip().lower()
        reviewer = (r.get("reviewer") or "").strip()
        if not decision:
            out["unchanged"] += 1
            continue
        eid = int(float(r["extraction_id"]))
        cur = conn.execute("SELECT * FROM extraction WHERE extraction_id=?", (eid,)).fetchone()
        if cur is None:
            out["errors"].append(f"{eid}: no such extraction")
            continue
        if decision not in ("approve", "reject"):
            out["errors"].append(f"{eid}: decision must be approve or reject, got '{decision}'")
            continue
        if not reviewer:
            out["errors"].append(f"{eid}: reviewer name required")
            continue
        if cur["status"] in ("approved", "rejected_by_reviewer") and cur["reviewer"] != reviewer:
            out["errors"].append(f"{eid}: already decided by {cur['reviewer']}")
            continue
        if decision == "approve" and not cur["quote_verified"]:
            out["errors"].append(f"{eid}: quote failed verification; cannot be approved")
            continue
        status = "approved" if decision == "approve" else "rejected_by_reviewer"
        conn.execute("UPDATE extraction SET status=?, reviewer=?, reviewed_at=?, reviewer_value=?, review_note=? "
                     "WHERE extraction_id=?",
                     (status, reviewer, now, (r.get("corrected_value") or "").strip() or None,
                      (r.get("review_note") or "").strip() or None, eid))
        out["approved" if status == "approved" else "rejected"] += 1
    conn.commit()
    return out


def approved_values(conn, source_id: str | None = None) -> list[dict]:
    """The only extractions calculations may use: reviewer-approved, with the reviewer's correction applied."""
    q = ("SELECT e.*, COALESCE(e.reviewer_value, e.value) AS approved_value FROM extraction e "
         "WHERE e.status='approved'" + (" AND e.source_id=?" if source_id else ""))
    return [dict(r) for r in conn.execute(q, (source_id,) if source_id else ())]


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("files", nargs="*")
    ap.add_argument("--db", default=str(ROOT / "data" / "dl3.db"))
    a = ap.parse_args(argv)
    files = [Path(f) for f in a.files] or sorted((ROOT / "review" / "returned").glob("*.[cx][sl]s*"))
    conn = archive.connect(Path(a.db))
    total = {"approved": 0, "rejected": 0, "unchanged": 0, "errors": []}
    for f in files:
        res = apply(conn, read_rows(f))
        for k in ("approved", "rejected", "unchanged"):
            total[k] += res[k]
        total["errors"] += [f"{f.name}: {e}" for e in res["errors"]]
    conn.close()
    print(total)
    return 1 if total["errors"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
