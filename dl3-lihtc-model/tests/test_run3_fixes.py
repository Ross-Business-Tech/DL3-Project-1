"""Fixes from the run log of 2026-11-15 19:32 (Michigan picks, Ohio columns, Census key, PDF award rows)."""
import csv
import json

import pytest

from src.awards import parse_awards as pa
from src.fetch import archive, fetch
from src.inventory import build, crawl
from src.report import coverage, export_web
from tests.test_awards import add, xlsx
from tests.test_fetch import SETTINGS, Site, go, reg

OHIO = {"Results": [["Project Name", "City", "County", "Lead Developer", "Total Units", "Credits Reserved"],
                    ["65 Nickel", "Columbus", "Franklin", "Acme", 43, 1031957]]}


def test_award_export_has_latest_snapshot_only(tmp_path):
    add(tmp_path, xlsx(OHIO))
    pa.run(tmp_path / "t.db", tmp_path / "a", progress=lambda m: None)
    add(tmp_path, xlsx(OHIO))                                   # same file fetched again: new snapshot row
    pa.run(tmp_path / "t.db", tmp_path / "a", progress=lambda m: None)
    rows = list(csv.DictReader(open(pa.export(tmp_path / "t.db", tmp_path / "out"))))
    assert len(rows) == 1


def test_unconfirmed_ohio_header_flagged_confirmed_header_annual(tmp_path):
    add(tmp_path, xlsx(OHIO))
    pa.run(tmp_path / "t.db", tmp_path / "a", progress=lambda m: None)
    conn = archive.connect(tmp_path / "t.db")
    r = conn.execute("SELECT * FROM award_row").fetchone()
    assert r["annual_credit"] is None and r["credit_unlabeled"] == 1031957 and "does not say annual" in r["flags"]
    rules = pa.load_rules()
    rules["confirmed_headers"] = {"OH": {"Credits  Reserved": {"field": "annual_credit", "source": "https://x p.12"}}}
    pa.run(tmp_path / "t.db", tmp_path / "a", force=True, rules=rules, progress=lambda m: None)
    r = conn.execute("SELECT * FROM award_row").fetchone()
    assert r["annual_credit"] == 1031957 and r["credit_unlabeled"] is None and "annual" not in (r["flags"] or "")
    rules["confirmed_headers"] = {"MI": {"Credits Reserved": {"field": "annual_credit", "source": "x"}}}
    pa.run(tmp_path / "t.db", tmp_path / "a", force=True, rules=rules, progress=lambda m: None)
    assert conn.execute("SELECT annual_credit FROM award_row").fetchone()[0] is None   # other states unaffected


def test_sheet_without_credit_column_noted_rows_not_flagged(tmp_path):
    add(tmp_path, xlsx({"BGF Results": [["Project Name", "City", "Lead Developer", "Total Units", "Funding Result"],
                                        ["Gap Deal", "Akron", "X", 60, "Funded"]]}), title="2022 4% BGF results")
    pa.run(tmp_path / "t.db", tmp_path / "a", progress=lambda m: None)
    conn = archive.connect(tmp_path / "t.db")
    assert "no tax credit column" in conn.execute("SELECT note FROM award_sheet").fetchone()[0]
    assert "no credit amount" not in (conn.execute("SELECT flags FROM award_row").fetchone()[0] or "")


def test_census_key_added_to_request_only(monkeypatch, tmp_path):
    monkeypatch.setenv("CENSUS_API_KEY", "abc123secretkey")
    u = "https://api.census.gov/data/2024/acs/acs5?get=NAME,B01003_001E&for=x:*"
    assert fetch.with_api_key(u) == u + "&key=abc123secretkey"
    assert fetch.with_api_key("https://ohiohome.org/x?a=1") == "https://ohiohome.org/x?a=1"
    assert fetch.without_api_key(u + "&key=abc123secretkey") == u
    assert fetch.without_api_key("https://api.census.gov/d?key=abc123secretkey&get=NAME") == "https://api.census.gov/d?get=NAME"
    assert "abc123secretkey" not in fetch.without_api_key("boom for url https://x/?q=1&key=abc123secretkey: timeout")
    site = Site()
    seen = {}
    try:
        def handler(headers):
            return (200, "application/json", b"[]")
        site.routes["/census?get=NAME"] = (500, "text/plain", b"wrong")
        monkeypatch.setitem(fetch.API_KEYS, "127.0.0.1", "CENSUS_API_KEY")
        site.routes["/census?get=NAME&key=abc123secretkey"] = (200, "application/json", b"[]")
        monkeypatch.setitem(SETTINGS["fetch"], "allowed_content_types",
                            SETTINGS["fetch"]["allowed_content_types"] + ["application/json"])
        s = go(site, tmp_path, reg(site, path="/census?get=NAME"))
        assert s.fetched == 1, s.details
        snap = archive.latest_snapshot(archive.connect(tmp_path / "t.db"), "T1")
        assert "abc123secretkey" not in snap["final_url"] and "abc123secretkey" not in snap["url"]
    finally:
        site.srv.shutdown()


def test_census_missing_key_message_says_what_to_do():
    from src.reference import msa
    with pytest.raises(ValueError, match="CENSUS_API_KEY"):
        msa.parse(b"<html><body>Missing Key. A valid key must be included with each data API request.</body></html>")


def cand(url, text, cat, kind="document", years=""):
    return {"category": cat, "url": url, "link_text": text, "kind": kind, "file_format": "pdf",
            "found_on_url": "https://m/qap", "found_on_sha256": "x", "score": 4, "years": years,
            "draft_marker": 0, "offsite": 0, "depth": 1, "retrieved_at": "t", "run_id": "r", "jurisdiction_id": "MI"}


def test_governor_approval_letter_is_not_the_current_qap():
    base = "https://www.michigan.gov/mshda/-/media/x/liqap/"
    cs = [cand(base + "mshda_li_qap_2026_2027_governor_approval.pdf", "2026-2027 QAP Governor Approval", "qap", years="2026,2027"),
          cand(base + "mshda_li_qap_2026_2027_qap_final.pdf", "2026-2027 Qualified Allocation Plan", "qap", years="2026,2027")]
    js = [{"jurisdiction_id": "MI", "state": "MI", "jurisdiction_type": "state", "in_50_state_scope": "yes",
           "allocating_agency": "MSHDA", "agency_url": "https://www.michigan.gov/mshda", "suballocator_of": "",
           "bond_issuer_note": "", "notes": ""}]
    st = {"MI": {"pages_fetched": 30, "errors": 0, "first_error": None, "finished_at": "t", "run_id": "r"}}
    r = build.build_rows(js, [], st, {"MI": cs}, [])[0]
    assert r["qap_current_nondraft_url"].endswith("qap_final.pdf")
    assert r["qap_document_urls"].startswith(base + "mshda_li_qap_2026_2027_qap_final.pdf")


def test_award_list_excludes_policies_and_criteria():
    rules = crawl.load_rules()
    ctx = "Low Income Housing Tax Credit"
    def is_award(text, url):
        return "award_list" in {c["category"] for c in crawl.classify(text, url, ctx, rules)}
    assert not is_award("Tab TT - Communities Without Recent Awards (PDF)", "https://m/lica/tab_tt.pdf")
    assert not is_award("LIHTC Compliance Policy #4", "https://m/compliance/policy4.pdf")
    assert not is_award("Award Criteria", "https://m/criteria.pdf")
    assert is_award("2025 LIHTC Awards", "https://m/2025-awards.pdf")


def add_pdf_award(tmp_path, sid, title, rowj, status="pending_review", url="https://m/mshda_li_sr_2025_apr1_lihtc_res.pdf"):
    conn = archive.connect(tmp_path / "t.db")
    src = {"source_id": sid, "jurisdiction": "MSHDA", "state": "MI", "doc_type": "award_list", "title": title, "url": url,
           "status": "unknown", "critical": 0, "notes": ""}
    archive.upsert_source(conn, src)
    snap = archive.store_snapshot(conn, tmp_path / "a", source=src, data=sid.encode(), requested_url=url, final_url=url,
                                  content_type="application/pdf", http_status=200).snapshot_id
    now = archive.utcnow().isoformat()
    conn.execute("INSERT INTO llm_call (snapshot_id, topic, prompt_version, model_requested, pages_sent, created_at) "
                 "VALUES (?,?,?,?,?,?)", (snap, "award_table", "v", "m", "all", now))
    cid = conn.execute("SELECT MAX(call_id) FROM llm_call").fetchone()[0]
    conn.execute("INSERT INTO extraction (call_id, snapshot_id, source_id, topic, field, value, page, quote, row_json, "
                 "quote_verified, value_in_quote, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,1,1,?,?)",
                 (cid, snap, sid, "award_table", "award_row", rowj.get("annual_credit_amount"), 2, "Maple Court ...",
                  json.dumps(rowj), status, now))
    conn.commit()
    conn.close()


ROW = {"project_name": "Maple Court", "sponsor": "Acme", "city": "Detroit", "total_units": "120",
       "annual_credit_amount": "$1,450,000", "credit_type": "unknown", "award_round_or_date": "April 1, 2025",
       "status": "Reserved", "set_aside": "Open - Urban", "total_development_cost": "", "notes": ""}


def test_pdf_award_rows_reach_export_and_coverage(tmp_path):
    add_pdf_award(tmp_path, "MI_AWARDS_1", "MI award list: 2025 April 1 LIHTC reservations", ROW)
    add_pdf_award(tmp_path, "MI_AWARDS_2", "MI award list: 9% reservations", {**ROW, "project_name": "Oak",
                  "award_round_or_date": "", "credit_type": "9%"}, status="approved", url="https://m/res_2024.pdf")
    m = export_web.export(tmp_path / "t.db", tmp_path / "web", fetch.load_settings(), reference_dir=tmp_path / "x")
    assert m["counts"]["awards"] == 1 and m["counts"]["awards_pending_review"] == 1
    ok = list(csv.DictReader(open(tmp_path / "web" / "awards.csv")))[0]
    assert (ok["project"], ok["pathway"], ok["year"], ok["credits_awarded"], ok["total_units"]) == \
        ("Oak", "9%", "2024", "1450000", "120")
    assert "year from file name" in ok["notes"] and "pathway from row" in ok["notes"]
    pend = list(csv.DictReader(open(tmp_path / "web" / "awards_pending_review.csv")))[0]
    assert (pend["pathway"], pend["year"]) == ("UNKNOWN", "2025") and "not reviewed" in pend["notes"]
    _, res = coverage.run(["MI"], tmp_path / "t.db", tmp_path / "cov", fetch.load_settings())
    it = {i["item"]: i for i in res[0]["items"]}
    assert it["awards 2024"]["ok"] == "yes" and "PDF: 1 approved" in it["awards 2024"]["value"]
    assert it["awards 2025"]["ok"] == "no" and it["awards 2025"]["detail"] == "PDF rows waiting for review"


def test_years_in_underscored_file_names():
    from src.inventory.crawl import plan_years, years_in
    assert pa.year_in("mshda_li_sr_2025_apr1_lihtc_res.pdf") == 2025
    assert plan_years("mshda_li_qap_2026_2027_qap_final.pdf") == [2026, 2027]
    assert years_in("res_2024.pdf") == [2024] and years_in("form 120245") == []
