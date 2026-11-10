// Reads the scraping pipeline's 50-state inventory (data/inventory.csv), which the pipeline branch
// built by crawling each agency's site. It is a map of WHERE the documents are, found
// automatically and NOT verified: no rule values are in it yet (fee cap, credit cap and deadline
// still say "needs verification" for every jurisdiction).
//
// What it gives the ranking tool:
//   - links a reviewer can click to check a state's plan, award lists and bond program
//   - the plan's draft / final status, so a draft is never mistaken for a rule
//   - a hint of which states have award lists for 2021-2025, i.e. where to research next
//
// It is a hint, not a fact: the crawler undercounts. (For Michigan it lists award years
// "2018-2021, 2026" although lists for 2022-2025 exist; for Indiana it lists 2024-2027.)

import { parseCsv } from './loadPartC.js'
import { stateName } from './usStates.js'

export const INVENTORY_SOURCE = {
  branch: 'claude/optimistic-hamilton-7al9rk',
  commit: '0cbdd31',
  file: 'dl3-lihtc-model/data/inventory/state_inventory.csv',
}

const WINDOW = [2021, 2022, 2023, 2024, 2025]
const clean = (v) => (v ?? '').trim()

// Only real web addresses are ever kept, so a bad cell cannot become a clickable script link.
// Some agency files have spaces in their addresses; those are encoded (%20) so they still work.
function safeUrl(raw) {
  const u = clean(raw).replace(/\s/g, '%20')
  try {
    const p = new URL(u)
    return p.protocol === 'https:' || p.protocol === 'http:' ? u : null
  } catch {
    return null
  }
}

/** "https://a.pdf [2027]; https://b.pdf [2026] [draft]" -> [{ url, label, labels, draft }] */
export function parseLinks(cell, warn = () => {}) {
  const out = []
  for (const part of clean(cell).split(/;\s+/)) {
    if (!part) continue
    const m = /^(https?:\/\/.*?)((?:\s+\[[^\]]*\])*)$/i.exec(part)
    const url = m ? safeUrl(m[1]) : null
    if (!url) { warn(part.slice(0, 60)); continue }
    const labels = [...m[2].matchAll(/\[([^\]]*)\]/g)].map((x) => x[1])
    out.push({ url, label: labels[0] ?? null, labels, draft: labels.some((l) => /draft|proposed/i.test(l)) })
  }
  return out
}

/** "2015, 2025–2028" -> Set(2015, 2025, 2026, 2027, 2028) */
export function parseYears(text) {
  const years = new Set()
  const t = clean(text)
  for (const m of t.matchAll(/(\d{4})\s*[–-]\s*(\d{4})/g)) {
    const [a, b] = [Number(m[1]), Number(m[2])]
    if (b >= a && b - a <= 60) for (let y = a; y <= b; y++) years.add(y)
  }
  for (const m of t.replace(/\d{4}\s*[–-]\s*\d{4}/g, '').matchAll(/\b(20\d\d)\b/g)) years.add(Number(m[1]))
  return years
}

function qapStatus(text) {
  const t = clean(text).toLowerCase()
  if (t.startsWith('draft')) return 'draft'
  if (t.startsWith('only related')) return 'related-only'
  if (t.startsWith('unknown')) return 'unknown'
  return null
}

/** How many of 2021-2025 the crawler found award lists for: a HINT, never a fact. */
export function awardCoverage(hasLists, years) {
  if (!hasLists) return 'none'
  const n = WINDOW.filter((y) => years.has(y)).length
  return n >= 3 ? 'three-plus' : n >= 1 ? 'one-or-two' : 'unclear'
}

/** @returns {{ byState: Map<string, object>, warnings: string[], stats: object }} */
export function inventoryFromCsv(csvText) {
  const table = parseCsv(csvText)
  const warnings = []
  const byState = new Map()
  if (table.length === 0) return { byState, warnings, stats: { jurisdictions: 0, states: 0 } }
  const [header, ...body] = table
  const col = Object.fromEntries(header.map((h, i) => [clean(h), i]))
  for (const needed of ['jurisdiction_id', 'in_50_state_scope', 'allocating_agency', 'qap_page_url', 'award_list_urls', 'award_years_available']) {
    if (!(needed in col)) throw new Error(`The inventory file is missing the "${needed}" column.`)
  }

  for (const [i, fields] of body.entries()) {
    const get = (name) => clean(fields[col[name]])
    if (get('in_50_state_scope') !== 'yes') continue // DC, territories and city sub-allocators are not ranked
    const state = stateName(get('jurisdiction_id'))
    if (!state) { warnings.push(`Inventory row ${i + 2}: "${get('jurisdiction_id')}" is not a state, so it was skipped.`); continue }
    if (byState.has(state)) { warnings.push(`Inventory lists ${state} twice, so the second row was skipped.`); continue }

    const bad = (what) => (part) => warnings.push(`${state}: a ${what} link was not a web address and was ignored ("${part}").`)
    const single = (name) => {
      const v = get(name)
      if (!v) return null
      const url = safeUrl(v)
      if (url) return url
      warnings.push(`${state}: the ${name} link was not a web address and was ignored.`)
      return null
    }
    const awardLists = parseLinks(get('award_list_urls'), bad('award list'))
    const years = parseYears(get('award_years_available'))

    byState.set(state, {
      state,
      agency: get('allocating_agency') || null,
      links: {
        program: single('lihtc_program_url'),
        qapPage: single('qap_page_url'),
        qapDocuments: parseLinks(get('qap_document_urls'), bad('plan document')),
        qapCurrent: single('qap_current_nondraft_url'),
        underwritingManual: single('underwriting_manual_url'),
        awardLists,
        applicationRound: single('application_round_url'),
        bondProgram: single('bond_program_url'),
      },
      planYears: get('plan_years') || null,
      qapStatus: qapStatus(get('qap_draft_or_final')),
      awardYearsText: get('award_years_available') || null,
      awardCoverage: awardCoverage(awardLists.length > 0, years),
      bondIssuer: get('bond_issuer_4pct') || null,
      localSuballocators: get('local_suballocators') || null,
      crawl: {
        method: get('crawl_method') || null,
        errors: Number(get('crawl_errors')) || 0,
        firstError: get('first_crawl_error') || null,
        lastCrawledAt: get('last_crawled_at') || null,
      },
      verificationStatus: get('verification_status') || null,
    })
  }

  const states = [...byState.values()]
  const stats = {
    jurisdictions: body.length,
    states: byState.size,
    awardCoverage: Object.fromEntries(['three-plus', 'one-or-two', 'unclear', 'none'].map((k) => [k, states.filter((s) => s.awardCoverage === k).length])),
    qapFound: states.filter((s) => s.links.qapPage || s.links.qapCurrent).length,
    qapStatus: Object.fromEntries(['draft', 'unknown', 'related-only'].map((k) => [k, states.filter((s) => s.qapStatus === k).length])),
  }
  return { byState, warnings, stats }
}

/** Attach each state's inventory entry to its records (both pathways share it). */
export function attachInventory(records, byState) {
  return records.map((r) => (byState.has(r.state) ? { ...r, sources: byState.get(r.state) } : r))
}

/** States ordered by where to research next: best award-list coverage first, then name. */
export function researchOrder(byState, records) {
  const deep = new Set(records.filter((r) => r.researched && !r.screenOnly).map((r) => r.state))
  const rank = { 'three-plus': 0, 'one-or-two': 1, unclear: 2, none: 3 }
  return [...byState.values()]
    .map((s) => ({ state: s.state, coverage: s.awardCoverage, yearsText: s.awardYearsText, awardLists: s.links.awardLists.length, qapStatus: s.qapStatus, researchedInDepth: deep.has(s.state), crawlErrors: s.crawl.errors }))
    .sort((a, b) => rank[a.coverage] - rank[b.coverage] || a.state.localeCompare(b.state))
}
