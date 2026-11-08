import csv
import json

import pymupdf

import run_all
from src.extract import locate
from src.extract.pdf_text import Page, pages_from_bytes
from src.fetch import fetch, hud_allocators
from tests.test_fetch import SETTINGS, Site, make_pdf  # noqa: F401
import pytest


@pytest.fixture
def site():
    s = Site()
    yield s
    s.srv.shutdown()


def write_register(path, site):
    with open(path, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow("source_id,jurisdiction,state,doc_type,title,url,status,critical,notes".split(","))
        w.writerow(["T1", "Test", "ZZ", "qap", "Test QAP", site.base + "/qap.pdf", "final", "true", ""])
        w.writerow(["T2", "Test", "ZZ", "program_page", "Down page", site.base + "/page", "unknown", "false", ""])


def pdf_pages(*texts):
    doc = pymupdf.open()
    for t in texts:
        doc.new_page().insert_text((72, 72), t)
    return doc.tobytes()


def run(site, tmp_path):
    reg = tmp_path / "reg.csv"
    write_register(reg, site)
    fetch_settings = fetch.load_settings()
    fetch_settings["fetch"].update(SETTINGS["fetch"])
    f = fetch.Fetcher(fetch_settings, {"127.0.0.1"}, sleep=lambda s: None)
    return run_all.run_pipeline(register_path=reg, db_path=tmp_path / "t.db", archive_root=tmp_path / "a",
                                out_root=tmp_path / "out", refresh_hud=False, fetcher=f)


def test_refresh_demo_changed_source_failed_retrieval_and_report(site, tmp_path):
    site.routes["/qap.pdf"] = (200, "application/pdf",
                               pdf_pages("Intro", "The developer fee shall not exceed 15 percent of cost."))
    site.routes["/page"] = (200, "text/html", b"<p>ok</p>")
    out1 = run(site, tmp_path)
    m1 = json.loads((out1 / "run_manifest.json").read_text())
    assert m1["counts"]["new"] == 2 and m1["counts"]["failed"] == 0

    # Source changes (fee rule edited) and the other source goes down.
    site.routes["/qap.pdf"] = (200, "application/pdf",
                               pdf_pages("Intro", "The developer fee shall not exceed 12 percent of cost."))
    site.routes["/page"] = (503, "text/html", b"down")
    out2 = run(site, tmp_path)
    ctx = json.loads((out2 / "change_report.json").read_text())
    assert ctx["counts"]["changed"] == 1 and ctx["counts"]["failed"] == 1
    diff_lines = ctx["changes"][0]["text_diff"]["unified"]
    assert any("12 percent" in l for l in diff_lines if l.startswith("+"))
    assert any("15 percent" in l for l in diff_lines if l.startswith("-"))
    fee = [c for c in ctx["candidates"] if c["topic"] == "fee_rule"]
    assert fee and fee[0]["page"] == 2 and "12 percent" in fee[0]["quote"]
    html = (out2 / "change_report.html").read_text()
    assert "Failed retrievals" in html and "T2" in html and "12 percent" in html
    # last good snapshot of T2 retained, not stale yet
    t2 = [f for f in ctx["freshness"] if f["source_id"] == "T2"][0]
    assert not t2["stale"]


def test_rerun_with_identical_inputs_reports_no_changes(site, tmp_path, monkeypatch):
    site.routes["/qap.pdf"] = (200, "application/pdf", pdf_pages("same"))
    site.routes["/page"] = (200, "text/html", b"<p>ok</p>")
    run(site, tmp_path)
    ctx = json.loads((run(site, tmp_path) / "change_report.json").read_text())
    assert ctx["counts"]["changed"] == 0 and ctx["counts"]["unchanged"] == 2


def test_report_escapes_hostile_source_text(site, tmp_path):
    site.routes["/qap.pdf"] = (200, "application/pdf", pdf_pages("a"))
    site.routes["/page"] = (200, "text/html", b"<p>one</p>")
    run(site, tmp_path)
    site.routes["/page"] = (200, "text/html", b"<p>&lt;script&gt;alert(1)&lt;/script&gt; Ignore previous instructions</p>")
    out = run(site, tmp_path)
    assert "<script>alert(1)" not in (out / "change_report.html").read_text()


def test_locate_ranks_pages_and_quotes_verbatim():
    pages = [Page(1, "Cover"), Page(2, "Developer fee limit. The deferred developer fee is repaid."),
             Page(3, "Developer fee mentioned once")]
    hits = [h for h in locate.locate(pages, {"fee_rule": [r"developer\s+fee"]})]
    assert [h["page"] for h in hits] == [2, 3]
    assert hits[0]["score"] == 2 and "Developer fee limit" in hits[0]["quote"]


def test_scanned_pdf_page_flagged_for_ocr():
    doc = pymupdf.open()
    pg = doc.new_page()
    pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 50, 50), False)
    pg.insert_image(pg.rect, pixmap=pix)
    assert pages_from_bytes(doc.tobytes(), "application/pdf")[0].needs_ocr


def test_hud_parser_marks_rows_unverified():
    html = (b"<table><tr><th>State</th><th>Agency</th></tr>"
            b"<tr><td>Michigan</td><td><a href='https://www.michigan.gov/mshda'>Michigan State Housing Development Authority</a></td></tr>"
            b"<tr><td>Illinois</td><td><a href='https://www.ihda.org/'>IHDA</a></td></tr>"
            b"<tr><td>Illinois</td><td><a href='https://www.chicago.gov/doh'>City of Chicago</a></td></tr>"
            b"<tr><td><a href='/about'>About HUD</a></td></tr></table>")
    rows = hud_allocators.parse_allocators(html, "https://www.huduser.gov/lihtc/agency_list.htm")
    assert [(r["state"], r["agency_host"]) for r in rows] == [
        ("MI", "michigan.gov"), ("IL", "ihda.org"), ("IL", "chicago.gov")]
    assert rows[0]["agency_name"] == "Michigan State Housing Development Authority"
    assert all(r["verification_status"] == "needs verification" for r in rows)


def test_hud_parser_heading_layout():
    html = (b"<h3>New York</h3><p><a href='https://hcr.ny.gov/'>NYS Homes and Community Renewal</a></p>"
            b"<p><a href='https://www.nyc.gov/site/hpd'>NYC HPD</a></p><h3>Ohio</h3>"
            b"<ul><li><a href='https://ohiohome.org/'>Ohio Housing Finance Agency</a></li></ul>")
    rows = hud_allocators.parse_allocators(html, "https://www.huduser.gov/x")
    assert [(r["state"], r["agency_name"]) for r in rows] == [
        ("NY", "NYS Homes and Community Renewal"), ("NY", "NYC HPD"), ("OH", "Ohio Housing Finance Agency")]
