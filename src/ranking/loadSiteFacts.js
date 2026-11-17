// Reads the site facts file (data/site_facts.csv): the Census and transit facts the urban
// definition needs, one row per city (project "*") or per project.
//
// A row is rejected unless it names its source URL, its retrieval date, and the Census boundary
// vintage it used (a different vintage than the definition's cannot answer test 1).

import { URBAN_DEFINITION } from './config.js'
import { parseCsv } from './loadPartC.js'
import { stateName } from './usStates.js'

export const SITE_FACT_COLUMNS = [
  'state', 'city', 'project', 'inUrbanizedArea', 'principalCity', 'inApprovedArea', 'tractDensity',
  'nearFixedRouteTransit', 'boundaryVintage', 'source', 'retrieved', 'notes',
]

const clean = (v) => (v ?? '').trim()
const isUnknown = (v) => clean(v) === '' || /^unknown\b/i.test(clean(v))
const bool = (v) => (isUnknown(v) ? { value: null } : /^(true|false)$/i.test(clean(v)) ? { value: clean(v).toLowerCase() === 'true' } : { error: true })

/** @returns {{ facts: object[], warnings: string[] }} */
export function siteFactsFromCsv(csvText, definition = URBAN_DEFINITION) {
  const table = parseCsv(csvText)
  const warnings = []
  if (table.length === 0) return { facts: [], warnings }
  const [header, ...body] = table
  if (SITE_FACT_COLUMNS.some((c, i) => clean(header[i]) !== c)) {
    throw new Error(`The site facts file must start with these columns: ${SITE_FACT_COLUMNS.join(', ')}.`)
  }
  const facts = []
  const seen = new Set()
  body.forEach((fields, index) => {
    const line = index + 2
    const skip = (why) => warnings.push(`Site facts row ${line} was skipped: ${why}.`)
    if (fields.length !== SITE_FACT_COLUMNS.length) return skip(`it has ${fields.length} columns`)
    const f = Object.fromEntries(SITE_FACT_COLUMNS.map((c, i) => [c, clean(fields[i])]))
    const state = stateName(f.state)
    if (!state) return skip(`"${f.state}" is not a state`)
    if (!f.city) return skip('it has no city')
    const project = f.project || '*'
    if (!/^https?:\/\//i.test(f.source)) return skip('it has no source URL')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f.retrieved)) return skip('it has no retrieval date')
    if (f.boundaryVintage !== definition.boundaryVintage) {
      return skip(`it uses the "${f.boundaryVintage}" Census boundaries, but the definition uses ${definition.boundaryVintage}`)
    }
    const parsed = {}
    for (const k of ['inUrbanizedArea', 'principalCity', 'inApprovedArea', 'nearFixedRouteTransit']) {
      const b = bool(f[k])
      if (b.error) return skip(`${k} must be true, false or UNKNOWN`)
      parsed[k] = b.value
    }
    if (isUnknown(f.tractDensity)) parsed.tractDensity = null
    else if (/^\d+(\.\d+)?$/.test(f.tractDensity.replaceAll(',', ''))) parsed.tractDensity = Number(f.tractDensity.replaceAll(',', ''))
    else return skip('tractDensity must be a number (residents per square mile) or UNKNOWN')

    const key = `${state}|${f.city.toLowerCase()}|${project.toLowerCase()}`
    if (seen.has(key)) return skip(`${f.city} ${project} appears twice`)
    seen.add(key)
    facts.push({ state, city: f.city, project, facts: parsed, source: f.source, retrieved: f.retrieved, notes: f.notes || null })
  })
  return { facts, warnings }
}
