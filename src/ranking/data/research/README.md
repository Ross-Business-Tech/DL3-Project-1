# AI research files

One JSON file per state, written by AI research agents on 2026-11-16 from official agency sources (QAPs, bond
program documents, award lists), following the brief in `BRIEF.md`. Every value carries a source link; every
0-5 judgment carries written evidence and sources. Unknown values are null, never estimated.

How the tool uses them (`../../loadResearch.js`):
- They fill gaps only. Our own research (the Michigan, Ohio and Indiana sheet values and yearly award table) is
  never overwritten, and disagreements are listed.
- Facts with sources (fee rule, feasible project size, partnership path, financing path) feed the checks in
  every view.
- The 0-5 judgments (Access, Urban feasibility, DL3 execution, Venture Development) are recorded as proposed by
  an AI research agent. They count only in the "Researched scores" view, marked "AI", and they have not been
  reviewed by DL3.
- Award counts are statewide (the urban filter needs site facts); the "Researched scores" view uses them for
  Scale and Funding and says so.

These files are research, not verified rules. Before relying on any of them, a reviewer should open the cited
source and confirm the value.
