// Ranking model settings, taken from the DL3 LIHTC Opportunity Model Guide (Oct 30, 2026).
// Everything here is a PROPOSED value awaiting Leon Walker / Andrew Stables approval
// (guide sections 5, 6, 7 and 9). Change a value here and every score updates.

export const MODEL_VERSION = 'sprint-0.1'

// Section 6: the seven ranking criteria and their proposed weights (must total 100).
export const COMPONENTS = [
  { key: 'economics', label: 'Developer economics', weight: 25 },
  { key: 'funding', label: 'Funding and competition', weight: 20 },
  { key: 'access', label: 'Access and QAP alignment', weight: 15 },
  { key: 'scale', label: 'Scale above 100 units', weight: 10 },
  { key: 'urban', label: 'Urban market feasibility', weight: 10 },
  { key: 'execution', label: 'DL3 ability to execute', weight: 10 },
  { key: 'venture', label: 'Venture Development fit', weight: 10 },
]

export const SETTINGS = {
  // Section 5D: "more than 100" means at least 101 units.
  minUnits: 101,
  // Section 5: fee must be strictly greater than 10% of total development cost.
  minFeePercent: 10,
  // Section 9A: a critical fee / deadline / eligibility source older than this blocks a
  // current recommendation until it is re-checked.
  staleAfterDays: 90,
  // How many states make the "shortlist" (used to decide when a rank must be withheld).
  shortlistSize: 10,
  // Section 7B: vary each weight by +/-20% and renormalize to 100.
  weightShock: 0.2,
  // A rank that moves by more than this many places under a weight change is "unstable".
  rankShiftTolerance: 1,
  // Section 7A: below this many jurisdictions a percentile is not a national percentile.
  smallSampleBelow: 10,
}

export const PATHWAYS = ['9%', '4%']
export const CONFIDENCE_LEVELS = ['High', 'Medium', 'Low']
