// Puts the data files together: the state sheet, the yearly award table, the award-by-award list
// and the site facts, with the urban definition applied. Plain functions on text, so it runs in
// the browser and in tests alike.

import { URBAN_DEFINITION } from './config.js'
import { parseAwards, urbanLowerBounds } from './awardAudit.js'
import { attachAwardHistory, awardHistoryFromCsv } from './loadAwardHistory.js'
import { recordsFromPartC } from './loadPartC.js'
import { siteFactsFromCsv } from './loadSiteFacts.js'
import { evaluateUrban, factsForAward } from './urban.js'

export function buildRecords({ partcCsv, awardHistoryCsv, awardsCsv, siteFactsCsv }, definition = URBAN_DEFINITION) {
  const sheet = recordsFromPartC(partcCsv)
  const history = awardHistoryFromCsv(awardHistoryCsv)
  const awards = parseAwards(awardsCsv)
  const siteFacts = siteFactsFromCsv(siteFactsCsv, definition)

  // For every state, pathway and year: how many awards above 100 units are CERTAINLY urban
  // new construction, judged from the award list and the site facts.
  const classify = (award) => evaluateUrban(factsForAward(award, siteFacts.facts), definition)
  const lower = urbanLowerBounds(awards.awards, classify)
  const rows = history.rows.map((row) => {
    const bound = lower.get(`${row.state}|${row.pathway}|${row.year}`)
    return bound ? { ...row, ...bound } : row
  })

  const merged = attachAwardHistory(sheet.records, rows)
  return {
    records: merged.records,
    warnings: [...sheet.warnings, ...history.warnings, ...awards.warnings, ...siteFacts.warnings, ...merged.warnings],
    stats: {
      ...sheet.stats,
      awardHistoryRows: history.rows.length,
      awards: awards.awards.length,
      siteFactRows: siteFacts.facts.length,
    },
  }
}
