"""Write a review packet: every extraction awaiting review, with its evidence, as CSV + XLSX.

    python -m src.review.build_packet            # -> review/packets/review_<date>.xlsx and .csv

The reviewer fills `decision` (approve / reject), `reviewer`, and optionally `corrected_value` and
`review_note`, saves the file into review/returned/, and runs python -m src.review.import_review.
"""
from __future__ import annotations

import csv
from pathlib import Path

from ..fetch import archive

ROOT = Path(__file__).resolve().parents[2]
COLUMNS = ["extraction_id", "source_id", "title", "doc_status", "topic", "field", "value", "units", "applies_to",
           "page", "section", "quote", "confidence", "notes", "validation_note", "source_url", "retrieved_at",
           "sha256", "model", "prompt_version",
           "decision", "reviewer", "corrected_value", "review_note"]
EDITABLE = {"decision", "reviewer", "corrected_value", "review_note"}


def rows(conn, include_rejected: bool = False):
    statuses = ("pending_review", "rejected_validation") if include_rejected else ("pending_review",)
    q = (f"SELECT e.*, src.title, s.final_url AS source_url, s.retrieved_at, s.sha256, c.model_served AS model, "
         f"c.prompt_version FROM extraction e JOIN snapshot s USING(snapshot_id) JOIN source src ON "
         f"src.source_id=e.source_id JOIN llm_call c USING(call_id) WHERE e.status IN "
         f"({','.join('?' * len(statuses))}) ORDER BY e.source_id, e.topic, e.field, e.page")
    for r in conn.execute(q, statuses):
        d = {k: r[k] if k in r.keys() else "" for k in COLUMNS}
        d.update(decision="", reviewer="", corrected_value="", review_note="")
        yield d


def build(db_path: Path | None = None, out_dir: Path | None = None, include_rejected: bool = False) -> Path:
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill

    conn = archive.connect(db_path or ROOT / "data" / "dl3.db")
    data = list(rows(conn, include_rejected))
    conn.close()
    out_dir = out_dir or ROOT / "review" / "packets"
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = f"review_{archive.utcnow():%Y%m%d_%H%M}"
    with open(out_dir / f"{stem}.csv", "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=COLUMNS)
        w.writeheader()
        w.writerows(data)
    wb = Workbook()
    ws = wb.active
    ws.title = "Review"
    ws.append(COLUMNS)
    for d in data:
        ws.append([d[c] for c in COLUMNS])
    yellow = PatternFill("solid", fgColor="FFF2CC")
    for cell in ws[1]:
        cell.font = Font(bold=True)
        if cell.value in EDITABLE:
            cell.fill = yellow
    for row in ws.iter_rows(min_row=2):
        for cell in row:
            cell.alignment = Alignment(wrap_text=True, vertical="top")
    for col in ws.columns:
        ws.column_dimensions[col[0].column_letter].width = 60 if col[0].value in ("quote", "notes", "title") else 16
    ws.freeze_panes = "B2"
    ws.auto_filter.ref = ws.dimensions
    help_ = wb.create_sheet("How to review")
    for line in [
        "For each row, open the source_url at the cited page and check the quote and value.",
        "decision: approve (the value is right and current) or reject.",
        "reviewer: your name. Required for every decision.",
        "corrected_value: optional. If the value is wrong but the quote is right, type the right value.",
        "doc_status 'draft' means the document is a draft: approve only as a draft rule; it never replaces a final rule.",
        "validation_note flags numbers the code could not find in the quote. Look closely at those rows.",
        "Save into review/returned/ and run: python -m src.review.import_review",
    ]:
        help_.append([line])
    help_.column_dimensions["A"].width = 120
    path = out_dir / f"{stem}.xlsx"
    wb.save(path)
    return path


if __name__ == "__main__":
    print(build())
