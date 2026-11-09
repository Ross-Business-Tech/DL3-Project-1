// How each of the seven criteria gets its 0-5 score (guide sections 6, 7A and 8).
//
// Every criterion returns the same kind of result:
//   { key, score, interval, method, status, reasons[], needs[] }
//
//   status  'final'      a usable score (calculated, or a judgment a person has approved)
//           'bounded'    the evidence only pins the score to a range: interval = { lo, hi }
//           'proposed'   a judgment waiting for a person to approve it (does not count yet)
//           'unresolved' not enough evidence to say anything
//   needs   plain-language list of what would let this criterion be scored
//
// Calculated: Scale, Economics (once DL3 sets its hurdles), Funding (see engine.js).
// Judgment (a person or AI proposes a 0-5 with written evidence, a person approves): Access,
// Urban feasibility, DL3 execution, and Venture Development (average of five factors).
// A score of 1, 2 or 4 always needs written evidence (guide 7A).

const isNum = (x) => typeof x === 'number' && Number.isFinite(x)
const isCount = (x) => Number.isInteger(x) && x >= 0
const isWhole05 = (x) => Number.isInteger(x) && x >= 0 && x <= 5
const isIsoDate = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`))
const hasText = (t) => typeof t === 'string' && t.trim() !== ''

function result(key, fields) {
  return { key, score: null, interval: null, method: 'calculated', status: 'unresolved', reasons: [], needs: [], ...fields }
}

// ------------------------------------------------------------------ Scale (guide 7A)

// 0 = no feasible project above 100 units
// 3 = feasible base case, with isolated large-project awards (100+ unit awards in fewer than 3 of 5 years)
// 5 = feasible base case, with 100+ unit eligible awards in at least 3 of the 5 years
// Only urban, DL3-product awards count (guide 6B), so a year counts only if its row says the
// award counts were filtered that way. Missing years can leave the score as a range.
export function scoreScale(record, settings) {
  const key = 'scale'
  const units = record.maxFeasibleUnits
  if (!isNum(units)) {
    return result(key, {
      reasons: ['It is not known whether a project above 100 units is feasible under the program rules'],
      needs: ['The largest feasible project size under the program rules'],
    })
  }
  if (units < settings.minUnits) {
    return result(key, { score: 0, status: 'final', reasons: [`No feasible project above 100 units (largest feasible: ${units})`] })
  }

  const years = settings.scaleWindowYears
  const strong = settings.scaleStrongYears
  const rows = Array.isArray(record.awardHistory) ? record.awardHistory : []
  const perYear = years.map((year) => {
    const row = rows.find((h) => h.year === year && h.complete !== false)
    if (!row) return { year, state: 'missing' }
    if (row.urbanFiltered !== true) return { year, state: 'unfiltered' }
    if (!isCount(row.awardsAbove100Units)) return { year, state: 'missing' }
    return { year, state: row.awardsAbove100Units > 0 ? 'large' : 'none', count: row.awardsAbove100Units }
  })
  const large = perYear.filter((y) => y.state === 'large').length
  const unknown = perYear.filter((y) => y.state === 'missing' || y.state === 'unfiltered')
  const summary = perYear.map((y) =>
    y.state === 'large' ? `${y.year}: ${y.count} award${y.count === 1 ? '' : 's'} above 100 units`
      : y.state === 'none' ? `${y.year}: none above 100 units`
        : `${y.year}: not known`)
  const needs = []
  if (perYear.some((y) => y.state === 'missing')) {
    needs.push(`Urban award counts above 100 units for ${perYear.filter((y) => y.state === 'missing').map((y) => y.year).join(', ')}`)
  }
  if (perYear.some((y) => y.state === 'unfiltered')) {
    needs.push('Apply the approved urban definition to the award counts (they are not filtered to urban projects yet)')
  }
  const base = [`A project of ${units} units is feasible`, ...summary]

  if (large >= strong) {
    return result(key, { score: 5, status: 'final', reasons: [...base, `Awards above 100 units in ${large} of ${years.length} years`] })
  }
  if (large + unknown.length >= strong) {
    // Not decided yet: the missing years could still push it to 5.
    const lo = large >= 1 ? 3 : 1
    return result(key, {
      interval: { lo, hi: 5 },
      status: 'bounded',
      reasons: [...base, `Could still reach ${strong} of ${years.length} years once the missing years are filled in`],
      needs,
    })
  }
  if (large >= 1) {
    return result(key, {
      score: 3,
      status: 'final',
      reasons: [...base, `Isolated large-project awards: ${large} of ${years.length} years, so it cannot reach ${strong}`],
      needs: [],
    })
  }
  // Feasible on paper, but no 100+ unit award in any year we know: the guide gives no anchor.
  return result(key, {
    interval: { lo: 1, hi: unknown.length > 0 ? 3 : 2 },
    status: 'bounded',
    reasons: [...base, 'Feasible on paper but no 100+ unit awards in the years known: a 1 or 2 needs written evidence'],
    needs: [...needs, 'A reviewer to give a 1 or 2 with written evidence'],
  })
}

// --------------------------------------------------------------- Economics (guide 5B, 7A)

// 0 = no positive retained net fee cash
// 3 = meets DL3's cash and present-value hurdles
// 5 = at least 1.5x both hurdles under base assumptions AND passes the approved downside test
// Inputs (record.economics): retainedNetCash, presentValue, downsidePasses (true / false / null).
export function scoreEconomics(record, settings) {
  const key = 'economics'
  const e = record.economics
  const h = settings.economicsHurdles
  if (!e || !isNum(e.retainedNetCash)) {
    return result(key, {
      reasons: ['DL3’s retained fee cash has not been calculated'],
      needs: ['DL3’s contractual fee share and the fee cash flow for a 120-unit base case (guide 5B-5C)'],
    })
  }
  if (e.retainedNetCash <= 0) {
    return result(key, { score: 0, status: 'final', reasons: ['No positive retained net fee cash'] })
  }
  const needs = []
  if (!isNum(h.minRetainedCash)) needs.push('DL3-approved minimum retained-cash hurdle')
  if (!isNum(h.minPresentValue)) needs.push('DL3-approved present-value hurdle')
  if (!isNum(e.presentValue)) needs.push('Present value of expected fee receipts for this state')
  if (needs.length > 0) {
    return result(key, {
      interval: { lo: 1, hi: 5 },
      status: 'bounded',
      reasons: ['Retained net fee cash is positive, but it cannot be compared with hurdles that are not set yet'],
      needs,
    })
  }
  const meets = e.retainedNetCash >= h.minRetainedCash && e.presentValue >= h.minPresentValue
  if (!meets) {
    return result(key, {
      interval: { lo: 1, hi: 2 },
      status: 'bounded',
      reasons: ['Positive cash but below DL3’s hurdles: a 1 or 2 needs written evidence'],
      needs: ['A reviewer to give a 1 or 2 with written evidence'],
    })
  }
  const m = h.strongMultiple
  const strongEnough = e.retainedNetCash >= m * h.minRetainedCash && e.presentValue >= m * h.minPresentValue
  if (!strongEnough) {
    return result(key, { score: 3, status: 'final', reasons: ['Meets DL3’s cash and present-value hurdles (a 4 would need written evidence)'] })
  }
  if (e.downsidePasses === true) {
    return result(key, { score: 5, status: 'final', reasons: [`At least ${m}x both hurdles, and the approved downside test passes`] })
  }
  if (e.downsidePasses === false) {
    return result(key, { score: 3, status: 'final', reasons: [`Clears ${m}x the hurdles, but fails the approved downside test, so it stays at 3`] })
  }
  return result(key, {
    interval: { lo: 3, hi: 5 },
    status: 'bounded',
    reasons: [`At least ${m}x both hurdles; a 5 also needs the approved downside test`],
    needs: ['The approved downside test result'],
  })
}

// ---------------------------------------- Judgment criteria: Access, Urban, DL3 execution

const JUDGMENT_NEEDS = {
  access: 'Evidence on sponsor eligibility, the partner and the scoring plan (guide 6, 7A)',
  urban: 'Evidence on rents, construction costs, demand and operating feasibility (guide 6, 7A)',
  execution: 'DL3’s staffing, partner and capital plan for this state (guide 6, 7A)',
}

// record.judgments[key] = { score: 0-5, evidence: 'written evidence', proposedBy, approvedBy, approvedOn }
// A judgment counts once a named person has approved it. Until then it is only a proposal.
export function scoreJudgment(record, key) {
  const j = record.judgments?.[key]
  if (!j || j.score === undefined || j.score === null) {
    return result(key, { method: 'judgment', reasons: ['No score has been proposed yet'], needs: [JUDGMENT_NEEDS[key]] })
  }
  if (!isWhole05(j.score)) {
    return result(key, { method: 'judgment', reasons: [`"${j.score}" is not a whole number from 0 to 5`], needs: ['A whole-number score from 0 to 5'] })
  }
  if (!hasText(j.evidence)) {
    return result(key, { method: 'judgment', reasons: ['A score needs written evidence behind it'], needs: ['Written evidence with citations for the proposed score'] })
  }
  const approved = hasText(j.approvedBy) && isIsoDate(j.approvedOn)
  return result(key, {
    method: 'judgment',
    score: j.score,
    status: approved ? 'final' : 'proposed',
    reasons: [`${j.proposedBy ? `Proposed by ${j.proposedBy}` : 'Proposed'}: ${j.evidence}`, approved ? `Approved by ${j.approvedBy} on ${j.approvedOn}` : 'Waiting for a reviewer to approve it'],
    needs: approved ? [] : ['A named reviewer to approve or change the proposed score'],
  })
}

// ------------------------------------------------- Venture Development (guide 8)

export const VENTURE_FACTORS = [
  { key: 'historicSuccess', label: 'Historic success' },
  { key: 'anchorInstitutions', label: 'Anchor institutions' },
  { key: 'availableProperty', label: 'Readily available land or buildings' },
  { key: 'emergingMomentum', label: 'Emerging momentum' },
  { key: 'localLeadership', label: 'Deliberate local leadership' },
]

// Score each of DL3's five factors 0-5 with evidence. Average them only when all five are
// supported; otherwise report an interval (unsupported factors at 0 and at 5).
// record.venture = { <factor>: { score, evidence }, ..., approvedBy, approvedOn }
export function scoreVenture(record) {
  const key = 'venture'
  const v = record.venture
  const supported = []
  const missing = []
  for (const f of VENTURE_FACTORS) {
    const x = v?.[f.key]
    if (x && isWhole05(x.score) && hasText(x.evidence)) supported.push(x.score)
    else missing.push(f.label)
  }
  if (supported.length === 0) {
    return result(key, {
      method: 'judgment',
      reasons: ['None of the five Venture Development factors has a supported score yet'],
      needs: ['Evidence-backed 0-5 scores for the five factors, for named neighborhoods or corridors'],
    })
  }
  const approved = hasText(v.approvedBy) && isIsoDate(v.approvedOn)
  const sum = supported.reduce((a, b) => a + b, 0)
  const approval = approved ? `Approved by ${v.approvedBy} on ${v.approvedOn}` : 'Waiting for a reviewer to approve how the factors were scored'
  const needsApproval = approved ? [] : ['A named reviewer to approve how the factors were scored']
  if (missing.length === 0) {
    return result(key, {
      method: 'judgment',
      score: sum / 5,
      status: approved ? 'final' : 'proposed',
      reasons: [`Average of all five factors: ${(sum / 5).toFixed(1)}`, approval],
      needs: needsApproval,
    })
  }
  return result(key, {
    method: 'judgment',
    interval: { lo: sum / 5, hi: (sum + 5 * missing.length) / 5 },
    status: approved ? 'bounded' : 'proposed',
    reasons: [`${supported.length} of 5 factors supported; missing: ${missing.join(', ')}`, approval],
    needs: [`Evidence for: ${missing.join(', ')}`, ...needsApproval],
  })
}

// ---------------------------------------------------------- Funding (calculated in engine.js)

export function scoreFunding(derived) {
  const key = 'funding'
  if (derived && derived.score !== null && derived.score !== undefined) {
    return result(key, {
      score: derived.score,
      status: 'final',
      reasons: [`Funding index ${derived.index.toFixed(0)} of 100 within the ${derived.pathway} pathway`, ...(derived.note ? [derived.note] : [])],
    })
  }
  return result(key, {
    reasons: [derived?.note ?? 'No award and application counts are available'],
    needs: ['Yearly eligible awards and qualified applications, urban product only'],
  })
}

// Funding needs the average yearly awards and applications. When a state has an award history
// table, those averages come from it (complete years in the window, urban-filtered rows only).
export function fundingFromHistory(record, settings) {
  const rows = (record.awardHistory ?? []).filter(
    (h) => settings.scaleWindowYears.includes(h.year) && h.complete !== false && h.urbanFiltered === true,
  )
  const awards = rows.filter((h) => isCount(h.eligibleAwards))
  const both = rows.filter((h) => isCount(h.eligibleAwards) && isCount(h.qualifiedApplications))
  if (awards.length === 0) return null
  const avg = (list, field) => list.reduce((s, h) => s + h[field], 0) / list.length
  return {
    eligibleAwardsPerYear: avg(awards, 'eligibleAwards'),
    qualifiedApplicationsPerYear: both.length > 0 ? avg(both, 'qualifiedApplications') : null,
    years: awards.map((h) => h.year),
  }
}

// ------------------------------------------------------------------ all seven

export function scoreCriteria(record, settings, derivedFunding) {
  return {
    economics: scoreEconomics(record, settings),
    funding: scoreFunding(derivedFunding),
    access: scoreJudgment(record, 'access'),
    scale: scoreScale(record, settings),
    urban: scoreJudgment(record, 'urban'),
    execution: scoreJudgment(record, 'execution'),
    venture: scoreVenture(record),
  }
}
