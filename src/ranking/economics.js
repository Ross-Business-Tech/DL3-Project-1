// Developer economics (guide 5B, 5C). Three distinct outcomes, no expense counted twice:
//   1. approved gross fee   what the program allows (from the fee rule; the fee screen or research sheet)
//   2. DL3 retained fee     gross fee x DL3's contractual share
//   3. DL3 fee cash flow    receipts at closing, during construction, at completion, and deferred
//                           repayment later, less DL3's overhead and pursuit costs
// Then the present value of expected net receipts, a downside test, and the expected pursuit value.
//
// The guide says to "model expected pursuit value using explicit scenarios for award probability,
// closing after award, and construction execution" and "do not equate a jurisdiction award rate with
// DL3's win probability". So the present value used for the hurdle is CONDITIONAL on winning (the
// chance of winning belongs to Funding and competition, and counting it here too would double count
// it). The award probability only feeds the separately shown expected pursuit value.
//
// EVERY term below is a placeholder until DL3 sets its own: 60% / 40% are the guide's own
// illustration (5C); the timing, probabilities, discount rate and downside are stand-ins.

export const ECONOMICS_TERMS = {
  dl3Share: 0.6, // guide 5C illustration
  deferredShare: 0.4, // guide 5C illustration
  cashSplit: { closing: 0.3, construction: 0.4, completion: 0.3 }, // placeholder
  years: { closing: 1, construction: 2, completion: 3 }, // years after award; placeholder
  deferredRepaymentYears: [4, 13], // repaid evenly from cash flow over these years; placeholder
  deferredRepaymentProbability: 0.75, // placeholder
  closeProbability: 0.9, // closes after award; placeholder
  completeProbability: 0.95, // construction completes; placeholder
  awardProbability: 0.5, // DL3's own chance of winning, NOT the agency's award rate; placeholder
  discountRate: 0.1, // placeholder
  overheadAndPursuitCosts: 0, // DL3's project overhead and pursuit costs; placeholder
  // Downside test (guide 7A "passes approved downside test"): more of the fee deferred to cover
  // overruns, a one-year delay, and a lower chance the deferred fee is ever repaid. Placeholder.
  downside: { deferredShareIncrease: 0.2, delayYears: 1, deferredRepaymentProbability: 0.4 },
}

const isNum = (x) => typeof x === 'number' && Number.isFinite(x)

function receipts(fee, t, shift = 0, deferredShare = t.deferredShare, repayProbability = t.deferredRepaymentProbability) {
  const retainedFee = fee * t.dl3Share
  const deferred = retainedFee * Math.min(1, Math.max(0, deferredShare))
  const nonDeferred = retainedFee - deferred
  const split = t.cashSplit
  const splitTotal = split.closing + split.construction + split.completion || 1
  const cash = {
    closing: (nonDeferred * split.closing) / splitTotal,
    construction: (nonDeferred * split.construction) / splitTotal,
    completion: (nonDeferred * split.completion) / splitTotal,
  }
  const df = (years) => 1 / (1 + t.discountRate) ** years
  const pClose = t.closeProbability
  const pDone = t.closeProbability * t.completeProbability
  let pv = cash.closing * pClose * df(t.years.closing + shift)
    + cash.construction * pClose * df(t.years.construction + shift)
    + cash.completion * pDone * df(t.years.completion + shift)
  const [from, to] = t.deferredRepaymentYears
  const n = to - from + 1
  for (let y = from; y <= to; y++) pv += ((deferred * repayProbability * pDone) / n) * df(y + shift)
  return { retainedFee, deferred, nonDeferred, cash, pvReceipts: pv }
}

/** The full model for one fee. Returns null when the fee or cost is unknown. */
export function economicsModel(approvedGrossFee, totalDevelopmentCost, terms = ECONOMICS_TERMS) {
  if (!isNum(approvedGrossFee) || !isNum(totalDevelopmentCost) || totalDevelopmentCost <= 0) return null
  const t = { ...ECONOMICS_TERMS, ...terms }
  const base = receipts(approvedGrossFee, t)
  const overhead = t.overheadAndPursuitCosts ?? 0
  const d = t.downside
  const down = receipts(approvedGrossFee, t, d.delayYears, t.deferredShare + d.deferredShareIncrease, d.deferredRepaymentProbability)
  return {
    approvedGrossFee,
    grossFeeToTdc: approvedGrossFee / totalDevelopmentCost,
    retainedFee: base.retainedFee,
    retainedFeeToTdc: base.retainedFee / totalDevelopmentCost,
    cash: base.cash,
    nonDeferredCash: base.nonDeferred - overhead, // cash in hand, net of overhead and pursuit costs
    deferredAmount: base.deferred,
    presentValue: base.pvReceipts - overhead, // PV of expected net receipts, if DL3 wins the award
    expectedPursuitValue: t.awardProbability * base.pvReceipts - overhead, // pursuit costs are spent win or lose
    downside: { nonDeferredCash: down.nonDeferred - overhead, presentValue: down.pvReceipts - overhead },
    terms: t,
  }
}

/** Does the downside case still clear DL3's hurdles? null when the hurdles are not set. */
export function downsidePasses(model, hurdles, requirePresentValue) {
  if (!model || !isNum(hurdles?.minRetainedCash)) return null
  if (requirePresentValue && !isNum(hurdles.minPresentValue)) return null
  return model.downside.nonDeferredCash >= hurdles.minRetainedCash && (!requirePresentValue || model.downside.presentValue >= hurdles.minPresentValue)
}
