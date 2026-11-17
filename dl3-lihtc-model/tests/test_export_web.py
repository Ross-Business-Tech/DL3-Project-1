import csv
import json

from src.awards import parse_awards as pa
from src.fetch import archive, fetch
from src.report import export_web
from tests.test_awards import add, xlsx

SET = fetch.load_settings()
WEBSITE_AWARD_COLUMNS = ("state,pathway,year,project,parent_project,city,total_units,new_construction,"
                         "age_restricted_or_assisted_living,credits_awarded,round_or_list,source_url,retrieved,notes")


def build(tmp_path):
    add(tmp_path, xlsx({"2025 9% Awards": [
        ["Project Name", "Developer", "City", "Total Units", "Annual Credit", "Construction Type", "Status"],
        ["Maple Court", "Acme", "Columbus", 120, 1450000, "New Construction", "Awarded"],
        ["Oak Homes", "Beta", "Dayton", 60, 900000, "Acquisition/Rehab", "Awarded"],
        ["Mixed", "Gamma", "Toledo", 80, 700000, "New Construction and Rehab", "Waitlist"]]}), title="Ohio 2025 awards")
    add(tmp_path, xlsx({"Sheet1": [["Project", "Sponsor", "Units", "Tax Credit Award"], ["Vague", "D", "n/a", 500000]]}),
        sid="OH_AWARDS_2", title="Award list")
    pa.run(tmp_path / "t.db", tmp_path / "a", progress=lambda m: None)
    conn = archive.connect(tmp_path / "t.db")
    q = {"source_id": "OH_QAP_CURRENT", "jurisdiction": "OHFA", "state": "OH", "doc_type": "qap_doc", "title": "Ohio QAP",
         "url": "https://ohiohome.org/qap.pdf", "status": "unknown", "critical": 1, "notes": ""}
    archive.upsert_source(conn, q)
    sid = archive.store_snapshot(conn, tmp_path / "a", source=q, data=b"%PDF-x", requested_url=q["url"], final_url=q["url"],
                                 content_type="application/pdf", http_status=200, retrieval_method="manual",
                                 retrieved_by="Private Person").snapshot_id
    archive.upsert_source(conn, {**q, "source_id": "OH_UW", "doc_type": "underwriting", "title": "UW"})
    archive.record_failure(conn, "OH_UW", "https://x", 4, "HTTP 403")
    now = archive.utcnow().isoformat()
    conn.execute("INSERT INTO llm_call (snapshot_id, topic, prompt_version, model_requested, pages_sent, created_at) "
                 "VALUES (?,?,?,?,?,?)", (sid, "fee_rule", "v", "m", "all", now))
    def ext(field, value, status, **kw):
        conn.execute("INSERT INTO extraction (call_id, snapshot_id, source_id, topic, field, value, page, quote, doc_status, "
                     "quote_verified, value_in_quote, status, reviewer, reviewed_at, reviewer_value, created_at) "
                     "VALUES (1,?,?,?,?,?,?,?,?,1,1,?,?,?,?,?)",
                     (sid, "OH_QAP_CURRENT", "fee_rule", field, value, 12, "the quote", "unknown", status,
                      kw.get("reviewer"), kw.get("reviewed_at"), kw.get("reviewer_value"), now))
    ext("developer_fee_max_percent", "15 %", "approved", reviewer="Private Person", reviewed_at=now, reviewer_value="15%")
    ext("developer_fee_basis", "eligible basis", "pending_review")
    ext("deferred_fee_max", "x", "rejected_validation")
    ext("other_fee_rule", "y", "rejected_by_reviewer", reviewer="Private Person")
    conn.commit()
    conn.close()
    return export_web.export(tmp_path / "t.db", tmp_path / "web", SET)


def read(tmp_path, name):
    return list(csv.DictReader(open(tmp_path / "web" / name)))


def test_awards_match_the_website_layout(tmp_path):
    m = build(tmp_path)
    assert (tmp_path / "web" / "awards.csv").read_text().splitlines()[0] == WEBSITE_AWARD_COLUMNS
    rows = {r["project"]: r for r in read(tmp_path, "awards.csv")}
    a = rows["Maple Court"]
    assert (a["state"], a["pathway"], a["year"], a["city"], a["total_units"], a["credits_awarded"]) == \
        ("OH", "9%", "2025", "Columbus", "120", "1450000")
    assert a["new_construction"] == "yes" and rows["Oak Homes"]["new_construction"] == "no"
    assert rows["Mixed"]["new_construction"] == "UNKNOWN" and "status as printed: Waitlist" in rows["Mixed"]["notes"]
    assert a["source_url"] == "https://ohiohome.org/a.xlsx" and "sheet '2025 9% Awards' row 2" in a["notes"]
    v = rows["Vague"]
    assert (v["pathway"], v["year"], v["total_units"], v["credits_awarded"]) == ("UNKNOWN",) * 4
    assert "not used as credits_awarded" in v["notes"] and "CHECK:" in v["notes"]
    assert m["counts"]["awards"] == 4


def test_rules_only_approved_or_clearly_unreviewed(tmp_path):
    build(tmp_path)
    rules = {r["field"]: r for r in read(tmp_path, "rules.csv")}
    assert set(rules) == {"developer_fee_max_percent", "developer_fee_basis"}   # rejected ones never exported
    ok = rules["developer_fee_max_percent"]
    assert ok["review_state"] == "approved" and ok["value"] == "15%" and ok["value_as_extracted"] == "15 %"
    assert ok["page"] == "12" and ok["quote"] == "the quote" and len(ok["sha256"]) == 64
    assert rules["developer_fee_basis"]["review_state"].startswith("not reviewed")


def test_sources_and_manifest_and_no_names(tmp_path):
    m = build(tmp_path)
    src = {r["source_id"]: r for r in read(tmp_path, "sources.csv")}
    assert src["OH_QAP_CURRENT"]["retrieval_method"] == "manual" and src["OH_QAP_CURRENT"]["stale"] == "no"
    assert src["OH_UW"]["last_retrieved"] == "" and src["OH_UW"]["blocks_recommendation"] == "yes"
    assert src["OH_UW"]["last_error"] == "HTTP 403"
    man = json.loads((tmp_path / "web" / "manifest.json").read_text())
    assert man["counts"] == m["counts"] and man["rules_approved"] == 1
    for f in (tmp_path / "web").iterdir():
        assert "Private Person" not in f.read_text()   # reviewer / importer names never leave the database
