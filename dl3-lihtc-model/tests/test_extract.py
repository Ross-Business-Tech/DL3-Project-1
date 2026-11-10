import csv
import json
from types import SimpleNamespace

import pymupdf
import pytest

from src.extract import extract
from src.extract.llm_client import ClaudeClient, LLMResult
from src.fetch import archive, fetch
from src.inventory import promote
from src.review import build_packet, import_review
from tests.test_fetch import SETTINGS, Site

FEE_PAGE = ("Section 4.2 Developer Fee. The developer fee shall not exceed 15% of total development cost "
            "excluding land, reserves and the developer fee. Up to 50% of the fee may be deferred.")
LLM_CFG = {**fetch.load_settings()["llm"]}
CLAUDE_CFG = {**LLM_CFG, "provider": "anthropic", "model": "claude-opus-5-5"}


def pdf(*pages):
    doc = pymupdf.open()
    for t in pages:
        page = doc.new_page()
        page.insert_textbox(pymupdf.Rect(50, 50, 550, 800), t, fontsize=10)
    return doc.tobytes()


class FakeClient:
    """Stands in for ClaudeClient. `answers` maps topic -> dict or callable(document) -> dict/LLMResult."""
    def __init__(self, answers):
        self.answers, self.calls = answers, []

    def extract(self, system, document, instruction, schema):
        topic = next(t for t in self.answers if extract.load_prompt(t)[1] == instruction)
        self.calls.append({"topic": topic, "system": system, "document": document, "schema": schema})
        a = self.answers[topic]
        a = a(document) if callable(a) else a
        if isinstance(a, LLMResult):
            return a
        return LLMResult(a if isinstance(a, str) else json.dumps(a), "claude-opus-5-5", "req_1", "end_turn",
                         {"input_tokens": 1000, "output_tokens": 200, "cache_write_tokens": 0, "cache_read_tokens": 0})


def finding(field, value, page, quote, **kw):
    return {"field": field, "value": value, "units": "percent", "applies_to": "9%", "page": page, "section": "4.2",
            "quote": quote, "confidence": "high", "notes": "", **kw}


@pytest.fixture
def env(tmp_path):
    site = Site()
    site.routes["/qap.pdf"] = (200, "application/pdf", pdf("Cover page 2027 QAP", FEE_PAGE, "Appendix"))
    reg = [{"source_id": "QAP1", "jurisdiction": "Test", "state": "ZZ", "doc_type": "qap", "title": "Test QAP",
            "url": site.base + "/qap.pdf", "status": "final", "critical": 1, "notes": ""}]
    f = fetch.Fetcher(SETTINGS, {"127.0.0.1"}, sleep=lambda s: None)
    fetch.run(reg, SETTINGS, tmp_path / "t.db", tmp_path / "a", fetcher=f)
    yield SimpleNamespace(site=site, reg=reg, db=tmp_path / "t.db", archive=tmp_path / "a", tmp=tmp_path)
    site.srv.shutdown()


def settings(**llm):
    return {"llm": {**LLM_CFG, "model": "test-model",
                    "topics_by_doc_type": {"qap": ["fee_rule"], "award_list": ["award_table"]}, **llm}}


def rows(env, status=None):
    conn = archive.connect(env.db)
    q = "SELECT * FROM extraction" + (" WHERE status=?" if status else "")
    return [dict(r) for r in conn.execute(q, (status,) if status else ())]


def go(env, client, **kw):
    return extract.run(env.db, env.archive, kw.pop("settings", settings()), client=client, progress=lambda m: None, **kw)


def test_verified_quote_goes_to_review_paraphrase_is_rejected(env):
    client = FakeClient({"fee_rule": {"findings": [
        finding("developer_fee_max_percent", "15%", 2, "The developer fee shall not exceed 15% of total development cost"),
        finding("developer_fee_basis", "TDC excluding land and reserves", 2,
                "total development cost excluding land, reserves and the developer fee"),
        finding("deferred_fee_max", "50%", 2, "Developers may defer half of the fee."),  # paraphrase
    ], "not_found": ["developer_fee_dollar_cap"]}})
    s = go(env, client)
    assert (s["calls"], s["pending_review"], s["rejected_validation"]) == (1, 2, 1)
    bad = rows(env, "rejected_validation")[0]
    assert bad["field"] == "deferred_fee_max" and "not found verbatim on page 2" in bad["validation_note"]
    good = {r["field"]: r for r in rows(env, "pending_review")}
    assert good["developer_fee_max_percent"]["quote_verified"] == 1 and good["developer_fee_max_percent"]["doc_status"] == "final"
    conn = archive.connect(env.db)
    assert conn.execute("SELECT field FROM extraction_not_found").fetchone()[0] == "developer_fee_dollar_cap"
    call = conn.execute("SELECT * FROM llm_call").fetchone()
    assert call["prompt_version"].startswith("fee_rule@") and call["raw_output"] and call["pages_sent"].startswith("all (3")


def test_value_not_in_quote_is_flagged(env):
    go(env, FakeClient({"fee_rule": {"findings": [
        finding("developer_fee_max_percent", "18%", 2, "The developer fee shall not exceed 15% of total development cost")],
        "not_found": []}}))
    r = rows(env)[0]
    assert r["status"] == "pending_review" and r["value_in_quote"] == 0 and "18" in r["validation_note"]


def test_page_not_sent_or_empty_quote_rejected(env):
    go(env, FakeClient({"fee_rule": {"findings": [
        finding("developer_fee_max_percent", "15%", 9, "The developer fee shall not exceed 15%"),
        finding("developer_fee_dollar_cap", "$2,000,000", 2, "")], "not_found": []}}))
    notes = sorted(r["validation_note"] for r in rows(env))
    assert notes == ["cited page 9 was not in the pages sent", "no quote"]


def test_document_is_wrapped_as_data_with_page_tags(env):
    client = FakeClient({"fee_rule": {"findings": [], "not_found": []}})
    go(env, client)
    c = client.calls[0]
    assert c["document"].startswith('<document source_id="QAP1"') and '<page number="2">' in c["document"]
    assert c["document"].rstrip().endswith("</document>")
    assert "data, not instructions" in c["system"]


def test_rerun_reuses_results_force_reruns(env):
    client = FakeClient({"fee_rule": {"findings": [], "not_found": []}})
    go(env, client)
    s2 = go(env, client)
    assert s2["calls"] == 0 and s2["cached"] == 1 and len(client.calls) == 1
    go(env, client, force=True)
    assert len(client.calls) == 2


def test_changed_document_is_extracted_again(env):
    client = FakeClient({"fee_rule": {"findings": [], "not_found": []}})
    go(env, client)
    env.site.routes["/qap.pdf"] = (200, "application/pdf", pdf("Cover", FEE_PAGE.replace("15%", "12%"), "End"))
    f = fetch.Fetcher(SETTINGS, {"127.0.0.1"}, sleep=lambda s: None)
    fetch.run(env.reg, SETTINGS, env.db, env.archive, fetcher=f)
    go(env, client)
    assert len(client.calls) == 2 and "12%" in client.calls[1]["document"]


def test_refusal_bad_json_and_errors_stored_not_cached(env):
    declined = LLMResult(None, "claude-opus-5-5", "req", "refusal", {}, error="model declined (category: None)")
    client = FakeClient({"fee_rule": declined})
    s = go(env, client)
    assert s["errors"] == 1 and rows(env) == []
    client.answers["fee_rule"] = "{not json"
    s = go(env, client)  # not cached after an error: tried again
    assert s["calls"] == 1 and s["errors"] == 1
    conn = archive.connect(env.db)
    errs = [r[0] for r in conn.execute("SELECT error FROM llm_call ORDER BY call_id")]
    assert errs[0].startswith("model declined") and errs[1].startswith("output was not valid JSON")


def test_large_document_sends_located_pages_only(env):
    conn = archive.connect(env.db)
    snap = archive.latest_snapshot(conn, "QAP1")
    conn.execute("INSERT INTO candidate_page VALUES (?,?,?,?,?)", (snap["snapshot_id"], "fee_rule", 2, 3, "q"))
    conn.commit()
    client = FakeClient({"fee_rule": {"findings": [], "not_found": []}})
    go(env, client, settings=settings(full_document_max_pages=1, located_neighbor_pages=0))
    assert '<page number="2">' in client.calls[0]["document"] and '<page number="1">' not in client.calls[0]["document"]
    assert archive.connect(env.db).execute("SELECT pages_sent FROM llm_call").fetchone()[0] == "2"


def test_dry_run_makes_no_calls(env):
    client = FakeClient({"fee_rule": {"findings": [], "not_found": []}})
    s = go(env, client, dry_run=True)
    assert client.calls == [] and s["estimated_input_tokens"] > 0


def test_draft_status_carried_to_findings(env):
    conn = archive.connect(env.db)
    conn.execute("UPDATE snapshot SET doc_status='draft'")
    conn.commit()
    go(env, FakeClient({"fee_rule": {"findings": [
        finding("developer_fee_max_percent", "15%", 2, "shall not exceed 15% of total development cost")], "not_found": []}}))
    assert rows(env)[0]["doc_status"] == "draft"


def test_award_table_rows(tmp_path):
    site = Site()
    page = "2026 9% Awards\nMaple Court Apartments Acme Housing LLC Detroit 120 120 $1,450,000\nOak Homes Beta Dev Flint 60 54 $900,000"
    site.routes["/awards.pdf"] = (200, "application/pdf", pdf(page))
    reg = [{"source_id": "AW", "jurisdiction": "T", "state": "ZZ", "doc_type": "award_list", "title": "Awards",
            "url": site.base + "/awards.pdf", "status": "final", "critical": 0, "notes": ""}]
    fetch.run(reg, SETTINGS, tmp_path / "t.db", tmp_path / "a", fetcher=fetch.Fetcher(SETTINGS, {"127.0.0.1"}, sleep=lambda s: None))
    base = {c: "" for c in ["sponsor", "address", "city", "county", "total_units", "restricted_units", "award_round_or_date",
                            "set_aside", "status", "section", "notes"]}
    rowsj = {"rows": [
        {**base, "project_name": "Maple Court Apartments", "annual_credit_amount": "$1,450,000", "credit_type": "9%",
         "page": 1, "confidence": "high", "quote": "Maple Court Apartments Acme Housing LLC Detroit 120 120 $1,450,000"},
        {**base, "project_name": "Invented Towers", "annual_credit_amount": "$2,000,000", "credit_type": "9%",
         "page": 1, "confidence": "high", "quote": "Invented Towers Gamma Detroit 200 200 $2,000,000"}]}
    s = extract.run(tmp_path / "t.db", tmp_path / "a", settings(), client=FakeClient({"award_table": rowsj}),
                    progress=lambda m: None)
    site.srv.shutdown()
    assert (s["pending_review"], s["rejected_validation"]) == (1, 1)
    r = [dict(x) for x in archive.connect(tmp_path / "t.db").execute("SELECT * FROM extraction WHERE status='pending_review'")][0]
    assert r["field"] == "award_row" and r["value"] == "$1,450,000" and json.loads(r["row_json"])["project_name"] == "Maple Court Apartments"


def test_spreadsheets_skipped_with_reason(tmp_path):
    conn = archive.connect(tmp_path / "t.db")
    archive.upsert_source(conn, {"source_id": "X", "jurisdiction": "T", "state": "ZZ", "doc_type": "award_list",
                                 "title": "x", "url": "http://x", "status": "unknown", "critical": 0, "notes": ""})
    archive.store_snapshot(conn, tmp_path / "a", source={"source_id": "X", "state": "ZZ", "doc_type": "award_list"},
                           data=b"PK\x03\x04xx", requested_url="http://x", final_url="http://x",
                           content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", http_status=200)
    s = extract.run(tmp_path / "t.db", tmp_path / "a", settings(), client=FakeClient({}), progress=lambda m: None)
    assert s["calls"] == 0 and "parsed in code" in s["skipped"][0]


def test_normalization_handles_pdf_typography():
    page = "The develop-\nment ﬁnancing “fee”  is\n15 percent – capped."
    assert extract.norm('development financing "fee" is 15 percent - capped.') in extract.norm(page)
    assert extract.numbers("$2,000,000 and 15.0%") == {"2000000", "15"}


def test_schemas_are_strict_for_structured_outputs():
    def check(node):
        if isinstance(node, dict):
            if node.get("type") == "object":
                assert node["additionalProperties"] is False and set(node["required"]) == set(node["properties"])
            for v in node.values():
                check(v)
        elif isinstance(node, list):
            for v in node:
                check(v)
    for t in ["fee_rule", "unit_credit_caps", "set_asides", "deadlines", "sponsor_eligibility", "award_table"]:
        b = extract.prompt_bundle(t)
        check(b["schema"])
        assert b["version"].startswith(t + "@")


def test_prompt_version_changes_when_prompt_changes(tmp_path, monkeypatch):
    for f in extract.PROMPTS.glob("*.md"):
        (tmp_path / f.name).write_text(f.read_text())
    monkeypatch.setattr(extract, "PROMPTS", tmp_path)
    v1 = extract.prompt_bundle("fee_rule")["version"]
    (tmp_path / "fee_rule.md").write_text((tmp_path / "fee_rule.md").read_text() + "\nAlso note caps.")
    assert extract.prompt_bundle("fee_rule")["version"] != v1


# --- the real client, against a stand-in SDK object -----------------------------------------------------
class FakeSDK:
    def __init__(self, response):
        self.kwargs, self.response = None, response
        self.beta = SimpleNamespace(messages=SimpleNamespace(create=self._create))
        self.messages = SimpleNamespace(create=self._create)

    def _create(self, **kw):
        self.kwargs = kw
        return self.response


def sdk_response(stop="end_turn", text='{"findings": [], "not_found": []}'):
    usage = SimpleNamespace(input_tokens=10, output_tokens=5, cache_creation_input_tokens=8, cache_read_input_tokens=0)
    return SimpleNamespace(stop_reason=stop, model="claude-opus-5-5", usage=usage, _request_id="req_x",
                           stop_details=SimpleNamespace(category="cyber") if stop == "refusal" else None,
                           content=[SimpleNamespace(type="text", text=text)])


def test_claude_client_request_shape():
    sdk = FakeSDK(sdk_response())
    res = ClaudeClient(CLAUDE_CFG, client=sdk).extract("SYS", "<document>..</document>", "INSTR", {"type": "object"})
    k = sdk.kwargs
    assert k["model"] == "claude-opus-5-5" and k["system"] == "SYS"
    assert k["betas"] == ["server-side-fallback-2026-07-01"] and k["fallbacks"] == "default"
    assert k["output_config"] == {"effort": "high", "format": {"type": "json_schema", "schema": {"type": "object"}}}
    doc_block, instr_block = k["messages"][0]["content"]
    assert doc_block["cache_control"] == {"type": "ephemeral"} and "cache_control" not in instr_block
    assert "temperature" not in k and "thinking" not in k
    assert res.text.startswith("{") and res.usage["cache_write_tokens"] == 8 and res.request_id == "req_x"


def test_claude_client_refusal_and_truncation_not_parsed():
    r = ClaudeClient(CLAUDE_CFG, client=FakeSDK(sdk_response("refusal"))).extract("s", "d", "i", {})
    assert r.text is None and "declined" in r.error
    r = ClaudeClient(CLAUDE_CFG, client=FakeSDK(sdk_response("max_tokens", '{"findings": ['))).extract("s", "d", "i", {})
    assert r.text is None and "max_tokens" in r.error


# --- review -------------------------------------------------------------------------------------------------
def test_review_packet_and_import(env):
    go(env, FakeClient({"fee_rule": {"findings": [
        finding("developer_fee_max_percent", "15%", 2, "shall not exceed 15% of total development cost"),
        finding("deferred_fee_max", "50%", 2, "Up to 50% of the fee may be deferred."),
        finding("developer_fee_dollar_cap", "$1", 2, "made up")], "not_found": []}}))
    path = build_packet.build(env.db, env.tmp / "packets")
    data = list(csv.DictReader(open(path.with_suffix(".csv"))))
    assert len(data) == 2 and {"quote", "source_url", "sha256", "decision"} <= set(data[0])
    by = {d["field"]: d for d in data}
    by["developer_fee_max_percent"].update(decision="approve", reviewer="Test Reviewer")
    by["deferred_fee_max"].update(decision="approve", reviewer="", corrected_value="50")
    rejected_id = rows(env, "rejected_validation")[0]["extraction_id"]
    conn = archive.connect(env.db)
    res = import_review.apply(conn, list(by.values()) + [{"extraction_id": str(rejected_id), "decision": "approve",
                                                          "reviewer": "Test Reviewer"}])
    assert res["approved"] == 1 and len(res["errors"]) == 2
    assert any("reviewer name required" in e for e in res["errors"])
    assert any("cannot be approved" in e for e in res["errors"])
    vals = import_review.approved_values(conn)
    assert [v["approved_value"] for v in vals] == ["15%"] and vals[0]["reviewer"] == "Test Reviewer"
    # xlsx round trip
    from openpyxl import load_workbook
    wb = load_workbook(path)
    ws = wb["Review"]
    hdr = [c.value for c in ws[1]]
    ws.cell(row=2, column=hdr.index("decision") + 1, value="reject")
    ws.cell(row=2, column=hdr.index("reviewer") + 1, value="Test Reviewer")
    wb.save(env.tmp / "returned.xlsx")
    returned = import_review.read_rows(env.tmp / "returned.xlsx")
    first_id = int(returned[0]["extraction_id"])
    res2 = import_review.apply(conn, returned)
    assert res2["errors"] == [] and res2["rejected"] == 1 and res2["unchanged"] == 1
    assert conn.execute("SELECT status FROM extraction WHERE extraction_id=?", (first_id,)).fetchone()[0] == "rejected_by_reviewer"


def test_promote_inventory_to_register(tmp_path):
    inv = tmp_path / "inv.csv"
    with open(inv, "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=["jurisdiction_id", "state", "allocating_agency", "qap_document_urls",
                                           "qap_current_nondraft_url", "qap_current_nondraft_years", "plan_years",
                                           "underwriting_manual_url", "award_list_urls"])
        w.writeheader()
        w.writerow({"jurisdiction_id": "MI", "state": "MI", "allocating_agency": "MSHDA",
                    "qap_document_urls": "https://m/2027QAP-Draft.pdf [2027] [draft]; https://m/2026QAP.pdf [2026]",
                    "qap_current_nondraft_url": "https://m/2026QAP.pdf", "qap_current_nondraft_years": "2026",
                    "plan_years": "2027", "underwriting_manual_url": "https://m/uw.pdf",
                    "award_list_urls": "https://m/a2025.xlsx; https://m/a2024.pdf"})
    reg = tmp_path / "reg.csv"
    with open(reg, "w", newline="") as fh:
        fh.write(open(fetch.ROOT / "config" / "source_register.csv").read())
    new = promote.promote(["MI"], inv, reg)
    ids = {r["source_id"]: r for r in new}
    assert set(ids) == {"MI_QAP_CURRENT", "MI_QAP_NEWEST", "MI_UW", "MI_AWARDS_1", "MI_AWARDS_2"}
    assert ids["MI_QAP_NEWEST"]["status"] == "draft" and ids["MI_QAP_CURRENT"]["status"] == "unknown"
    promote.promote(["MI"], inv, reg)  # idempotent
    loaded = fetch.load_register(reg)
    assert sum(r["source_id"].startswith("MI_") for r in loaded) == 5 and any(r["source_id"] == "P3" for r in loaded)


def test_real_sdk_accepts_request_and_parses_response():
    """Real anthropic SDK, network mocked: the request body we build is what the API expects."""
    anthropic = pytest.importorskip("anthropic")
    httpx2 = pytest.importorskip("httpx2")
    seen = {}

    def handler(request):
        seen["url"], seen["headers"], seen["body"] = str(request.url), request.headers, json.loads(request.content)
        return httpx2.Response(200, headers={"request-id": "req_mock"}, json={
            "id": "msg_1", "type": "message", "role": "assistant", "model": "claude-opus-5-5",
            "content": [{"type": "text", "text": '{"findings": [], "not_found": ["deferred_fee_max"]}'}],
            "stop_reason": "end_turn", "stop_sequence": None,
            "usage": {"input_tokens": 12, "output_tokens": 7, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0}})

    sdk = anthropic.Anthropic(api_key="test-key", http_client=httpx2.Client(transport=httpx2.MockTransport(handler)))
    b = extract.prompt_bundle("fee_rule")
    res = ClaudeClient(CLAUDE_CFG, client=sdk).extract(b["system"], "<document>x</document>", b["instruction"], b["schema"])
    assert res.error is None and json.loads(res.text)["not_found"] == ["deferred_fee_max"] and res.request_id == "req_mock"
    body = seen["body"]
    assert seen["url"].endswith("/v1/messages?beta=true") or seen["url"].endswith("/v1/messages")
    assert "server-side-fallback-2026-07-01" in seen["headers"].get("anthropic-beta", "")
    assert body["model"] == "claude-opus-5-5" and body["fallbacks"] == "default"
    assert body["output_config"]["format"]["type"] == "json_schema" and body["output_config"]["effort"] == "high"
    assert body["messages"][0]["content"][0]["cache_control"] == {"type": "ephemeral"}


def test_run_all_with_extract(env, monkeypatch):
    import run_all
    reg = env.tmp / "reg.csv"
    with open(reg, "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(env.reg[0]))
        w.writeheader()
        w.writerows(env.reg)
    real = fetch.load_settings()
    monkeypatch.setattr(fetch, "load_settings", lambda path=None: {**real, "fetch": {**real["fetch"], **SETTINGS["fetch"]},
                                                                   "llm": settings()["llm"]})
    client = FakeClient({"fee_rule": {"findings": [
        finding("developer_fee_max_percent", "15%", 2, "shall not exceed 15% of total development cost")], "not_found": []}})
    f = fetch.Fetcher(SETTINGS, {"127.0.0.1"}, sleep=lambda s: None)
    out = run_all.run_pipeline(register_path=reg, db_path=env.db, archive_root=env.archive, out_root=env.tmp / "out",
                               refresh_hud=False, fetcher=f, extract=True, llm_client=client)
    m = json.loads((out / "run_manifest.json").read_text())
    assert m["extraction"]["pending_review"] == 1 and m["extraction"]["calls"] == 1
