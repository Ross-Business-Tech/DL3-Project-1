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
(603 awards) it was built from. Both are kept exactly as received. Every row carries a source URL and a
retrieval date, and `loadPartC.test.js` re-counts the yearly table from the award list on every test run.

Things to know about this data:
- 23 of the 36 yearly rows are UNKNOWN: Michigan lists do not state construction type, Ohio's 4% lists mostly
  do not, and Indiana's 4% lists are incomplete.
- `qualifiedApplications` is UNKNOWN in every row, so Funding cannot be calculated yet.
- `urbanFiltered` is false in every row (the urban definition is not approved yet). A count of zero is still used
  for Scale, because filtering can only remove awards; a positive count waits for the definition.
- Indiana's `year` is IHCDA's credit-year label; its notes say the calendar award year is one year earlier.
  Michigan's year is the calendar year of the funding round. These are not the same basis.
- Ohio 9% `eligibleAwards` is a lower bound in years that include service-enriched awards of unstated type.

See `../SCORING.md` for the exact columns and rules.

All of this is public agency information. Never add personal data about individuals.
