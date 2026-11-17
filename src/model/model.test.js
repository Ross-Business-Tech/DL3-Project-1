// The final site's data layer: DL3 inputs, the territory list, and running the pipeline from the site.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { buildRecords } from '../ranking/buildData.js'
import { withAssumptionSensitivity } from '../ranking/sensitivity.js'
import { applyStateInputs, inputStatus, sanitize, settingsFor, emptyInputs, loadInputs, saveInputs, STORAGE_KEY } from './dl3Inputs.js'
import { buildTerritories, codeOf, sourcesFromCsv, overviewStats } from './territories.js'
import { cleanStates, dispatchBody, fetchNewerResults, looksLikeKey, sealKeys, summarizeRuns, plainStatus } from './pipelineRun.js'

const data = new URL('../ranking/data/', import.meta.url)
const read = (name) => readFileSync(new URL(name, data), 'utf8')
const researchFiles = readdirSync(new URL('research/', data)).filter((f) => f.endsWith('.json')).map((name) => ({ name, json: JSON.parse(read(`research/${name}`)) }))
const pipelineFiles = {
  rulesCsv: read('pipeline/rules.csv'), sourcesCsv: read('pipeline/sources.csv'), costCsv: read('pipeline/cost_per_unit.csv'),
  metroCsv: read('pipeline/states_in_top_msas.csv'), awardsCsv: read('pipeline/awards.csv'), manifest: JSON.parse(read('pipeline/manifest.json')),
}
const built = buildRecords({
  partcCsv: read('partc.csv'), awardHistoryCsv: read('award_history.csv'), awardsCsv: read('awards.csv'), siteFactsCsv: read('site_facts.csv'),
  programCapsCsv: read('program_caps.csv'), nationalFee: JSON.parse(read('national_fee_screen.json')), inventoryCsv: read('inventory.csv'), researchFiles, pipelineFiles,
})
const AS_OF = '2026-11-17'
const territoriesWith = (inputs) => {
  const records = applyStateInputs(built.records, inputs, codeOf, 'DL3 test')
  return buildTerritories(withAssumptionSensitivity(records, { asOf: AS_OF, settings: settingsFor(inputs) }), records)
}

// ------------------------------------------------------------------ DL3 inputs

test('DL3 inputs: bad values from storage or a file are dropped', () => {
  const s = sanitize({
    economics: { dl3Share: 55, deferredShare: 140, discountRate: 'x', minRetainedCash: '750000', evil: 1 },
    feeDenominator: 'gross', states: { MI: { execution: 4, sponsorPath: true, extra: 1 }, OH: { execution: 9 }, 'x<y': { execution: 1 } },
  })
  assert.deepEqual(s.economics, { dl3Share: 55, minRetainedCash: 750000 })
  assert.equal(s.feeDenominator, null)
  assert.deepEqual(s.states, { MI: { execution: 4, sponsorPath: true } })
})

test('DL3 inputs: kept in browser storage and nowhere else', () => {
  const store = new Map()
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) }
  saveInputs({ economics: { dl3Share: 50 }, states: {} }, storage)
  assert.deepEqual([...store.keys()], [STORAGE_KEY])
  assert.equal(loadInputs(storage).economics.dl3Share, 50)
  assert.deepEqual(loadInputs({ getItem: () => '{broken' }), emptyInputs())
  assert.deepEqual(loadInputs({ getItem: () => { throw new Error('blocked') } }), emptyInputs())
})

test('DL3 inputs: percentages and hurdles reach the engine; placeholders stay where nothing was entered', () => {
  const st = settingsFor(sanitize({ economics: { dl3Share: 50, minRetainedCash: 2000000, overheadAndPursuitCosts: 25000 }, feeDenominator: 'net' }))
  assert.equal(st.economicsAssumptions.dl3Share, 0.5)
  assert.equal(st.economicsAssumptions.overheadAndPursuitCosts, 25000)
  assert.equal(st.economicsAssumptions.deferredShare, undefined) // engine fills the placeholder
  assert.deepEqual([st.economicsHurdles.minRetainedCash, st.economicsHurdles.minPresentValue], [2000000, 1000000])
  assert.equal(st.feeDenominator, 'net')
  assert.equal(inputStatus(sanitize({ economics: { dl3Share: 50 } })).usingPlaceholders, true)
})

test('DL3 inputs change scores: a stricter cash hurdle never raises an estimate', () => {
  const base = territoriesWith(emptyInputs())
  const strict = territoriesWith(sanitize({ economics: { minRetainedCash: 50_000_000, minPresentValue: 50_000_000 } }))
  const est = (list, id) => list.find((t) => t.id === id).estimate
  for (const id of ['MI', 'OH', 'IN']) {
    if (est(base, id) !== null && est(strict, id) !== null) assert.ok(est(strict, id) <= est(base, id), id)
  }
  assert.ok(['MI', 'OH', 'IN'].some((id) => est(strict, id) !== est(base, id)), 'the hurdle should matter somewhere')
})

test('DL3 per-state judgments: execution becomes an approved DL3 score; paths clear their checks', () => {
  const inputs = sanitize({ states: { IN: { execution: 5, sponsorPath: true, financingPath: true } } })
  const recs = applyStateInputs(built.records, inputs, codeOf, 'DL3 test').filter((r) => r.state === 'Indiana')
  assert.ok(recs.length > 0)
  for (const r of recs) {
    assert.equal(r.judgments.execution.score, 5)
    assert.equal(r.judgments.execution.approvedBy, 'DL3 test')
    assert.deepEqual([r.sponsorPath, r.financingPath], [true, true])
  }
  const indiana = territoriesWith(inputs).find((t) => t.id === 'IN')
  const checks = indiana.pathways.flatMap((p) => p.checksList)
  assert.ok(checks.filter((c) => /sponsor/i.test(c.label)).every((c) => c.status === 'pass'))
  assert.ok(indiana.pathways.some((p) => p.criteria.execution.status === 'final' && p.criteria.execution.score === 5))
})

// ------------------------------------------------------------------ territories

test('territories: 50 states, MI/OH/IN marked for the presentation, with pipeline evidence', () => {
  const t = territoriesWith(emptyInputs())
  assert.equal(t.length, 50)
  const presented = t.filter((x) => x.presented).map((x) => x.id).sort()
  assert.deepEqual(presented, ['IN', 'MI', 'OH'])
  const mi = t.find((x) => x.id === 'MI')
  assert.ok(mi.pipeline.rules.length > 50, 'approved Michigan rules')
  assert.ok(mi.pipeline.rules.every((r) => r.url === null || /^https?:/.test(r.url)))
  assert.ok(mi.sourceLinks.length > 0)
  // an estimate is never shown as a firm score
  for (const x of t) {
    if (x.isEstimate) assert.ok(x.score === null && x.scoreText.startsWith('≈'), x.id)
    if (x.score !== null) assert.ok(!x.isEstimate)
  }
  // ordered best first
  const est = t.map((x) => x.estimate ?? -1)
  assert.deepEqual(est, [...est].sort((a, b) => b - a))
  const s = overviewStats(t)
  assert.equal(s.areas, 50)
  assert.ok(s.scored >= s.passing)
})

test('sources list includes national documents and flags staleness', () => {
  const s = sourcesFromCsv(pipelineFiles.sourcesCsv)
  assert.equal(s.length, pipelineFiles.manifest.counts.sources)
  assert.ok(s.some((x) => x.state === 'US'))
  assert.ok(s.every((x) => x.url === null || /^https?:/.test(x.url)))
  assert.deepEqual(sourcesFromCsv('source_id,state,title,url\nX,MI,t,javascript:alert(1)\n')[0].url, null)
})

// ------------------------------------------------------------------ running the pipeline

test('run request: only state codes, booleans, and the development branch', () => {
  assert.deepEqual(cleanStates(['mi', ' oh', 'MI', 'in;rm', '"x"', 'CHI']), ['MI', 'OH', 'CHI'])
  const b = dispatchBody({ states: ['MI', 'OH'], extract: 1, recrawl: 0, requestId: 'web-abc', sealed: 'v1:xyz' })
  assert.deepEqual(b, { ref: 'development', inputs: { states: 'MI OH', extract: true, recrawl: false, request_id: 'web-abc', keys: 'v1:xyz' } })
  assert.ok(looksLikeKey('AIzaSy-abc_123.x') && looksLikeKey('') && !looksLikeKey('has space') && !looksLikeKey('a\nb'))
})

test('API keys are sealed so only the private key opens them (browser half of src/run_keys.py)', async () => {
  const { subtle } = globalThis.crypto
  const pair = await subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['encrypt', 'decrypt'])
  const jwk = await subtle.exportKey('jwk', pair.publicKey)
  const sealed = await sealKeys({ GEMINI_API_KEY: 'AIza-secret-1', CENSUS_API_KEY: '' }, jwk)
  assert.match(sealed, /^v1:[A-Za-z0-9_-]+$/)
  assert.ok(!sealed.includes('AIza'))
  const body = JSON.parse(atob(sealed.slice(3).replaceAll('-', '+').replaceAll('_', '/')))
  assert.deepEqual(Object.keys(body), ['GEMINI_API_KEY']) // blank keys are not sent
  const plain = await subtle.decrypt({ name: 'RSA-OAEP' }, pair.privateKey, Uint8Array.from(atob(body.GEMINI_API_KEY), (c) => c.charCodeAt(0)))
  assert.equal(new TextDecoder().decode(plain), 'AIza-secret-1')
  assert.equal(await sealKeys({ GEMINI_API_KEY: ' ' }, jwk), '')
})

test('run status: plain words, and only GitHub links', () => {
  const [r] = summarizeRuns([{ id: 1, display_title: 'DL3 data pipeline: MI web-1', status: 'completed', conclusion: 'failure', html_url: 'javascript:x' }])
  assert.equal(r.url, null)
  assert.equal(plainStatus(r), 'Stopped with an error')
  assert.equal(plainStatus(null), 'Waiting for GitHub to start the run…')
})

test('newer results: used only when complete and newer than what the site has', async () => {
  const files = { 'manifest.json': JSON.stringify({ generated_at: '2026-12-01T00:00:00Z' }), 'rules.csv': 'r', 'sources.csv': 's', 'cost_per_unit.csv': 'c', 'states_in_top_msas.csv': 'm', 'awards.csv': 'a' }
  const fake = (have) => async (url) => {
    const name = decodeURIComponent(url.split('/').pop())
    return name in have ? { ok: true, json: async () => JSON.parse(have[name]), text: async () => have[name] } : { ok: false }
  }
  const got = await fetchNewerResults('2026-11-17T02:20:11Z', fake(files))
  assert.equal(got.files.rulesCsv, 'r')
  assert.equal(got.inventory, null)
  assert.equal(await fetchNewerResults('2026-12-02T00:00:00Z', fake(files)), null) // not newer
  const partial = { ...files }
  delete partial['awards.csv']
  assert.equal(await fetchNewerResults('2026-11-17T02:20:11Z', fake(partial)), null) // half-published
  assert.equal(await fetchNewerResults(null, async () => { throw new Error('offline') }), null)
})
