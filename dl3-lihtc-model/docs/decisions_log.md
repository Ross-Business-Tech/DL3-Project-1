# Decisions log

Open decisions need Andrew Stables / DL3 sign-off before scoring. Record each decision with date and who made it.

## Decided

| Date | Decision | By | Notes |
|---|---|---|---|
| 2026-11-10 | LLM extraction uses Google Gemini (`gemini-3.5-flash-lite`, from `GEMINI_MODEL`) instead of the Claude API named in the project brief. Claude remains available with `llm.provider: anthropic`. | Student team | Same prompts, schema, quote verification and review for both. Record the provider and model with every run (stored in `llm_call`). |

## Open

| Decision | Status |
|---|---|
| Fee denominator: Section 1 (TDC less fee, land, reserves) vs Section 5 (TDC including them) | Needs Andrew before scoring |
| The 3 pilot jurisdictions | Midpoint check-in |
| Retained-cash hurdle and DL3 fee share | Open |
| Urban definition (proposed: Census 2020 urban areas + DL3 overrides) | Open |
| Venture Development factor scoring method | Open |
| Ongoing operator after handoff | Open |
