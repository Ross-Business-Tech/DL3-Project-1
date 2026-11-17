// Sample data in the same shape as the ranking system's output (see src/ranking/forFrontEnd.js on the
// ranking branch). Every field below is one the ranking system fills in, so real results can replace
// this list one for one. Nothing here is a real ranking.

// Where the numbers come from: the model version and the date of the run.
export const MODEL_INFO = {
  modelVersion: 'sprint-0.1',
  runDate: 'November 2026',
}

// The ranking system covers the 50 states and DC.
export const TOTAL_AREAS = 51

// `score` is null until a state passes every check and all criteria have evidence.
// `scoreText` is what the site shows in that case, for example "Not scored yet".
// `depth` is "In depth", "Fee screen only", or "Not researched".
// `pathways` gives the 9% and 4% results separately, each with its checks and reason.
// `sourceLinks` lists the public pages the team found for that state. They're placeholders here.
export const TERRITORIES = [
  {
    id: 'MI', name: 'Michigan', kind: 'State',
    score: 92, scoreText: '92 / 100',
    status: 'Complete', depth: 'In depth',
    agency: 'Sample agency name', openQuestions: 0, sources: 4, lastChecked: 'November 2026',
    feeRule: '9%: passes at 14.20% · 4%: rule not verified',
    creditCap: 'Needs verification', deadline: 'Needs verification',
    pathways: [
      { pathway: '9%', checks: 'Pass', confidence: 'Medium', reason: 'Sample: fee and unit checks pass.' },
      { pathway: '4%', checks: 'Needs verification', confidence: 'Low', reason: 'Sample: bond rule not verified.' },
    ],
    sourceLinks: [
      { label: 'Latest non-draft plan', url: 'https://example.org/sample-plan' },
      { label: 'Application round', url: 'https://example.org/sample-round' },
    ],
  },
  {
    id: 'OH', name: 'Ohio', kind: 'State',
    score: 89, scoreText: '89 / 100',
    status: 'Complete', depth: 'In depth',
    agency: 'Sample agency name', openQuestions: 1, sources: 3, lastChecked: 'November 2026',
    feeRule: '9%: passes at 13.60%',
    creditCap: 'Needs verification', deadline: 'Needs verification',
    pathways: [
      { pathway: '9%', checks: 'Pass', confidence: 'Medium', reason: 'Sample: fee and unit checks pass.' },
      { pathway: '4%', checks: 'Needs verification', confidence: 'Low', reason: 'Sample: award count incomplete.' },
    ],
    sourceLinks: [{ label: 'Latest non-draft plan', url: 'https://example.org/sample-plan' }],
  },
  {
    id: 'IN', name: 'Indiana', kind: 'State',
    score: null, scoreText: 'Not scored yet',
    status: 'Review', depth: 'In depth',
    agency: 'Sample agency name', openQuestions: 2, sources: 3, lastChecked: 'November 2026',
    feeRule: '9%: rule not verified · 4%: fee screen only',
    creditCap: 'Needs verification', deadline: 'Needs verification',
    pathways: [
      { pathway: '9%', checks: 'Needs verification', confidence: 'Low', reason: 'Sample: fee rule not confirmed.' },
      { pathway: '4%', checks: 'Needs verification', confidence: 'Low', reason: 'Sample: sponsor path needs DL3 input.' },
    ],
    sourceLinks: [{ label: 'Application round', url: 'https://example.org/sample-round' }],
  },
  {
    id: 'CA', name: 'California', kind: 'State',
    score: null, scoreText: 'Not scored yet',
    status: 'Incomplete', depth: 'Fee screen only',
    agency: 'Sample agency name', openQuestions: 4, sources: 1, lastChecked: 'November 2026',
    feeRule: '9%: fee screen only',
    creditCap: 'Needs verification', deadline: 'Needs verification',
    pathways: [
      { pathway: '9%', checks: 'Needs verification', confidence: 'Low', reason: 'Sample: only the fee screen is done.' },
    ],
    sourceLinks: [],
  },
]

// The source register from the DL3 guide, section 12. These are the public pages the team starts from.
export const SOURCES = [
  { id: 'P1', title: 'HUD list of LIHTC allocating agencies', use: 'Starting list of state and local agencies. Re-check names and links.', url: 'https://www.huduser.gov/lihtc/agency_list.htm' },
  { id: 'P2', title: 'HUD LIHTC program data', use: 'Property and tenant data. Keep it separate from award records.', url: 'https://www.huduser.gov/portal/datasets/lihtc.html' },
  { id: 'P3', title: 'IHDA Qualified Allocation Plan page', use: 'Current and past plans, redlines and FAQs.', url: 'https://www.ihda.org/developers/qap/' },
  { id: 'P4', title: 'Cook County Assessor affordable housing program', use: 'Example property tax abatement program.', url: 'https://www.cookcountyassessor.gov/affordable-housing' },
  { id: 'P5', title: 'Illinois Property Tax Code, section 15-178', use: 'State law on affordable housing property tax assessments.', url: 'https://ilga.gov/legislation/ilcs/fulltext?DocName=003502000K15-178' },
  { id: 'P6', title: 'MSHDA Qualified Allocation Plan page', use: 'Example route to adopted plans, scoring and deadlines.', url: 'https://www.michigan.gov/mshda/developers/lihtc/lihtc/qualified-allocation-plan' },
  { id: 'P7', title: 'MSHDA combined application page', use: 'Application and scoring files that must match the selected round.', url: 'https://www.michigan.gov/mshda/developers/lihtc/spotlight/mshdas-combined-application-for-rental-housing-programs' },
  { id: 'P8', title: 'IHDA LIHTC program page', use: 'Historical 4% and 9% allocations and current timelines.', url: 'https://www.ihda.org/developers/tax-credits/low-income-tax-credit/' },
  { id: 'P9', title: 'IRS Revenue Ruling 2016-29', use: 'Separates a local opportunity to comment from a required local veto.', url: 'https://www.irs.gov/pub/irs-drop/rr-16-29.pdf' },
]

// Overview numbers, worked out from the list above so they always match it.
export function overviewStats(list = TERRITORIES) {
  const count = (fn) => list.filter(fn).length
  return {
    areas: TOTAL_AREAS,
    priority: count((t) => t.status === 'Complete'),
    needReview: count((t) => t.status === 'Review' || t.status === 'Incomplete'),
    researched: Math.round((count((t) => t.depth === 'In depth') / TOTAL_AREAS) * 100),
  }
}
