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
