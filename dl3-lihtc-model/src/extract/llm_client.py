"""Thin wrapper around the Claude API (official `anthropic` SDK) for structured extraction.

The rest of the pipeline only sees `LLMResult`, so tests use a fake client and no API key is needed.
Credentials come from the environment (ANTHROPIC_API_KEY, or an `ant auth login` profile).
"""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class LLMResult:
    text: str | None              # the JSON text (structured output); None on refusal/error
    model_served: str | None
    request_id: str | None
    stop_reason: str | None
    usage: dict = field(default_factory=dict)
    error: str | None = None


class ClaudeClient:
    def __init__(self, cfg: dict, client=None):
        self.cfg = cfg
        if client is None:
            import anthropic
            client = anthropic.Anthropic()
        self.client = client

    def extract(self, system: str, document: str, instruction: str, schema: dict) -> LLMResult:
        import anthropic
        kwargs = dict(
            model=self.cfg["model"],
            max_tokens=self.cfg.get("max_tokens", 16000),
            system=system,
            # Document first, marked cacheable: every topic prompt for the same document reuses it.
            messages=[{"role": "user", "content": [
                {"type": "text", "text": document, "cache_control": {"type": "ephemeral"}},
                {"type": "text", "text": instruction},
            ]}],
            output_config={"effort": self.cfg.get("effort", "high"),
                           "format": {"type": "json_schema", "schema": schema}},
        )
        try:
            if self.cfg.get("refusal_fallback", True):
                resp = self.client.beta.messages.create(
                    betas=["server-side-fallback-2026-07-01"], fallbacks="default", **kwargs)
            else:
                resp = self.client.messages.create(**kwargs)
        except anthropic.AuthenticationError as e:
            raise RuntimeError("Claude API: no valid credentials. Set ANTHROPIC_API_KEY or run `ant auth login`.") from e
        except anthropic.BadRequestError as e:
            return LLMResult(None, None, None, None, error=f"bad request: {e.message}")
        except anthropic.RateLimitError as e:
            return LLMResult(None, None, None, None, error=f"rate limited: {e.message}")
        except anthropic.APIStatusError as e:
            return LLMResult(None, None, None, None, error=f"API error {e.status_code}: {e.message}")
        except anthropic.APIConnectionError as e:
            return LLMResult(None, None, None, None, error=f"connection error: {e}")

        u = resp.usage
        usage = {"input_tokens": u.input_tokens, "output_tokens": u.output_tokens,
                 "cache_write_tokens": getattr(u, "cache_creation_input_tokens", 0) or 0,
                 "cache_read_tokens": getattr(u, "cache_read_input_tokens", 0) or 0}
        rid = getattr(resp, "_request_id", None)
        if resp.stop_reason == "refusal":
            cat = getattr(getattr(resp, "stop_details", None), "category", None)
            return LLMResult(None, resp.model, rid, resp.stop_reason, usage, error=f"model declined (category: {cat})")
        if resp.stop_reason == "max_tokens":
            return LLMResult(None, resp.model, rid, resp.stop_reason, usage,
                             error="output hit max_tokens; not parsed (raise llm.max_tokens)")
        text = next((b.text for b in resp.content if b.type == "text"), None)
        return LLMResult(text, resp.model, rid, resp.stop_reason, usage)


class GeminiClient:
    """Google Gemini via the official `google-genai` SDK. Same contract as ClaudeClient.

    Key: GEMINI_API_KEY (from the environment or .env). Model: GEMINI_MODEL, else settings llm.models.gemini.
    """

    BLOCKING = {"SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "LANGUAGE", "OTHER",
                "MALFORMED_RESPONSE"}

    def __init__(self, cfg: dict, client=None):
        self.cfg = cfg
        if client is None:
            import os

            from google import genai
            from google.genai import types
            key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
            if not key:
                raise RuntimeError("Gemini: GEMINI_API_KEY is not set (put it in .env or the environment).")
            client = genai.Client(api_key=key, http_options=types.HttpOptions(
                timeout=int(cfg.get("timeout_seconds", 300) * 1000),
                retry_options=types.HttpRetryOptions(attempts=4, http_status_codes=[429, 500, 502, 503, 504])))
        self.client = client

    def extract(self, system: str, document: str, instruction: str, schema: dict) -> LLMResult:
        from google.genai import errors, types
        config = types.GenerateContentConfig(
            system_instruction=system,
            response_mime_type="application/json",
            response_json_schema=schema,
            max_output_tokens=self.cfg.get("max_tokens", 16000),
        )
        if self.cfg.get("gemini_thinking_level"):
            config.thinking_config = types.ThinkingConfig(thinking_level=self.cfg["gemini_thinking_level"])
        # Document first and identical across topics, so Gemini's implicit prefix caching can reuse it.
        contents = [types.Content(role="user", parts=[types.Part(text=document), types.Part(text=instruction)])]
        try:
            resp = self.client.models.generate_content(model=self.cfg["model"], contents=contents, config=config)
        except errors.ClientError as e:
            if e.code in (401, 403):
                raise RuntimeError(f"Gemini: key rejected ({e.code}). Check GEMINI_API_KEY.") from e
            return LLMResult(None, None, None, None, error=f"Gemini request error {e.code}: {e.message}")
        except errors.APIError as e:
            return LLMResult(None, None, None, None, error=f"Gemini API error {e.code}: {e.message}")
        except Exception as e:  # network failures surface as transport exceptions
            return LLMResult(None, None, None, None, error=f"Gemini connection error: {type(e).__name__}: {e}")

        um = resp.usage_metadata
        cached = (getattr(um, "cached_content_token_count", 0) or 0) if um else 0
        usage = {} if um is None else {
            "input_tokens": max((um.prompt_token_count or 0) - cached, 0),
            "output_tokens": (um.candidates_token_count or 0) + (getattr(um, "thoughts_token_count", 0) or 0),
            "cache_write_tokens": 0, "cache_read_tokens": cached}
        model, rid = getattr(resp, "model_version", None) or self.cfg["model"], getattr(resp, "response_id", None)
        fb = getattr(resp, "prompt_feedback", None)
        if fb is not None and getattr(fb, "block_reason", None):
            return LLMResult(None, model, rid, "blocked", usage, error=f"Gemini blocked the prompt: {fb.block_reason}")
        if not resp.candidates:
            return LLMResult(None, model, rid, None, usage, error="Gemini returned no answer")
        reason = getattr(resp.candidates[0].finish_reason, "name", str(resp.candidates[0].finish_reason))
        if reason == "MAX_TOKENS":
            return LLMResult(None, model, rid, reason, usage, error="output hit max_tokens; not parsed (raise llm.max_tokens)")
        if reason == "RECITATION":
            return LLMResult(None, model, rid, reason, usage, error=(
                "Gemini stopped because the answer repeated document text verbatim (RECITATION). The quotes "
                "are required; retry with --force, or use the anthropic provider for this document."))
        if reason in self.BLOCKING:
            return LLMResult(None, model, rid, reason, usage, error=f"Gemini stopped: {reason}")
        return LLMResult(resp.text, model, rid, reason, usage)


def make_client(cfg: dict):
    """The client for llm.provider: gemini (default) or anthropic."""
    provider = cfg.get("provider", "gemini")
    if provider == "gemini":
        return GeminiClient(cfg)
    if provider == "anthropic":
        return ClaudeClient(cfg)
    raise ValueError(f"unknown llm.provider '{provider}' (use gemini or anthropic)")
