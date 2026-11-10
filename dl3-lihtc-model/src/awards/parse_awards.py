"""Parse archived award spreadsheets (.xlsx, .xlsm, .xls, .csv) into award rows. Code only, no LLM.

For each archived award_list document that is a spreadsheet:
1. In every sheet, find the header row (the row whose cells best match config/award_columns.yaml).
2. Map columns to fields. Annual credit, ten-year credit and equity are separate; a column that only says
   "credit" or "award" goes to credit_unlabeled and the row is flagged, never assumed annual.
3. Read project rows below it: skip totals and blank rows; a single-text row is a section heading
   (e.g. "9% Awards - Nonprofit Set-Aside") carried onto the rows beneath it.
4. Credit type and award year come from a column, else the section heading, sheet name or file title, and
   the basis is recorded. Unknown stays unknown.
Every row keeps its sheet name and row number (the citation) and all original cells. Nothing is totalled.

    python -m src.awards.parse_awards                 # all archived award spreadsheets
    python -m src.awards.parse_awards --only OH_AWARDS_2 --force
    python -m src.awards.parse_awards --export        # outputs/awards/award_rows.csv for checking
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import re
from pathlib import Path

import yaml

from ..fetch import archive

ROOT = Path(__file__).resolve().parents[2]
PARSER_VERSION = "awards-1"
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
XLS = "application/vnd.ms-excel"
SHEET_TYPES = {XLSX, XLS, "text/csv"}
MONEY_FIELDS = ("annual_credit", "ten_year_credit", "equity", "credit_requested", "credit_unlabeled")
INT_FIELDS = ("total_units", "restricted_units")
TEXT_FIELDS = ("application_number", "project_name", "sponsor", "address", "city", "county", "zip", "award_date",
               "set_aside", "project_type", "status", "score")
YEAR = re.compile(r"\b(20[0-3]\d)\b")
NINE = re.compile(r"(?<![\d.])9\s*(%|pct|percent)", re.I)
FOUR = re.compile(r"(?<![\d.])4\s*(%|pct|percent)", re.I)


def load_rules(path: Path | None = None) -> dict:
    rules = yaml.safe_load((path or ROOT / "config" / "award_columns.yaml").read_text())
    rules["_fields"] = [(f, [re.compile(p, re.I) for p in pats]) for f, pats in rules["fields"].items()]
    rules["_ignore"] = [re.compile(p, re.I) for p in rules.get("ignore_headers", [])]
    rules["_total"] = [re.compile(p, re.I) for p in rules["total_row"]]
    return rules


# --- reading files into plain grids ---------------------------------------------------------------------
def read_sheets(raw: bytes, content_type: str) -> list[tuple[str, list[list], str | None]]:
    """[(sheet name, rows of cell values, note)]. Macros are never run; formulas use their saved values."""
    ct = (content_type or "").split(";")[0].strip().lower()
    if ct == "text/csv":
        text = raw.decode("utf-8-sig", "replace")
        return [("csv", [row for row in csv.reader(io.StringIO(text))], None)]
    if raw[:4] == b"PK\x03\x04":
        from openpyxl import load_workbook
        wb = load_workbook(io.BytesIO(raw), read_only=True, data_only=True)
        out = []
        for ws in wb.worksheets:
            note = "hidden sheet" if ws.sheet_state != "visible" else None
            out.append((ws.title, [list(r) for r in ws.iter_rows(values_only=True)], note))
        return out
    try:
        import xlrd
    except ImportError as e:
        raise RuntimeError("old-style .xls file: install xlrd (pip install xlrd)") from e
    book = xlrd.open_workbook(file_contents=raw)
    out = []
    for sh in book.sheets():
        rows = []
        for i in range(sh.nrows):
            row = []
            for c in sh.row(i):
                v = c.value
                if c.ctype == xlrd.XL_CELL_DATE:
                    try:
                        v = xlrd.xldate_as_datetime(v, book.datemode)
                    except Exception:
                        pass
                elif c.ctype in (xlrd.XL_CELL_EMPTY, xlrd.XL_CELL_BLANK):
                    v = None
                row.append(v)
            rows.append(row)
        out.append((sh.name, rows, "hidden sheet" if sh.visibility else None))
    return out


# --- cell helpers ---------------------------------------------------------------------------------------------
def text(v) -> str:
    if v is None:
        return ""
    if hasattr(v, "isoformat"):
        return v.isoformat()[:10] if v.isoformat().endswith("00:00:00") else v.isoformat()
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return " ".join(str(v).split())


def number(v) -> float | None:
    """A number from a cell: 1450000, "$1,450,000", "(500)" -> -500. Text that is not a number -> None."""
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip().replace("$", "").replace(",", "").replace(" ", "")
    neg = s.startswith("(") and s.endswith(")")
    s = s.strip("()")
    if not re.fullmatch(r"-?\d+(\.\d+)?", s):
        return None
    return -float(s) if neg else float(s)


def col_letter(i: int) -> str:
    s = ""
    i += 1
    while i:
        i, r = divmod(i - 1, 26)
        s = chr(65 + r) + s
    return s


# --- header detection ---------------------------------------------------------------------------------------
def map_header(cells: list, rules: dict) -> tuple[dict, list]:
    """{field: column index} for one candidate header row, plus unmapped header texts."""
    mapping, unmapped = {}, []
    for i, c in enumerate(cells):
        h = text(c).lower()
        if not h or len(h) > 80 or number(c) is not None:
            continue
        if any(rx.search(h) for rx in rules["_ignore"]):
            unmapped.append(text(c))
            continue
        field = next((f for f, pats in rules["_fields"] if any(rx.search(h) for rx in pats)), None)
        if field and field not in mapping:
            mapping[field] = i
        else:
            unmapped.append(text(c))
    return mapping, unmapped


def find_header(rows: list[list], rules: dict):
    best = None
    for i, row in enumerate(rows[: rules["header_search_rows"]]):
        m, unmapped = map_header(row, rules)
        has_key = "project_name" in m or ("application_number" in m and "sponsor" in m)
        if has_key and len(m) >= rules["min_mapped_columns"] and (best is None or len(m) > len(best[1])):
            best = (i, m, unmapped)
    return best


# --- context: credit type and year ---------------------------------------------------------------------
def credit_type_in(s: str) -> str | None:
    nine, four = bool(NINE.search(s or "")), bool(FOUR.search(s or ""))
    if nine and not four:
        return "9%"
    if four and not nine:
        return "4%"
    return None


def year_in(s: str) -> int | None:
    ys = {int(y) for y in YEAR.findall(s or "")}
    return ys.pop() if len(ys) == 1 else None  # two different years is ambiguous: leave unknown


# --- parse one sheet --------------------------------------------------------------------------------------------
def parse_sheet(name: str, rows: list[list], rules: dict, file_title: str) -> dict:
    found = find_header(rows, rules)
    if found is None:
        return {"sheet_name": name, "header_row": None, "column_map": {}, "unmapped": [], "rows": [],
                "note": "no award table found (no header row with a project name and 3 known columns)"}
    hi, m, unmapped = found
    headers = [text(c) or f"column {col_letter(i)}" for i, c in enumerate(rows[hi])]
    preamble = " ".join(text(c) for r in rows[:hi] for c in r if text(c))
    out, section = [], ""
    for ri in range(hi + 1, len(rows)):
        row = rows[ri]
        cells = [(i, c) for i, c in enumerate(row) if text(c)]
        if not cells:
            continue
        first = text(cells[0][1])
        if any(rx.search(first) for rx in rules["_total"]):
            continue
        name_idx = m.get("project_name", m.get("application_number"))
        pname = text(row[name_idx]) if name_idx is not None and name_idx < len(row) else ""
        if len(cells) == 1 and number(cells[0][1]) is None:
            section = first  # heading such as "9% Awards" or "Nonprofit Set-Aside"
            continue
        if not pname or pname.lower() == text(rows[hi][name_idx]).lower():
            continue  # no project on this line, or a repeated header
        get = lambda f: row[m[f]] if f in m and m[f] < len(row) else None  # noqa: E731
        rec = {"row_number": ri + 1, "section": section,
               "raw": {headers[i] if i < len(headers) else f"column {col_letter(i)}": text(c) for i, c in cells}}
        flags = []
        for f in TEXT_FIELDS:
            rec[f] = text(get(f)) or None
        for f in MONEY_FIELDS + INT_FIELDS:
            v = get(f)
            n = number(v)
            if n is None and text(v):
                flags.append(f"{f} is not a number: '{text(v)[:30]}'")
            if f in INT_FIELDS and n is not None:
                if not float(n).is_integer():
                    flags.append(f"{f} is not a whole number: {n}")
                    n = None
                else:
                    n = int(n)
            rec[f] = n

        ct, basis = None, "none"
        for src, val in (("column", text(get("credit_type"))), ("section", section), ("sheet name", name),
                         ("heading above table", preamble), ("file title", file_title)):
            ct = credit_type_in(val)
            if ct:
                basis = src
                break
        rec["credit_type"], rec["credit_type_basis"] = ct or "unknown", basis
        if not ct:
            flags.append("credit type (9% or 4%) not stated")

        yr, ybasis = None, "none"
        col_year = number(get("award_year"))
        if col_year and 2000 <= col_year <= 2035:
            yr, ybasis = int(col_year), "column"
        else:
            for src, val in (("column", text(get("award_year"))), ("award date", text(get("award_date"))),
                             ("section", section), ("sheet name", name), ("heading above table", preamble),
                             ("file title", file_title)):
                yr = year_in(val)
                if yr:
                    ybasis = src
                    break
        rec["award_year"], rec["award_year_basis"] = yr, ybasis
        if not yr:
            flags.append("award year not stated")

        if rec["credit_unlabeled"] is not None and rec["annual_credit"] is None:
            flags.append("credit column does not say annual or ten-year: needs verification")
        if all(rec[f] is None for f in MONEY_FIELDS):
            flags.append("no credit amount on this row")
        if rec["total_units"] is not None and rec["restricted_units"] is not None \
                and rec["restricted_units"] > rec["total_units"]:
            flags.append("restricted units exceed total units")
        if any(isinstance(n, (int, float)) and n < 0 for n in (rec[f] for f in MONEY_FIELDS + INT_FIELDS)):
            flags.append("negative number")
        rec["flags"] = flags
        out.append(rec)
    return {"sheet_name": name, "header_row": hi + 1, "unmapped": unmapped, "rows": out, "note": None,
            "column_map": {f: {"column": col_letter(i), "header": headers[i]} for f, i in m.items()}}


# --- database ---------------------------------------------------------------------------------------------------
def award_snapshots(conn, only: set[str] | None):
    for r in conn.execute(
            "SELECT s.*, src.doc_type, src.title, src.state FROM snapshot s JOIN source src USING(source_id) "
            "WHERE s.snapshot_id IN (SELECT MAX(snapshot_id) FROM snapshot GROUP BY source_id) ORDER BY s.source_id"):
        if only and r["source_id"] not in only:
            continue
        if r["doc_type"].startswith("award_list") and (r["content_type"] or "") in SHEET_TYPES:
            yield r


def store(conn, snap, parsed: dict, note: str | None) -> tuple[int, int]:
    flagged = sum(1 for r in parsed["rows"] if r["flags"])
    cur = conn.execute(
        "INSERT INTO award_sheet (snapshot_id, source_id, sheet_name, header_row, column_map, unmapped, rows_parsed,"
        " rows_flagged, note, parser_version, parsed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        (snap["snapshot_id"], snap["source_id"], parsed["sheet_name"], parsed["header_row"],
         json.dumps(parsed["column_map"]), json.dumps(parsed["unmapped"]), len(parsed["rows"]), flagged,
         "; ".join(x for x in (parsed["note"], note) if x) or None, PARSER_VERSION, archive.utcnow().isoformat()))
    sid = cur.lastrowid
    cols = ["application_number", "project_name", "sponsor", "address", "city", "county", "zip", "total_units",
            "restricted_units", "annual_credit", "ten_year_credit", "equity", "credit_requested", "credit_unlabeled",
            "credit_type", "credit_type_basis", "award_year", "award_year_basis", "award_date", "set_aside",
            "project_type", "status", "score"]
    for r in parsed["rows"]:
        conn.execute(
            f"INSERT INTO award_row (sheet_id, snapshot_id, source_id, state, sheet_name, row_number, section, "
            f"{', '.join(cols)}, raw_json, flags, doc_status) VALUES ({','.join('?' * (len(cols) + 10))})",
            (sid, snap["snapshot_id"], snap["source_id"], snap["state"], parsed["sheet_name"], r["row_number"],
             r["section"] or None, *[r[c] for c in cols], json.dumps(r["raw"], sort_keys=True),
             "; ".join(r["flags"]) or None, snap["doc_status"]))
    return len(parsed["rows"]), flagged


def run(db_path: Path, archive_root: Path, only: set[str] | None = None, force: bool = False,
        rules: dict | None = None, progress=print) -> dict:
    rules = rules or load_rules()
    conn = archive.connect(db_path)
    summary = {"files": 0, "sheets": 0, "rows": 0, "flagged": 0, "reused": 0, "errors": [], "no_table": []}
    for snap in list(award_snapshots(conn, only)):
        done = conn.execute("SELECT COUNT(*) FROM award_sheet WHERE snapshot_id=? AND parser_version=?",
                            (snap["snapshot_id"], PARSER_VERSION)).fetchone()[0]
        if done and not force:
            summary["reused"] += 1
            continue
        conn.execute("DELETE FROM award_row WHERE snapshot_id=?", (snap["snapshot_id"],))
        conn.execute("DELETE FROM award_sheet WHERE snapshot_id=?", (snap["snapshot_id"],))
        try:
            sheets = read_sheets((archive_root / snap["archive_path"]).read_bytes(), snap["content_type"])
        except Exception as e:  # a corrupt or password-protected workbook must not stop the others
            conn.rollback()
            summary["errors"].append(f"{snap['source_id']}: could not open ({type(e).__name__}: {str(e)[:120]})")
            continue
        summary["files"] += 1
        for name, rows, note in sheets:
            parsed = parse_sheet(name, rows, rules, snap["title"] or "")
            n, flagged = store(conn, snap, parsed, note)
            summary["sheets"] += 1
            summary["rows"] += n
            summary["flagged"] += flagged
            if parsed["header_row"] is None:
                summary["no_table"].append(f"{snap['source_id']} / {name}")
            progress(f"{snap['source_id']} / {name}: {n} rows, {flagged} flagged"
                     + ("" if parsed["header_row"] else " (no award table found)"))
        conn.commit()
    conn.close()
    return summary


EXPORT_COLS = ["source_id", "state", "award_year", "award_year_basis", "credit_type", "credit_type_basis", "project_name",
               "sponsor", "city", "county", "total_units", "restricted_units", "annual_credit", "ten_year_credit",
               "equity", "credit_requested", "credit_unlabeled", "set_aside", "status", "section", "sheet_name",
               "row_number", "flags", "doc_status", "source_url", "retrieved_at", "sha256"]


def export(db_path: Path, out_dir: Path) -> Path:
    conn = archive.connect(db_path)
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "award_rows.csv"
    with open(path, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=EXPORT_COLS)
        w.writeheader()
        for r in conn.execute("SELECT a.*, s.final_url AS source_url, s.retrieved_at, s.sha256 FROM award_row a "
                              "JOIN snapshot s USING(snapshot_id) ORDER BY a.source_id, a.sheet_name, a.row_number"):
            w.writerow({c: r[c] for c in EXPORT_COLS})
    conn.close()
    return path


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--only", nargs="*", help="source_ids")
    ap.add_argument("--force", action="store_true", help="re-parse files already parsed")
    ap.add_argument("--export", action="store_true", help="also write outputs/awards/award_rows.csv")
    ap.add_argument("--db", default=str(ROOT / "data" / "dl3.db"))
    ap.add_argument("--archive", default=str(ROOT / "archive"))
    a = ap.parse_args(argv)
    s = run(Path(a.db), Path(a.archive), only=set(a.only) if a.only else None, force=a.force)
    print(json.dumps(s, indent=2))
    if a.export:
        print("Wrote", export(Path(a.db), ROOT / "outputs" / "awards"))
    return 1 if s["errors"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
