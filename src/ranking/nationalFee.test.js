// Checks the 50-state fee screen (draft, from the team dashboard) and how it is loaded.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildRecords } from './buildData.js'
import { evaluateGates, rankRecords } from './engine.js'
import { applyFeeScreen, feeRuleVerified, feeScreenConfidence, readFeeScreen } from './loadNationalFee.js'
import { recordsFromPartC } from './loadPartC.js'

const read = (name) => readFileSync(new URL(`./data/${name}`, import.meta.url), 'utf8')
const json = JSON.parse(read('national_fee_screen.json'))
const sheet = recordsFromPartC(read('partc.csv')).records
const files = () => ({ partcCsv: read('partc.csv'), awardHistoryCsv: read('award_history.csv'), awardsCsv: read('awards.csv'), siteFactsCsv: read('site_facts.csv'), programCapsCsv: read('program_caps.csv'), nationalFee: json })
const built = buildRecords(files())
const by = Object.fromEntries(built.records.map((r) => [r.id, r]))
const run = (records) => rankRecords(records, { asOf: '2026-11-09' })

test('the fee screen has all 50 states, a run date and an example project, and is internally consistent', () => {
  const { byState, tdc, runDate, warnings } = readFeeScreen(json)
  assert.equal(byState.size, 50)
  assert.equal(tdc, 40_000_000)
  assert.equal(runDate, '2026-11-01')
  assert.deepEqual(warnings, []) // every ratio is fee / cost, and no firm Pass or Fail contradicts the 10% rule
  assert.deepEqual(built.warnings, [])
})

test('only 17 of the 50 states passed an independent review; 30 are marked verified', () => {
  const rows = json.national
  assert.equal(rows.filter((r) => r.status === 'Verified').length, 30)
  assert.equal(rows.filter((r) => r.qa === 'CONFIRMED' || r.qa === 'CORRECTED').length, 17 + 5) // 22 reviewed, 5 of them still unverified
  assert.equal(rows.filter((r) => r.status === 'Verified' && (r.qa === 'CONFIRMED' || r.qa === 'CORRECTED')).length, 17)
})

test('confidence: Medium only when verified AND independently reviewed; everything else is Low', () => {
  const row = (status, qa) => ({ status, qa })
  assert.equal(feeScreenConfidence(row('Verified', 'CONFIRMED')), 'Medium')
  assert.equal(feeScreenConfidence(row('Verified', 'CORRECTED')), 'Medium')
  assert.equal(feeScreenConfidence(row('Verified', 'not reviewed')), 'Low')
  assert.equal(feeScreenConfidence(row('Needs verification', 'CONFIRMED')), 'Low')
  assert.equal(by['alabama-9'].confidence, 'Medium') // Verified + CONFIRMED
  assert.equal(by['arkansas-9'].confidence, 'Low') // Verified, not reviewed
})

test('a fee rule counts as verified only when the state is verified and the pathway has no "rule unverified" note', () => {
  const nebraska = json.national.find((r) => r.state === 'Nebraska')
  assert.equal(nebraska.status, 'Verified')
  assert.equal(feeRuleVerified(nebraska, '9%'), false) // "percentage (rule unverified: combined cap ...)"
  assert.equal(feeRuleVerified(json.national.find((r) => r.state === 'Alabama'), '9%'), true)
  assert.equal(feeRuleVerified(json.national.find((r) => r.state === 'Idaho'), '9%'), false) // no fee found at all
})

test('states researched in depth keep their own numbers; the screen is kept only for comparison', () => {
  assert.equal(by['indiana-4'].approvedGrossFee, 4_800_000) // our research pack, not the dashboard's 4.5M
  assert.equal(by['indiana-4'].confidence, 'Medium')
  assert.equal(by['indiana-4'].screenOnly, undefined)
  assert.equal(by['indiana-4'].feeScreen.fee, 4_500_000)
  assert.equal(by['michigan-9'].approvedGrossFee, 1_800_000)
  assert.equal(by['indiana-9'].approvedGrossFee, null) // the dashboard has a number; our research does not, so it is not borrowed
  assert.equal(by['indiana-9'].screenOnly, undefined)
})

test('the screen and our research differ in exactly these places (so they are visible, not hidden)', () => {
  assert.deepEqual(built.feeComparison, [
    { state: 'Indiana', pathway: '9%', research: null, dashboard: 4_500_000 },
    { state: 'Indiana', pathway: '4%', research: 4_800_000, dashboard: 4_500_000 },
    { state: 'Ohio', pathway: '4%', research: 5_333_333, dashboard: 6_000_000 },
  ])
})

test('states we had not researched get a fee, the example cost and a source date; nothing else is invented', () => {
  const al = by['alabama-9']
  assert.deepEqual([al.approvedGrossFee, al.totalDevelopmentCost, al.criticalSourceDates, al.screenOnly, al.researched], [5_217_391, 40_000_000, ['2026-11-01'], true, true])
  assert.equal(al.sponsorPath, null)
  assert.equal(al.financingPath, null)
  assert.equal(al.maxFeasibleUnits, null)
  assert.match(al.notes, /Fee screen only/)
  assert.match(al.notes, /120 units/)
  assert.match(al.feeScreen.url, /^https:\/\//)
})

test('states with no fee rule found stay unresearched', () => {
  for (const id of ['idaho-9', 'idaho-4', 'oklahoma-9', 'oklahoma-4']) assert.equal(by[id].researched, false)
  assert.equal(by['florida-4'].researched, false) // Florida 9% has a fee, Florida 4% does not
  assert.equal(by['florida-9'].researched, true)
})

test('the fee screen fills 87 of the 100 rows; 6 stay researched in depth and 7 have no fee rule', () => {
  const screenOnly = built.records.filter((r) => r.screenOnly)
  assert.equal(screenOnly.length, 87)
  assert.equal(built.stats.feeScreenFilled, 87)
  assert.equal(built.stats.feeScreenStates, 50)
  assert.equal(built.stats.researchedStates, 3) // still only three states researched in depth
  assert.equal(built.records.filter((r) => r.researched && !r.screenOnly).length, 6)
  assert.equal(built.records.filter((r) => !r.researched).length, 7)
})

test('a fee that passes only on an unverified rule is unknown, never a pass; it can still fail', () => {
  const base = { id: 'x', state: 'X', pathway: '9%', confidence: 'Low', approvedGrossFee: 5_000_000, totalDevelopmentCost: 40_000_000, criticalSourceDates: ['2026-11-01'] }
  const gate = (over) => evaluateGates({ ...base, ...over }, { asOf: '2026-11-09' }).checks.find((c) => c.key === 'fee')
  assert.equal(gate({ feeRuleVerified: true }).status, 'pass')
  assert.equal(gate({}).status, 'pass') // records without the flag behave as before
  assert.equal(gate({ feeRuleVerified: false }).status, 'unknown')
  assert.match(gate({ feeRuleVerified: false }).detail, /not verified yet/)
  assert.equal(gate({ feeRuleVerified: false, approvedGrossFee: 2_000_000 }).status, 'fail')
})

test('after loading, no state can pass every gate, and low-confidence fee failures are held rather than excluded', () => {
  const out = run(built.records)
  for (const l of out.lists) assert.equal(l.counts.pass, 0) // sponsor path, financing and size are unknown everywhere
  // Utah: dashboard says Fail on both, status Needs verification -> Low confidence -> held, not excluded
  assert.equal(by['utah-9'].confidence, 'Low')
  const nine = out.lists.find((l) => l.pathway === '9%')
  assert.ok(nine.needsVerification.some((r) => r.id === 'utah-9'))
  assert.ok(!nine.excluded.some((r) => r.id === 'utah-9'))
  // Arkansas: Verified, not reviewed -> Low too; a fee failure there is also held
  assert.ok(nine.needsVerification.some((r) => r.id === 'arkansas-9'))
  // Alabama: Verified + CONFIRMED, fee passes, but nothing else is known -> needs verification, not ranked
  assert.ok(nine.needsVerification.some((r) => r.id === 'alabama-9'))
  assert.equal(nine.ranked.length, 0)
})

test('only Medium-confidence fee failures are excluded; the rest of the screen is still tallied', () => {
  const out = run(built.records)
  for (const l of out.lists) {
    for (const r of l.excluded) assert.notEqual(r.confidence, 'Low')
    assert.equal(l.counts.total, l.counts.pass + l.counts.needsVerification + l.counts.fail)
  }
})

test('the example project is only an example: applying the screen twice gives the same records', () => {
  const again = applyFeeScreen(sheet, json).records
  assert.deepEqual(again, applyFeeScreen(structuredClone(sheet), structuredClone(json)).records)
})
