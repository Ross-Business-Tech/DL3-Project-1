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

`award_history.csv` is the yearly award table that the Scale and Funding scores are calculated from. It is
empty (header only) until the research team fills it. One row per state, credit pathway and year; every row
needs a source URL and a retrieval date, and its counts must already be limited to urban, DL3-product awards.
See `../SCORING.md` for the exact columns and rules.

All of this is public agency information. Never add personal data about individuals.
