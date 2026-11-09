// Reads the program caps table (data/program_caps.csv): what each program's rules allow for a
// single project (credit, unit, cost and bond limits, and the developer fee limit), one row per
// state and credit pathway. Every row must name its source URL and retrieval date.
//
// The text columns are kept as written, because the rules do not always reduce to a number
// ("lesser of $1.8M or 7.5% of ..."). Plain numbers are also read out so they can be used.

import { parseCsv } from './loadPartC.js'
import { stateName } from './usStates.js'

export const PROGRAM_CAP_COLUMNS = [
  'state', 'pathway', 'maxCreditPerProject', 'unitCap', 'costCap', 'bondVolumeCap', 'developerFeeLimit',
  'creditPerUnitAt120', 'creditPerUnitAt200', 'source', 'retrieved', 'notes',
]

const clean = (v) => (v ?? '').trim()
const isUnknown = (v) => clean(v) === '' || /^unknown\b/i.test(clean(v))
// The first plain number in a cell such as "1650000 (Open Urban/PSH urban; 1500000 others)".
const leadingNumber = (v) => (/^\d[\d,]*(\.\d+)?/.exec(clean(v)) ? Number(/^\d[\d,]*(\.\d+)?/.exec(clean(v))[0].replaceAll(',', '')) : null)

/** @returns {{ caps: object[], warnings: string[] }} */
export function programCapsFromCsv(csvText) {
  const table = parseCsv(csvText)
  const warnings = []
  if (table.length === 0) return { caps: [], warnings }
  const [header, ...body] = table
  if (PROGRAM_CAP_COLUMNS.some((c, i) => clean(header[i]) !== c)) {
    throw new Error(`The program caps file must start with these columns: ${PROGRAM_CAP_COLUMNS.join(', ')}.`)
  }
  const caps = []
  const seen = new Set()
  body.forEach((fields, index) => {
    const line = index + 2
    const skip = (why) => warnings.push(`Program caps row ${line} was skipped: ${why}.`)
    if (fields.length !== PROGRAM_CAP_COLUMNS.length) return skip(`it has ${fields.length} columns`)
    const f = Object.fromEntries(PROGRAM_CAP_COLUMNS.map((c, i) => [c, clean(fields[i])]))
    const state = stateName(f.state)
    if (!state) return skip(`"${f.state}" is not a state`)
    if (f.pathway !== '9%' && f.pathway !== '4%') return skip(`pathway "${f.pathway}"`)
    if (!/^https?:\/\//i.test(f.source)) return skip('it has no source URL')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f.retrieved)) return skip('it has no retrieval date')
    const key = `${state}|${f.pathway}`
    if (seen.has(key)) return skip(`${state} ${f.pathway} appears twice`)
    seen.add(key)

    const maxCredit = leadingNumber(f.maxCreditPerProject)
    const perUnit120 = /^\d+$/.test(f.creditPerUnitAt120) ? Number(f.creditPerUnitAt120) : null
    const perUnit200 = /^\d+$/.test(f.creditPerUnitAt200) ? Number(f.creditPerUnitAt200) : null
    // The per-unit figures must be the maximum credit spread over 120 and 200 units.
    if (maxCredit !== null && perUnit120 !== null && Math.round(maxCredit / 120) !== perUnit120) {
      warnings.push(`${state} ${f.pathway}: credit per unit at 120 units is ${perUnit120}, but ${maxCredit} / 120 is ${Math.round(maxCredit / 120)}.`)
    }
    if (maxCredit !== null && perUnit200 !== null && Math.round(maxCredit / 200) !== perUnit200) {
      warnings.push(`${state} ${f.pathway}: credit per unit at 200 units is ${perUnit200}, but ${maxCredit} / 200 is ${Math.round(maxCredit / 200)}.`)
    }

    caps.push({
      state,
      pathway: f.pathway,
      maxCreditPerProject: maxCredit,
      maxCreditText: isUnknown(f.maxCreditPerProject) ? null : f.maxCreditPerProject,
      // A number = the program caps projects at that many units. 'none-stated' = the rules were
      // read and no unit cap was found. 'unknown' = not yet checked.
      unitCap: /^\d+$/.test(f.unitCap) ? Number(f.unitCap) : /none stated/i.test(f.unitCap) ? 'none-stated' : 'unknown',
      costCapText: isUnknown(f.costCap) ? null : f.costCap,
      bondVolumeCap: /^\d+$/.test(f.bondVolumeCap) ? Number(f.bondVolumeCap) : null,
      developerFeeLimitText: isUnknown(f.developerFeeLimit) ? null : f.developerFeeLimit,
      creditPerUnitAt120: perUnit120,
      creditPerUnitAt200: perUnit200,
      source: f.source,
      retrieved: f.retrieved,
      notes: f.notes || null,
    })
  })
  return { caps, warnings }
}

/** Attach each row to the record with the same state and pathway. */
export function attachProgramCaps(records, caps) {
  const warnings = []
  const byKey = new Map(caps.map((c) => [`${c.state}|${c.pathway}`, c]))
  const known = new Set(records.map((r) => `${r.state}|${r.pathway}`))
  for (const c of caps) {
    if (!known.has(`${c.state}|${c.pathway}`)) warnings.push(`Program caps for ${c.state} ${c.pathway} match no state in the data sheet, so they were ignored.`)
  }
  return { records: records.map((r) => (byKey.has(`${r.state}|${r.pathway}`) ? { ...r, programCaps: byKey.get(`${r.state}|${r.pathway}`) } : r)), warnings }
}
