// The DL3 state-ranking algorithm (guide sections 5D, 6, 7 and 9A).
//
// Pure functions only: the same input always gives the same output, nothing is random, and
// nothing calls a language model. Pipeline for each record (one state/agency + credit pathway):
//
//   1. Gates (5D)        Pass / Fail / Needs verification. A failed gate is excluded no matter
//                        how well it scores; unknown evidence can never pass.
//   2. Score (7A, 7B)    0-5 per component x weight / 5 = points out of 100. Unknown components
//                        give an interval (unknown = 0 for the low end, 5 for the high end);
//                        known components are never re-weighted.
//   3. Rank (7B)         Separate 9% and 4% lists. Ties share a rank. An ordinal rank is withheld
//                        when the uncertainty could change where the record lands.
//   4. Sensitivity (7B)  Each weight +/-20%, renormalized to 100. Results that move are flagged.

import { COMPONENTS, CRITERIA_OWNERS, GATE_OWNERS, SETTINGS, MODEL_VERSION } from './config.js'
import { fundingFromHistory, scoreCriteria } from './scoring.js'

const EPS = 1e-9
const isNum = (x) => typeof x === 'number' && Number.isFinite(x)
const toCents = (x) => Math.round(x * 100)

// ---------------------------------------------------------------- weights

export function defaultWeights() {
  return Object.fromEntries(COMPONENTS.map((c) => [c.key, c.weight]))
}

export function checkWeights(weights) {
  let total = 0
  for (const { key } of COMPONENTS) {
    const w = weights[key]
    if (!isNum(w) || w < 0) throw new Error(`Weight for "${key}" must be a number of 0 or more.`)
    total += w
  }
  if (Math.abs(total - 100) > 1e-6) throw new Error(`Weights must total 100 (they total ${total}).`)
  return weights
}

function normalizeWeights(weights) {
  const total = COMPONENTS.reduce((sum, { key }) => sum + weights[key], 0)
  return Object.fromEntries(COMPONENTS.map(({ key }) => [key, (weights[key] * 100) / total]))
}

// ------------------------------------------------------- developer economics (section 5)

// Strictly greater than 10% passes; exactly 10% fails. Compared in whole cents so that
// floating-point rounding can never turn 10.0% into 10.0000001%.
export function feeTest(approvedGrossFee, totalDevelopmentCost, settings = SETTINGS) {
  if (!isNum(approvedGrossFee) || !isNum(totalDevelopmentCost) || approvedGrossFee < 0 || totalDevelopmentCost <= 0) {
    return { status: 'unknown', ratio: null }
  }
  const ratio = approvedGrossFee / totalDevelopmentCost
  const passes = toCents(approvedGrossFee) * 100 > toCents(totalDevelopmentCost) * settings.minFeePercent
  return { status: passes ? 'pass' : 'fail', ratio }
}

// Section 5B: three distinct outcomes, without counting any deduction twice.
//   approved gross fee  = eligible fee base x fee % (or the cap, whichever is lower)
//   DL3 retained fee    = gross fee x DL3 share, less other required deductions
//   non-deferred cash   = retained fee x (1 - deferred share), less DL3 overhead and pursuit costs
export function feeEconomics({
  eligibleFeeBase,
  feePercent,
  cap = null,
  totalDevelopmentCost,
  dl3Share = 1,
  deferredShare = 0,
  otherDeductions = 0,
  overheadAndPursuitCosts = 0,
}) {
  const uncapped = (eligibleFeeBase * feePercent) / 100
  const approvedGrossFee = isNum(cap) ? Math.min(uncapped, cap) : uncapped
  const retainedFee = approvedGrossFee * dl3Share - otherDeductions
  const deferredAmount = retainedFee * deferredShare
  const nonDeferredReceipts = retainedFee - deferredAmount
  return {
    approvedGrossFee,
    grossFeeToTdc: approvedGrossFee / totalDevelopmentCost,
    retainedFee,
    retainedFeeToTdc: retainedFee / totalDevelopmentCost,
    deferredAmount,
    nonDeferredReceipts,
    netCashAfterCosts: nonDeferredReceipts - overheadAndPursuitCosts,
    capBinds: isNum(cap) && uncapped > cap,
    feeTest: feeTest(approvedGrossFee, totalDevelopmentCost),
  }
}

// ------------------------------------------------------------------- gates (5D, 9A)

function daysBetween(fromIso, toIso) {
  const a = Date.parse(`${fromIso}T00:00:00Z`)
  const b = Date.parse(`${toIso}T00:00:00Z`)
  return Number.isNaN(a) || Number.isNaN(b) ? null : Math.round((b - a) / 86_400_000)
}

const boolStatus = (v) => (v === true ? 'pass' : v === false ? 'fail' : 'unknown')

export function evaluateGates(record, { asOf, settings = SETTINGS }) {
  const checks = []

  const units = record.maxFeasibleUnits
  const cap = record.programCaps?.unitCap // a number only when the program rules cap project size
  const capped = isNum(cap) && cap < settings.minUnits
  checks.push({
    key: 'units',
    label: `More than 100 units (at least ${settings.minUnits})`,
    status: capped ? 'fail' : isNum(units) ? (units >= settings.minUnits ? 'pass' : 'fail') : 'unknown',
    detail: capped
      ? `The program caps projects at ${cap} units`
      : isNum(units) ? `Largest plausible urban project: ${units} units` : 'Largest feasible project size not known',
  })

  const fee = feeTest(record.approvedGrossFee, record.totalDevelopmentCost, settings)
  // Unknown rules cannot receive a pass (guide 5D): a fee that clears 10% only on a rule that is
  // not verified yet stays unknown. It can still fail, and then it is held for verification.
  const unverifiedPass = fee.status === 'pass' && record.feeRuleVerified === false
  checks.push({
    key: 'fee',
    label: `Developer fee above ${settings.minFeePercent}% of total development cost`,
    ratio: fee.ratio,
    status: unverifiedPass ? 'unknown' : fee.status,
    detail:
      fee.ratio === null
        ? 'Approved fee or development cost missing'
        : unverifiedPass
          ? `Fee would be ${(fee.ratio * 100).toFixed(2)}% of total development cost, but the fee rule is not verified yet`
          : `Fee is ${(fee.ratio * 100).toFixed(2)}% of total development cost`,
  })

  checks.push({
    key: 'sponsor',
    label: 'Eligible sponsor or documented partnership path',
    status: boolStatus(record.sponsorPath),
    detail: record.sponsorPath == null ? 'Not yet confirmed' : record.sponsorPath ? 'Path documented' : 'No path found',
  })

  checks.push({
    key: 'financing',
    label: 'Financing and execution requirements satisfiable',
    status: boolStatus(record.financingPath),
    detail: record.financingPath == null ? 'Not yet confirmed' : record.financingPath ? 'Requirements satisfiable' : 'Requirements cannot be met',
  })

  // Freshness never fails a record; it only blocks a pass until the source is re-checked.
  const dates = Array.isArray(record.criticalSourceDates) ? record.criticalSourceDates : []
  const ages = dates.map((d) => daysBetween(d, asOf))
  const stale = ages.filter((age) => age === null || age > settings.staleAfterDays)
  checks.push({
    key: 'freshness',
    label: `Critical sources retrieved within ${settings.staleAfterDays} days`,
    status: dates.length === 0 || stale.length > 0 ? 'unknown' : 'pass',
    detail:
      dates.length === 0
        ? 'No source retrieval dates recorded'
        : stale.length > 0
          ? `${stale.length} of ${dates.length} critical sources are stale or have an unreadable date`
          : `Oldest source is ${Math.max(...ages)} day${Math.max(...ages) === 1 ? '' : 's'} old`,
  })

  // A failure resting on low-confidence evidence (guide 9A: "critical evidence is missing,
  // conflicting, or stale") is not final, so it is held for verification rather than excluded.
  const failed = checks.some((c) => c.status === 'fail')
  const lowConfidenceFail = failed && record.confidence === 'Low'
  const status =
    failed && !lowConfidenceFail
      ? 'Fail'
      : failed || checks.some((c) => c.status === 'unknown')
        ? 'Needs verification'
        : 'Pass'
  return { status, checks, lowConfidenceFail }
}

// -------------------------------------------------------------------- scoring (7A, 7B)

// A valid score is a whole number from 0 to 5 (Venture Development may be an average, like 3.4).
const isValidScore = (s, comp) => isNum(s) && s >= 0 && s <= 5 && (comp?.fractional === true || Number.isInteger(s))
// A criterion the evidence only pins to a range, such as Scale between 3 and 5.
const isInterval = (s) => s !== null && typeof s === 'object' && isNum(s.lo) && isNum(s.hi) && s.lo >= 0 && s.hi <= 5 && s.lo <= s.hi

// Total = sum(weight x score) / 5. Unknown components are bounded (0 for the low end, 5 for the
// high end), never averaged away; a component known only as a range contributes that range.
export function scoreComponents(scores, weights) {
  let lo = 0
  let hi = 0
  let knownWeight = 0
  let totalWeight = 0
  const unknown = []
  for (const comp of COMPONENTS) {
    const w = weights[comp.key]
    const s = scores?.[comp.key]
    totalWeight += w
    if (isValidScore(s, comp)) {
      lo += (w * s) / 5
      hi += (w * s) / 5
      knownWeight += w
    } else if (isInterval(s)) {
      lo += (w * s.lo) / 5
      hi += (w * s.hi) / 5
      unknown.push(comp.key)
    } else {
      hi += w // unknown scored 5 => weight x 5 / 5
      unknown.push(comp.key)
    }
  }
  return {
    lo,
    hi,
    point: unknown.length === 0 ? lo : null,
    coverage: knownWeight / totalWeight,
    unknown,
  }
}

// 7A: scores of 1, 2 and 4 need written evidence; anything that is not a valid score is ignored.
// Only scores someone typed in are checked: calculated scores explain themselves.
function scoreWarnings(record) {
  const warnings = []
  for (const comp of COMPONENTS) {
    const s = record.scores?.[comp.key]
    if (s === undefined || s === null || isInterval(s)) continue
    if (!isValidScore(s, comp)) warnings.push(`${comp.label}: "${s}" is not a valid 0 to 5 score, so it was treated as unknown`)
    else if ([1, 2, 4].includes(s) && !record.evidence?.[comp.key]) warnings.push(`${comp.label}: a score of ${s} needs written evidence`)
  }
  return warnings
}

// A score typed into the record always wins over a calculated or proposed one.
function enteredResult(comp, value) {
  const base = { key: comp.key, method: 'entered', score: null, interval: null, reasons: [], needs: [] }
  if (isValidScore(value, comp)) return { ...base, score: value, status: 'final', reasons: ['Score entered directly'] }
  if (isInterval(value)) return { ...base, interval: value, status: 'bounded', reasons: ['Range entered directly'] }
  return { ...base, status: 'unresolved', reasons: [value === null ? 'Entered as unknown' : 'Not a valid score, so it was treated as unknown'] }
}

// ------------------------------------------------- funding and competition index (7A)

const percentile = (value, values) => {
  const less = values.filter((v) => v < value).length
  const equal = values.filter((v) => v === value).length
  return ((less + 0.5 * equal) / values.length) * 100
}

// Average of the within-pathway percentiles of (a) eligible award volume and (b) award rate
// (eligible awards / qualified applications). Missing application counts leave the component
// unresolved. Mapping to a 0-5 score follows the anchors: no awards = 0, middle third = 3,
// top third = 5. The bottom third has no anchor in the guide, so it maps to 1 (proposed).
export function fundingAccess(records, settings = SETTINGS) {
  const results = new Map()
  const byPathway = new Map()
  for (const r of records) {
    if (!byPathway.has(r.pathway)) byPathway.set(r.pathway, [])
    byPathway.get(r.pathway).push(r)
  }
  for (const [pathway, group] of byPathway) {
    const rows = group.map((r) => {
      const volume = r.funding?.eligibleAwardsPerYear
      const apps = r.funding?.qualifiedApplicationsPerYear
      const rate = isNum(volume) && isNum(apps) && apps > 0 ? volume / apps : null
      return { id: r.id, volume: isNum(volume) ? volume : null, rate }
    })
    const volumes = rows.filter((x) => x.volume !== null).map((x) => x.volume)
    const rates = rows.filter((x) => x.rate !== null).map((x) => x.rate)
    for (const row of rows) {
      const universe = volumes.length
      const smallSample = universe < settings.smallSampleBelow
      const base = { pathway, universe, smallSample, awardRate: row.rate }
      if (row.volume === null || row.rate === null) {
        results.set(row.id, { ...base, index: null, score: null, note: 'Award or application counts missing, so this component is unresolved' })
        continue
      }
      const index = (percentile(row.volume, volumes) + percentile(row.rate, rates)) / 2
      const score = row.volume === 0 ? 0 : index >= 200 / 3 ? 5 : index >= 100 / 3 ? 3 : 1
      results.set(row.id, {
        ...base,
        index,
        score,
        note: smallSample ? `Percentiles come from only ${universe} jurisdictions in the ${pathway} pathway, which is not a national percentile` : null,
      })
    }
  }
  return results
}

// When a state has no funding counts of its own but does have a yearly award history, take the
// averages from that table (complete years only, urban-filtered rows only).
function withHistoryFunding(record, settings) {
  const f = record.funding
  if (f && (isNum(f.eligibleAwardsPerYear) || isNum(f.qualifiedApplicationsPerYear))) return record
  const fromHistory = fundingFromHistory(record, settings)
  return fromHistory ? { ...record, funding: fromHistory } : record
}

// What is still needed to finish scoring, for researched states only (the unresearched ones
// would bury the list): open criteria and open gate checks, with who can supply each.
// States that already failed a gate are left out: nobody needs to score an excluded state.
function buildReviewQueue(assessed) {
  const queue = []
  for (const a of assessed) {
    if (a.benchmarkOnly || !a.researched || a.screenOnly || a.gates.status === 'Fail') continue
    for (const comp of COMPONENTS) {
      const c = a.criteria[comp.key]
      if (c.status === 'final') continue
      queue.push({
        id: a.id, state: a.state, pathway: a.pathway, kind: 'criterion', key: comp.key, item: comp.label,
        owner: CRITERIA_OWNERS[comp.key], status: c.status, needs: c.needs, reasons: c.reasons,
      })
    }
    for (const check of a.gates.checks) {
      const open = check.status === 'unknown' || (check.status === 'fail' && a.gates.lowConfidenceFail)
      if (!open) continue
      queue.push({
        id: a.id, state: a.state, pathway: a.pathway, kind: 'gate', key: check.key, item: check.label,
        owner: GATE_OWNERS[check.key], status: check.status === 'fail' ? 'low-confidence fail' : 'unknown',
        needs: [check.detail], reasons: [],
      })
    }
  }
  return queue.sort((x, y) => x.owner.localeCompare(y.owner) || x.state.localeCompare(y.state) || x.pathway.localeCompare(y.pathway))
}

// ------------------------------------------------------------ ranking (7B)

// For each record work out the best and worst place it could finish given its score interval.
// A record whose best and worst place agree gets an ordinal rank (ties share it); otherwise the
// rank is withheld and the range is reported instead.
function positionPool(entries, settings) {
  const out = new Map()
  for (const r of entries) {
    let definitelyAbove = 0
    let possiblyAbove = 0
    let tied = false
    for (const o of entries) {
      if (o === r) continue
      if (o.lo > r.hi + EPS) definitelyAbove++
      if (o.hi > r.lo + EPS) possiblyAbove++
      if (r.point !== null && o.point !== null && Math.abs(o.point - r.point) <= EPS) tied = true
    }
    const best = 1 + definitelyAbove
    const worst = 1 + possiblyAbove
    out.set(r.id, {
      best,
      worst,
      rank: best === worst ? best : null,
      tied,
      shortlistStatus: worst <= settings.shortlistSize ? 'in' : best > settings.shortlistSize ? 'out' : 'uncertain',
    })
  }
  return out
}

// Section 7B: vary each weight by +/-20%, renormalize to 100, and see what moves.
function sensitivityScenarios(weights, settings) {
  const scenarios = []
  for (const { key, label } of COMPONENTS) {
    for (const [direction, factor] of [['up', 1 + settings.weightShock], ['down', 1 - settings.weightShock]]) {
      scenarios.push({
        label: `${label} weight ${direction === 'up' ? '+' : '-'}${Math.round(settings.weightShock * 100)}%`,
        weights: normalizeWeights({ ...weights, [key]: weights[key] * factor }),
      })
    }
  }
  return scenarios
}

function rankPool(assessed, weights, settings) {
  const entries = assessed.map((a) => ({ id: a.id, ...scoreComponents(a.scores, weights) }))
  return positionPool(entries, settings)
}

function describeUnknown(keys) {
  return keys.map((k) => COMPONENTS.find((c) => c.key === k).label).join(', ')
}

// What is still open on a record held for verification: unknown checks, plus any failure that
// rests on low-confidence evidence.
function openChecksText(a) {
  const parts = a.gates.checks.filter((c) => c.status === 'unknown').map((c) => `${c.label}: ${c.detail}`)
  if (a.gates.lowConfidenceFail) {
    const fails = a.gates.checks.filter((c) => c.status === 'fail').map((c) => c.detail)
    parts.unshift(`Fails on current data (${fails.join('; ')}) but the evidence is low confidence, so it cannot be excluded yet`)
  }
  return parts.join('; ')
}

// ------------------------------------------------------------- the main entry point

/**
 * Rank a list of records.
 *
 * Each record is one allocating jurisdiction + credit pathway:
 *   { id, state, pathway: '9%' | '4%', allocator, confidence: 'High'|'Medium'|'Low',
 *     maxFeasibleUnits, approvedGrossFee, totalDevelopmentCost, sponsorPath, financingPath,
 *     criticalSourceDates: ['2026-10-20', ...],
 *
 *   How each 0-5 criterion gets its score (see scoring.js). In order of precedence:
 *     scores: { economics, funding, access, scale, urban, execution, venture }
 *         a score typed in directly (whole 0-5, null = unknown); always wins
 *     awardHistory: [{ year, yearComplete, eligibleAwards, awardsAbove100, qualifiedApplications, urbanFiltered }]
 *         -> Scale (and, if `funding` is absent, Funding) are calculated from it
 *     funding: { eligibleAwardsPerYear, qualifiedApplicationsPerYear } -> Funding is calculated
 *     economics: { retainedNetCash, presentValue, downsidePasses } -> Economics, once DL3's hurdles are set
 *     judgments: { access|urban|execution: { score, evidence, proposedBy, approvedBy, approvedOn } }
 *     venture: { <five factors>: { score, evidence }, approvedBy, approvedOn }
 *     evidence: { <component>: 'written evidence' }   // for typed-in scores of 1, 2 or 4
 *     nextDeadline, recommendedAction, overrides: [] }
 *
 * options: { asOf: 'YYYY-MM-DD', weights, settings }
 */
export function rankRecords(records, options = {}) {
  const settings = {
    ...SETTINGS,
    ...options.settings,
    economicsHurdles: { ...SETTINGS.economicsHurdles, ...options.settings?.economicsHurdles },
  }
  const weights = checkWeights(options.weights ?? defaultWeights())
  const asOf = options.asOf ?? new Date().toISOString().slice(0, 10)

  const prepared = records.map((r) => withHistoryFunding(r, settings))
  const fundingByRecord = fundingAccess(prepared, settings)
  const assessed = prepared.map((r) => {
    const gates = evaluateGates(r, { asOf, settings })

    // One 0-5 result per criterion; what feeds the ranking is the usable part of each.
    const funding = fundingByRecord.get(r.id)
    const criteria = scoreCriteria(r, settings, funding)
    const scores = {}
    for (const comp of COMPONENTS) {
      const typed = r.scores?.[comp.key]
      if (typed !== undefined) {
        criteria[comp.key] = enteredResult(comp, typed)
        scores[comp.key] = typed
        continue
      }
      const c = criteria[comp.key]
      const counts = c.status === 'final' || c.status === 'bounded' || (c.status === 'proposed' && settings.countProposed)
      scores[comp.key] = counts ? (c.interval ?? c.score) : null
    }

    return {
      id: r.id,
      state: r.state,
      pathway: r.pathway,
      allocator: r.allocator ?? null,
      confidence: r.confidence ?? 'Low',
      nextDeadline: r.nextDeadline ?? null,
      recommendedAction: r.recommendedAction ?? null,
      scores,
      criteria,
      evidence: r.evidence ?? {},
      derived: r.scores?.funding === undefined && funding ? { ...r.derived, funding } : (r.derived ?? {}),
      overrides: r.overrides ?? [],
      notes: r.notes ?? null,
      programCaps: r.programCaps ?? null,
      feeScreen: r.feeScreen ?? null,
      screenOnly: r.screenOnly === true,
      researched: r.researched ?? true,
      benchmarkOnly: r.benchmarkOnly === true,
      gates,
      score: scoreComponents(scores, weights),
      warnings: scoreWarnings(r),
    }
  })

  const pathways = [...new Set(assessed.map((a) => a.pathway))].sort().reverse() // '9%' before '4%'
  const lists = pathways.map((pathway) => {
    // Benchmark-only jurisdictions (the guide's Illinois) are researched but never ranked.
    const group = assessed.filter((a) => a.pathway === pathway && !a.benchmarkOnly)
    const pool = group.filter((a) => a.gates.status === 'Pass')
    const benchmark = assessed
      .filter((a) => a.pathway === pathway && a.benchmarkOnly)
      .map((a) => ({
        ...a,
        reason: 'Benchmark only: excluded from the active new-development shortlist (guide section 1)',
        action: 'Research for benchmarking and rule changes only',
        date: asOf,
      }))
      .sort((a, b) => a.state.localeCompare(b.state))
    const position = positionPool(
      pool.map((a) => ({ id: a.id, ...a.score })),
      settings,
    )

    const scenarioResults = sensitivityScenarios(weights, settings).map((s) => ({
      label: s.label,
      positions: rankPool(pool, s.weights, settings),
    }))

    const ranked = pool
      .map((a) => {
        const pos = position.get(a.id)
        const changes = []
        for (const s of scenarioResults) {
          const p = s.positions.get(a.id)
          if (p.shortlistStatus !== pos.shortlistStatus) changes.push(`${s.label}: shortlist status becomes "${p.shortlistStatus}"`)
          else if (pos.rank !== null && p.rank === null) changes.push(`${s.label}: rank can no longer be fixed`)
          else if (pos.rank !== null && p.rank !== null && Math.abs(p.rank - pos.rank) > settings.rankShiftTolerance) {
            changes.push(`${s.label}: rank moves from ${pos.rank} to ${p.rank}`)
          }
        }
        const overridden = a.overrides.length > 0
        const actionable = pos.shortlistStatus === 'in' && pos.rank !== null && a.confidence !== 'Low'
        let reason
        let action
        if (actionable) {
          reason = `Passes all gates; ranked ${pos.rank}${pos.tied ? ' (tied)' : ''} in the ${pathway} list`
          action = a.recommendedAction ?? 'Prepare a review profile'
        } else if (a.confidence === 'Low' && pos.shortlistStatus === 'in') {
          reason = 'Would make the shortlist, but low-confidence records cannot be actionable'
          action = 'Raise evidence quality before pursuing'
        } else if (pos.shortlistStatus === 'out') {
          reason = 'Passes all gates but ranks below the shortlist'
          action = 'Monitor'
        } else if (a.score.unknown.length > 0) {
          reason = `Missing evidence (${describeUnknown(a.score.unknown)}) means the rank cannot be fixed yet`
          action = `Fill in: ${describeUnknown(a.score.unknown)}`
        } else {
          reason = 'Missing evidence on another jurisdiction means this rank cannot be fixed yet'
          action = 'Complete the other jurisdictions’ evidence'
        }
        return {
          ...a,
          rank: pos.rank,
          rankRange: [pos.best, pos.worst],
          tied: pos.tied,
          shortlistStatus: pos.shortlistStatus,
          provisional: a.score.point === null,
          actionable,
          overridden,
          stability: { unstable: changes.length > 0, changes },
          reason,
          action,
          date: asOf,
        }
      })
      .sort(
        (a, b) =>
          b.score.lo - a.score.lo || b.score.hi - a.score.hi || a.state.localeCompare(b.state),
      )

    const needsVerification = group
      .filter((a) => a.gates.status === 'Needs verification')
      .map((a) => ({
        ...a,
        reason: openChecksText(a),
        action: 'Verify the missing or stale evidence before scoring',
        date: asOf,
      }))
      .sort((a, b) => a.state.localeCompare(b.state))

    const excluded = group
      .filter((a) => a.gates.status === 'Fail')
      .map((a) => ({
        ...a,
        reason: a.gates.checks.filter((c) => c.status === 'fail').map((c) => c.detail).join('; '),
        action: 'Excluded; keep in the coverage report',
        date: asOf,
      }))
      .sort((a, b) => a.state.localeCompare(b.state))

    return {
      pathway,
      ranked,
      shortlist: ranked.filter((r) => r.actionable),
      needsVerification,
      excluded,
      benchmark,
      counts: {
        total: group.length,
        pass: pool.length,
        needsVerification: needsVerification.length,
        fail: excluded.length,
        benchmark: benchmark.length,
      },
    }
  })

  return { modelVersion: MODEL_VERSION, asOf, weights, settings, lists, reviewQueue: buildReviewQueue(assessed) }
}

// ----------------------------------------------------- overrides (7B: "log overrides")

// Returns a copy of the record with one component score changed and the change logged with
// who approved it, why, and when. Overrides are never applied silently.
export function applyScoreOverride(record, { component, score, approver, reason, date }) {
  if (!COMPONENTS.some((c) => c.key === component)) throw new Error(`Unknown component "${component}".`)
  if (!isValidScore(score)) throw new Error('An override score must be a whole number from 0 to 5.')
  for (const [name, value] of Object.entries({ approver, reason, date })) {
    if (typeof value !== 'string' || value.trim() === '') throw new Error(`An override needs a ${name}.`)
  }
  if (Number.isNaN(Date.parse(`${date}T00:00:00Z`))) throw new Error('An override date must look like 2026-11-08.')
  return {
    ...record,
    scores: { ...record.scores, [component]: score },
    overrides: [...(record.overrides ?? []), { component, from: record.scores?.[component] ?? null, to: score, approver, reason, date }],
  }
}
