import json
import os
from types import SimpleNamespace

import pytest

from src.env import load_env
from src.extract import extract
from src.extract.llm_client import ClaudeClient, GeminiClient, make_client
from src.fetch import fetch

genai_types = pytest.importorskip("google.genai.types")
CFG = {**fetch.load_settings()["llm"], "provider": "gemini", "model": "gemini-3.5-flash-lite"}


def response(text='{"findings": [], "not_found": []}', reason="STOP", block=None, usage=True):
    um = SimpleNamespace(prompt_token_count=1200, candidates_token_count=80, thoughts_token_count=40,
                         cached_content_token_count=1000) if usage else None
    cand = [SimpleNamespace(finish_reason=SimpleNamespace(name=reason))] if reason else []
    return SimpleNamespace(text=text, candidates=cand, usage_metadata=um, model_version="gemini-3.5-flash-lite-001",
                           response_id="resp_1", prompt_feedback=SimpleNamespace(block_reason=block) if block else None)


class FakeGenAI:
    def __init__(self, resp=None, exc=None):
        self.kw, self.resp, self.exc = None, resp, exc
        self.models = SimpleNamespace(generate_content=self._gen)

    def _gen(self, **kw):
        self.kw = kw
        if self.exc:
            raise self.exc
        return self.resp


def test_request_shape_and_usage():
    sdk = FakeGenAI(response())
    r = GeminiClient(CFG, client=sdk).extract("SYS", "<document>d</document>", "INSTR", {"type": "object"})
    cfg = sdk.kw["config"]
    assert sdk.kw["model"] == "gemini-3.5-flash-lite"
    assert cfg.system_instruction == "SYS" and cfg.response_mime_type == "application/json"
    assert cfg.response_json_schema == {"type": "object"} and cfg.thinking_config is None
    parts = sdk.kw["contents"][0].parts
    assert [p.text for p in parts] == ["<document>d</document>", "INSTR"]  # document first: shared cache prefix
    assert r.text.startswith("{") and r.model_served == "gemini-3.5-flash-lite-001" and r.request_id == "resp_1"
    assert r.usage == {"input_tokens": 200, "output_tokens": 120, "cache_write_tokens": 0, "cache_read_tokens": 1000}


def test_thinking_level_optional():
    sdk = FakeGenAI(response())
    GeminiClient({**CFG, "gemini_thinking_level": "low"}, client=sdk).extract("s", "d", "i", {})
    assert sdk.kw["config"].thinking_config.thinking_level.lower() == "low"


@pytest.mark.parametrize("reason,needle", [("MAX_TOKENS", "max_tokens"), ("RECITATION", "verbatim"),
                                           ("SAFETY", "SAFETY")])
def test_stop_reasons_never_parsed(reason, needle):
    r = GeminiClient(CFG, client=FakeGenAI(response(text='{"findings": [', reason=reason))).extract("s", "d", "i", {})
    assert r.text is None and needle in r.error


def test_blocked_prompt_and_empty_answer():
    r = GeminiClient(CFG, client=FakeGenAI(response(block="PROHIBITED_CONTENT", reason=None))).extract("s", "d", "i", {})
    assert r.text is None and "blocked" in r.error
    r = GeminiClient(CFG, client=FakeGenAI(response(reason=None))).extract("s", "d", "i", {})
    assert r.text is None and "no answer" in r.error


def test_api_errors():
    from google.genai import errors
    rate = errors.ClientError(429, {"error": {"code": 429, "message": "quota", "status": "RESOURCE_EXHAUSTED"}})
    r = GeminiClient(CFG, client=FakeGenAI(exc=rate)).extract("s", "d", "i", {})
    assert r.text is None and "429" in r.error
    bad_key = errors.ClientError(403, {"error": {"code": 403, "message": "denied", "status": "PERMISSION_DENIED"}})
    with pytest.raises(RuntimeError, match="GEMINI_API_KEY"):
        GeminiClient(CFG, client=FakeGenAI(exc=bad_key)).extract("s", "d", "i", {})


def test_missing_key_message(monkeypatch):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
    with pytest.raises(RuntimeError, match="GEMINI_API_KEY is not set"):
        GeminiClient(CFG)


def test_real_sdk_request_body(monkeypatch):
    """Real google-genai SDK, network mocked: our config serializes to a valid generateContent request."""
    try:  # google-genai 3.x uses httpx2; older releases use httpx
        import httpx2 as httpx
    except ImportError:
        httpx = pytest.importorskip("httpx")
    from google import genai
    seen = {}

    def handler(request):
        seen["url"], seen["body"] = str(request.url), json.loads(request.content)
        return httpx.Response(200, json={
            "candidates": [{"content": {"role": "model", "parts": [{"text": '{"findings": [], "not_found": ["deferred_fee_max"]}'}]},
                            "finishReason": "STOP"}],
            "usageMetadata": {"promptTokenCount": 50, "candidatesTokenCount": 9},
            "modelVersion": "gemini-3.5-flash-lite", "responseId": "r_mock"})

    sdk = genai.Client(api_key="test-key", http_options=genai_types.HttpOptions(
        httpx_client=httpx.Client(transport=httpx.MockTransport(handler))))
    b = extract.prompt_bundle("fee_rule")
    r = GeminiClient(CFG, client=sdk).extract(b["system"], "<document>x</document>", b["instruction"], b["schema"])
    assert r.error is None and json.loads(r.text)["not_found"] == ["deferred_fee_max"] and r.request_id == "r_mock"
    body = seen["body"]
    assert "models/gemini-3.5-flash-lite:generateContent" in seen["url"]
    gc = body["generationConfig"]
    assert gc["responseMimeType"] == "application/json" and gc["responseJsonSchema"]["required"] == ["findings", "not_found"]
    assert "data, not instructions" in body["systemInstruction"]["parts"][0]["text"]
    assert body["contents"][0]["parts"][0]["text"] == "<document>x</document>"


def test_provider_and_model_from_env(monkeypatch):
    monkeypatch.setenv("GEMINI_MODEL", "gemini-env-model")
    monkeypatch.delenv("LLM_PROVIDER", raising=False)
    cfg = extract.resolve_cfg(fetch.load_settings()["llm"])
    assert cfg["provider"] == "gemini" and cfg["model"] == "gemini-env-model" and cfg["prices"] is None
    monkeypatch.setenv("LLM_PROVIDER", "anthropic")
    monkeypatch.delenv("ANTHROPIC_MODEL", raising=False)
    cfg = extract.resolve_cfg(fetch.load_settings()["llm"])
    assert cfg["model"] == "claude-opus-5-5" and cfg["prices"]["input"] == 4.0


def test_make_client(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "x")
    assert isinstance(make_client({**CFG}), GeminiClient)
    with pytest.raises(ValueError):
        make_client({**CFG, "provider": "openai"})
    assert ClaudeClient  # still available with provider: anthropic


def test_env_file_loading(tmp_path, monkeypatch):
    f = tmp_path / ".env"
    f.write_text('# comment\nGEMINI_MODEL="gemini-from-file"\nexport DL3_TEST_A=1\nHERENOW_WORKSPACE=x\nEMPTY=\n')
    monkeypatch.delenv("GEMINI_MODEL", raising=False)
    monkeypatch.setenv("DL3_TEST_A", "already-set")
    assert load_env([f, tmp_path / "missing.env"]) == [f]
    assert os.environ["GEMINI_MODEL"] == "gemini-from-file"
    assert os.environ["DL3_TEST_A"] == "already-set"  # existing environment wins
    monkeypatch.delenv("GEMINI_MODEL")


def test_no_prices_reports_tokens_only(tmp_path):
    s = extract.run(tmp_path / "t.db", tmp_path / "a", {"llm": {**CFG, "price_per_mtok": {"gemini": None}}},
                    client=None, progress=lambda m: None)
    assert s["estimated_cost_usd"] is None and s["provider"] == "gemini"
