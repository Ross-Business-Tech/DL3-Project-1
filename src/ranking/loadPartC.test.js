// Checks that the real data sheet loads correctly and lands where the research report says.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseCsv, recordsFromPartC } from './loadPartC.js'
import { rankRecords } from './engine.js'
import { attachAwardHistory, awardHistoryFromCsv } from './loadAwardHistory.js'
import { parseAwards, recountFromAwards } from './awardAudit.js'

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

const read = (name) => readFileSync(new URL(`./data/${name}`, import.meta.url), 'utf8')

test('the yearly award table loads cleanly and attaches to Michigan, Ohio and Indiana', () => {
  const history = awardHistoryFromCsv(read('award_history.csv'))
  assert.deepEqual(history.warnings, [])
  assert.equal(history.rows.length, 36)
  assert.deepEqual([...new Set(history.rows.map((r) => r.state))].sort(), ['Indiana', 'Michigan', 'Ohio'])
  const attached = attachAwardHistory(records, history.rows)
  assert.deepEqual(attached.warnings, [])
  assert.equal(attached.records.find((r) => r.id === 'indiana-9').awardHistory.length, 6) // 2021-2025 plus 2026 year to date
  assert.equal(attached.records.find((r) => r.id === 'alabama-9').awardHistory, undefined)
})

test('AUDIT: every yearly count that has a number matches a recount from the award-by-award list', () => {
  const { awards, warnings } = parseAwards(read('awards.csv'))
  assert.deepEqual(warnings, [])
  assert.equal(awards.length, 603)
  const recount = recountFromAwards(awards)
  const { rows } = awardHistoryFromCsv(read('award_history.csv'))
  const numeric = rows.filter((r) => r.eligibleAwards !== null)
  assert.equal(numeric.length, 13) // the other 23 of 36 rows are UNKNOWN
  for (const r of numeric) {
    const got = recount.get(`${r.state}|${r.pathway}|${r.year}`)
    assert.deepEqual([got.eligibleAwards, got.awardsAbove100Units], [r.eligibleAwards, r.awardsAbove100Units], `${r.state} ${r.pathway} ${r.year}`)
  }
  // Every sourced row carries a source URL and a retrieval date
  assert.ok(awards.every((a) => a.source.startsWith('http') && a.retrieved))
})

test('AUDIT: counts that are only lower bounds are the ones with awards of unstated construction type', () => {
  const recount = recountFromAwards(parseAwards(read('awards.csv')).awards)
  const { rows } = awardHistoryFromCsv(read('award_history.csv'))
  const lowerBound = rows.filter((r) => r.eligibleAwards !== null && recount.get(`${r.state}|${r.pathway}|${r.year}`).unknownTypeRows > 0)
  // Ohio 9% reports numbers for years that include service-enriched awards of unstated type
  assert.ok(lowerBound.length > 0 && lowerBound.every((r) => r.state === 'Ohio' && r.pathway === '9%'))
})

test('a definition (such as "urban") can be applied to the awards to rebuild the counts', () => {
  const { awards } = parseAwards(read('awards.csv'))
  const all = recountFromAwards(awards).get('Indiana|4%|2025')
  const noAgeRestricted = recountFromAwards(awards, { include: (a) => a.ageRestricted === false }).get('Indiana|4%|2025')
  assert.deepEqual([all.eligibleAwards, all.awardsAbove100Units], [9, 7])
  assert.ok(noAgeRestricted.awardsAbove100Units < all.awardsAbove100Units) // filtering only ever removes awards
})

test('on the real data, the still-needed list shows what each researched state is missing', () => {
  const queue = result.reviewQueue
  assert.deepEqual([...new Set(queue.map((q) => q.state))].sort(), ['Indiana', 'Michigan', 'Ohio'])
  // Indiana 4% has a feasible 234-unit project but no award history: Scale is a range, not a guess
  const scale = queue.find((q) => q.id === 'indiana-4' && q.key === 'scale')
  assert.equal(scale.status, 'bounded')
  assert.match(scale.needs.join(' '), /2021, 2022, 2023, 2024, 2025/)
  // Michigan 4% has no confirmed feasible project size, so its Scale cannot even start
  assert.equal(queue.find((q) => q.id === 'michigan-4' && q.key === 'scale').status, 'unresolved')
  // excluded states (Michigan 9%, Ohio 9%) are not asked for anything
  assert.ok(!queue.some((q) => q.id === 'michigan-9' || q.id === 'ohio-9'))
  // every remaining state's sponsor path is a DL3 question
  assert.ok(queue.filter((q) => q.key === 'sponsor').every((q) => /DL3/.test(q.owner)))
  assert.equal(queue.filter((q) => q.key === 'sponsor').length, 4)
})
