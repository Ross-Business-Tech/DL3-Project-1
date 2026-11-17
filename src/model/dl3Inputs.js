// DL3's own numbers: fee terms, hurdles and per-state judgments. CONFIDENTIAL.
//
// They are kept only in the signed-in employee's browser (localStorage) and used by the ranking that runs in
// that browser. They are never sent to a server, never published, never committed (this repository is public).
// To share them with a colleague, use "Save to a file" and send the file privately.
//
// Until DL3 enters a value, the ranking uses the guide's PLACEHOLDER (60% / 40% illustration, $1M hurdles),
// and the site says so wherever a score appears.

import { RESEARCH_VIEW_SETTINGS } from '../ranking/config.js'
import { ECONOMICS_TERMS } from '../ranking/economics.js'

export const STORAGE_KEY = 'dl3-inputs-v1'

// Each economic input: how it is shown, and how it maps to the engine's settings.
export const ECONOMIC_FIELDS = [
  { key: 'dl3Share', label: 'DL3 share of the developer fee', unit: '%', placeholder: ECONOMICS_TERMS.dl3Share * 100, min: 0, max: 100 },
  { key: 'deferredShare', label: 'Share of DL3’s fee that is deferred', unit: '%', placeholder: ECONOMICS_TERMS.deferredShare * 100, min: 0, max: 100 },
  { key: 'overheadAndPursuitCosts', label: 'Overhead and pursuit costs per project', unit: '$', placeholder: ECONOMICS_TERMS.overheadAndPursuitCosts, min: 0 },
  { key: 'discountRate', label: 'Discount rate', unit: '%', placeholder: ECONOMICS_TERMS.discountRate * 100, min: 0, max: 100 },
  { key: 'awardProbability', label: 'DL3’s own chance of winning an award', unit: '%', placeholder: ECONOMICS_TERMS.awardProbability * 100, min: 0, max: 100 },
  { key: 'minRetainedCash', label: 'Minimum cash DL3 must keep per deal', unit: '$', placeholder: RESEARCH_VIEW_SETTINGS.economicsHurdles.minRetainedCash, min: 0 },
  { key: 'minPresentValue', label: 'Minimum present value per deal', unit: '$', placeholder: RESEARCH_VIEW_SETTINGS.economicsHurdles.minPresentValue, min: 0 },
]

export const STATE_FIELDS = [
  { key: 'execution', label: 'DL3 ability to execute (0–5)', kind: 'score' },
  { key: 'sponsorPath', label: 'Sponsor or partner path confirmed', kind: 'yesno' },
  { key: 'financingPath', label: 'Financing path confirmed', kind: 'yesno' },
]

// Decisions on the scores researchers proposed, per state and pathway: approve, change (with a new score) or reject.
export const JUDGED = ['access', 'urban', 'execution', 'venture']
export const DECISIONS = ['approve', 'change', 'reject']
export const approvalKey = (code, pathway) => `${code}|${pathway}`

export function emptyInputs() {
  return { economics: {}, feeDenominator: null, states: {}, approvals: {}, updatedAt: null }
}

const num = (v) => (v === '' || v === null || v === undefined ? null : Number(v))
const isNum = (v) => typeof v === 'number' && Number.isFinite(v)

/** Clean whatever came from storage or an imported file: unknown keys dropped, out-of-range values refused. */
export function sanitize(raw) {
  const out = emptyInputs()
  if (!raw || typeof raw !== 'object') return out
  for (const f of ECONOMIC_FIELDS) {
    const v = num(raw.economics?.[f.key])
    if (isNum(v) && v >= (f.min ?? -Infinity) && v <= (f.max ?? Infinity)) out.economics[f.key] = v
  }
  if (raw.feeDenominator === 'tdc' || raw.feeDenominator === 'net') out.feeDenominator = raw.feeDenominator
  for (const [code, s] of Object.entries(raw.states ?? {})) {
    if (!/^[A-Z]{2}$/.test(code) || !s || typeof s !== 'object') continue
    const st = {}
    const e = num(s.execution)
    if (Number.isInteger(e) && e >= 0 && e <= 5) st.execution = e
    for (const k of ['sponsorPath', 'financingPath']) if (s[k] === true || s[k] === false) st[k] = s[k]
    if (Object.keys(st).length) out.states[code] = st
  }
  for (const [key, decisions] of Object.entries(raw.approvals ?? {})) {
    if (!/^[A-Z]{2}\|(9|4)%$/.test(key) || !decisions || typeof decisions !== 'object') continue
    const clean = {}
    for (const c of JUDGED) {
      const d = decisions[c]
      if (!d || !DECISIONS.includes(d.decision)) continue
      if (d.decision === 'change' && (c === 'venture' || !Number.isInteger(d.score) || d.score < 0 || d.score > 5)) continue
      clean[c] = {
        decision: d.decision,
        ...(d.decision === 'change' ? { score: d.score } : {}),
        ...(typeof d.note === 'string' && d.note.trim() ? { note: d.note.trim().slice(0, 300) } : {}),
        ...(typeof d.by === 'string' && d.by.trim() ? { by: d.by.trim().slice(0, 120) } : {}),
        ...(typeof d.on === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.on) ? { on: d.on } : {}),
      }
    }
    if (Object.keys(clean).length) out.approvals[key] = clean
  }
  if (typeof raw.updatedAt === 'string') out.updatedAt = raw.updatedAt.slice(0, 40)
  return out
}

export function loadInputs(storage = globalThis.localStorage) {
  try {
    return sanitize(JSON.parse(storage?.getItem(STORAGE_KEY) ?? 'null'))
  } catch {
    return emptyInputs()
  }
}

export function saveInputs(inputs, storage = globalThis.localStorage) {
  const clean = { ...sanitize(inputs), updatedAt: new Date().toISOString() }
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(clean))
  } catch {
    // Private window or storage blocked: the values still apply until the page is closed.
  }
  return clean
}

export function clearInputs(storage = globalThis.localStorage) {
  try {
    storage?.removeItem(STORAGE_KEY)
  } catch {
    // nothing stored
  }
  return emptyInputs()
}

/** Which economic values are DL3's own and which are still placeholders. */
export function inputStatus(inputs) {
  const entered = ECONOMIC_FIELDS.filter((f) => isNum(inputs.economics[f.key])).map((f) => f.key)
  const hurdlesSet = isNum(inputs.economics.minRetainedCash) && isNum(inputs.economics.minPresentValue)
  const decisions = Object.values(inputs.approvals ?? {}).reduce((n, d) => n + Object.keys(d).length, 0)
  return { entered, hurdlesSet, statesEntered: Object.keys(inputs.states).length, decisions, usingPlaceholders: entered.length < ECONOMIC_FIELDS.length }
}

/** Engine settings: the researched-scores view, with DL3's numbers wherever they have been entered. */
export function settingsFor(inputs) {
  const e = inputs.economics
  const pct = (k) => (isNum(e[k]) ? { [k]: e[k] / 100 } : {})
  return {
    ...RESEARCH_VIEW_SETTINGS,
    ...(inputs.feeDenominator ? { feeDenominator: inputs.feeDenominator } : {}),
    economicsAssumptions: {
      ...pct('dl3Share'), ...pct('deferredShare'), ...pct('discountRate'), ...pct('awardProbability'),
      ...(isNum(e.overheadAndPursuitCosts) ? { overheadAndPursuitCosts: e.overheadAndPursuitCosts } : {}),
    },
    economicsHurdles: {
      ...RESEARCH_VIEW_SETTINGS.economicsHurdles,
      ...(isNum(e.minRetainedCash) ? { minRetainedCash: e.minRetainedCash } : {}),
      ...(isNum(e.minPresentValue) ? { minPresentValue: e.minPresentValue } : {}),
    },
  }
}

/** One reviewer decision applied to a record's proposed judgment. */
function decide(record, criterion, d, who, date) {
  const by = d.by ?? who
  const on = d.on ?? date
  if (criterion === 'venture') {
    if (!record.venture) return record
    if (d.decision === 'reject') {
      const { venture, ...rest } = record
      return { ...rest, ventureRejected: { by, on, note: d.note ?? null, was: venture } }
    }
    return { ...record, venture: { ...record.venture, approvedBy: by, approvedOn: on } }
  }
  const j = record.judgments?.[criterion]
  const judgments = { ...record.judgments }
  if (d.decision === 'reject') {
    delete judgments[criterion]
    return { ...record, judgments, rejected: { ...record.rejected, [criterion]: { by, on, note: d.note ?? null, was: j ?? null } } }
  }
  if (d.decision === 'approve') {
    if (!j) return record
    judgments[criterion] = { ...j, approvedBy: by, approvedOn: on }
  } else {
    const why = d.note ? `: ${d.note}` : ''
    judgments[criterion] = {
      ...j,
      score: d.score,
      evidence: j ? `${j.evidence} DL3 changed the proposed ${j.score} to ${d.score}${why}` : `Scored by DL3${why}`,
      proposedBy: j?.proposedBy ?? by,
      approvedBy: by,
      approvedOn: on,
    }
  }
  return { ...record, judgments }
}

/**
 * Records with DL3's decisions applied: first the reviewer's decisions on proposed scores, then DL3's own
 * per-state answers (ability to execute, sponsor and financing paths), which win over any proposal.
 */
export function applyStateInputs(records, inputs, codeOf, who = 'DL3') {
  const date = (inputs.updatedAt ?? new Date().toISOString()).slice(0, 10)
  return records.map((r) => {
    let out = r
    const decisions = inputs.approvals?.[approvalKey(codeOf(r.state), r.pathway)]
    for (const [c, d] of Object.entries(decisions ?? {})) out = decide(out, c, d, who, date)
    const s = inputs.states[codeOf(r.state)]
    if (!s) return out
    out = { ...out }
    if (s.sponsorPath === true || s.sponsorPath === false) out.sponsorPath = s.sponsorPath
    if (s.financingPath === true || s.financingPath === false) out.financingPath = s.financingPath
    if (Number.isInteger(s.execution)) {
      // A DL3 judgment, approved by DL3 itself (guide 6: "DL3 ability to execute" is DL3's own call).
      out.judgments = {
        ...out.judgments,
        execution: { score: s.execution, evidence: 'DL3’s own assessment of its staffing, partners and capital for this state', proposedBy: who, approvedBy: who, approvedOn: date },
      }
    }
    return out
  })
}

/** Record one decision (or clear it with decision null) and return the new inputs. */
export function withDecision(inputs, code, pathway, criterion, decision, who) {
  const key = approvalKey(code, pathway)
  const current = { ...(inputs.approvals?.[key] ?? {}) }
  if (decision) current[criterion] = { ...decision, by: who, on: new Date().toISOString().slice(0, 10) }
  else delete current[criterion]
  const approvals = { ...inputs.approvals, [key]: current }
  if (Object.keys(current).length === 0) delete approvals[key]
  return { ...inputs, approvals }
}
