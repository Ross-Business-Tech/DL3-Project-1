// Ranking model settings, taken from the DL3 LIHTC Opportunity Model Guide (Oct 30, 2026).
// Everything here is a PROPOSED value awaiting Leon Walker / Andrew Stables approval
// (guide sections 5, 6, 7 and 9). Change a value here and every score updates.

export const MODEL_VERSION = 'sprint-0.1'

// Section 6: the seven ranking criteria and their proposed weights (must total 100).
// `fractional`: the guide averages five factors for Venture Development, so its score can be 3.4.
// Every other criterion is a whole number from 0 to 5.
export const COMPONENTS = [
  { key: 'economics', label: 'Developer economics', weight: 25 },
  { key: 'funding', label: 'Funding and competition', weight: 20 },
  { key: 'access', label: 'Access and QAP alignment', weight: 15 },
  { key: 'scale', label: 'Scale above 100 units', weight: 10 },
  { key: 'urban', label: 'Urban market feasibility', weight: 10 },
  { key: 'execution', label: 'DL3 ability to execute', weight: 10 },
  { key: 'venture', label: 'Venture Development fit', weight: 10, fractional: true },
]

// Who has to supply what before each criterion can be scored (shown in the "still needed" list).
export const CRITERIA_OWNERS = {
  economics: 'DL3 (sets the cash and present-value hurdles)',
  funding: 'Research (yearly award and application counts, urban only)',
  access: 'AI proposes, DL3 reviewer confirms',
  scale: 'Research (yearly award history, urban only)',
  urban: 'AI proposes, DL3 reviewer confirms',
  execution: 'DL3 (staff, partners and capital)',
  venture: 'AI proposes, DL3 reviewer confirms',
}

export const GATE_OWNERS = {
  units: 'Research (program size rules)',
  fee: 'Research (confirm the fee rule)',
  sponsor: 'DL3 (confirm a sponsor or partner path)',
  financing: 'Research and DL3 (financing path)',
  freshness: 'Research (re-check the sources)',
}

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

  // Section 4A / 7A: the five complete award years used for Scale and Funding. 2026 year-to-date
  // is tracked separately and never counts toward "3 of 5 years".
  scaleWindowYears: [2021, 2022, 2023, 2024, 2025],
  // Section 7A: a 5 for Scale needs 100+ unit awards in at least this many of those years.
  scaleStrongYears: 3,
  // Section 5C / 7A: DL3 must approve these before Economics can be scored 3 or higher.
  // null = not yet set by DL3. A 5 needs `strongMultiple` times both hurdles.
  economicsHurdles: { minRetainedCash: null, minPresentValue: null, strongMultiple: 1.5 },
  // Judgments that are proposed but not yet approved by a person do not count toward the score
  // unless this is true (useful for a preview; never for a final ranking).
  countProposed: false,
}

export const PATHWAYS = ['9%', '4%']
export const CONFIDENCE_LEVELS = ['High', 'Medium', 'Low']
