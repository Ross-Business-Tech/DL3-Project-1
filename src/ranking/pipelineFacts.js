// Lets the data pipeline's REVIEWED data feed the score, so any state the pipeline collects can be scored on
// more than the draft fee screen.
//
// Which source wins, per value (strongest first):
//   1. our own sheet research (partc.csv: Michigan, Ohio, Indiana)   never overwritten; differences are listed
//   2. the pipeline: rules a named reviewer approved, award lists read in code, cost per unit
//   3. the AI research agents' files (from search excerpts, not verified)
//   4. the draft 50-state fee screen
//
// What the pipeline can supply:
//   - developer fee: from approved fee rules (maximum %, dollar cap, and what the % is taken of), applied to a
//     100-unit deal at the state's median cost per unit (DL3's 2026-11-15 guidance). Where rules conflict,
//     the LOWEST fee is used (a check must never pass on the generous reading). Rules from a draft
//     document never verify a fee: a draft can fail a check but never pass one.
//   - project size: a 101+ unit new-construction award in 2021-2025 shows the program allows one (guide 5D)
//   - award counts per year, where we have no numbers: from the award lists. Years with awards of
//     unstated construction type stay UNKNOWN rather than being undercounted.
//   - source dates: the retrieval date of the approved rule behind the fee
//
// Like the fee screen, the % basis "eligible basis" is taken as 75% of total development cost.

import { SETTINGS } from './config.js'
import { largestNewConstruction, parseAwards, recountFromAwards } from './awardAudit.js'

const isNum = (x) => typeof x === 'number' && Number.isFinite(x)
const EXAMPLE_TDC = 40_000_000 // the guide's example project, used when the pipeline has no cost data
const ELIGIBLE_SHARE = 0.75

const appliesTo = (rule, pathway) => rule.appliesTo === pathway || rule.appliesTo === 'both' || rule.appliesTo === 'unknown'

function percentOf(value) {
  const m = /(\d+(?:\.\d+)?)\s*%?/.exec(value ?? '')
  const p = m ? Number(m[1]) / 100 : null
  return p !== null && p > 0 && p <= 0.4 ? p : null
}

function dollarsOf(value) {
  const m = /\$?\s*(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(million|m\b)?/i.exec(value ?? '')
  if (!m) return null
  const n = Number(m[1].replaceAll(',', '')) * (m[2] ? 1_000_000 : 1)
  return n >= 100_000 ? n : null
}

/** What the fee percentage is taken of. */
export function basisKind(text) {
  const t = (text ?? '').toLowerCase()
  if (/exclud\w*[^.]*developer fee|other development costs|less (the )?(developer )?fee/.test(t)) return 'cost-excluding-fee'
  if (/eligible basis/.test(t)) return 'eligible-basis'
  if (/total development cost|\btdc\b/.test(t)) return 'total-cost'
  return 'unknown'
}

/** The fee for one deal, from a percentage, its basis and a cap. */
export function feeFor(percent, basis, tdc, cap = null) {
  const base = basis === 'total-cost' ? tdc : basis === 'cost-excluding-fee' ? tdc / (1 + percent) : tdc * ELIGIBLE_SHARE
  const fee = percent * base
  return isNum(cap) ? Math.min(fee, cap) : fee
}

/** The newest median cost per unit for a pathway (or, failing that, the other pathway). */
export function costFor(entry, pathway) {
  const pick = (pw) => (entry?.costs ?? []).filter((c) => c.pathway === pw && isNum(c.median)).sort((a, b) => String(b.year).localeCompare(String(a.year)))[0]
  return pick(pathway) ?? pick(pathway === '9%' ? '4%' : '9%') ?? null
}

/** The pipeline's fee for one state and pathway, or null when no approved fee rule gives a percentage. */
export function pipelineFee(entry, pathway) {
  const rules = (entry?.rules ?? []).filter((r) => r.topic === 'fee_rule' && appliesTo(r, pathway))
  const percents = rules.filter((r) => r.field === 'developer_fee_max_percent').map((r) => ({ rule: r, p: percentOf(r.value) })).filter((x) => x.p !== null)
  if (percents.length === 0) return null
  const caps = rules.filter((r) => r.field === 'developer_fee_dollar_cap').map((r) => ({ rule: r, cap: dollarsOf(r.value) })).filter((x) => x.cap !== null)
  const bases = [...new Set(rules.filter((r) => r.field === 'developer_fee_basis').map((r) => basisKind(r.value)))]
  const basis = bases.length === 1 ? bases[0] : 'unknown' // none or several: take the conservative 75% reading
  const cost = costFor(entry, pathway)
  const tdc = cost ? cost.median * 100 : EXAMPLE_TDC
  const cap = caps.length ? Math.min(...caps.map((c) => c.cap)) : null
  const fee = Math.min(...percents.map((x) => feeFor(x.p, basis, tdc, cap)))
  const used = [...percents.map((x) => x.rule), ...caps.map((c) => c.rule), ...rules.filter((r) => r.field === 'developer_fee_basis')]
  const distinct = new Set(percents.map((x) => x.p)).size
  const fromDraft = used.some((r) => r.docStatus === 'draft')
  return {
    fee,
    tdc,
    tdcBasis: cost ? `median ${cost.pathway} cost per unit ${cost.year} ($${Math.round(cost.median).toLocaleString('en-US')}) × 100 units` : 'the guide’s example project ($40M), no cost data yet',
    percents: [...new Set(percents.map((x) => x.p))],
    cap,
    basis,
    conflicting: distinct > 1 || caps.length > 1 && new Set(caps.map((c) => c.cap)).size > 1 || bases.length > 1,
    ruleVerified: !fromDraft,
    confidence: distinct === 1 && basis !== 'unknown' && cost ? 'Medium' : 'Low',
    dates: [...new Set(used.map((r) => r.retrieved).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d ?? '')))],
    sources: used.map((r) => ({ field: r.field, value: r.value, page: r.page, url: r.url, document: r.document })),
  }
}

function historyRows(awards, state, pathway, asOfYear) {
  const counts = recountFromAwards(awards.filter((a) => a.state === state && a.pathway === pathway))
  const rows = []
  for (const [key, c] of counts) {
    const year = Number(key.split('|')[2])
    const sample = awards.find((a) => a.state === state && a.pathway === pathway && a.year === year)
    const certain = c.unknownTypeRows === 0
    rows.push({
      state,
      pathway,
      year,
      complete: year < asOfYear,
      eligibleAwards: certain ? c.eligibleAwards : null,
      awardsAbove100Units: certain ? c.awardsAbove100Units : null,
      qualifiedApplications: null,
      urbanFiltered: false,
      source: sample?.source ?? null,
      retrieved: sample?.retrieved ?? null,
      notes: certain ? 'Data pipeline: counted from the award list (statewide)' : `Data pipeline: ${c.unknownTypeRows} awards do not state construction type, so the count is unknown`,
      fromPipeline: true,
    })
  }
  return rows
}

/**
 * Apply the pipeline's reviewed data to the records.
 * @param sheetDeep ids of records researched in our own sheet (never overwritten)
 * @returns {{ records, comparison: object[], stats: object }}
 */
export function applyPipelineFacts(records, pipeline, { awardsCsv = '', sheetDeep = new Set(), asOfYear = new Date().getFullYear() } = {}) {
  let awards = []
  try {
    awards = parseAwards(awardsCsv ?? '').awards
  } catch {
    awards = [] // a changed column layout is reported by loadPipeline; nothing is scored from it
  }
  const largest = largestNewConstruction(awards, SETTINGS.scaleWindowYears)
  const comparison = []
  const stats = { feesFromPipeline: 0, sizeFromPipeline: 0, historyYearsFromPipeline: 0 }

  const out = records.map((r) => {
    const entry = pipeline.byState.get(r.state)
    const next = { ...r }

    // Developer fee (and the cost it is measured against)
    const pf = entry ? pipelineFee(entry, r.pathway) : null
    if (pf) {
      next.pipelineFee = pf
      if (sheetDeep.has(r.id)) {
        if (isNum(r.approvedGrossFee) && Math.round(r.approvedGrossFee) !== Math.round(pf.fee)) {
          comparison.push({ state: r.state, pathway: r.pathway, research: r.approvedGrossFee, pipeline: Math.round(pf.fee), pipelineTdc: pf.tdc })
        }
      } else {
        stats.feesFromPipeline++
        Object.assign(next, {
          approvedGrossFee: Math.round(pf.fee),
          totalDevelopmentCost: Math.round(pf.tdc),
          feeRuleVerified: pf.ruleVerified,
          confidence: pf.confidence,
          criticalSourceDates: pf.dates.length ? pf.dates : r.criticalSourceDates,
          researched: true,
          feeFromPipeline: true,
          notes: [
            `Developer fee from reviewer-approved rules collected by the data pipeline: ${pf.percents.map((p) => `${(p * 100).toFixed(1).replace(/\.0$/, '')}%`).join(' / ')}`
              + `${pf.cap ? `, capped at $${pf.cap.toLocaleString('en-US')}` : ''}, on ${pf.tdcBasis}.`,
            pf.conflicting ? 'The approved rules disagree, so the lowest fee is used.' : null,
            pf.basis === 'unknown' ? 'What the percentage is taken of is not stated, so 75% of cost (eligible basis) is assumed.' : null,
            r.notes,
          ].filter(Boolean).join(' '),
        })
      }
    }

    // Project size
    if (!isNum(next.maxFeasibleUnits)) {
      const a = largest.get(`${r.state}|${r.pathway}`)
      if (a && a.units >= SETTINGS.minUnits) {
        stats.sizeFromPipeline++
        next.maxFeasibleUnits = a.units
        next.unitsEvidence = `A ${a.units}-unit new-construction award (${a.project}, ${a.city ?? 'city not stated'}, ${a.year}) in the pipeline's award lists shows the program allows a project this size`
      }
    }

    // Award counts: only years we have no numbers for
    const fresh = historyRows(awards, r.state, r.pathway, asOfYear)
    if (fresh.length) {
      const have = new Map((next.awardHistory ?? []).map((h) => [h.year, h]))
      const rows = [...(next.awardHistory ?? [])]
      for (const row of fresh) {
        const h = have.get(row.year)
        if (!h) {
          rows.push(row)
          stats.historyYearsFromPipeline++
        } else if (h.eligibleAwards === null && h.awardsAbove100Units === null && (row.eligibleAwards !== null || row.awardsAbove100Units !== null)) {
          rows[rows.indexOf(h)] = { ...h, ...row }
          stats.historyYearsFromPipeline++
        }
      }
      next.awardHistory = rows.sort((x, y) => x.year - y.year)
    }
    return next
  })
  return { records: out, comparison, stats }
}
