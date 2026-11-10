// Puts the data files together: the state sheet, the yearly award table, the award-by-award list
// and the site facts, with the urban definition applied. Plain functions on text, so it runs in
// the browser and in tests alike.

import { URBAN_DEFINITION } from './config.js'
import { parseAwards, urbanLowerBounds } from './awardAudit.js'
import { attachAwardHistory, awardHistoryFromCsv } from './loadAwardHistory.js'
import { attachInventory, inventoryFromCsv, researchOrder } from './loadInventory.js'
import { applyFeeScreen } from './loadNationalFee.js'
import { recordsFromPartC } from './loadPartC.js'
import { attachProgramCaps, programCapsFromCsv } from './loadProgramCaps.js'
import { siteFactsFromCsv } from './loadSiteFacts.js'
import { evaluateUrban, factsForAward } from './urban.js'

export function buildRecords({ partcCsv, awardHistoryCsv, awardsCsv, siteFactsCsv, programCapsCsv, nationalFee, inventoryCsv }, definition = URBAN_DEFINITION) {
  const sheet = recordsFromPartC(partcCsv)
  const history = awardHistoryFromCsv(awardHistoryCsv)
  const awards = parseAwards(awardsCsv)
  const siteFacts = siteFactsFromCsv(siteFactsCsv, definition)
  const programCaps = programCapsFromCsv(programCapsCsv ?? '')

  // For every state, pathway and year: how many awards above 100 units are CERTAINLY urban
  // new construction, judged from the award list and the site facts.
  const classify = (award) => evaluateUrban(factsForAward(award, siteFacts.facts), definition)
  const lower = urbanLowerBounds(awards.awards, classify)
  const rows = history.rows.map((row) => {
    const bound = lower.get(`${row.state}|${row.pathway}|${row.year}`)
    return bound ? { ...row, ...bound } : row
  })

  // The 50-state fee screen fills in states we have not researched (and never overwrites ones we have).
  const fee = nationalFee ? applyFeeScreen(sheet.records, nationalFee) : { records: sheet.records, warnings: [], stats: {}, comparison: [] }
  const merged = attachAwardHistory(fee.records, rows)
  const withCaps = attachProgramCaps(merged.records, programCaps.caps)
  // The scraping pipeline's inventory: where each state's documents are (found automatically, not verified).
  const inventory = inventoryFromCsv(inventoryCsv ?? '')
  const records = attachInventory(withCaps.records, inventory.byState)
  return {
    records,
    warnings: [...sheet.warnings, ...history.warnings, ...awards.warnings, ...siteFacts.warnings, ...programCaps.warnings, ...fee.warnings, ...merged.warnings, ...withCaps.warnings, ...inventory.warnings],
    stats: {
      ...sheet.stats,
      awardHistoryRows: history.rows.length,
      awards: awards.awards.length,
      siteFactRows: siteFacts.facts.length,
      programCapRows: programCaps.caps.length,
      ...fee.stats,
    },
    feeComparison: fee.comparison,
    inventory: { stats: inventory.stats, researchNext: researchOrder(inventory.byState, records) },
  }
}
