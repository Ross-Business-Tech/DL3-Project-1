// Checks the program caps table (what each program allows for one project).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildRecords } from './buildData.js'
import { evaluateGates } from './engine.js'
import { attachProgramCaps, programCapsFromCsv } from './loadProgramCaps.js'

const read = (name) => readFileSync(new URL(`./data/${name}`, import.meta.url), 'utf8')
const HEADER = 'state,pathway,maxCreditPerProject,unitCap,costCap,bondVolumeCap,developerFeeLimit,creditPerUnitAt120,creditPerUnitAt200,source,retrieved,notes\n'
const SRC = 'https://example.org/qap.pdf,2026-11-09'

test('the real caps table loads cleanly and attaches to all six researched rows', () => {
  const { caps, warnings } = programCapsFromCsv(read('program_caps.csv'))
  assert.deepEqual(warnings, []) // includes the check that credit per unit = max credit / 120 and / 200
  assert.equal(caps.length, 6)
  const built = buildRecords({ partcCsv: read('partc.csv'), awardHistoryCsv: read('award_history.csv'), awardsCsv: read('awards.csv'), siteFactsCsv: read('site_facts.csv'), programCapsCsv: read('program_caps.csv') })
  assert.deepEqual(built.warnings, [])
  assert.equal(built.stats.programCapRows, 6)
  assert.deepEqual(built.records.filter((r) => r.programCaps).map((r) => r.id).sort(), ['indiana-4', 'indiana-9', 'michigan-4', 'michigan-9', 'ohio-4', 'ohio-9'])
})

test('plain numbers are read out of the text, and "none stated" is not a cap', () => {
  const by = Object.fromEntries(programCapsFromCsv(read('program_caps.csv')).caps.map((c) => [`${c.state}|${c.pathway}`, c]))
  assert.equal(by['Michigan|9%'].maxCreditPerProject, 1650000) // "1650000 (Open Urban/PSH urban; 1500000 others)"
  assert.equal(by['Indiana|9%'].maxCreditPerProject, 1300000)
  assert.equal(by['Indiana|4%'].bondVolumeCap, 45000000)
  assert.equal(by['Ohio|9%'].creditPerUnitAt120, 15000)
  assert.equal(by['Indiana|4%'].maxCreditPerProject, null)
  assert.ok(Object.values(by).every((c) => c.unitCap === 'none-stated'))
})

test('rows without a source or date are rejected, and bad per-unit arithmetic is flagged', () => {
  const csv = HEADER + [
    `IN,9%,1300000,UNKNOWN,UNKNOWN,UNKNOWN,15%,10000,6500,${SRC},wrong per-unit figure`,
    'OH,9%,1800000,UNKNOWN,UNKNOWN,UNKNOWN,20%,15000,9000,,2026-11-09,no source',
    `OH,4%,UNKNOWN,UNKNOWN,UNKNOWN,UNKNOWN,20%,UNKNOWN,UNKNOWN,https://example.org,not a date`,
  ].join('\n')
  const { caps, warnings } = programCapsFromCsv(csv)
  assert.deepEqual(caps.map((c) => `${c.state} ${c.pathway}`), ['Indiana 9%'])
  assert.match(warnings.join(' '), /1300000 \/ 120 is 10833/)
  assert.match(warnings.join(' '), /no source URL/)
  assert.throws(() => programCapsFromCsv('state,pathway\nIN,9%\n'), /must start with these columns/)
  assert.match(attachProgramCaps([{ state: 'Ohio', pathway: '9%' }], caps).warnings[0], /Indiana 9%/)
})

test('a program that caps projects at 100 units or fewer fails the units gate; no stated cap changes nothing', () => {
  const base = { id: 'x', state: 'X', pathway: '9%', confidence: 'High', maxFeasibleUnits: 140, approvedGrossFee: 4_800_000, totalDevelopmentCost: 40_000_000, sponsorPath: true, financingPath: true, criticalSourceDates: ['2026-11-01'] }
  const gate = (programCaps) => evaluateGates({ ...base, programCaps }, { asOf: '2026-11-09' })
  assert.equal(gate({ unitCap: 75 }).status, 'Fail')
  assert.match(gate({ unitCap: 75 }).checks[0].detail, /caps projects at 75 units/)
  assert.equal(gate({ unitCap: 101 }).status, 'Pass')
  assert.equal(gate({ unitCap: 'none-stated' }).status, 'Pass')
  assert.equal(gate(undefined).status, 'Pass')
})
