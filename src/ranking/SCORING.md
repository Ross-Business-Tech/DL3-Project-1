# How each criterion gets its 0-5 score

The ranking is arithmetic on seven 0-5 scores (guide section 7B). This page says where each score
comes from, what it needs, and how to feed it. The weights and thresholds are proposals until
Leon and Andrew approve them.

A score of **1, 2 or 4 always needs written evidence** (guide 7A). If the evidence only pins a
score to a range, the tool keeps the range. It never guesses, and unknown never counts as a pass.

| Criterion (weight) | Route | The tool scores it when it has | Owner |
| --- | --- | --- | --- |
| Developer economics (25) | Calculated | DL3's retained fee cash and present value for a base case, plus DL3's two hurdles and a downside test | DL3 |
| Funding and competition (20) | Calculated | Yearly urban eligible awards and qualified applications (from the award history table) | Research |
| Access and QAP alignment (15) | Judgment | A 0-5 score with written evidence, approved by a named reviewer | AI proposes, reviewer confirms |
| Scale above 100 units (10) | Calculated | Whether a 101+ unit project is feasible, plus yearly counts of urban awards above 100 units | Research |
| Urban market feasibility (10) | Judgment | A 0-5 score with written evidence, approved by a named reviewer | AI proposes, reviewer confirms |
| DL3 ability to execute (10) | Judgment | DL3's staffing, partner and capital plan, scored 0-5 with evidence and approved | DL3 |
| Venture Development fit (10) | Judgment | Five factor scores (0-5, each with evidence); their average, approved by a named reviewer | AI proposes, reviewer confirms |

## Scale, exactly

- No feasible project above 100 units: **0**.
- Feasible, with 100+ unit awards in **at least 3 of the 5 complete years** (2021-2025): **5**.
- Feasible, with 100+ unit awards in 1 or 2 of those years (and no way to reach 3): **3**.
- Feasible but no such awards in any known year: a **1 or 2**, which needs written evidence, so the tool shows the range 1 to 2.
- Missing years leave a range (for example 3 to 5) until they are filled in.
- 2026 year-to-date and any year outside the window never count toward "3 of 5".
- Only awards already limited to **urban, DL3-product** projects count. A row must say `urbanFiltered = true`.
  One exception: a count of **zero** is used even before filtering, because filtering can only remove awards.

"Isolated" is read as "fewer than 3 of the 5 years". That reading is a proposal to confirm with Andrew.

## Preview scores (placeholders, not a result)

The page's **Preview scores** button shows what the tool produces today if a few things DL3 has not decided are filled in with stand-ins. Every stand-in is a box on the page that you can change, and everything re-scores.

- **Developer economics is calculated for every state with a verified fee:** fee × DL3's share × (1 − share paid later), compared with a cash target. The 60% and 40% are the guide's own illustration (5C), and the cash target is a stand-in for DL3's real number. The present-value test is not applied.
- **Optional what-if:** any criterion with no evidence is assumed to score 3. It is labeled "Assumed 3" wherever it appears, and it is never counted as evidence.
- **Optional:** also rank states researched in depth whose checks are still open. A state that failed a check is never ranked, and none of these is ever "actionable."

Preview leaves the normal results alone: with it off, nothing changes. "Evidence complete" counts only scores that rest on real evidence, so a preview cannot look more complete than it is.

## The urban definition (proposed, not yet approved)

A project site is urban only if **all three** tests pass (guide 6B; Andrew approves the final version):

1. **Census urban area:** the geocoded site is inside an Urbanized Area (population 50,000+) under the 2020 Census boundaries. Urban clusters fail. Re-run when 2030 boundaries are released.
2. **Place:** inside the city limits of a principal city, or inside a DL3-approved neighborhood or transit corridor.
3. **Built environment:** the tract has at least 3,000 residents per square mile, or fixed-route transit is within half a mile. **The 3,000 is a placeholder** to calibrate against sites DL3 already treats as urban in Chicago.

A test that cannot be answered is *unknown*, never a pass. Any failed test makes the site not urban. The tool counts an award toward Scale only when it is known new construction and certainly urban. Those counts are lower bounds, so they stay valid however incomplete an award list is.
While `approved` is false in `config.js`, a Scale score that rests on this definition is a **proposal and does not count** in the total.

Facts go in `data/site_facts.csv` (one row per city, project `*`, or per project): `state, city, project, inUrbanizedArea, principalCity, inApprovedArea, tractDensity, nearFixedRouteTransit, boundaryVintage, source, retrieved, notes`. Rows without a source URL, retrieval date, and the 2020 boundary vintage are rejected.

## Where the data goes

- `data/partc.csv`: the state sheet (fee rules, unit limits, sponsor and financing paths, source dates).
- `data/awards.csv`: the award-by-award list (one row per award, with city and unit count). `awardAudit.js` recounts the yearly table from it, and is where DL3's approved urban definition plugs in.
- `data/award_history.csv`: **one row per state, credit pathway and year.** Every row needs a source URL and a retrieval date, or it is rejected. Columns:
  `state, pathway, year, yearComplete, eligibleAwards, awardsAbove100Units, qualifiedApplications, urbanFiltered, source, retrieved, notes`.
  `state` may be a name or a two-letter code. Use `UNKNOWN` for a count you cannot find. Never estimate one.
- Judgments, Venture factors and DL3's economics inputs go on the record as described at the top of `engine.js`.

The page's **Still needed to finish scoring** section (and its CSV) lists every open item per state, grouped by who can supply it.

## Rules that never bend

- A criterion with a typed-in score uses that score.
- A judgment that no named person has approved is shown as a proposal and **not counted** in the total.
- Every result is calculated in code from the inputs, so the same inputs always give the same ranking.

## Guide coverage checklist (for the handoff)

How the scoring tool lines up with the DL3 LIHTC Opportunity Model Guide (Oct 30, 2026). "Placeholder" means the
calculation is built and tested but runs on stand-in terms until DL3 sets its own. Every row is covered by `npm test`.

| Guide section | What it asks | Status |
| --- | --- | --- |
| 5D | Gates before scoring: 101+ units, fee strictly above 10%, sponsor path, financing; Pass / Fail / Needs verification; unknown never passes | Done. A 101+ unit new-construction award in 2021-2025 counts as proof that size is allowed (Ohio 4%). |
| 1 vs 5 | Fee denominator: the guide defines it two ways | Done. Both ratios are shown on every state; a switch picks the one used; states whose result flips are flagged. DL3 decides. |
| 5B | Approved gross fee, DL3 retained fee, cash at each milestone, deferred amount, present value, pursuit value with explicit scenarios, downside test | Done with placeholder terms (60% / 40% are the guide's illustration). Reproduces the guide's $1.62M example. |
| 5C | 120-unit, $40M common scenario; test 150 / 200 units, costs, partner shares, credit pricing, rates, gap funding, delays, overruns | Partly. 120 units / $40M, cost +10%, DL3 share and deferral, delay and deferred-repayment downside are done. 150 / 200 units, credit pricing, interest rates and gap funding are not modelled (fee rules for other sizes are not loaded). |
| 6 | Seven criteria, proposed weights, same definitions within each pathway | Done. Weights are editable in Preview. |
| 6A | Award volume, applications per award, award rate, oversubscription, sponsor concentration, first-time sponsors | Partly. Volume and award rate feed the funding index; the rest need sponsor-level award data that is not collected. |
| 6B | Separate 9% / 4%, construction type, urban geography | Done for 9% / 4% and construction type. The urban definition is built (proposed, three tests) but needs site facts. |
| 7A | 0-5 rubric with 0 / 3 / 5 anchors; 1, 2, 4 only with written evidence | Done. Economics, Scale and Funding are calculated; the rest are judgments that count only once a named person approves them. |
| 7B | Total = sum(weight x score) / 5; intervals for missing evidence, no re-weighting; withhold rank when uncertain; separate lists; ties; +/-20% weights; test denominator, costs, deferrals, sharing; flag unstable; log overrides | Done, except the geography stress test (needs site facts). |
| 8 | Venture Development: five factors, averaged only when all are supported | Done; needs evidence for named neighborhoods. |
| 8B | Jurisdiction profiles; quarterly report with changes since the last release | Profiles done (printable report on the page). Change report done (run-to-run). |
| 9A | Confidence labels; Low cannot be actionable; 90-day freshness blocks a recommendation | Done. |
| 9C | Editable scoring settings, exportable records | Done (settings in config.js and on the page; CSV and HTML exports). |
| 10 | Calculation tests: 100 vs 101, exactly 10%, caps, deferrals, missing data, duplicates, amendments, stale sources, ties, reproducibility | Done. Amendments are covered by the change report and refresh demo. |
| 10 | Refresh demonstration | Done for the scoring side (simulated rule change, change report). The scraping pipeline shows the source side. |
| 10A | Back-testing against past rounds | Not done: needs the information available before a past round, which is not collected. |

## Using the results in the team's front end

The front end (branch `claude/epic-hamilton-532vgr`) reads `TERRITORIES` from `src/data.js`, which is sample data.
`forFrontEnd.js` builds the same list from real results:

```js
import { REAL_DATA } from './ranking/realData.js'
import { rankRecords } from './ranking/engine.js'
import { territoriesFromResult } from './ranking/forFrontEnd.js'
export const TERRITORIES = territoriesFromResult(rankRecords(REAL_DATA.records))
```

Today every `score` is `null`, because no state has passed every check. `scoreText` says why. The front end's sort
should be `(b.score ?? -1) - (a.score ?? -1)`, and its score pill should show `scoreText`.
