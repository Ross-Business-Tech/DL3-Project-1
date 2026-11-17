// Loads the AI research agents' state files (data/research/*.json) and fills in the records.
//
// Each file is one state, researched from official sources with a citation for every value (see
// data/research/BRIEF.md for the exact instructions the agents followed). What it adds:
//   - the fee rule and the approved fee for the guide's example project (120 units, $40M)
//   - whether a 101+ unit project is feasible, whether the rules give an outside developer a
//     partnership path, whether the financing path is realistic
//   - award counts by year (new construction, above 100 units, applications)
//   - 0-5 judgments with written evidence for Access, Urban feasibility and DL3 execution, and the
//     five Venture Development factors for the state's most promising urban market
//
// Rules that keep it honest:
//   - Every judgment is recorded as PROPOSED by an AI research agent. It only counts toward a score
//     in the "Researched scores" view, which says so, and never as approved by DL3.
//   - Our deeper research (Michigan, Ohio, Indiana sheet values) is never overwritten; the agents
//     only fill gaps there, and disagreements are listed.
//   - A value without a source link, or a score without written evidence, is ignored.

import { stateName } from './usStates.js'

const isNum = (x) => typeof x === 'number' && Number.isFinite(x)
const isWhole05 = (x) => Number.isInteger(x) && x >= 0 && x <= 5
const isUrl = (u) => typeof u === 'string' && /^https?:\/\/\S+$/i.test(u.trim())
const text = (t) => (typeof t === 'string' && t.trim() !== '' ? t.trim() : null)
const bool = (v) => (v === true || v === false ? v : null)
const VENTURE = ['historicSuccess', 'anchorInstitutions', 'availableProperty', 'emergingMomentum', 'localLeadership']

function sourcesOf(obj) {
  const list = [...(Array.isArray(obj?.sources) ? obj.sources : []), obj?.source].filter(isUrl)
  return [...new Set(list.map((u) => u.trim()))]
}

// A 0-5 judgment with evidence and at least one source, or null.
function judgment(obj) {
  if (!obj || !isWhole05(obj.score) || !text(obj.evidence)) return null
  const sources = sourcesOf(obj)
  if (sources.length === 0) return null
  return { score: obj.score, evidence: `${text(obj.evidence)} Sources: ${sources.join(' ')}`, sources, proposedBy: 'AI research agent' }
}

/** Validate one state file. Returns { state, pathways, venture, ... } or throws with a plain reason. */
export function readResearchFile(json, fileName = 'research file') {
  const state = stateName(json?.state)
  if (!state) throw new Error(`${fileName}: "${json?.state}" is not a state.`)
  const researchedOn = /^\d{4}-\d{2}-\d{2}$/.test(json.researchedOn ?? '') ? json.researchedOn : null
  if (!researchedOn) throw new Error(`${fileName}: researchedOn must be a date like 2026-11-16.`)
  const warnings = []
  const pathways = {}
  for (const pw of ['9%', '4%']) {
    const p = json.pathways?.[pw]
    if (!p) { warnings.push(`${state} ${pw}: no research`); continue }
    const fee = p.fee && isNum(p.fee.approvedGrossFee) && isUrl(p.fee.source)
      ? { approvedGrossFee: p.fee.approvedGrossFee, ruleVerified: p.fee.ruleVerified === true, rule: text(p.fee.rule), arithmetic: text(p.fee.arithmetic), source: p.fee.source.trim(), quote: text(p.fee.quote) }
      : null
    if (p.fee && !fee) warnings.push(`${state} ${pw}: fee ignored (missing number or source)`)
    const sourced = (o, check) => (o && check(o.value) && isUrl(o.source) ? { value: o.value, evidence: text(o.evidence), source: o.source.trim() } : null)
    const awards = (Array.isArray(p.awardsByYear) ? p.awardsByYear : [])
      .filter((a) => Number.isInteger(a?.year) && a.year >= 2015 && a.year <= 2030 && isUrl(a.source))
      .map((a) => ({
        year: a.year,
        newConstructionAwards: Number.isInteger(a.newConstructionAwards) && a.newConstructionAwards >= 0 ? a.newConstructionAwards : null,
        above100Units: Number.isInteger(a.above100Units) && a.above100Units >= 0 ? a.above100Units : null,
        applications: Number.isInteger(a.applications) && a.applications >= 0 ? a.applications : null,
        source: a.source.trim(),
      }))
      .filter((a) => a.above100Units === null || a.newConstructionAwards === null || a.above100Units <= a.newConstructionAwards)
    pathways[pw] = {
      fee,
      maxFeasibleUnits: sourced(p.maxFeasibleUnits, (v) => Number.isInteger(v) && v > 0),
      sponsorPath: sourced(p.sponsorPath, (v) => v === true || v === false),
      financingPath: sourced(p.financingPath, (v) => v === true || v === false),
      awardsByYear: awards,
      oversubscription: p.oversubscription && isNum(p.oversubscription.requestedToAvailable) && isUrl(p.oversubscription.source) ? p.oversubscription.requestedToAvailable : null,
      nextDeadline: text(p.nextDeadline),
      judgments: { access: judgment(p.scores?.access), urban: judgment(p.scores?.urban), execution: judgment(p.scores?.execution) },
      confidence: ['High', 'Medium', 'Low'].includes(p.confidence) ? p.confidence : 'Low',
    }
  }
  const v = json.venture ?? {}
  const venture = { market: text(v.market) }
  for (const f of VENTURE) {
    const j = judgment(v[f])
    if (j) venture[f] = { score: j.score, evidence: j.evidence }
  }
  return { state, researchedOn, agency: text(json.agency), pathways, venture, notes: text(json.notes), warnings }
}

/**
 * Fill records from research files. Returns { records, warnings, comparison, states }.
 * `files` is a list of { name, json }.
 */
export function applyResearch(records, files) {
  const warnings = []
  const byState = new Map()
  for (const { name, json } of files) {
    try {
      const r = readResearchFile(json, name)
      warnings.push(...r.warnings)
      byState.set(r.state, r)
    } catch (e) {
      warnings.push(e.message)
    }
  }
  const comparison = []
  const out = records.map((rec) => {
    const res = byState.get(rec.state)
    const p = res?.pathways[rec.pathway]
    if (!p) return rec
    const deep = rec.researched === true && rec.screenOnly !== true // our own sheet research
    const next = { ...rec, aiResearch: { researchedOn: res.researchedOn, confidence: p.confidence, notes: res.notes, market: res.venture.market, oversubscription: p.oversubscription } }

    // Fee: our sheet wins where it has a number; otherwise the agent's verified-or-not fee is used,
    // carrying its own "verified" flag so an unverified rule can fail but never pass.
    if (p.fee) {
      if (deep && isNum(rec.approvedGrossFee)) {
        if (Math.round(rec.approvedGrossFee) !== Math.round(p.fee.approvedGrossFee)) comparison.push({ state: rec.state, pathway: rec.pathway, research: rec.approvedGrossFee, agent: p.fee.approvedGrossFee })
      } else {
        next.approvedGrossFee = p.fee.approvedGrossFee
        next.totalDevelopmentCost = 40_000_000
        next.feeRuleVerified = p.fee.ruleVerified
        next.feeFromAgent = p.fee
      }
    }
    if (!isNum(rec.maxFeasibleUnits) && p.maxFeasibleUnits) {
      next.maxFeasibleUnits = p.maxFeasibleUnits.value
      next.unitsEvidence = `${p.maxFeasibleUnits.evidence ?? `Largest feasible project: ${p.maxFeasibleUnits.value} units`} (AI research)`
    }
    if (bool(rec.sponsorPath) === null && p.sponsorPath) next.sponsorPath = p.sponsorPath.value
    if (bool(rec.financingPath) === null && p.financingPath) next.financingPath = p.financingPath.value
    if (!text(rec.nextDeadline) && p.nextDeadline) next.nextDeadline = p.nextDeadline

    // The record is now researched; an agent-researched state is no longer "fee screen only".
    if (!deep) {
      next.researched = true
      next.screenOnly = false
      next.confidence = p.confidence
      next.criticalSourceDates = [res.researchedOn]
      next.notes = [`AI-researched ${res.researchedOn} (not yet reviewed by DL3).`, res.notes].filter(Boolean).join(' ')
    }

    // Award history: fill only years we do not already have numbers for.
    const have = new Map((rec.awardHistory ?? []).map((h) => [h.year, h]))
    const rows = [...(rec.awardHistory ?? [])]
    for (const a of p.awardsByYear) {
      const h = have.get(a.year)
      const row = {
        year: a.year,
        complete: a.year <= 2025,
        eligibleAwards: a.newConstructionAwards,
        awardsAbove100Units: a.above100Units,
        qualifiedApplications: a.applications,
        urbanFiltered: false,
        source: a.source,
        retrieved: res.researchedOn,
        notes: 'AI research (statewide counts)',
        fromAgent: true,
      }
      if (!h) rows.push(row)
      else if (h.eligibleAwards === null && h.awardsAbove100Units === null) rows[rows.indexOf(h)] = { ...h, ...row }
    }
    next.awardHistory = rows.sort((x, y) => x.year - y.year)

    // Judgments (proposed, never approved) and Venture Development factors.
    const judgments = { ...(rec.judgments ?? {}) }
    for (const k of ['access', 'urban', 'execution']) if (!judgments[k] && p.judgments[k]) judgments[k] = p.judgments[k]
    next.judgments = judgments
    if (!rec.venture) {
      const v = Object.fromEntries(VENTURE.filter((f) => res.venture[f]).map((f) => [f, res.venture[f]]))
      if (Object.keys(v).length > 0) next.venture = v
    }
    return next
  })
  return { records: out, warnings, comparison, states: [...byState.keys()].sort() }
}
