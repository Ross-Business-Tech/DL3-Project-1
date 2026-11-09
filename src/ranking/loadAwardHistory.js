// Reads the yearly award table (data/award_history.csv) and attaches each row to its state's
// record. This one table feeds two criteria: Scale (awards above 100 units) and Funding
// (awards and applications per year).
//
// One row = one state, one credit pathway, one calendar year. Rules (guide 4, 4A, 4B, 6B):
//   - every row must name its source URL and the date it was retrieved, or it is rejected
//   - counts are plain whole numbers, or UNKNOWN; nothing is estimated
//   - urbanFiltered must be true for the row to count: the counts must already be limited to the
//     urban, DL3-product awards (the urban definition is Andrew's to approve)
//   - yearComplete is false for the current year so far; those rows never count toward "3 of 5"

import { parseCsv } from './loadPartC.js'

export const AWARD_HISTORY_COLUMNS = [
  'state', 'pathway', 'year', 'yearComplete', 'eligibleAwards', 'awardsAbove100Units',
  'qualifiedApplications', 'urbanFiltered', 'source', 'retrieved', 'notes',
]

const clean = (v) => (v ?? '').trim()
const isUnknown = (v) => clean(v) === '' || /^unknown\b/i.test(clean(v))
const isoDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`))

function count(value) {
  if (isUnknown(value)) return { value: null }
  const s = clean(value).replaceAll(',', '')
  return /^\d+$/.test(s) ? { value: Number(s) } : { error: `"${clean(value)}" is not a whole number` }
}

/** @returns {{ rows: object[], warnings: string[] }} */
export function awardHistoryFromCsv(csvText) {
  const table = parseCsv(csvText)
  const warnings = []
  if (table.length === 0) return { rows: [], warnings }
  const [header, ...body] = table
  if (AWARD_HISTORY_COLUMNS.some((c, i) => clean(header[i]) !== c)) {
    throw new Error(`The award history file must start with these columns: ${AWARD_HISTORY_COLUMNS.join(', ')}.`)
  }

  const rows = []
  const seen = new Set()
  body.forEach((fields, index) => {
    const line = index + 2
    const skip = (why) => warnings.push(`Award history row ${line} was skipped: ${why}.`)
    if (fields.length !== AWARD_HISTORY_COLUMNS.length) return skip(`it has ${fields.length} columns instead of ${AWARD_HISTORY_COLUMNS.length}`)
    const f = Object.fromEntries(AWARD_HISTORY_COLUMNS.map((c, i) => [c, clean(fields[i])]))

    if (f.pathway !== '9%' && f.pathway !== '4%') return skip(`pathway must be 9% or 4%, not "${f.pathway}"`)
    if (!/^\d{4}$/.test(f.year)) return skip(`year must be four digits, not "${f.year}"`)
    if (!/^https?:\/\//i.test(f.source)) return skip('it has no source URL')
    if (!isoDate(f.retrieved)) return skip('it has no retrieval date like 2026-11-08')
    const complete = f.yearComplete.toLowerCase()
    if (complete !== 'true' && complete !== 'false') return skip('yearComplete must be true or false')

    const eligible = count(f.eligibleAwards)
    const above = count(f.awardsAbove100Units)
    const apps = count(f.qualifiedApplications)
    for (const [name, c] of [['eligibleAwards', eligible], ['awardsAbove100Units', above], ['qualifiedApplications', apps]]) {
      if (c.error) return skip(`${name} ${c.error}`)
    }
    if (eligible.value !== null && above.value !== null && above.value > eligible.value) {
      return skip('awardsAbove100Units is larger than eligibleAwards')
    }
    if (eligible.value !== null && apps.value !== null && apps.value < eligible.value) {
      return skip('qualifiedApplications is smaller than eligibleAwards')
    }
    const key = `${f.state}|${f.pathway}|${f.year}`
    if (seen.has(key)) return skip(`${f.state} ${f.pathway} ${f.year} appears twice`)
    seen.add(key)

    rows.push({
      state: f.state,
      pathway: f.pathway,
      year: Number(f.year),
      complete: complete === 'true',
      eligibleAwards: eligible.value,
      awardsAbove100Units: above.value,
      qualifiedApplications: apps.value,
      urbanFiltered: f.urbanFiltered.toLowerCase() === 'true',
      source: f.source,
      retrieved: f.retrieved,
      notes: f.notes || null,
    })
  })
  return { rows, warnings }
}

/** Attach each row to the record with the same state and pathway. */
export function attachAwardHistory(records, rows) {
  const warnings = []
  const byKey = new Map(records.map((r) => [`${r.state}|${r.pathway}`, []]))
  for (const row of rows) {
    const list = byKey.get(`${row.state}|${row.pathway}`)
    if (!list) warnings.push(`Award history for ${row.state} ${row.pathway} matches no state in the data sheet, so it was ignored.`)
    else list.push(row)
  }
  const attached = records.map((r) => {
    const list = byKey.get(`${r.state}|${r.pathway}`)
    return list.length > 0 ? { ...r, awardHistory: list.sort((a, b) => a.year - b.year) } : r
  })
  return { records: attached, warnings }
}
