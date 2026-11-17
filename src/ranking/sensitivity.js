// Assumption stress tests (guide 7B: "Test fee denominator, costs, deferrals, sharing, and geography").
// The weight test (+/-20% per weight) lives in engine.js. This file re-runs the whole ranking with
// one assumption moved at a time and reports, state by state, what changed: the checks, the fee
// result, Developer economics, or the rank. ("Geography" needs the urban site facts, which are not
// collected yet, so it is not tested here.)

import { rankRecords } from './engine.js'

export function assumptionScenarios(settings) {
  const s = [
    {
      key: 'denominator',
      label: settings.feeDenominator === 'net' ? 'Fee measured against total development cost (section 5)' : 'Fee measured against cost less fee, land and reserves (section 1)',
      settings: { feeDenominator: settings.feeDenominator === 'net' ? 'tdc' : 'net' },
    },
    { key: 'cost', label: 'Development cost 10% higher, fee unchanged', settings: { costMultiplier: (settings.costMultiplier ?? 1) * 1.1 } },
  ]
  if (settings.deriveEconomicsFromFee) {
    const a = settings.economicsAssumptions
    const terms = (patch) => ({ economicsAssumptions: { ...a, ...patch } })
    s.push(
      { key: 'share-down', label: 'DL3 fee share 20% lower', settings: terms({ dl3Share: a.dl3Share * 0.8 }) },
      { key: 'share-up', label: 'DL3 fee share 20% higher', settings: terms({ dl3Share: Math.min(1, a.dl3Share * 1.2) }) },
      { key: 'deferral-up', label: 'Deferred share 20% higher', settings: terms({ deferredShare: Math.min(1, a.deferredShare * 1.2) }) },
      { key: 'deferral-down', label: 'Deferred share 20% lower', settings: terms({ deferredShare: a.deferredShare * 0.8 }) },
    )
  }
  return s
}

function index(result) {
  const m = new Map()
  for (const l of result.lists) {
    for (const [where, items] of [['ranked', l.ranked], ['needsVerification', l.needsVerification], ['excluded', l.excluded]]) {
      for (const r of items) m.set(r.id, { where, r })
    }
  }
  return m
}

const WHERE = { ranked: 'ranked', needsVerification: 'held for verification', excluded: 'excluded' }
const econText = (c) => (c.interval ? `${c.interval.lo}-${c.interval.hi}` : c.score ?? 'unknown')
const rankText = (r) => (r.rank !== null && r.rank !== undefined ? String(r.rank) : r.rankRange ? `${r.rankRange[0]}-${r.rankRange[1]}` : '-')

/** What changes for one state between the base run and a scenario run (plain sentences). */
function differences(b, o) {
  const msgs = []
  const feeB = b.r.gates.checks.find((c) => c.key === 'fee').status
  const feeO = o.r.gates.checks.find((c) => c.key === 'fee').status
  if (feeB !== feeO) msgs.push(`fee check ${feeB} -> ${feeO}`)
  if (b.where !== o.where) msgs.push(`${WHERE[b.where]} -> ${WHERE[o.where]}`)
  const eB = econText(b.r.criteria.economics)
  const eO = econText(o.r.criteria.economics)
  if (String(eB) !== String(eO)) msgs.push(`Developer economics ${eB} -> ${eO}`)
  if (b.where === 'ranked' && o.where === 'ranked' && JSON.stringify(b.r.rankRange) !== JSON.stringify(o.r.rankRange)) {
    msgs.push(`rank ${rankText(b.r)} -> ${rankText(o.r)}`)
  }
  return msgs
}

/**
 * Rank, then re-rank once per scenario, and attach `assumptionChanges` (a list of sentences) to
 * every state in the base result. Same options as rankRecords.
 */
export function withAssumptionSensitivity(records, options = {}) {
  const base = rankRecords(records, options)
  const baseIdx = index(base)
  const changes = new Map([...baseIdx.keys()].map((id) => [id, []]))
  for (const sc of assumptionScenarios(base.settings)) {
    const idx = index(rankRecords(records, { ...options, settings: { ...options.settings, ...sc.settings } }))
    for (const [id, b] of baseIdx) {
      const o = idx.get(id)
      if (!o) continue
      const msgs = differences(b, o)
      if (msgs.length > 0) changes.get(id).push(`${sc.label}: ${msgs.join('; ')}`)
    }
  }
  const tag = (r) => ({ ...r, assumptionChanges: changes.get(r.id) ?? [] })
  return {
    ...base,
    scenarios: assumptionScenarios(base.settings).map((s) => s.label),
    lists: base.lists.map((l) => ({
      ...l,
      ranked: l.ranked.map(tag),
      needsVerification: l.needsVerification.map(tag),
      excluded: l.excluded.map(tag),
      shortlist: l.shortlist.map(tag),
    })),
  }
}

// ------------------------------------------------------------- change report (guide 8B, 10)

/**
 * Compare two ranking runs, state by state: which checks changed, where the state landed, the score,
 * the rank, and Developer economics. Returns [{ id, state, pathway, changes: [sentence] }], only for
 * states where something changed. Used for the quarterly "changes since the last release" report
 * and the refresh demonstration.
 */
export function compareRuns(before, after) {
  const a = index(before)
  const b = index(after)
  const out = []
  for (const [id, x] of a) {
    const y = b.get(id)
    if (!y) continue
    const changes = []
    for (const c of x.r.gates.checks) {
      const d = y.r.gates.checks.find((k) => k.key === c.key)
      if (d && (d.status !== c.status || d.detail !== c.detail)) changes.push(`${c.label}: ${c.status} -> ${d.status} (${d.detail})`)
    }
    if (x.where !== y.where) changes.push(`Now ${WHERE[y.where]} (was ${WHERE[x.where]})`)
    const s = (r) => (r.score.point !== null ? r.score.point.toFixed(1) : `${r.score.lo.toFixed(1)}-${r.score.hi.toFixed(1)}`)
    if (s(x.r) !== s(y.r)) changes.push(`Score ${s(x.r)} -> ${s(y.r)}`)
    if (x.where === 'ranked' && y.where === 'ranked' && JSON.stringify(x.r.rankRange) !== JSON.stringify(y.r.rankRange)) changes.push(`Rank ${rankText(x.r)} -> ${rankText(y.r)}`)
    const ex = x.r.economicsDetail
    const ey = y.r.economicsDetail
    if (ex && ey && Math.round(ex.presentValue) !== Math.round(ey.presentValue)) {
      changes.push(`Fee ${Math.round(ex.approvedGrossFee).toLocaleString('en-US')} -> ${Math.round(ey.approvedGrossFee).toLocaleString('en-US')}; present value of DL3's receipts ${Math.round(ex.presentValue).toLocaleString('en-US')} -> ${Math.round(ey.presentValue).toLocaleString('en-US')} (placeholder terms)`)
    }
    if (changes.length > 0) out.push({ id, state: y.r.state, pathway: y.r.pathway, changes })
  }
  return out.sort((p, q) => p.state.localeCompare(q.state) || p.pathway.localeCompare(q.pathway))
}

/**
 * The refresh demonstration (guide 2, 10): one source changes and the change flows through.
 * It uses the same edit as the scraping pipeline's own refresh test: a developer fee rule going from
 * 15% to 12%. Here it is Indiana's fee rule (15% of eligible basis), so the approved fee scales by 12/15.
 * It is a SIMULATION: nothing in the data files changes.
 */
export function refreshDemo(records, options = {}, { stateName = 'Indiana', from = 15, to = 12 } = {}) {
  const changed = records.map((r) =>
    r.state === stateName && typeof r.approvedGrossFee === 'number' ? { ...r, approvedGrossFee: (r.approvedGrossFee * to) / from } : r,
  )
  const before = rankRecords(records, options)
  const after = rankRecords(changed, options)
  return {
    description: `Simulated source change: ${stateName}'s developer fee rule goes from ${from}% to ${to}% of eligible basis (the same edit the scraping pipeline's refresh test makes). Nothing in the data files changes.`,
    changes: compareRuns(before, after),
  }
}
