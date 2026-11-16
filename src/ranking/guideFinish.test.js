// Checks the pieces that bring the scoring closer to the DL3 guide: the fee denominator (sections 1
// vs 5) and project-size evidence from awards (5D).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildRecords } from './buildData.js'
import { evaluateGates, feeTest, rankRecords } from './engine.js'
import { SETTINGS } from './config.js'

const read = (name) => readFileSync(new URL(`./data/${name}`, import.meta.url), 'utf8')
const files = () => ({
  partcCsv: read('partc.csv'), awardHistoryCsv: read('award_history.csv'), awardsCsv: read('awards.csv'), siteFactsCsv: read('site_facts.csv'),
  programCapsCsv: read('program_caps.csv'), nationalFee: JSON.parse(read('national_fee_screen.json')), inventoryCsv: read('inventory.csv'),
})
const built = buildRecords(files())
const by = Object.fromEntries(built.records.map((r) => [r.id, r]))

// ------------------------------------------------------------------ fee denominator

test('both fee ratios are reported; section 5 (total cost) is the default', () => {
  const t = feeTest(1_800_000, 40_000_000)
  assert.equal(SETTINGS.feeDenominator, 'tdc')
  assert.ok(Math.abs(t.ratio - 0.045) < 1e-12)
  // section 1: 40M - 1.8M fee - 2M land (5%) - 1M reserves (2.5%) = 35.2M -> 5.11%, the research pack's side figure
  assert.ok(Math.abs(t.ratios.net - 1_800_000 / 35_200_000) < 1e-12)
  assert.equal((t.ratios.net * 100).toFixed(2), '5.11')
})

test('the research pack side figures reproduce: Ohio 9% 8.82%, Indiana 4% 14.91% under section 1', () => {
  assert.equal((feeTest(3_000_000, 40_000_000).ratios.net * 100).toFixed(2), '8.82')
  assert.equal((feeTest(4_800_000, 40_000_000).ratios.net * 100).toFixed(2), '14.91')
})

test('switching to section 1 changes which cost the 10% is measured against, and flags flips', () => {
  const net = { ...SETTINGS, feeDenominator: 'net' }
  // $3.8M: 9.5% of total cost (fails) but 3.8 / (40 - 3.8 - 3) = 11.4% of the net cost (passes)
  const base = feeTest(3_800_000, 40_000_000)
  const alt = feeTest(3_800_000, 40_000_000, net)
  assert.deepEqual([base.status, alt.status], ['fail', 'pass'])
  assert.equal(base.denominatorSensitive, true)
  assert.equal(alt.denominatorSensitive, true)
  // Michigan 9% fails either way, so it is not sensitive
  assert.equal(feeTest(1_800_000, 40_000_000).denominatorSensitive, false)
  // exactly 10% still fails under section 1: fee = 10% of (tdc - fee - land - reserves)
  const fee = (0.1 * 40_000_000 * (1 - 0.075)) / 1.1
  assert.equal(feeTest(Math.round(fee * 100) / 100, 40_000_000, net).status, 'fail')
})

test('the gate says which cost it used, shows both ratios, and names a flip', () => {
  const rec = { id: 'x', state: 'X', pathway: '4%', confidence: 'High', approvedGrossFee: 3_800_000, totalDevelopmentCost: 40_000_000 }
  const check = evaluateGates(rec, { asOf: '2026-11-16' }).checks.find((c) => c.key === 'fee')
  assert.match(check.label, /10% of total development cost/)
  // 3.8M / 40M = 9.50%; 3.8M / (40M - 3.8M - 2M land - 1M reserves = 33.2M) = 11.45%
  assert.match(check.detail, /^Fee is 9\.50% of total development cost \(11\.45% of cost less fee, land and reserves\)/)
  assert.match(check.detail, /flips under the other definition/)
  const netCheck = evaluateGates(rec, { asOf: '2026-11-16', settings: { ...SETTINGS, feeDenominator: 'net' } }).checks.find((c) => c.key === 'fee')
  assert.match(netCheck.label, /cost less fee, land and reserves/)
  assert.equal(netCheck.status, 'pass')
})

test('on the 50-state screen, some fee results depend on the denominator, and they are flagged', () => {
  const out = rankRecords(built.records, { asOf: '2026-11-16' })
  const flagged = out.lists.flatMap((l) => [...l.needsVerification, ...l.excluded]).filter((r) => r.gates.checks.find((c) => c.key === 'fee').denominatorSensitive)
  assert.ok(flagged.length > 0)
  assert.ok(flagged.every((r) => r.screenOnly || r.researched))
})

test('a cost increase with the fee unchanged lowers the fee ratio (stress test)', () => {
  const base = rankRecords(built.records, { asOf: '2026-11-16' })
  const dear = rankRecords(built.records, { asOf: '2026-11-16', settings: { costMultiplier: 1.1 } })
  const ratio = (out) => out.lists.find((l) => l.pathway === '4%').needsVerification.find((r) => r.id === 'indiana-4').gates.checks.find((c) => c.key === 'fee').ratio
  assert.ok(Math.abs(ratio(base) - 0.12) < 1e-12)
  assert.ok(Math.abs(ratio(dear) - 4_800_000 / 44_000_000) < 1e-12) // 10.91%, still passes
})

// ------------------------------------------------------- project size from the award list

test('a 101+ unit new-construction award in 2021-2025 shows the program allows that size', () => {
  assert.equal(by['ohio-4'].maxFeasibleUnits, 245)
  assert.match(by['ohio-4'].unitsEvidence, /245-unit new-construction award \(Dering Family Homes, Columbus, 2022\)/)
  const gate = evaluateGates(by['ohio-4'], { asOf: '2026-11-16' }).checks.find((c) => c.key === 'units')
  assert.deepEqual([gate.status, gate.detail], ['pass', by['ohio-4'].unitsEvidence])
})

test('the sheet\'s own value wins, and states with no such award stay unknown', () => {
  assert.equal(by['indiana-4'].maxFeasibleUnits, 234) // from the research sheet, not overwritten
  assert.equal(by['indiana-4'].unitsEvidence, undefined)
  assert.equal(by['indiana-9'].maxFeasibleUnits, null) // largest 9% new construction there is far below 101
  assert.equal(by['ohio-9'].maxFeasibleUnits, null)
  assert.equal(by['michigan-9'].maxFeasibleUnits, null) // Michigan's lists do not state construction type
})

// ------------------------------------------------------------- economics model (5B, 5C)

import { ECONOMICS_TERMS, downsidePasses, economicsModel } from './economics.js'

const near = (a, b, tol = 1) => assert.ok(Math.abs(a - b) <= tol, `${a} should be within ${tol} of ${b}`)

test('the guide\'s own 5C illustration: $4.5M fee, DL3 keeps 60%, 40% deferred -> $1.62M non-deferred cash', () => {
  const m = economicsModel(4_500_000, 40_000_000)
  near(m.retainedFee, 2_700_000)
  near(m.deferredAmount, 1_080_000)
  near(m.nonDeferredCash, 1_620_000)
  near(m.grossFeeToTdc, 0.1125, 1e-12)
  near(m.cash.closing + m.cash.construction + m.cash.completion, 1_620_000)
})

test('present value of expected net receipts, by hand: Indiana 4% at $4.8M', () => {
  const m = economicsModel(4_800_000, 40_000_000)
  // cash 518,400 (yr 1, x0.9) + 691,200 (yr 2, x0.9) + 518,400 (yr 3, x0.9x0.95), deferred 1,152,000 x 0.75 x 0.855
  // repaid evenly in years 4-13, all discounted at 10%
  const df = (y) => 1 / 1.1 ** y
  let pv = 518_400 * 0.9 * df(1) + 691_200 * 0.9 * df(2) + 518_400 * 0.855 * df(3)
  for (let y = 4; y <= 13; y++) pv += ((1_152_000 * 0.75 * 0.855) / 10) * df(y)
  near(m.presentValue, pv)
  near(m.presentValue, 1_612_298)
  near(m.expectedPursuitValue, 0.5 * pv) // the award probability only enters the pursuit value
  // downside: 60% deferred, one year later, 40% repayment
  near(m.downside.nonDeferredCash, 1_152_000)
  near(m.downside.presentValue, 1_018_488)
})

test('overhead and pursuit costs come off once; no expense is counted twice', () => {
  const a = economicsModel(4_800_000, 40_000_000)
  const b = economicsModel(4_800_000, 40_000_000, { ...ECONOMICS_TERMS, overheadAndPursuitCosts: 200_000 })
  near(a.nonDeferredCash - b.nonDeferredCash, 200_000)
  near(a.presentValue - b.presentValue, 200_000)
  near(a.expectedPursuitValue - b.expectedPursuitValue, 200_000)
  assert.equal(economicsModel(null, 40_000_000), null)
})

test('the downside test needs the hurdles; with them it passes or fails on cash and present value', () => {
  const m = economicsModel(4_800_000, 40_000_000)
  assert.equal(downsidePasses(m, { minRetainedCash: null }, false), null)
  assert.equal(downsidePasses(m, { minRetainedCash: 1_000_000 }, false), true)
  assert.equal(downsidePasses(m, { minRetainedCash: 1_000_000, minPresentValue: 1_100_000 }, true), false) // downside PV 1.02M
  assert.equal(downsidePasses(m, { minRetainedCash: 1_000_000, minPresentValue: null }, true), null)
})

test('the economics breakdown is always shown, but in the normal view it never scores Economics', () => {
  const out = rankRecords(built.records, { asOf: '2026-11-16' })
  const r = out.lists.find((l) => l.pathway === '4%').needsVerification.find((x) => x.id === 'indiana-4')
  near(r.economicsDetail.presentValue, 1_612_298)
  assert.equal(r.criteria.economics.status, 'unresolved')
  // and no breakdown is invented for a fee on an unverified rule
  const neb = out.lists.find((l) => l.pathway === '9%').needsVerification.find((x) => x.id === 'nebraska-9')
  assert.equal(neb.economicsDetail, null)
})

test('with both hurdles required (the guide\'s rule) preview can now score Economics fully', () => {
  const out = rankRecords(built.records, { asOf: '2026-11-16', settings: { deriveEconomicsFromFee: true, economicsHurdles: { minRetainedCash: 1_000_000, minPresentValue: 1_000_000 } } })
  const e = out.lists.find((l) => l.pathway === '4%').needsVerification.find((x) => x.id === 'indiana-4').criteria.economics
  assert.deepEqual([e.status, e.score], ['final', 5]) // 1.728M >= 1.5M, 1.61M >= 1.5M, downside 1.15M / 1.02M >= 1M
  assert.doesNotMatch(e.reasons.join(' '), /present-value test not applied/)
})
