// What the pages show, built from the ranking engine's result and the data pipeline's evidence.
// The design's field names (src/ranking/forFrontEnd.js) plus: an estimate for ordering, the pipeline
// evidence for each state, and real source links.

import { territoriesFromResult } from '../ranking/forFrontEnd.js'
import { parseCsv } from '../ranking/loadPartC.js'
import { safeUrl } from '../ranking/loadPipeline.js'
import { US_STATES } from '../ranking/usStates.js'

export const CODE_OF = Object.fromEntries(Object.entries(US_STATES).map(([code, name]) => [name, code]))
export const codeOf = (stateName) => CODE_OF[stateName] ?? stateName
export const PRESENTED = ['MI', 'OH', 'IN'] // the states the final deliverable presents first

const r1 = (n) => Math.round(n * 10) / 10

function linksFor(sources) {
  const l = sources?.links
  if (!l) return []
  const out = [
    ['Current allocation plan (QAP)', l.qapCurrent], ['QAP page', l.qapPage], ['Underwriting manual', l.underwritingManual],
    ['Application round', l.applicationRound], ['Bond / 4% program', l.bondProgram], ['LIHTC program page', l.program],
  ].filter(([, url]) => url).map(([label, url]) => ({ label, url }))
  l.awardLists.slice(0, 6).forEach((url, i) => out.push({ label: `Award list ${i + 1}`, url }))
  return out
}

/** One entry per state, best first: real scores, then estimates, then states still being researched. */
export function buildTerritories(result, records) {
  const all = result.lists.flatMap((l) => [...l.ranked, ...l.needsVerification, ...l.excluded, ...l.benchmark])
  const base = territoriesFromResult(result)
  return base
    .map((t) => {
      const rows = all.filter((r) => codeOf(r.state) === t.id)
      const rec = records.find((r) => codeOf(r.state) === t.id)
      const estimates = rows.map((r) => r.score?.estimate).filter((x) => typeof x === 'number')
      const estimate = t.score ?? (estimates.length ? r1(Math.max(...estimates)) : null)
      const isEstimate = t.score === null && estimate !== null
      return {
        ...t,
        estimate,
        isEstimate,
        scoreText: t.score !== null ? t.scoreText : isEstimate ? `≈ ${Math.round(estimate)} / 100` : t.scoreText,
        scoreNote: t.score !== null ? 'Passes every check' : isEstimate ? `Estimate: ${t.scoreText.replace(' (range; evidence incomplete)', '')} possible while evidence is incomplete` : null,
        presented: PRESENTED.includes(t.id),
        pipeline: rec?.pipeline ?? null,
        sourceLinks: linksFor(rec?.sources),
        pathways: t.pathways.map((p) => {
          const row = rows.find((r) => r.pathway === p.pathway)
          return {
            ...p,
            action: row?.action ?? null,
            checksList: row?.gates?.checks?.map((c) => ({ label: c.label, status: c.status, detail: c.detail })) ?? [],
            criteria: row?.criteria ?? null,
            economics: row?.economics ?? null,
          }
        }),
      }
    })
    .sort((a, b) => (b.estimate ?? -1) - (a.estimate ?? -1) || Number(b.presented) - Number(a.presented) || a.name.localeCompare(b.name))
}

export function overviewStats(territories) {
  const count = (fn) => territories.filter(fn).length
  return {
    areas: territories.length,
    scored: count((t) => t.estimate !== null),
    passing: count((t) => t.score !== null),
    needReview: count((t) => t.status === 'Review' || t.status === 'Incomplete'),
    researched: territories.length ? Math.round((count((t) => t.depth === 'In depth') / territories.length) * 100) : 0,
  }
}

/** The documents the pipeline keeps (sources.csv), national ones included. */
export function sourcesFromCsv(csvText) {
  const table = parseCsv(csvText ?? '')
  if (table.length < 2) return []
  const [header, ...body] = table
  const col = Object.fromEntries(header.map((h, i) => [h.trim(), i]))
  const get = (row, k) => (col[k] === undefined ? '' : (row[col[k]] ?? '').trim())
  return body
    .filter((row) => get(row, 'source_id'))
    .map((row) => ({
      id: get(row, 'source_id'),
      state: get(row, 'state'),
      title: get(row, 'title'),
      type: get(row, 'doc_type'),
      url: safeUrl(get(row, 'url')),
      status: get(row, 'doc_status') || 'unknown',
      critical: get(row, 'critical') === 'yes',
      lastRetrieved: get(row, 'last_retrieved').slice(0, 10) || null,
      stale: get(row, 'stale') === 'yes',
      lastError: get(row, 'last_error') || null,
    }))
    .sort((a, b) => a.state.localeCompare(b.state) || a.type.localeCompare(b.type) || a.id.localeCompare(b.id))
}
