// Loads the 50-state fee screen (data/national_fee_screen.json) and fills in the state sheet.
//
// WHAT THIS IS: a draft, fee-only screen taken from the team's dashboard. For every state it has
// the developer fee that each program's rule allows for the guide's example project (120 units,
// $40M total development cost), with the rule text and a source link.
//
// WHAT THIS IS NOT: a ranking input beyond the fee gate. Sponsor path, financing, project size
// and every 0-5 score stay unknown. Rules that keep it honest:
//   - States we researched in depth (Michigan, Ohio, Indiana) are never overwritten.
//   - A state is "Medium" confidence only if its status is Verified AND it passed an independent
//     review (qa CONFIRMED or CORRECTED). Everything else is "Low".
//   - A fee that rests on a rule the dashboard itself calls unverified can fail (and is then held
//     for verification), but it can never pass: unknown rules cannot receive a pass.

import { stateName } from './usStates.js'

const isNum = (x) => typeof x === 'number' && Number.isFinite(x)
const PATHWAYS = ['9%', '4%']

/** Is the fee rule for this state and pathway established well enough to let a fee pass? */
export function feeRuleVerified(row, pathway) {
  const p = row[pathway]
  if (!isNum(p.fee)) return false
  if (row.status !== 'Verified') return false
  if (p.gate_full === 'Needs verification') return false
  if (/rule unverified|no fee percentage found/i.test(p.binding ?? '')) return false
  return true
}

export function feeScreenConfidence(row) {
  return row.status === 'Verified' && (row.qa === 'CONFIRMED' || row.qa === 'CORRECTED') ? 'Medium' : 'Low'
}

/** @returns {{ byState: Map<string, object>, tdc: number, runDate: string, warnings: string[] }} */
export function readFeeScreen(json) {
  const warnings = []
  const tdc = json?.scenario?.tdc
  if (!isNum(tdc) || tdc <= 0) throw new Error('The fee screen has no example project cost (scenario.tdc).')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(json.run_date ?? '')) throw new Error('The fee screen has no run date.')
  if (!Array.isArray(json.national)) throw new Error('The fee screen has no list of states.')

  const byState = new Map()
  for (const row of json.national) {
    const state = stateName(row.state)
    if (!state) { warnings.push(`Fee screen row "${row.state}" is not a state, so it was skipped.`); continue }
    if (byState.has(state)) { warnings.push(`Fee screen lists ${state} twice, so the second row was skipped.`); continue }
    for (const pathway of PATHWAYS) {
      const p = row[pathway]
      if (!p) { warnings.push(`${state} has no ${pathway} entry in the fee screen.`); continue }
      // Internal checks: the dashboard's ratio must be its fee divided by the example cost, and a
      // firm Pass or Fail must agree with the 10% rule.
      if (isNum(p.fee) && isNum(p.ratio_full) && Math.abs(p.fee / tdc - p.ratio_full) > 1e-6) {
        warnings.push(`${state} ${pathway}: the fee screen says ${(p.ratio_full * 100).toFixed(2)}% of cost, but its dollars give ${((p.fee / tdc) * 100).toFixed(2)}%.`)
      }
      if (isNum(p.ratio_full) && ((p.gate_full === 'Pass' && !(p.ratio_full > 0.1)) || (p.gate_full === 'Fail' && p.ratio_full > 0.1))) {
        warnings.push(`${state} ${pathway}: the fee screen says ${p.gate_full} at ${(p.ratio_full * 100).toFixed(2)}%, which contradicts the 10% rule.`)
      }
    }
    if (row.url && !/^https?:\/\//i.test(row.url)) warnings.push(`${state}: the source link is not a web address, so it was ignored.`)
    byState.set(state, row)
  }
  return { byState, tdc, runDate: json.run_date, warnings }
}

/** Fill in the records for states the sheet has not researched; attach the screen to every state. */
export function applyFeeScreen(records, json) {
  const { byState, tdc, runDate, warnings } = readFeeScreen(json)
  const comparison = []
  let filled = 0

  const out = records.map((r) => {
    const row = byState.get(r.state)
    if (!row) return r
    const p = row[r.pathway]
    const screen = {
      source: 'dashboard',
      runDate,
      fee: isNum(p?.fee) ? p.fee : null,
      ratio: isNum(p?.ratio_full) ? p.ratio_full : null,
      binding: p?.binding ?? null,
      ruleVerified: feeRuleVerified(row, r.pathway),
      ruleText: row.rule_text ?? null,
      encoding: row.encoding ?? null,
      url: /^https?:\/\//i.test(row.url ?? '') ? row.url : null,
      status: row.status,
      qa: row.qa,
      confidence: feeScreenConfidence(row),
      perProjectCap: row.per_project_cap ?? null,
      exampleCost: tdc,
    }

    // States researched in depth keep their own numbers; the screen is kept only for comparison.
    if (r.researched) {
      if (screen.fee !== r.approvedGrossFee) comparison.push({ state: r.state, pathway: r.pathway, research: r.approvedGrossFee, dashboard: screen.fee })
      return { ...r, feeScreen: screen }
    }
    if (screen.fee === null) return { ...r, feeScreen: screen } // no fee rule found: stays unresearched

    filled++
    return {
      ...r,
      approvedGrossFee: screen.fee,
      totalDevelopmentCost: tdc,
      criticalSourceDates: [runDate],
      confidence: screen.confidence,
      feeRuleVerified: screen.ruleVerified,
      researched: true,
      screenOnly: true,
      notes: [
        `Fee screen only (draft from the team dashboard, run ${runDate}). Fee is for the guide's example project: 120 units, $${tdc.toLocaleString('en-US')} total development cost; it assumes an eligible base of 75% of cost where the rule needs one.`,
        row.rule_text,
        screen.qa === 'not reviewed' ? 'Not independently reviewed.' : `Independent review: ${screen.qa}.`,
      ].filter(Boolean).join(' '),
      feeScreen: screen,
    }
  })

  return { records: out, warnings, stats: { feeScreenStates: byState.size, feeScreenFilled: filled }, comparison }
}
