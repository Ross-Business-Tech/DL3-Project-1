# Ranking data

`partc.csv` is the "Part C" data sheet from the DL3 LIHTC research pack (draft for Andrew's review,
sources retrieved Nov 8, 2026). It is kept exactly as received. Do not edit it by hand to fix
problems: fix the research, replace the file, and re-run `npm test`.

What it covers today:
- 100 rows: all 50 states, each with a 9% and a 4% row.
- Only Michigan, Ohio and Indiana have researched data. The other 47 states list only the agency
  name from HUD's allocator list; everything else is UNKNOWN.
- No row has a confirmed sponsor path for DL3 (the report marks it "DL3 INPUT REQUIRED"), so no
  state can pass every gate yet.

Known quirks, handled by `../loadPartC.js`:
- 94 rows have one extra column holding a date followed by "(agency only)". The loader removes it
  so the confidence and notes columns line up.
- Illinois is flagged benchmark-only (guide section 1).
- The sheet has no 0-5 component scores, so every ranking factor is unknown until someone scores it.

`award_history.csv` is the yearly award table (36 rows: Michigan, Ohio and Indiana, 9% and 4%, 2021 to 2026
year-to-date) that the Scale and Funding scores are calculated from. `awards.csv` is the award-by-award list
(632 awards) it was built from. Both are kept exactly as received. Every row carries a source URL and a
retrieval date, and `loadPartC.test.js` re-counts the yearly table from the award list on every test run.

`program_caps.csv` (6 rows) says what each program's rules allow for one project: maximum credit, unit cap,
cost cap, bond volume cap and developer fee limit, with the source. The credit-per-unit figures are checked
against the maximum credit on every test run. No unit cap was stated in any of the six programs.

`national_fee_screen.json` is a draft fee-only screen for all 50 states, copied from the team dashboard
(`dashboard.html`, run 2026-11-01). It gives the developer fee each program's rule allows for the guide's example
project (120 units, $40M total development cost), with the rule text and a source link. How it is used:
- It fills in states we have not researched (87 of the 100 rows) with a fee, the example cost, and the run date.
  It never overwrites Michigan, Ohio or Indiana. Where it differs from our research, the difference is listed by
  `buildRecords().feeComparison` (Indiana 9%, Indiana 4%, Ohio 4%).
- Confidence is Medium only when the dashboard marks the state Verified AND it passed an independent review (17 states).
  Everything else is Low. A fee that fails on a Low-confidence rule is held for verification, not excluded.
- A fee that passes only on a rule the dashboard itself calls "unverified" counts as unknown, never a pass.
- Sponsor path, financing, project size and every 0-5 score stay unknown for these states.
- 7 rows have no fee rule at all (Idaho and Oklahoma, plus one pathway each for Florida, Maine and Massachusetts).
- The dashboard's own review covered only 22 of the 50 states, and it assumed a sponsor path for its pilots that our
  research marks as needing DL3's input, so none of that is used.

`site_facts.csv` is the Census and transit facts the urban definition needs. It is empty (header only) until
the research team fills it; see `../SCORING.md`.

Things to know about this data:
- 23 of the 36 yearly rows are UNKNOWN: Michigan lists do not state construction type, Ohio's 4% lists mostly
  do not, and Indiana's 4% lists are incomplete.
- `qualifiedApplications` is filled only for Indiana 9% (all six years) and Indiana 4% (2025 and 2026). Those
  counts cover every application in the state, including rehab, while `eligibleAwards` counts new construction
  only, so they are not like-for-like. Funding stays unresolved until the counts are urban and comparable.
- Some `notes` still say "qualifiedApplications UNKNOWN" next to a number that was filled in later. Trust the column.
- `urbanFiltered` is false in every row (the urban definition is not approved yet). A count of zero is still used
  for Scale, because filtering can only remove awards; a positive count waits for the definition.
- Indiana's `year` is IHCDA's credit-year label; its notes say the calendar award year is one year earlier.
  Michigan's year is the calendar year of the funding round. These are not the same basis.
- Ohio 9% `eligibleAwards` is a lower bound in years that include service-enriched awards of unstated type.

See `../SCORING.md` for the exact columns and rules.

All of this is public agency information. Never add personal data about individuals.
