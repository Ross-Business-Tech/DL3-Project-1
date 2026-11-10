// Checks PREVIEW mode: placeholder-based scoring that is clearly not a result.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildRecords } from './buildData.js'
import { rankRecords } from './engine.js'

const read = (name) => readFileSync(new URL(`./data/${name}`, import.meta.url), 'utf8')
const built = buildRecords({
  partcCsv: read('partc.csv'), awardHistoryCsv: read('award_history.csv'), awardsCsv: read('awards.csv'),
  siteFactsCsv: read('site_facts.csv'), programCapsCsv: read('program_caps.csv'), nationalFee: JSON.parse(read('national_fee_screen.json')),
})
const PREVIEW = {
  deriveEconomicsFromFee: true,
  requirePresentValue: false,
  economicsHurdles: { minRetainedCash: 1_000_000 },
  fillUnknownScore: 3,
  previewIncludeOpenChecks: true,
}
const run = (settings) => rankRecords(built.records, { asOf: '2026-11-10', settings })
const find = (out, pathway, id) => {
  const l = out.lists.find((x) => x.pathway === pathway)
  return [...l.ranked, ...l.needsVerification, ...l.excluded].find((r) => r.id === id)
}

test('preview is off by default: the normal run still ranks nothing and scores nothing', () => {
  const out = run({})
  for (const l of out.lists) assert.equal(l.ranked.length, 0)
  assert.equal(find(out, '4%', 'indiana-4').criteria.economics.status, 'unresolved')
  assert.ok(!('previewRanked' in out.lists[0].counts))
})

test('Economics is calculated from each state\'s fee: fee x DL3 share x (1 - deferred share) against the cash hurdle', () => {
  const out = run({ deriveEconomicsFromFee: true, requirePresentValue: false, economicsHurdles: { minRetainedCash: 1_000_000 } })
  // Indiana 4%: $4.8M x 60% x 60% = $1,728,000, at least 1.5x the hurdle, but a 5 needs the downside test
  const indiana = find(out, '4%', 'indiana-4').criteria.economics
  assert.deepEqual([indiana.status, indiana.interval], ['bounded', { lo: 3, hi: 5 }])
  // Michigan 4%: $2.1M x 60% x 60% = $756,000, below the hurdle
  assert.deepEqual(find(out, '4%', 'michigan-4').criteria.economics.interval, { lo: 1, hi: 2 })
  assert.match(find(out, '4%', 'indiana-4').criteria.economics.reasons.join(' '), /present-value test not applied/)
})

test('changing the placeholders changes the score; the page can use this to re-score live', () => {
  const at = (hurdle) => find(run({ deriveEconomicsFromFee: true, requirePresentValue: false, economicsHurdles: { minRetainedCash: hurdle } }), '4%', 'indiana-4').criteria.economics
  assert.deepEqual(at(1_000_000).interval, { lo: 3, hi: 5 }) // $1.73M is at least 1.5x $1M
  assert.equal(at(1_500_000).score, 3) // meets $1.5M, but not 1.5x it
  assert.deepEqual(at(2_000_000).interval, { lo: 1, hi: 2 }) // below $2M
  const half = find(run({ deriveEconomicsFromFee: true, requirePresentValue: false, economicsHurdles: { minRetainedCash: 1_000_000 }, economicsAssumptions: { dl3Share: 0.3 } }), '4%', 'indiana-4').criteria.economics
  assert.deepEqual(half.interval, { lo: 1, hi: 2 }) // $4.8M x 30% x 60% = $864,000
})

test('with the present-value test required (the guide\'s rule), cash alone cannot score Economics', () => {
  const out = run({ deriveEconomicsFromFee: true, economicsHurdles: { minRetainedCash: 1_000_000 } })
  const e = find(out, '4%', 'indiana-4').criteria.economics
  assert.equal(e.status, 'bounded')
  assert.deepEqual(e.interval, { lo: 1, hi: 5 })
  assert.ok(e.needs.some((n) => /present-value hurdle/.test(n)))
})

test('a fee on an unverified rule is not turned into an Economics score', () => {
  const out = run({ deriveEconomicsFromFee: true, requirePresentValue: false, economicsHurdles: { minRetainedCash: 1_000_000 } })
  assert.equal(find(out, '9%', 'nebraska-9').criteria.economics.status, 'unresolved') // "rule unverified"
  assert.notEqual(find(out, '9%', 'alabama-9').criteria.economics.status, 'unresolved') // verified and reviewed
})

test('what-if: criteria with no evidence are assumed at the chosen value and labeled as assumptions', () => {
  const out = run(PREVIEW)
  const r = find(out, '4%', 'ohio-4')
  assert.equal(r.criteria.access.status, 'assumed')
  assert.equal(r.criteria.access.method, 'assumed')
  assert.equal(r.criteria.access.score, 3)
  assert.match(r.criteria.access.reasons[0], /What-if only/)
  assert.equal(r.scores.access, 3)
  // real evidence is never overwritten by the assumption
  assert.equal(r.criteria.economics.status, 'bounded')
  assert.notEqual(r.criteria.economics.method, 'assumed')
  // and the open item is still on the still-needed list
  assert.ok(out.reviewQueue.some((q) => q.id === 'ohio-4' && q.key === 'access'))
})

test('preview ranks only states researched in depth with checks still open, never one that failed or a fee-screen-only state', () => {
  const out = run(PREVIEW)
  const nine = out.lists.find((l) => l.pathway === '9%')
  const four = out.lists.find((l) => l.pathway === '4%')
  assert.deepEqual(nine.ranked.map((r) => r.id), ['indiana-9'])
  assert.deepEqual(four.ranked.map((r) => r.id).sort(), ['indiana-4', 'michigan-4', 'ohio-4'])
  assert.ok(!nine.ranked.some((r) => ['michigan-9', 'ohio-9'].includes(r.id))) // failed the fee test on firm evidence
  assert.ok([...nine.ranked, ...four.ranked].every((r) => !r.screenOnly && r.previewOnly && !r.actionable))
  assert.equal(four.counts.previewRanked, 3)
  assert.equal(four.counts.pass, 0)
  assert.ok(!four.needsVerification.some((r) => r.id === 'ohio-4')) // listed under the ranking instead
  assert.match(four.ranked[0].reason, /Preview only: these checks have not cleared/)
})

test('preview result on the real data: Michigan 4% is clearly last; Ohio and Indiana cannot be separated yet', () => {
  const four = run(PREVIEW).lists.find((l) => l.pathway === '4%')
  const by = Object.fromEntries(four.ranked.map((r) => [r.id, r]))
  assert.equal(by['michigan-4'].rank, 3)
  assert.equal(by['ohio-4'].rank, null)
  assert.equal(by['indiana-4'].rank, null)
  assert.deepEqual(by['ohio-4'].rankRange, [1, 2])
  assert.deepEqual(by['indiana-4'].rankRange, [1, 2])
  // Ohio: econ 3-5, the six others assumed 3 -> (25*3 + 20*3 + 15*3 + 10*3 + 10*3 + 10*3 + 10*3) / 5 = 60 up to 70
  assert.ok(Math.abs(by['ohio-4'].score.lo - 60) < 1e-9 && Math.abs(by['ohio-4'].score.hi - 70) < 1e-9)
})

test('evidence coverage never counts what-if assumptions or ranges as evidence', () => {
  const ohio = run(PREVIEW).lists.find((l) => l.pathway === '4%').ranked.find((r) => r.id === 'ohio-4')
  assert.equal(ohio.score.coverage, 0.75) // six criteria hold a number, five of them only assumed
  assert.equal(ohio.evidenceCoverage, 0) // but none of the weight rests on real evidence
  // typed-in scores are evidence
  const typed = rankRecords([{ id: 'x', state: 'X', pathway: '9%', confidence: 'High', maxFeasibleUnits: 140, approvedGrossFee: 4_800_000, totalDevelopmentCost: 40_000_000, sponsorPath: true, financingPath: true, criticalSourceDates: ['2026-11-09'], scores: { economics: 3, funding: 3, access: 3, scale: 3, urban: 3, execution: 3, venture: 3 } }], { asOf: '2026-11-10' })
  assert.equal(typed.lists[0].ranked[0].evidenceCoverage, 1)
})

test('without the what-if assumption, preview scores stay wide ranges and no rank is claimed', () => {
  const four = run({ ...PREVIEW, fillUnknownScore: null }).lists.find((l) => l.pathway === '4%')
  assert.ok(four.ranked.every((r) => r.score.point === null && r.score.hi - r.score.lo > 50))
})
