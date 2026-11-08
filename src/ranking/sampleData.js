// ILLUSTRATIVE SAMPLE DATA ONLY. Every name and number below is made up so the ranking page has
// something to show. None of it describes a real state, agency, or award. Replace this file
// with real, source-linked records (guide section 4) before using any result.

export const SAMPLE_AS_OF = '2026-11-08'

const FRESH = ['2026-10-12', '2026-10-20', '2026-10-28']
const STALE = ['2026-05-30', '2026-10-20', '2026-10-28']

function record(overrides) {
  return {
    allocator: 'Sample housing finance agency',
    confidence: 'High',
    maxFeasibleUnits: 140,
    approvedGrossFee: 4_800_000,
    totalDevelopmentCost: 40_000_000,
    sponsorPath: true,
    financingPath: true,
    criticalSourceDates: FRESH,
    nextDeadline: '2027-02-15',
    recommendedAction: 'Prepare a jurisdiction profile for DL3 review',
    evidence: {},
    ...overrides,
  }
}

const note = 'Sample evidence note'

export const SAMPLE_RECORDS = [
  // ---- 9% pathway
  record({
    id: 'a-9', state: 'Sample State A', pathway: '9%',
    scores: { economics: 4, access: 4, scale: 5, urban: 3, execution: 4, venture: 3 },
    evidence: { economics: note, access: note, execution: note },
    funding: { eligibleAwardsPerYear: 12, qualifiedApplicationsPerYear: 30 },
  }),
  record({
    id: 'b-9', state: 'Sample State B', pathway: '9%',
    scores: { economics: 5, access: 3, scale: 3, urban: 4, execution: 3, venture: 4 },
    evidence: { urban: note, venture: note },
    funding: { eligibleAwardsPerYear: 9, qualifiedApplicationsPerYear: 36 },
  }),
  record({
    // Same numbers as State A on purpose: shows how ties are reported.
    id: 'c-9', state: 'Sample State C', pathway: '9%',
    scores: { economics: 4, access: 4, scale: 5, urban: 3, execution: 4, venture: 3 },
    evidence: { economics: note, access: note, execution: note },
    funding: { eligibleAwardsPerYear: 12, qualifiedApplicationsPerYear: 30 },
  }),
  record({
    // Two components and the application counts are missing: shows a score interval.
    id: 'h-9', state: 'Sample State H', pathway: '9%', confidence: 'Medium',
    scores: { economics: 4, access: 3, scale: 3, urban: 3 },
    evidence: { economics: note },
    funding: { eligibleAwardsPerYear: 7, qualifiedApplicationsPerYear: null },
  }),
  record({
    // Great scores but low-confidence evidence: ranked, never actionable.
    id: 'i-9', state: 'Sample State I', pathway: '9%', confidence: 'Low',
    scores: { economics: 5, access: 4, scale: 5, urban: 4, execution: 5, venture: 4 },
    evidence: { access: note, urban: note, venture: note },
    funding: { eligibleAwardsPerYear: 15, qualifiedApplicationsPerYear: 30 },
  }),
  record({
    // Largest plausible project is only 80 units: fails the 100-unit gate.
    id: 'd-9', state: 'Sample State D', pathway: '9%', maxFeasibleUnits: 80,
    scores: { economics: 5, access: 5, scale: 0, urban: 5, execution: 5, venture: 5 },
    funding: { eligibleAwardsPerYear: 10, qualifiedApplicationsPerYear: 25 },
  }),
  record({
    // Fee is exactly 10% of total development cost: "greater than 10%" means this fails.
    id: 'e-9', state: 'Sample State E', pathway: '9%', approvedGrossFee: 4_000_000,
    scores: { economics: 3, access: 3, scale: 3, urban: 3, execution: 3, venture: 3 },
    funding: { eligibleAwardsPerYear: 8, qualifiedApplicationsPerYear: 24 },
  }),
  record({
    // No confirmed sponsor or partner path yet: unknown can never pass.
    id: 'f-9', state: 'Sample State F', pathway: '9%', sponsorPath: null,
    scores: { economics: 4, access: 3, scale: 3, urban: 3, execution: 3, venture: 3 },
    evidence: { economics: note },
    funding: { eligibleAwardsPerYear: 11, qualifiedApplicationsPerYear: 33 },
  }),
  record({
    // One critical source is more than 90 days old: blocked until it is re-checked.
    id: 'g-9', state: 'Sample State G', pathway: '9%', criticalSourceDates: STALE,
    scores: { economics: 4, access: 3, scale: 3, urban: 3, execution: 3, venture: 3 },
    evidence: { economics: note },
    funding: { eligibleAwardsPerYear: 10, qualifiedApplicationsPerYear: 30 },
  }),

  // ---- 4% pathway (ranked separately from 9%)
  record({
    id: 'j-4', state: 'Sample State J', pathway: '4%', approvedGrossFee: 4_400_000,
    scores: { economics: 4, access: 3, scale: 4, urban: 4, execution: 3, venture: 3 },
    evidence: { economics: note, scale: note, urban: note },
    funding: { eligibleAwardsPerYear: 20, qualifiedApplicationsPerYear: 32 },
  }),
  record({
    id: 'k-4', state: 'Sample State K', pathway: '4%',
    scores: { economics: 3, access: 5, scale: 3, urban: 3, execution: 5, venture: 3 },
    funding: { eligibleAwardsPerYear: 14, qualifiedApplicationsPerYear: 28 },
  }),
  record({
    // Developer fee not yet extracted from the allocation plan.
    id: 'l-4', state: 'Sample State L', pathway: '4%', approvedGrossFee: null,
    scores: { economics: null, access: 3, scale: 3, urban: 3, execution: 3, venture: 3 },
    funding: { eligibleAwardsPerYear: 9, qualifiedApplicationsPerYear: 18 },
  }),
  record({
    // Bond financing cannot be satisfied: fails the financing gate.
    id: 'm-4', state: 'Sample State M', pathway: '4%', financingPath: false,
    scores: { economics: 4, access: 4, scale: 4, urban: 4, execution: 4, venture: 4 },
    evidence: { economics: note, access: note, scale: note, urban: note, execution: note, venture: note },
    funding: { eligibleAwardsPerYear: 6, qualifiedApplicationsPerYear: 24 },
  }),
]
