// Made-up sample data for the screens. Nothing here is a real ranking or a real rule.
// When the research and scoring work is ready, this file is the one place to swap in real results.

// Territories with details. Rule values say "Needs verification" until a reviewer confirms them.
export const TERRITORIES = [
  {
    id: 'MI', name: 'Michigan', kind: 'State', score: 92, status: 'Complete', depth: 'In depth',
    agency: 'Sample agency name', openQuestions: 0, sources: 4, lastChecked: 'November 2026',
    feeRule: 'Needs verification', creditCap: 'Needs verification', deadline: 'Needs verification',
  },
  {
    id: 'OH', name: 'Ohio', kind: 'State', score: 89, status: 'Complete', depth: 'In depth',
    agency: 'Sample agency name', openQuestions: 1, sources: 3, lastChecked: 'November 2026',
    feeRule: 'Needs verification', creditCap: 'Needs verification', deadline: 'Needs verification',
  },
  {
    id: 'IN', name: 'Indiana', kind: 'State', score: 86, status: 'Review', depth: 'In depth',
    agency: 'Sample agency name', openQuestions: 2, sources: 3, lastChecked: 'November 2026',
    feeRule: 'Needs verification', creditCap: 'Needs verification', deadline: 'Needs verification',
  },
  {
    id: 'CA', name: 'California', kind: 'State', score: 74, status: 'Incomplete', depth: 'Partial',
    agency: 'Sample agency name', openQuestions: 4, sources: 1, lastChecked: 'November 2026',
    feeRule: 'Needs verification', creditCap: 'Needs verification', deadline: 'Needs verification',
  },
  {
    id: 'local-a', name: 'Sample City A', kind: 'Local', score: 88, status: 'Complete', depth: 'In depth',
    agency: 'Sample local agency', openQuestions: 0, sources: 2, lastChecked: 'November 2026',
    feeRule: 'Needs verification', creditCap: 'Needs verification', deadline: 'Needs verification',
  },
  {
    id: 'local-b', name: 'Sample City B', kind: 'Local', score: 79, status: 'Review', depth: 'Partial',
    agency: 'Sample local agency', openQuestions: 3, sources: 1, lastChecked: 'November 2026',
    feeRule: 'Needs verification', creditCap: 'Needs verification', deadline: 'Needs verification',
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
