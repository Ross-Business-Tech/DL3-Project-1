// The data pipeline's export (data/pipeline/*): loaded as evidence, approved rules only, never a score change.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { pipelineFromFiles, attachPipeline } from './loadPipeline.js'
import { buildRecords } from './buildData.js'

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

test('attaching the pipeline changes no gate, score or rank', () => {
  const without = buildRecords(files())
  const withP = buildRecords({ ...files(), pipelineFiles: real() })
  const pick = (b) => b.records.map((r) => JSON.stringify([r.id, r.gates, r.criteria, r.score, r.rank, r.confidence]))
  assert.deepEqual(pick(withP), pick(without))
  assert.ok(withP.records.find((r) => r.id === 'michigan-9').pipeline.rules.length > 0)
  assert.equal(without.records.filter((r) => r.pipeline).length, 0)
  assert.equal(attachPipeline([{ state: 'Nowhere' }], new Map())[0].pipeline, undefined)
})

test('the ranking engine passes the pipeline evidence through to the cards', async () => {
  const { rankRecords } = await import('./engine.js')
  const built = buildRecords({ ...files(), pipelineFiles: real() })
  const result = rankRecords(built.records, { asOf: '2026-11-17' })
  const items = JSON.stringify(result.lists, (k, v) => (k === 'pipeline' && v ? `PIPELINE:${v.state}:${v.rules.length}` : v))
  assert.match(items, /PIPELINE:Michigan:\d+/)
})
