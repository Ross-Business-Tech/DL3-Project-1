// Reads the award-by-award list (data/awards.csv) and recounts the yearly numbers from it.
//
// Two jobs:
//   1. Audit: check the yearly table (award_history.csv) against the awards it was built from.
//   2. Apply a definition: once DL3 approves what "urban" means, pass it as `include` and the
//      yearly counts for Scale and Funding can be rebuilt from the same awards.
//
// Counting rule (same as the research team used): a "parent project" counts once however many
// phases it has. It is an eligible award if any of its rows is new construction (mixed new +
// rehab counts), and "above 100 units" if an eligible phase has more than 100 units.

import { parseCsv } from './loadPartC.js'
import { stateName } from './usStates.js'

export const AWARD_COLUMNS = [
  'state', 'pathway', 'year', 'project', 'parent_project', 'city', 'total_units', 'new_construction',
  'age_restricted_or_assisted_living', 'credits_awarded', 'round_or_list', 'source_url', 'retrieved', 'notes',
]

const clean = (v) => (v ?? '').trim()
const yesNo = (v) => ({ yes: true, no: false }[clean(v).toLowerCase()] ?? null) // UNKNOWN -> null

/** @returns {{ awards: object[], warnings: string[] }} */
export function parseAwards(csvText) {
  const table = parseCsv(csvText)
  const warnings = []
  if (table.length === 0) return { awards: [], warnings }
  const [header, ...body] = table
  if (AWARD_COLUMNS.some((c, i) => clean(header[i]) !== c)) {
    throw new Error(`The awards file must start with these columns: ${AWARD_COLUMNS.join(', ')}.`)
  }
  const awards = []
  body.forEach((fields, index) => {
    const line = index + 2
    const skip = (why) => warnings.push(`Awards row ${line} was skipped: ${why}.`)
    if (fields.length !== AWARD_COLUMNS.length) return skip(`it has ${fields.length} columns`)
    const f = Object.fromEntries(AWARD_COLUMNS.map((c, i) => [c, clean(fields[i])]))
    const state = stateName(f.state)
    if (!state) return skip(`"${f.state}" is not a state`)
    if (f.pathway !== '9%' && f.pathway !== '4%') return skip(`pathway "${f.pathway}"`)
    if (!/^\d{4}$/.test(f.year)) return skip(`year "${f.year}"`)
    if (!/^https?:\/\//i.test(f.source_url)) return skip('no source URL')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f.retrieved)) return skip('no retrieval date')
    awards.push({
      state,
      pathway: f.pathway,
      year: Number(f.year),
      project: f.project,
      parent: f.parent_project || f.project,
      city: f.city || null,
      units: /^\d+$/.test(f.total_units) ? Number(f.total_units) : null,
      newConstruction: yesNo(f.new_construction),
      ageRestricted: yesNo(f.age_restricted_or_assisted_living),
      credits: /^\d+$/.test(f.credits_awarded) ? Number(f.credits_awarded) : null,
      round: f.round_or_list,
      source: f.source_url,
      retrieved: f.retrieved,
      notes: f.notes || null,
    })
  })
  return { awards, warnings }
}

/**
 * Yearly counts rebuilt from the awards. `include(award)` lets a definition (such as "urban")
 * leave awards out. Returns Map("State|9%|2023" -> { eligibleAwards, awardsAbove100Units,
 * unknownTypeRows }). unknownTypeRows > 0 means some awards that year have no stated
 * construction type, so eligibleAwards is only a lower bound.
 */
export function recountFromAwards(awards, { include = () => true } = {}) {
  const out = new Map()
  const groups = new Map()
  for (const a of awards) {
    const key = `${a.state}|${a.pathway}|${a.year}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(a)
  }
  for (const [key, rows] of groups) {
    const parents = new Map()
    let unknownTypeRows = 0
    for (const a of rows) {
      if (!include(a)) continue
      if (a.newConstruction === null) unknownTypeRows++
      if (!parents.has(a.parent)) parents.set(a.parent, [])
      parents.get(a.parent).push(a)
    }
    const eligible = [...parents.values()].filter((p) => p.some((a) => a.newConstruction === true))
    const above = eligible.filter((p) => p.some((a) => a.newConstruction === true && a.units !== null && a.units > 100))
    out.set(key, { eligibleAwards: eligible.length, awardsAbove100Units: above.length, unknownTypeRows })
  }
  return out
}
