// The research team's data sheet (draft, retrieved Nov 8, 2026), loaded for the ranking page.
// See src/ranking/data/README.md for where it came from and what is known to be missing.
import awardHistoryCsv from './data/award_history.csv?raw'
import partcCsv from './data/partc.csv?raw'
import { attachAwardHistory, awardHistoryFromCsv } from './loadAwardHistory.js'
import { recordsFromPartC } from './loadPartC.js'

const sheet = recordsFromPartC(partcCsv)
const history = awardHistoryFromCsv(awardHistoryCsv)
const merged = attachAwardHistory(sheet.records, history.rows)

export const REAL_DATA = {
  records: merged.records,
  warnings: [...sheet.warnings, ...history.warnings, ...merged.warnings],
  stats: { ...sheet.stats, awardHistoryRows: history.rows.length },
}
