// The data pipeline's export (data/pipeline/*): approved rules only; its reviewed facts fill gaps in the score
// (pipelineFacts.js) but never overwrite our own sheet research.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { pipelineFromFiles, attachPipeline } from './loadPipeline.js'
import { buildRecords } from './buildData.js'
import { basisKind, feeFor } from './pipelineFacts.js'

const read = (name) => readFileSync(new URL(`./data/${name}`, import.meta.url), 'utf8')
const real = () => ({
  rulesCsv: read('pipeline/rules.csv'), sourcesCsv: read('pipeline/sources.csv'), costCsv: read('pipeline/cost_per_unit.csv'),
  metroCsv: read('pipeline/states_in_top_msas.csv'), awardsCsv: read('pipeline/awards.csv'),
  manifest: JSON.parse(read('pipeline/manifest.json')),
})
const files = () => ({
  partcCsv: read('partc.csv'), awardHistoryCsv: read('award_history.csv'), awardsCsv: read('awards.csv'), siteFactsCsv: read('site_facts.csv'),
  programCapsCsv: read('program_caps.csv'), nationalFee: JSON.parse(read('national_fee_screen.json')), inventoryCsv: read('inventory.csv'),
})

test('the real export loads with no warnings and only approved rules', () => {
  const p = pipelineFromFiles(real())
  assert.deepEqual(p.warnings, [])
  assert.ok(p.generatedAt && p.stats.approvedRules > 0)
  const all = [...p.byState.values()].flatMap((e) => e.rules)
  assert.equal(all.length, p.stats.approvedRules)
  const rulesCsv = read('pipeline/rules.csv')
  const approvedInFile = rulesCsv.split('\n').filter((l) => /,approved,/.test(l)).length
  assert.ok(all.length <= approvedInFile && /not reviewed/.test(rulesCsv)) // unreviewed rows exist in the file but are dropped
  assert.ok(all.every((r) => r.url === null || /^https?:\/\//.test(r.url)))
})

test('Michigan, Ohio and Indiana carry award rows, metros and documents', () => {
  const p = pipelineFromFiles(real())
  for (const s of ['Michigan', 'Ohio', 'Indiana']) {
    const e = p.byState.get(s)
    assert.ok(e.awards.length > 0, s)
    assert.ok(e.metro?.inTop, s)
    assert.ok(e.documents.length > 0, s)
  }
  assert.ok(p.byState.get('Ohio').costs.some((c) => c.pathway === '9%' && c.median > 100000))
  assert.ok(p.stats.statesOutsideTopMetros.includes('Wyoming'))
})

test('unapproved rules, CHECK rows and unsafe links never come through', () => {
  const rulesCsv = 'state,topic,field,value,review_state,source_url,quote,page\n' +
    'MI,fee_rule,developer_fee_max_percent,15%,approved,https://m.gov/qap.pdf,"fee is 15%",12\n' +
    'MI,fee_rule,deferred_fee_max,50%,not reviewed: do not use in calculations,https://m.gov/qap.pdf,x,3\n' +
    'MI,deadlines,application_deadline,"Feb 1",approved,javascript:alert(1),x,4\n'
  const awardsCsv = 'state,pathway,year,credits_awarded,total_units,notes\n' +
    'MI,9%,2024,1000000,120,"sheet x"\nMI,9%,2024,900000,60,"CHECK: credit type not stated"\nMI,UNKNOWN,2023,5,10,x\n'
  const p = pipelineFromFiles({ rulesCsv, awardsCsv })
  const mi = p.byState.get('Michigan')
  assert.deepEqual(mi.rules.map((r) => [r.field, r.value]), [['developer_fee_max_percent', '15%'], ['application_deadline', 'Feb 1']])
  assert.equal(mi.rules[1].url, null)
  assert.deepEqual(mi.awards.find((a) => a.pathway === '9%'), { pathway: '9%', year: '2024', awards: 1, withCredits: 1, units100: 1 })
  assert.equal(mi.awards.length, 2) // the UNKNOWN-pathway row is kept apart
})

test('a missing column is an error, an empty export is simply empty', () => {
  assert.throws(() => pipelineFromFiles({ rulesCsv: 'state,topic\nMI,fee_rule\n' }), /missing the "field" column/)
  const p = pipelineFromFiles({})
  assert.equal(p.byState.size, 0)
  assert.equal(p.stats.approvedRules, 0)
})

test('our own sheet research is never overwritten; disagreements are listed', () => {
  const without = buildRecords(files())
  const withP = buildRecords({ ...files(), pipelineFiles: real() })
  const pick = (b) => b.records.filter((r) => ['Michigan', 'Ohio', 'Indiana'].includes(r.state))
    .map((r) => JSON.stringify([r.id, r.approvedGrossFee, r.totalDevelopmentCost, r.maxFeasibleUnits, r.feeRuleVerified, r.confidence, r.criticalSourceDates]))
  assert.deepEqual(pick(withP), pick(without))
  // Michigan's approved rules give the same fee as our research; Indiana's do not, and that is listed.
  assert.equal(withP.records.find((r) => r.id === 'michigan-9').pipelineFee.fee, 1_800_000)
  assert.ok(withP.pipelineComparison.some((c) => c.state === 'Indiana'))
  assert.ok(!withP.pipelineComparison.some((c) => c.state === 'Michigan'))
  assert.ok(withP.records.find((r) => r.id === 'michigan-9').pipeline.rules.length > 0)
  assert.equal(without.records.filter((r) => r.pipeline).length, 0)
  assert.equal(attachPipeline([{ state: 'Nowhere' }], new Map())[0].pipeline, undefined)
})

// A state the pipeline collected but nobody researched by hand (California), in the export's own columns.
const RULE_HEAD = 'state,source_id,document,doc_status,topic,field,value,units,applies_to,page,section,quote,review_state,reviewed_on,value_as_extracted,checks,source_url,retrieved,sha256'
const rule = (field, value, { applies = 'both', status = 'final', review = 'approved', retrieved = '2026-11-20' } = {}) =>
  `CA,CA_QAP,CTCAC regulations,${status},fee_rule,${field},"${value}",,${applies},12,,quote,${review},2026-11-21,,,https://www.treasurer.ca.gov/regs.pdf,${retrieved},abc`
const AWARD_HEAD = 'state,pathway,year,project,parent_project,city,total_units,new_construction,age_restricted_or_assisted_living,credits_awarded,round_or_list,source_url,retrieved,notes'
const award = (year, project, units, nc, pathway = '9%') => `CA,${pathway},${year},${project},,Los Angeles,${units},${nc},no,1000000,Round 1,https://www.treasurer.ca.gov/a.pdf,2026-11-20,`
const COST_HEAD = 'state,pathway,year,projects_with_cost,projects_total,median_cost_per_unit,min_cost_per_unit,max_cost_per_unit,median_units,cost_for_100_units_at_median,basis,sources'
const california = (rules, awards = [], costs = ['CA,9%,2025,10,10,600000,400000,800000,80,60000000,total cost / units,CA_AW']) => ({
  rulesCsv: [RULE_HEAD, ...rules].join('\n'), awardsCsv: [AWARD_HEAD, ...awards].join('\n'), costCsv: [COST_HEAD, ...costs].join('\n'),
})
const caRecords = (pf) => buildRecords({ ...files(), pipelineFiles: pf }).records.filter((r) => r.state === 'California')

test('a state with only the draft fee screen is scored from the pipeline\'s approved rules', () => {
  const before = buildRecords(files()).records.find((r) => r.id === 'california-9')
  const ca9 = caRecords(california([rule('developer_fee_max_percent', '15%'), rule('developer_fee_basis', 'total development cost')])).find((r) => r.pathway === '9%')
  assert.equal(ca9.totalDevelopmentCost, 60_000_000) // median cost per unit x 100 units
  assert.equal(ca9.approvedGrossFee, 9_000_000) // 15% of total development cost
  assert.equal(ca9.feeRuleVerified, true)
  assert.equal(ca9.confidence, 'Medium')
  assert.deepEqual(ca9.criticalSourceDates, ['2026-11-20'])
  assert.match(ca9.notes, /reviewer-approved rules/)
  assert.notEqual(ca9.approvedGrossFee, before.approvedGrossFee)
})

test('pipeline fees take the lowest reading, respect caps and the basis, and never pass on a draft', () => {
  const pf = california([
    rule('developer_fee_max_percent', '20%'), rule('developer_fee_max_percent', '12'),
    rule('developer_fee_dollar_cap', '$5,000,000'), rule('developer_fee_basis', 'eligible basis'),
  ])
  const ca9 = caRecords(pf).find((r) => r.pathway === '9%')
  assert.equal(ca9.approvedGrossFee, Math.round(Math.min(0.12 * 0.75 * 60e6, 5e6))) // 12% of 75% of cost
  assert.equal(ca9.confidence, 'Low') // the rules disagree
  assert.ok(ca9.pipelineFee.conflicting)
  const capped = caRecords(california([rule('developer_fee_max_percent', '15%'), rule('developer_fee_dollar_cap', '$2,000,000')])).find((r) => r.pathway === '9%')
  assert.equal(capped.approvedGrossFee, 2_000_000)
  const draft = caRecords(california([rule('developer_fee_max_percent', '15%', { status: 'draft' })])).find((r) => r.pathway === '9%')
  assert.equal(draft.feeRuleVerified, false)
  const pathwayOnly = caRecords(california([rule('developer_fee_max_percent', '15%', { applies: '4%' })]))
  assert.ok(!pathwayOnly.find((r) => r.pathway === '9%').feeFromPipeline)
  assert.ok(pathwayOnly.find((r) => r.pathway === '4%').feeFromPipeline)
  const unreviewed = caRecords(california([rule('developer_fee_max_percent', '15%', { review: 'not reviewed: do not use in calculations' })]))
  assert.ok(unreviewed.every((r) => !r.feeFromPipeline))
})

test('pipeline award lists supply project size and yearly counts, unknown where construction type is missing', () => {
  const pf = california([], [award(2023, 'Big One', 140, 'yes'), award(2023, 'Small', 60, 'yes'), award(2024, 'Mystery', 200, 'UNKNOWN'), award(2019, 'Old Giant', 300, 'yes')])
  const ca9 = caRecords(pf).find((r) => r.pathway === '9%')
  assert.equal(ca9.maxFeasibleUnits, 140) // 2019 is outside 2021-2025
  const y2023 = ca9.awardHistory.find((h) => h.year === 2023)
  assert.deepEqual([y2023.eligibleAwards, y2023.awardsAbove100Units, y2023.fromPipeline], [2, 1, true])
  const y2024 = ca9.awardHistory.find((h) => h.year === 2024)
  assert.deepEqual([y2024.eligibleAwards, y2024.awardsAbove100Units], [null, null])
})

test('fee arithmetic', () => {
  assert.equal(basisKind('eligible basis'), 'eligible-basis')
  assert.equal(basisKind('all other development costs, excluding developer fee'), 'cost-excluding-fee')
  assert.equal(basisKind('Total Development Cost'), 'total-cost')
  assert.equal(basisKind('something else'), 'unknown')
  assert.equal(feeFor(0.15, 'total-cost', 40e6), 6e6)
  assert.equal(Math.round(feeFor(0.15, 'cost-excluding-fee', 40e6)), Math.round(0.15 * 40e6 / 1.15))
  assert.equal(feeFor(0.15, 'eligible-basis', 40e6, 2e6), 2e6)
})

test('the ranking engine passes the pipeline evidence through to the cards', async () => {
  const { rankRecords } = await import('./engine.js')
  const built = buildRecords({ ...files(), pipelineFiles: real() })
  const result = rankRecords(built.records, { asOf: '2026-11-17' })
  const items = JSON.stringify(result.lists, (k, v) => (k === 'pipeline' && v ? `PIPELINE:${v.state}:${v.rules.length}` : v))
  assert.match(items, /PIPELINE:Michigan:\d+/)
})
