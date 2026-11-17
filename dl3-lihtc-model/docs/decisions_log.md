# Decisions log

Open decisions need Andrew Stables / DL3 sign-off before scoring. Record each decision with date and who made it.

## Decided

| Date | Decision | By | Notes |
|---|---|---|---|
| 2026-11-10 | LLM extraction uses Google Gemini (`gemini-3.5-flash-lite`, from `GEMINI_MODEL`) instead of the Claude API named in the project brief. Claude remains available with `llm.provider: anthropic`. | Student team | Same prompts, schema, quote verification and review for both. Record the provider and model with every run (stored in `llm_call`). |

| 2026-11-15 | **Urban screen (state level):** keep states that are part of at least one of the top 100 metropolitan statistical areas by population in the most recent ACS 5-year estimates. | DL3 guidance relayed by the team | Collection: source `CENSUS_MSA` (Census API, table B01003) -> `data/reference/top_msas.csv` and `states_in_top_msas.csv`. Multi-state metros count for every state they touch (Indiana is in via Chicago). Puerto Rico metros are ranked and flagged. The year in the API URL must be raised when a newer 5-year release comes out. |
| 2026-11-15 | **Fee test approach:** take each state's total development cost per unit, apply it to a 100-unit deal, and pass the state if the developer fee its rules allow is at least 10% of that total. | DL3 guidance relayed by the team | Collection: TDC columns in award lists (`src/awards/costs.py` -> median cost per unit by state, pathway, year) and QAP cost limits (`cost_limits` prompt). Applying the test is the scoring code's job. |
| 2026-11-15 | **4% opportunity:** check whether each state used up its private activity bond volume cap in the latest data; unused cap suggests room for more 4% deals, oversubscription suggests competition. | DL3 guidance relayed by the team | Collection: `bond_volume_cap` prompt (cap, housing share, allocated, requested, remaining, carryforward, oversubscription statements, each with its year) on bond pages and cap reports; the crawler now finds volume cap pages. |

## Conflicts to confirm with Andrew

| Topic | Conflict | Until resolved |
|---|---|---|
| Fee threshold: "at least 10%" vs "more than 10%" | The 2026-11-15 guidance says a fee of >= 10% passes. The project brief's hard rule says the fee must be strictly greater than 10% and exactly 10% fails. | Report a fee of exactly 10% as "needs verification", not pass or fail. Do not relax silently. |
| Fee denominator | The brief's Section 1 (TDC less fee, land, reserves) and Section 5 (TDC including them) disagree; the new guidance says "this total" (cost per unit x 100). Most QAPs state the fee on their own basis (eligible basis, or costs excluding land), so converting needs a ratio between that basis and TDC. | Keep each state's fee basis as extracted (`developer_fee_basis`); scoring must not assume it equals TDC. |
| Urban: state-level vs site-level | The guidance screens whole states by metro membership; the brief proposes Census 2020 urban areas at site level. A state can be "in" because of one metro while most of its 9% pool is rural. | Collect both; record which one each score uses. |
| Where cost per unit comes from | Few agencies publish TDC with awards. QAP cost limits are caps, not actual costs. | Report cost per unit as UNKNOWN where no source states it; never fill from another state. |

## Open

| Decision | Status |
|---|---|
| Fee denominator: Section 1 (TDC less fee, land, reserves) vs Section 5 (TDC including them) | Needs Andrew before scoring |
| The 3 pilot jurisdictions | The website's researched states are Michigan, Ohio and Indiana; confirm |
| Retained-cash hurdle and DL3 fee share | Open |
| Urban definition (proposed: Census 2020 urban areas + DL3 overrides) | Open |
| Venture Development factor scoring method | Open |
| Ongoing operator after handoff | Open |
