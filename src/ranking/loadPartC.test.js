// Checks that the real data sheet loads correctly and lands where the research report says.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseCsv, recordsFromPartC } from './loadPartC.js'
import { rankRecords } from './engine.js'

const csv = readFileSync(new URL('./data/partc.csv', import.meta.url), 'utf8')
const { records, warnings, stats } = recordsFromPartC(csv)
const by = Object.fromEntries(records.map((r) => [r.id, r]))
const result = rankRecords(records, { asOf: '2026-11-09' })
const list = (p) => result.lists.find((l) => l.pathway === p)
const where = (id) => {
  for (const l of result.lists) {
    for (const [name, items] of Object.entries({ ranked: l.ranked, needsVerification: l.needsVerification, excluded: l.excluded, benchmark: l.benchmark })) {
      if (items.some((r) => r.id === id)) return name
    }
  }
}

test('the CSV parser handles quotes, commas inside quotes and blank lines', () => {
  assert.deepEqual(parseCsv('a,b\n"x, y","say ""hi"""\n\n'), [['a', 'b'], ['x, y', 'say "hi"']])
})

test('all 100 rows load; the 94 rows with an extra column are repaired, none skipped', () => {
  assert.equal(stats.rows, 100)
  assert.equal(stats.repairedRows, 94)
  assert.equal(stats.skippedRows, 0)
  assert.equal(stats.states, 50)
  assert.equal(new Set(records.map((r) => r.id)).size, 100)
  const alabama = by['alabama-9']
  assert.equal(alabama.confidence, 'Low') // would have been misread as UNKNOWN before the repair
  assert.equal(alabama.sheetText.agencyRetrieved, '2026-11-08')
  assert.equal(alabama.researched, false)
})

test('the sheet is internally consistent (stated fee percentages match the dollar amounts)', () => {
  assert.deepEqual(warnings, [])
})

test('only Michigan, Ohio and Indiana count as researched', () => {
  assert.equal(stats.researchedStates, 3)
  assert.deepEqual(records.filter((r) => r.researched).map((r) => r.id).sort(), ['indiana-4', 'indiana-9', 'michigan-4', 'michigan-9', 'ohio-4', 'ohio-9'])
})

test('Indiana 4% values are read correctly and unknowns stay unknown', () => {
  const r = by['indiana-4']
  assert.equal(r.maxFeasibleUnits, 234)
  assert.equal(r.approvedGrossFee, 4_800_000)
  assert.equal(r.totalDevelopmentCost, 40_000_000)
  assert.equal(r.financingPath, true)
  assert.equal(r.sponsorPath, null)
  assert.equal(r.confidence, 'Medium')
  assert.deepEqual(r.criticalSourceDates, ['2026-11-08', '2026-11-08', '2026-11-08'])
  assert.equal(r.funding.qualifiedApplicationsPerYear, null) // "33 (2025A-C); 37 (2026A-C)" is not an annual number
})

test('no state passes every gate yet, because no sponsor path is confirmed', () => {
  for (const l of result.lists) {
    assert.equal(l.ranked.length, 0)
    assert.equal(l.counts.pass, 0)
  }
  assert.ok(records.every((r) => r.sponsorPath === null))
})

test('Michigan and Ohio 9% fail the fee test; they are excluded', () => {
  assert.equal(where('michigan-9'), 'excluded')
  assert.equal(where('ohio-9'), 'excluded')
  assert.match(list('9%').excluded.find((r) => r.id === 'michigan-9').reason, /4\.50%/)
})

test('a fee failure on low-confidence evidence (Michigan 4%) is held for verification, not excluded', () => {
  assert.equal(where('michigan-4'), 'needsVerification')
  assert.match(list('4%').needsVerification.find((r) => r.id === 'michigan-4').reason, /low confidence/)
})

test('Indiana and Ohio 4% need verification; Illinois is benchmark only; the rest are unresearched', () => {
  assert.equal(where('indiana-4'), 'needsVerification')
  assert.equal(where('ohio-4'), 'needsVerification')
  assert.equal(where('indiana-9'), 'needsVerification')
  assert.equal(where('illinois-9'), 'benchmark')
  assert.equal(where('illinois-4'), 'benchmark')
  assert.deepEqual(list('4%').counts, { total: 49, pass: 0, needsVerification: 49, fail: 0, benchmark: 1 })
  assert.deepEqual(list('9%').counts, { total: 49, pass: 0, needsVerification: 47, fail: 2, benchmark: 1 })
})
