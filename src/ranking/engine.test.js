// Run with: npm test
// These check the calculation rules in the DL3 Opportunity Model Guide (sections 5D, 6, 7, 9A).
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applyScoreOverride,
  checkWeights,
  defaultWeights,
  evaluateGates,
  feeEconomics,
  feeTest,
  fundingAccess,
  rankRecords,
  scoreComponents,
} from './engine.js'
import { SAMPLE_AS_OF, SAMPLE_RECORDS } from './sampleData.js'

const AS_OF = '2026-11-08'
const W = defaultWeights()
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} should equal ${b}`)

function rec(overrides = {}) {
  return {
    id: 'x',
    state: 'X',
    pathway: '9%',
    confidence: 'High',
    maxFeasibleUnits: 120,
    approvedGrossFee: 4_800_000,
    totalDevelopmentCost: 40_000_000,
    sponsorPath: true,
    financingPath: true,
    criticalSourceDates: ['2026-10-20'],
    scores: { economics: 3, funding: 3, access: 3, scale: 3, urban: 3, execution: 3, venture: 3 },
    ...overrides,
  }
}
const list = (records, pathway = '9%') => rankRecords(records, { asOf: AS_OF }).lists.find((l) => l.pathway === pathway)

test('weights total 100 and are validated', () => {
  assert.equal(Object.values(W).reduce((a, b) => a + b, 0), 100)
  assert.throws(() => checkWeights({ ...W, economics: 30 }), /total 100/)
})

test("the guide's example: scores 4,3,4,5,3,4,3 give 74/100", () => {
  const scores = { economics: 4, funding: 3, access: 4, scale: 5, urban: 3, execution: 4, venture: 3 }
  const s = scoreComponents(scores, W)
  near(s.point, 74)
  assert.equal(s.coverage, 1)
})

test('100 units fails the gate, 101 passes', () => {
  assert.equal(evaluateGates(rec({ maxFeasibleUnits: 100 }), { asOf: AS_OF }).status, 'Fail')
  assert.equal(evaluateGates(rec({ maxFeasibleUnits: 101 }), { asOf: AS_OF }).status, 'Pass')
})

test('a fee of exactly 10% fails; just above 10% passes', () => {
  assert.equal(feeTest(4_000_000, 40_000_000).status, 'fail')
  assert.equal(feeTest(4_000_000.01, 40_000_000).status, 'pass')
  assert.equal(feeTest(3, 30).status, 'fail') // would be risky with plain floating-point division
  assert.equal(feeTest(null, 40_000_000).status, 'unknown')
})

test("the guide's fee illustration: cap, retained share and deferral", () => {
  const base = { eligibleFeeBase: 30_000_000, feePercent: 15, totalDevelopmentCost: 40_000_000 }
  const capped = feeEconomics({ ...base, cap: 4_000_000 })
  assert.equal(capped.approvedGrossFee, 4_000_000)
  assert.equal(capped.capBinds, true)
  assert.equal(capped.feeTest.status, 'fail') // exactly 10% of $40M
  const uncapped = feeEconomics({ ...base, dl3Share: 0.6, deferredShare: 0.4 })
  near(uncapped.grossFeeToTdc, 0.1125)
  assert.equal(uncapped.feeTest.status, 'pass')
  near(uncapped.nonDeferredReceipts, 1_620_000)
  near(uncapped.deferredAmount, 1_080_000)
})

test('a failed gate is excluded however well it scores; unknown never passes', () => {
  const perfect = { economics: 5, funding: 5, access: 5, scale: 5, urban: 5, execution: 5, venture: 5 }
  const l = list([
    rec({ id: 'fail', state: 'Fail', maxFeasibleUnits: 90, scores: perfect }),
    rec({ id: 'unk', state: 'Unknown', sponsorPath: null, scores: perfect }),
    rec({ id: 'ok', state: 'Ok' }),
  ])
  assert.deepEqual(l.ranked.map((r) => r.id), ['ok'])
  assert.deepEqual(l.excluded.map((r) => r.id), ['fail'])
  assert.deepEqual(l.needsVerification.map((r) => r.id), ['unk'])
  assert.deepEqual(l.counts, { total: 3, pass: 1, needsVerification: 1, fail: 1, benchmark: 0 })
})

test('a failure on low-confidence evidence is held for verification; high-confidence failures are excluded', () => {
  const shortUnits = { maxFeasibleUnits: 90 }
  assert.equal(evaluateGates(rec({ ...shortUnits, confidence: 'High' }), { asOf: AS_OF }).status, 'Fail')
  assert.equal(evaluateGates(rec({ ...shortUnits, confidence: 'Medium' }), { asOf: AS_OF }).status, 'Fail')
  const low = evaluateGates(rec({ ...shortUnits, confidence: 'Low' }), { asOf: AS_OF })
  assert.equal(low.status, 'Needs verification')
  assert.equal(low.lowConfidenceFail, true)
  const l = list([rec({ id: 'lowfail', ...shortUnits, confidence: 'Low' })])
  assert.deepEqual(l.needsVerification.map((r) => r.id), ['lowfail'])
  assert.match(l.needsVerification[0].reason, /low confidence/)
})

test('benchmark-only jurisdictions are kept but never gated, ranked or counted', () => {
  const l = list([rec({ id: 'real', state: 'Real' }), rec({ id: 'bench', state: 'Bench', benchmarkOnly: true })])
  assert.deepEqual(l.ranked.map((r) => r.id), ['real'])
  assert.deepEqual(l.benchmark.map((r) => r.id), ['bench'])
  assert.deepEqual(l.counts, { total: 1, pass: 1, needsVerification: 0, fail: 0, benchmark: 1 })
})

test('a critical source older than 90 days needs verification; 90 days exactly is fine', () => {
  assert.equal(evaluateGates(rec({ criticalSourceDates: ['2026-08-10'] }), { asOf: AS_OF }).status, 'Pass') // 90 days
  assert.equal(evaluateGates(rec({ criticalSourceDates: ['2026-08-09'] }), { asOf: AS_OF }).status, 'Needs verification')
  assert.equal(evaluateGates(rec({ criticalSourceDates: [] }), { asOf: AS_OF }).status, 'Needs verification')
})

test('missing components give an interval and are not re-weighted', () => {
  const s = scoreComponents({ economics: 4, funding: 3, access: 4, scale: 5, urban: 3 }, W) // execution + venture unknown
  near(s.lo, (25 * 4 + 20 * 3 + 15 * 4 + 10 * 5 + 10 * 3) / 5) // 60
  near(s.hi, 60 + 20) // unknown weights 10 + 10 scored at 5
  assert.equal(s.point, null)
  near(s.coverage, 0.8)
  assert.deepEqual(s.unknown, ['execution', 'venture'])
})

test('invalid scores are treated as unknown, and scores of 1, 2 or 4 need evidence', () => {
  const l = list([rec({ scores: { economics: 3.5, funding: 3, access: 4, scale: 3, urban: 3, execution: 3, venture: 3 } })])
  const r = l.ranked[0]
  assert.ok(r.score.unknown.includes('economics'))
  assert.equal(r.warnings.length, 2) // 3.5 is invalid; the 4 has no evidence
})

test('ties share a rank and are flagged; names only set display order', () => {
  const l = list([rec({ id: 'b', state: 'Bravo' }), rec({ id: 'a', state: 'Alpha' }), rec({ id: 'c', state: 'Charlie', scores: { economics: 5, funding: 5, access: 5, scale: 5, urban: 5, execution: 5, venture: 5 } })])
  assert.deepEqual(l.ranked.map((r) => [r.state, r.rank, r.tied]), [
    ['Charlie', 1, false],
    ['Alpha', 2, true],
    ['Bravo', 2, true],
  ])
})

test('an ordinal rank is withheld when missing evidence could change it', () => {
  const full = (id, v) => rec({ id, state: id, scores: { economics: v, funding: v, access: v, scale: v, urban: v, execution: v, venture: v } })
  const partial = rec({ id: 'partial', state: 'partial', scores: { economics: 3, funding: 3, access: 3, scale: 3, urban: 3 } }) // 60..80
  const l = list([full('high', 5), full('mid', 3), full('low', 1), partial])
  const by = Object.fromEntries(l.ranked.map((r) => [r.id, r]))
  assert.equal(by.high.rank, 1) // 100 beats everything, even partial's best case of 80
  assert.equal(by.partial.rank, null) // overlaps "mid" (60), so its place is open
  assert.deepEqual(by.partial.rankRange, [2, 3])
  assert.equal(by.mid.rank, null) // partial could finish above or below it
  assert.equal(by.low.rank, 4) // 20 is below partial's worst case of 60
})

test('9% and 4% are ranked in separate lists', () => {
  const out = rankRecords([rec({ id: 'n9', pathway: '9%' }), rec({ id: 'n4', pathway: '4%' })], { asOf: AS_OF })
  assert.deepEqual(out.lists.map((l) => l.pathway), ['9%', '4%'])
  assert.deepEqual(out.lists.map((l) => l.ranked.map((r) => r.id)), [['n9'], ['n4']])
  assert.ok(out.lists.every((l) => l.ranked.every((r) => r.rank === 1)))
})

test('low-confidence records are ranked but never actionable', () => {
  const l = list([rec({ id: 'low', state: 'low', confidence: 'Low' }), rec({ id: 'hi', state: 'hi', scores: { economics: 2, funding: 2, access: 2, scale: 2, urban: 2, execution: 2, venture: 2 } })])
  assert.equal(l.ranked.find((r) => r.id === 'low').actionable, false)
  assert.deepEqual(l.shortlist.map((r) => r.id), ['hi'])
})

test('the weight stress test flags a ranking that flips and renormalizes to 100', () => {
  // X is stronger on economics (25 pts), Y on venture (10 pts): their order depends on the weights.
  const x = rec({ id: 'x', state: 'X', scores: { economics: 5, funding: 3, access: 3, scale: 3, urban: 3, execution: 3, venture: 0 } })
  const y = rec({ id: 'y', state: 'Y', scores: { economics: 3, funding: 3, access: 3, scale: 3, urban: 3, execution: 3, venture: 5 } })
  const [first, second] = list([x, y]).ranked
  assert.deepEqual([first.id, second.id], ['x', 'y']) // base: X = 62, Y = 58
  assert.ok(first.stability.unstable === false && second.stability.unstable === false) // one-place swaps are within tolerance...
  const strict = rankRecords([x, y], { asOf: AS_OF, settings: { rankShiftTolerance: 0 } }).lists[0].ranked
  assert.ok(strict.every((r) => r.stability.unstable)) // ...but not at zero tolerance
  assert.ok(strict[0].stability.changes.some((c) => c.includes('Developer economics weight -20%')))
})

test('the same input always gives the same output', () => {
  const a = rankRecords(SAMPLE_RECORDS, { asOf: SAMPLE_AS_OF })
  const b = rankRecords(structuredClone(SAMPLE_RECORDS), { asOf: SAMPLE_AS_OF })
  assert.deepEqual(a, b)
})

test('funding index: unknown application counts leave the component unresolved; small samples are disclosed', () => {
  const rows = [
    rec({ id: 'p', funding: { eligibleAwardsPerYear: 20, qualifiedApplicationsPerYear: 20 } }),
    rec({ id: 'q', funding: { eligibleAwardsPerYear: 10, qualifiedApplicationsPerYear: 40 } }),
    rec({ id: 'r', funding: { eligibleAwardsPerYear: 5, qualifiedApplicationsPerYear: null } }),
    rec({ id: 's', funding: { eligibleAwardsPerYear: 0, qualifiedApplicationsPerYear: 10 } }),
  ]
  const f = fundingAccess(rows)
  assert.equal(f.get('r').score, null)
  assert.equal(f.get('p').score, 5) // best volume and best award rate
  assert.equal(f.get('s').score, 0) // no eligible awards
  assert.equal(f.get('p').smallSample, true)
  assert.match(f.get('p').note, /not a national percentile/)
})

test('an override needs an approver, a reason and a date, and is logged', () => {
  const r = rec({ scores: { economics: 3 } })
  assert.throws(() => applyScoreOverride(r, { component: 'economics', score: 4, approver: 'Andrew', reason: '', date: '2026-11-08' }), /reason/)
  assert.throws(() => applyScoreOverride(r, { component: 'economics', score: 9, approver: 'Andrew', reason: 'x', date: '2026-11-08' }), /0 to 5/)
  const o = applyScoreOverride(r, { component: 'economics', score: 4, approver: 'Andrew', reason: 'Confirmed with agency', date: '2026-11-08' })
  assert.equal(o.scores.economics, 4)
  assert.deepEqual(o.overrides, [{ component: 'economics', from: 3, to: 4, approver: 'Andrew', reason: 'Confirmed with agency', date: '2026-11-08' }])
  assert.equal(r.scores.economics, 3) // the original is untouched
})

test('sample data: every record lands in the list the guide says it should', () => {
  const out = rankRecords(SAMPLE_RECORDS, { asOf: SAMPLE_AS_OF })
  const nine = out.lists[0]
  assert.deepEqual(nine.excluded.map((r) => r.id).sort(), ['d-9', 'e-9'])
  assert.deepEqual(nine.needsVerification.map((r) => r.id).sort(), ['f-9', 'g-9'])
  assert.deepEqual(nine.ranked.map((r) => r.id).sort(), ['a-9', 'b-9', 'c-9', 'h-9', 'i-9'])
  const four = out.lists[1]
  assert.deepEqual(four.excluded.map((r) => r.id), ['m-4'])
  assert.deepEqual(four.needsVerification.map((r) => r.id), ['l-4'])
})
