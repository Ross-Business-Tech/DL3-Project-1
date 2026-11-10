import io
import json

import pytest
from openpyxl import Workbook

from src.awards import parse_awards as pa
from src.fetch import archive

XLSX = pa.XLSX


def xlsx(sheets: dict) -> bytes:
    wb = Workbook()
    wb.remove(wb.active)
    for name, rows in sheets.items():
        ws = wb.create_sheet(name)
        for r in rows:
            ws.append(r)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def add(tmp_path, data, ctype=XLSX, sid="OH_AWARDS_1", title="Ohio award list", doc_type="award_list"):
    conn = archive.connect(tmp_path / "t.db")
    src = {"source_id": sid, "jurisdiction": "OHFA", "state": "OH", "doc_type": doc_type, "title": title,
           "url": "https://ohiohome.org/a.xlsx", "status": "unknown", "critical": 0, "notes": ""}
    archive.upsert_source(conn, src)
    archive.store_snapshot(conn, tmp_path / "a", source=src, data=data, requested_url=src["url"],
                           final_url=src["url"], content_type=ctype, http_status=200)
    conn.close()


def rows(tmp_path):
    conn = archive.connect(tmp_path / "t.db")
    return [dict(r) for r in conn.execute("SELECT * FROM award_row ORDER BY award_row_id")]


def go(tmp_path, **kw):
    return pa.run(tmp_path / "t.db", tmp_path / "a", progress=lambda m: None, **kw)


TYPICAL = {"2026 9% Reservations": [
    ["Ohio Housing Finance Agency"], ["2026 9% LIHTC Reservations"], [],
    ["Project Name", "Developer", "City", "County", "Total Units", "LIHTC Units", "Annual Credit Amount", "Developer Fee", "Pool"],
    ["New Affordability"],
    ["Maple Court", "Acme Housing LLC", "Columbus", "Franklin", 120, 110, 1450000, 2000000, "Urban"],
    ["Oak Homes", "Beta Dev", "Dayton", "Montgomery", "60", "54", "$900,000", 900000, "Urban"],
    ["Service Enriched Housing"],
    ["Pine Place", "Gamma", "Toledo", "Lucas", 45, 45, 700000.0, 500000, "PSH"],
    [],
    ["Total", None, None, None, 225, 209, 3050000],
]}


def test_typical_sheet(tmp_path):
    add(tmp_path, xlsx(TYPICAL))
    s = go(tmp_path)
    assert (s["files"], s["sheets"], s["rows"], s["flagged"], s["errors"]) == (1, 1, 3, 0, [])
    r = rows(tmp_path)
    assert [x["project_name"] for x in r] == ["Maple Court", "Oak Homes", "Pine Place"]  # no Total, no headings
    m = r[0]
    assert (m["sponsor"], m["city"], m["county"], m["total_units"], m["restricted_units"]) == \
        ("Acme Housing LLC", "Columbus", "Franklin", 120, 110)
    assert m["annual_credit"] == 1450000 and m["ten_year_credit"] is None and m["credit_unlabeled"] is None
    assert r[1]["annual_credit"] == 900000 and r[1]["total_units"] == 60  # "$900,000" and "60" as text
    assert (m["credit_type"], m["credit_type_basis"], m["award_year"], m["award_year_basis"]) == \
        ("9%", "sheet name", 2026, "sheet name")
    assert (m["section"], r[2]["section"], m["set_aside"]) == ("New Affordability", "Service Enriched Housing", "Urban")
    assert (m["sheet_name"], m["row_number"], m["state"]) == ("2026 9% Reservations", 6, "OH")  # the citation
    raw = json.loads(m["raw_json"])
    assert raw["Developer Fee"] == "2000000" and raw["Annual Credit Amount"] == "1450000"
    conn = archive.connect(tmp_path / "t.db")
    sh = conn.execute("SELECT * FROM award_sheet").fetchone()
    cmap = json.loads(sh["column_map"])
    assert sh["header_row"] == 4 and cmap["annual_credit"] == {"column": "G", "header": "Annual Credit Amount"}
    assert cmap["sponsor"]["header"] == "Developer" and "Developer Fee" in json.loads(sh["unmapped"])


def test_annual_ten_year_equity_kept_apart_and_unlabeled_flagged(tmp_path):
    add(tmp_path, xlsx({"Awards": [
        ["Development Name", "Applicant", "Units", "Annual LIHTC", "10-Year Credit Total", "Equity Proceeds"],
        ["A", "X", 100, 1000000, 10000000, 8800000]]}), sid="A1", title="2025 9% awards")
    add(tmp_path, xlsx({"Awards": [["Project", "Sponsor", "Units", "Tax Credit Award"], ["B", "Y", 100, 1200000]]}),
        sid="A2", title="2025 9% awards")
    go(tmp_path)
    a, b = rows(tmp_path)
    assert (a["annual_credit"], a["ten_year_credit"], a["equity"]) == (1000000, 10000000, 8800000) and a["flags"] is None
    assert b["annual_credit"] is None and b["credit_unlabeled"] == 1200000
    assert "does not say annual or ten-year" in b["flags"]
    assert (b["credit_type"], b["credit_type_basis"], b["award_year"]) == ("9%", "file title", 2025)


def test_requested_is_not_awarded(tmp_path):
    add(tmp_path, xlsx({"Apps": [["Project Name", "Sponsor", "Annual Credits Requested", "Status"],
                                 ["C", "Z", 800000, "Not funded"]]}))
    go(tmp_path)
    r = rows(tmp_path)[0]
    assert r["credit_requested"] == 800000 and r["annual_credit"] is None and r["status"] == "Not funded"


def test_unknown_stays_unknown_and_is_flagged(tmp_path):
    add(tmp_path, xlsx({"Sheet1": [["Project Name", "Sponsor", "Units", "Annual Credit"],
                                   ["D", "W", 80, 500000],
                                   ["E", "V", "TBD", "pending"]]}), title="Award list")
    go(tmp_path)
    d, e = rows(tmp_path)
    assert d["credit_type"] == "unknown" and d["award_year"] is None
    assert "credit type (9% or 4%) not stated" in d["flags"] and "award year not stated" in d["flags"]
    assert e["total_units"] is None and "total_units is not a number: 'TBD'" in e["flags"]
    assert "no credit amount on this row" in e["flags"]


def test_ambiguous_year_and_mixed_credit_type_not_guessed(tmp_path):
    add(tmp_path, xlsx({"All": [["Project Name", "Sponsor", "Credit Type", "Year", "Annual Credit"],
                                ["F", "U", "4% bond", 2024, 300000],
                                ["G", "T", "9% competitive", 2025, 900000],
                                ["H", "S", "", "", 100000]]}), title="2021-2025 awards, 9% and 4%")
    go(tmp_path)
    f, g, h = rows(tmp_path)
    assert (f["credit_type"], f["credit_type_basis"], f["award_year"], f["award_year_basis"]) == ("4%", "column", 2024, "column")
    assert (g["credit_type"], g["award_year"]) == ("9%", 2025)
    assert h["credit_type"] == "unknown" and h["award_year"] is None  # title names both: not guessed


def test_section_heading_sets_credit_type(tmp_path):
    add(tmp_path, xlsx({"Awards": [["Project Name", "Sponsor", "Annual Credit"], ["9% Awards"], ["I", "R", 1],
                                   ["4% Awards"], ["J", "Q", 2]]}), title="2025 awards")
    go(tmp_path)
    i, j = rows(tmp_path)
    assert (i["credit_type"], i["credit_type_basis"], j["credit_type"]) == ("9%", "section", "4%")


def test_sanity_flags(tmp_path):
    add(tmp_path, xlsx({"2025 9%": [["Project Name", "Sponsor", "Total Units", "LIHTC Units", "Annual Credit"],
                                    ["K", "P", 50, 60, -5], ["L", "O", 10.5, 10, 1]]}))
    go(tmp_path)
    k, l = rows(tmp_path)
    assert "restricted units exceed total units" in k["flags"] and "negative number" in k["flags"]
    assert l["total_units"] is None and "not a whole number" in l["flags"]


def test_multiple_sheets_and_sheet_without_table(tmp_path):
    add(tmp_path, xlsx({"Instructions": [["This workbook lists awards."], ["Contact the agency with questions."]],
                        "2024 9%": [["Project Name", "Sponsor", "Annual Credit"], ["M", "N", 5]],
                        "2023 4%": [["Project Name", "Sponsor", "Annual Credit"], ["N", "M", 6]]}))
    s = go(tmp_path)
    assert s["sheets"] == 3 and s["rows"] == 2 and s["no_table"] == ["OH_AWARDS_1 / Instructions"]
    assert [(r["award_year"], r["credit_type"]) for r in rows(tmp_path)] == [(2024, "9%"), (2023, "4%")]


def test_csv_and_old_xls(tmp_path):
    add(tmp_path, b"\xef\xbb\xbfProject Name,Sponsor,Total Units,Annual Credit\nCsv One,S,40,\"$400,000\"\nTotal,,40,400000\n",
        ctype="text/csv", sid="C1", title="2025 9% awards")
    xlwt = pytest.importorskip("xlwt")
    pytest.importorskip("xlrd")
    wb = xlwt.Workbook()
    ws = wb.add_sheet("2022 9%")
    for i, row in enumerate([["Project Name", "Sponsor", "Total Units", "Annual Credit"], ["Xls One", "S", 30, 250000]]):
        for j, v in enumerate(row):
            ws.write(i, j, v)
    buf = io.BytesIO()
    wb.save(buf)
    add(tmp_path, buf.getvalue(), ctype=pa.XLS, sid="X1")
    go(tmp_path)
    c, x = rows(tmp_path)
    assert (c["project_name"], c["annual_credit"], c["total_units"], c["award_year"]) == ("Csv One", 400000, 40, 2025)
    assert (x["project_name"], x["annual_credit"], x["total_units"], x["award_year"]) == ("Xls One", 250000, 30, 2022)


def test_rerun_reuses_force_reparses_new_version_parsed(tmp_path):
    add(tmp_path, xlsx(TYPICAL))
    go(tmp_path)
    assert go(tmp_path)["reused"] == 1 and len(rows(tmp_path)) == 3
    go(tmp_path, force=True)
    assert len(rows(tmp_path)) == 3  # replaced, not duplicated
    t2 = {"2026 9% Reservations": TYPICAL["2026 9% Reservations"][:6]}
    add(tmp_path, xlsx(t2))
    go(tmp_path)
    conn = archive.connect(tmp_path / "t.db")
    latest = archive.latest_snapshot(conn, "OH_AWARDS_1")["snapshot_id"]
    assert conn.execute("SELECT COUNT(*) FROM award_row WHERE snapshot_id=?", (latest,)).fetchone()[0] == 1


def test_corrupt_file_reported_others_continue_and_pdfs_ignored(tmp_path):
    add(tmp_path, b"PK\x03\x04not really a workbook", sid="BAD")
    add(tmp_path, xlsx(TYPICAL), sid="GOOD")
    add(tmp_path, b"%PDF-1.4 x", ctype="application/pdf", sid="PDF1")
    add(tmp_path, xlsx(TYPICAL), sid="NOTAWARD", doc_type="qap_doc")
    s = go(tmp_path)
    assert s["files"] == 1 and s["rows"] == 3 and len(s["errors"]) == 1 and s["errors"][0].startswith("BAD: could not open")


def test_export_has_citation_and_source(tmp_path):
    import csv
    add(tmp_path, xlsx(TYPICAL))
    go(tmp_path)
    path = pa.export(tmp_path / "t.db", tmp_path / "out")
    r = list(csv.DictReader(open(path)))[0]
    assert r["sheet_name"] == "2026 9% Reservations" and r["row_number"] == "6" and len(r["sha256"]) == 64
    assert r["source_url"] == "https://ohiohome.org/a.xlsx"


def test_number_and_helpers():
    assert pa.number("$1,450,000") == 1450000 and pa.number("(500)") == -500 and pa.number("N/A") is None
    assert pa.number(True) is None and pa.number(" 12.5 ") == 12.5
    assert pa.col_letter(0) == "A" and pa.col_letter(27) == "AB"
    assert pa.credit_type_in("2026 9% round") == "9%" and pa.credit_type_in("9% and 4%") is None
    assert pa.credit_type_in("at 49% AMI") is None and pa.credit_type_in("4 percent bond") == "4%"
    assert pa.year_in("2025 awards") == 2025 and pa.year_in("2021-2025") is None


def test_run_all_awards_flag(tmp_path):
    import csv

    import run_all
    from tests.test_fetch import SETTINGS, Site
    from src.fetch import fetch
    site = Site()
    site.routes["/awards.xlsx"] = (200, XLSX, xlsx(TYPICAL))
    reg = tmp_path / "reg.csv"
    with open(reg, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow("source_id,jurisdiction,state,doc_type,title,url,status,critical,notes".split(","))
        w.writerow(["OH_AWARDS_1", "OHFA", "OH", "award_list", "Ohio awards", site.base + "/awards.xlsx", "unknown", "false", ""])
    settings = {"fetch": {**SETTINGS["fetch"], "allowed_content_types": [XLSX]}}
    try:
        out = run_all.run_pipeline(register_path=reg, db_path=tmp_path / "t.db", archive_root=tmp_path / "a",
                                   out_root=tmp_path / "out", refresh_hud=False, awards=True,
                                   fetcher=fetch.Fetcher(settings, {"127.0.0.1"}, sleep=lambda s: None))
    finally:
        site.srv.shutdown()
    m = json.loads((out / "run_manifest.json").read_text())
    assert m["awards"]["rows"] == 3 and m["awards"]["errors"] == []
