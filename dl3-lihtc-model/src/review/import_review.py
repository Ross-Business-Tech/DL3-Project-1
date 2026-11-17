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
        with open(path, newline="", encoding="utf-8-sig") as fh:  # Excel adds a byte-order mark
            return list(csv.DictReader(fh))
    from openpyxl import load_workbook
    ws = load_workbook(path, read_only=True)["Review"]
    it = ws.iter_rows(values_only=True)
    header = [str(h) for h in next(it)]
    return [{h: ("" if v is None else str(v)) for h, v in zip(header, r)} for r in it]


APPROVE = {"approve", "approved", "accept", "accepted", "yes", "y", "ok"}
REJECT = {"reject", "rejected", "no", "n", "decline", "declined"}
CORRECT = {"correct", "corrected", "fix", "fixed"}
NO_VALUE = {"", "n/a", "na", "none", "-"}


def _same(a: str, b: str) -> bool:
    return " ".join((a or "").split()).lower() == " ".join((b or "").split()).lower()


def apply(conn, rows: list[dict], dry_run: bool = False) -> dict:
    """Record decisions. 'accept'/'yes' count as approve, 'no' as reject; 'correct' approves with the
    corrected value. A corrected value equal to the original, or on a rejected row, is not a correction."""
    out = {"approved": 0, "rejected": 0, "corrected": 0, "unchanged": 0, "errors": []}
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
        corrected = (r.get("corrected_value") or "").strip()
        if corrected.lower() in NO_VALUE or _same(corrected, cur["value"] or ""):
            corrected = ""
        if decision in CORRECT:
            if not corrected:
                out["errors"].append(f"{eid}: decision 'correct' needs a corrected_value different from the value")
                continue
            decision = "approve"
        elif decision in APPROVE:
            decision = "approve"
        elif decision in REJECT:
            decision, corrected = "reject", ""
        else:
            out["errors"].append(f"{eid}: decision must be approve, reject or correct, got '{decision}'")
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
                     (status, reviewer, now, corrected or None, (r.get("review_note") or "").strip() or None, eid))
        out["approved" if status == "approved" else "rejected"] += 1
        out["corrected"] += int(bool(corrected))
    if dry_run:
        conn.rollback()
    else:
        conn.commit()
    return out


def approved_values(conn, source_id: str | None = None) -> list[dict]:
    """The only extractions calculations may use: reviewer-approved, with the reviewer's correction applied."""
    q = ("SELECT e.*, COALESCE(e.reviewer_value, e.value) AS approved_value FROM current_extraction e "
         "WHERE e.status='approved'" + (" AND e.source_id=?" if source_id else ""))
    return [dict(r) for r in conn.execute(q, (source_id,) if source_id else ())]


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("files", nargs="*")
    ap.add_argument("--db", default=str(ROOT / "data" / "dl3.db"))
    ap.add_argument("--dry-run", action="store_true", help="check the file and report; change nothing")
    a = ap.parse_args(argv)
    files = [Path(f) for f in a.files] or sorted((ROOT / "review" / "returned").glob("*.[cx][sl]s*"))
    if not files:
        print("No returned review files. Put them in review/returned/ or name them on the command line.")
        return 1
    conn = archive.connect(Path(a.db))
    total = {"approved": 0, "rejected": 0, "corrected": 0, "unchanged": 0, "errors": []}
    for f in files:
        try:
            data = read_rows(f)
        except PermissionError:
            print(f"Cannot read {f}: your computer is not letting this program open that folder.\n"
                  f"Move the file into {ROOT / 'review' / 'returned'} with Finder and run the command without a path,\n"
                  "or on a Mac allow access in System Settings > Privacy & Security > Files and Folders.")
            return 1
        except FileNotFoundError:
            print(f"File not found: {f}")
            return 1
        res = apply(conn, data, dry_run=a.dry_run)
        for k in ("approved", "rejected", "corrected", "unchanged"):
            total[k] += res[k]
        total["errors"] += [f"{f.name}: {e}" for e in res["errors"]]
    conn.close()
    print(("DRY RUN, nothing saved. " if a.dry_run else "") +
          f"{total['approved']} approved ({total['corrected']} with a corrected value), {total['rejected']} rejected, "
          f"{total['unchanged']} without a decision, {len(total['errors'])} problems")
    for e in total["errors"][:20]:
        print("  ", e)
    if len(total["errors"]) > 20:
        print(f"   ... and {len(total['errors']) - 20} more")
    return 1 if total["errors"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
