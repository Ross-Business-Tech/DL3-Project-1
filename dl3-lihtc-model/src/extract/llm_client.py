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
