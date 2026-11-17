import json

from src.fetch import archive, fetch
from src.report import coverage

SET = fetch.load_settings()


def setup(tmp_path):
    conn = archive.connect(tmp_path / "t.db")
    def src(sid, doc_type, status="unknown", snap=True):
        s = {"source_id": sid, "jurisdiction": "MSHDA", "state": "MI", "doc_type": doc_type, "title": sid,
             "url": "https://m/" + sid, "status": status, "critical": 1, "notes": ""}
        archive.upsert_source(conn, s)
        if snap:
            return archive.store_snapshot(conn, tmp_path / "a", source=s, data=sid.encode(), requested_url=s["url"],
                                          final_url=s["url"], content_type="application/pdf", http_status=200).snapshot_id
    q = src("MI_QAP_CURRENT", "qap_doc")
    src("MI_QAP_NEWEST", "qap_doc", status="draft")
    src("MI_UW", "underwriting", snap=False)
    aw = src("MI_AWARDS_1", "award_list")
    src("MIX_OTHER", "qap_doc")  # different jurisdiction prefix: must not count for MI
    now = archive.utcnow().isoformat()
    conn.execute("INSERT INTO llm_call (snapshot_id, topic, prompt_version, model_requested, pages_sent, created_at) "
                 "VALUES (?,?,?,?,?,?)", (q, "fee_rule", "v", "m", "all", now))
    conn.execute("INSERT INTO llm_call (snapshot_id, topic, prompt_version, model_requested, pages_sent, created_at) "
                 "VALUES (?,?,?,?,?,?)", (q, "deadlines", "v", "m", "all", now))
    for status in ("approved", "pending_review"):
        conn.execute("INSERT INTO extraction (call_id, snapshot_id, source_id, topic, field, quote_verified, value_in_quote, "
                     "status, created_at) VALUES (1,?,?,?,?,1,1,?,?)", (q, "MI_QAP_CURRENT", "fee_rule", "f", status, now))
    conn.execute("INSERT INTO extraction (call_id, snapshot_id, source_id, topic, field, quote_verified, value_in_quote, "
                 "status, created_at) VALUES (2,?,?,?,?,1,1,'pending_review',?)", (q, "MI_QAP_CURRENT", "deadlines", "d", now))
    conn.execute("INSERT INTO award_sheet (snapshot_id, source_id, sheet_name, header_row, rows_parsed, rows_flagged, "
                 "parser_version, parsed_at) VALUES (?,?,?,?,?,?,?,?)", (aw, "MI_AWARDS_1", "s", 1, 3, 1, "v", now))
    for year, ct, flags in ((2025, "9%", None), (2025, "9%", "x"), (None, "unknown", "award year not stated")):
        conn.execute("INSERT INTO award_row (sheet_id, snapshot_id, source_id, sheet_name, row_number, credit_type, "
                     "award_year, raw_json, flags) VALUES (1,?,?,?,?,?,?,?,?)", (aw, "MI_AWARDS_1", "s", 2, ct, year, "{}", flags))
    conn.commit()
    conn.close()


def test_coverage_checklist(tmp_path):
    setup(tmp_path)
    path, results = coverage.run(["MI"], tmp_path / "t.db", tmp_path / "out", SET)
    it = {i["item"]: i for i in results[0]["items"]}
    assert it["sources registered"]["value"] == 4 and it["sources never retrieved"]["detail"] == "MI_UW"
    assert it["QAP archived"]["value"] == 2 and it["QAP that is not a draft"]["value"] == 1
    assert it["QAP confirmed final by a person"]["ok"] == "no"          # unknown is not final
    assert it["underwriting manual archived"]["ok"] == "no"
    assert it["rules: fee_rule"]["ok"] == "yes" and it["rules: fee_rule"]["value"].startswith("1 approved, 1 to review")
    assert it["rules: deadlines"]["ok"] == "no" and it["rules: deadlines"]["detail"] == "1 waiting for review"
    assert it["rules: scoring_criteria"]["detail"] == "not extracted yet"
    assert it["awards 2025"]["ok"] == "yes" and it["awards 2025"]["value"] == "2 9% (1 flagged)"
    assert it["awards 2021"]["ok"] == "no" and it["award rows with no year"]["ok"] == "no"
    assert path.exists() and len(results[0]["missing"]) >= 5


def test_unknown_jurisdiction_is_all_missing(tmp_path):
    setup(tmp_path)
    _, results = coverage.run(["ZZ"], tmp_path / "t.db", tmp_path / "out", SET)
    assert all(i["ok"] == "no" for i in results[0]["items"] if i["item"] in ("sources registered", "QAP archived"))
