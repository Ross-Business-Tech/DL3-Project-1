// Reads what the data pipeline (dl3-lihtc-model/) exports for the website: data/pipeline/*.
// Refresh with:  cd dl3-lihtc-model && python -m src.report.export_web --site
//
// What it adds to each state (both pathways share it):
//   - rules a named person APPROVED, each with its page, quote and source link. Rules not yet
//     reviewed are never shown here and never used: that is the pipeline's review rule.
//   - the pipeline's award rows per pathway and year (spreadsheets read in code + approved PDF rows),
//     shown next to our own research so the two can be compared. They do not change any score.
//   - total development cost per unit where award lists publish it
//   - whether the state is part of a top-100 metro area (Census ACS 5-year), DL3's 2026-11-15 screen
//   - the documents the pipeline keeps, with their last retrieval date and whether they are stale
//
// Everything is display and evidence. Nothing here changes a gate or a score.

import { parseCsv } from './loadPartC.js'
import { stateName } from './usStates.js'

const clean = (v) => (v ?? '').trim()

export const RULE_TOPICS = {
  fee_rule: 'Developer fee',
  unit_credit_caps: 'Credit and unit caps',
  cost_limits: 'Cost limits',
  set_asides: 'Set-asides',
  deadlines: 'Deadlines',
  sponsor_eligibility: 'Developer eligibility',
  scoring_criteria: 'How applications are scored',
  credit_availability: 'Credit available and 4% bonds',
  bond_volume_cap: 'Bond volume cap',
}

// Only real web addresses become links, so a bad cell can never become a script link.
export function safeUrl(raw) {
  const u = clean(raw).replace(/\s/g, '%20')
  try {
    const p = new URL(u)
    return p.protocol === 'https:' || p.protocol === 'http:' ? u : null
  } catch {
    return null
  }
}

function rowsOf(csvText, required, what) {
  const table = parseCsv(csvText ?? '')
  if (table.length === 0) return []
  const [header, ...body] = table
  const col = Object.fromEntries(header.map((h, i) => [clean(h), i]))
  for (const name of required) {
    if (!(name in col)) throw new Error(`The pipeline's ${what} file is missing the "${name}" column.`)
  }
  return body.filter((f) => f.some((x) => clean(x))).map((f) => Object.fromEntries(header.map((h, i) => [clean(h), clean(f[i])])))
}

const num = (v) => {
  const n = Number(clean(v).replace(/[$,]/g, ''))
  return clean(v) !== '' && Number.isFinite(n) ? n : null
}

/**
 * @returns {{ byState: Map<string, object>, warnings: string[], stats: object, generatedAt: string|null }}
 */
export function pipelineFromFiles({ rulesCsv, sourcesCsv, costCsv, metroCsv, awardsCsv, manifest } = {}) {
  const warnings = []
  const byState = new Map()
  const entry = (state) => {
    if (!byState.has(state)) {
      byState.set(state, { state, rules: [], awards: new Map(), costs: [], metro: null, documents: [] })
    }
    return byState.get(state)
  }
  const stateOf = (code, where) => {
    const s = stateName(code)
    // Territories, DC and national sources are in the pipeline's files but are not ranked here.
    if (!s && code && !['US', 'UNKNOWN', 'DC', 'PR', 'VI', 'GU', 'AS', 'MP'].includes(code)) warnings.push(`Pipeline ${where}: "${code}" is not a state, so it was skipped.`)
    return s
  }

  // Approved rules only. A rule that has not been reviewed is not shown or used.
  for (const r of rowsOf(rulesCsv, ['state', 'topic', 'field', 'value', 'review_state', 'source_url'], 'rules')) {
    if (r.review_state !== 'approved') continue
    const state = stateOf(r.state, 'rules')
    if (!state) continue
    entry(state).rules.push({
      topic: r.topic, topicLabel: RULE_TOPICS[r.topic] ?? r.topic, field: r.field, value: r.value, units: r.units || null,
      appliesTo: r.applies_to || 'unknown', page: num(r.page), section: r.section || null, quote: r.quote || null,
      document: r.document || null, docStatus: r.doc_status || 'unknown', reviewedOn: r.reviewed_on || null,
      checks: r.checks || null, url: safeUrl(r.source_url), retrieved: r.retrieved || null,
    })
  }

  // Award rows per pathway and year. Rows whose notes say CHECK still need a person and are not counted.
  for (const a of rowsOf(awardsCsv, ['state', 'pathway', 'year', 'credits_awarded', 'notes'], 'awards')) {
    const state = stateOf(a.state, 'awards')
    if (!state || /CHECK:/.test(a.notes)) continue
    const key = `${a.pathway}|${a.year}`
    const e = entry(state).awards
    const cur = e.get(key) ?? { pathway: a.pathway, year: a.year, awards: 0, withCredits: 0, units100: 0 }
    cur.awards += 1
    if (num(a.credits_awarded) !== null) cur.withCredits += 1
    if ((num(a.total_units) ?? 0) >= 101) cur.units100 += 1
    e.set(key, cur)
  }

  for (const c of rowsOf(costCsv, ['state', 'pathway', 'year', 'median_cost_per_unit', 'projects_with_cost'], 'cost')) {
    const state = stateOf(c.state, 'cost')
    const median = num(c.median_cost_per_unit)
    if (!state || median === null) continue
    entry(state).costs.push({
      pathway: c.pathway, year: c.year, median, min: num(c.min_cost_per_unit), max: num(c.max_cost_per_unit),
      projects: num(c.projects_with_cost), of: num(c.projects_total), for100Units: num(c.cost_for_100_units_at_median),
    })
  }

  for (const m of rowsOf(metroCsv, ['state', 'in_top_msa', 'top_msa_count', 'top_n'], 'metro')) {
    const state = stateOf(m.state, 'metro')
    if (!state) continue
    entry(state).metro = {
      inTop: m.in_top_msa === 'yes', count: num(m.top_msa_count) ?? 0, topN: num(m.top_n) ?? 100,
      largest: m.largest_msa || null, largestRank: num(m.largest_msa_rank), largestPopulation: num(m.largest_msa_population),
      cutoff: num(m.cutoff_population), vintage: m.vintage || null, url: safeUrl(m.source_url), retrieved: m.retrieved || null,
    }
  }

  for (const s of rowsOf(sourcesCsv, ['source_id', 'state', 'title', 'url', 'last_retrieved', 'stale'], 'sources')) {
    const state = stateOf(s.state, 'sources')
    if (!state) continue
    entry(state).documents.push({
      id: s.source_id, title: s.title, type: s.doc_type || null, url: safeUrl(s.url), status: s.doc_status || 'unknown',
      critical: s.critical === 'yes', lastRetrieved: s.last_retrieved || null, method: s.retrieval_method || null,
      stale: s.stale === 'yes', blocks: s.blocks_recommendation === 'yes', lastError: s.last_error || null,
    })
  }

  for (const e of byState.values()) {
    e.awards = [...e.awards.values()].sort((a, b) => a.pathway.localeCompare(b.pathway) || String(a.year).localeCompare(String(b.year)))
    e.costs.sort((a, b) => a.pathway.localeCompare(b.pathway) || String(b.year).localeCompare(String(a.year)))
  }

  const all = [...byState.values()]
  const stats = {
    states: all.length,
    statesWithRules: all.filter((e) => e.rules.length).map((e) => e.state),
    approvedRules: all.reduce((n, e) => n + e.rules.length, 0),
    awardRows: all.reduce((n, e) => n + e.awards.reduce((m, a) => m + a.awards, 0), 0),
    statesInTopMetros: all.filter((e) => e.metro?.inTop).length,
    statesOutsideTopMetros: all.filter((e) => e.metro && !e.metro.inTop).map((e) => e.state).sort(),
    staleCritical: all.flatMap((e) => e.documents.filter((d) => d.blocks).map((d) => `${e.state}: ${d.title}`)),
  }
  return { byState, warnings, stats, generatedAt: manifest?.generated_at ?? null, codeVersion: manifest?.code_version ?? null }
}

/** Attach each state's pipeline evidence to its records (both pathways share it). */
export function attachPipeline(records, byState) {
  return records.map((r) => (byState.has(r.state) ? { ...r, pipeline: byState.get(r.state) } : r))
}
