// Checks the urban definition: three tests that must all pass (guide 6B), and how it feeds Scale.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { URBAN_DEFINITION } from './config.js'
import { parseAwards, urbanLowerBounds } from './awardAudit.js'
import { buildRecords } from './buildData.js'
import { rankRecords } from './engine.js'
import { siteFactsFromCsv } from './loadSiteFacts.js'
import { evaluateUrban, factsForAward } from './urban.js'

const read = (name) => readFileSync(new URL(`./data/${name}`, import.meta.url), 'utf8')
const ALL = { inUrbanizedArea: true, principalCity: true, inApprovedArea: false, tractDensity: 5200, nearFixedRouteTransit: false }

// ---------------------------------------------------------------------- the three tests

test('the definition is recorded as proposed, not approved, with placeholder thresholds', () => {
  assert.equal(URBAN_DEFINITION.approved, false)
  assert.equal(URBAN_DEFINITION.boundaryVintage, '2020')
  assert.equal(URBAN_DEFINITION.tractDensityFloorPerSqMile, 3000)
  assert.equal(URBAN_DEFINITION.placeholderThresholds, true)
})

test('a site is urban only when all three tests pass', () => {
  const r = evaluateUrban(ALL)
  assert.equal(r.status, 'urban')
  assert.deepEqual(r.tests.map((t) => t.status), ['pass', 'pass', 'pass'])
})

test('test 1: a site outside an Urbanized Area (an urban cluster) fails, whatever else is true', () => {
  assert.equal(evaluateUrban({ ...ALL, inUrbanizedArea: false }).status, 'not-urban')
})

test('test 2: a principal city OR a DL3-approved area passes; both ruled out fails', () => {
  assert.equal(evaluateUrban({ ...ALL, principalCity: false, inApprovedArea: true }).tests[1].status, 'pass')
  assert.equal(evaluateUrban({ ...ALL, principalCity: false, inApprovedArea: false }).status, 'not-urban')
  // a generic suburb: in the metro area but neither a principal city nor an approved area
  assert.equal(evaluateUrban({ ...ALL, principalCity: false, inApprovedArea: null }).tests[1].status, 'unknown')
})

test('test 3: density at the floor passes, just under fails unless transit is within half a mile', () => {
  const noTransit = { ...ALL, nearFixedRouteTransit: false }
  assert.equal(evaluateUrban({ ...noTransit, tractDensity: 3000 }).tests[2].status, 'pass')
  assert.equal(evaluateUrban({ ...noTransit, tractDensity: 2999 }).status, 'not-urban')
  assert.equal(evaluateUrban({ ...noTransit, tractDensity: 2999, nearFixedRouteTransit: true }).status, 'urban')
  assert.equal(evaluateUrban({ ...ALL, tractDensity: null, nearFixedRouteTransit: false }).tests[2].status, 'unknown')
})

test('unknown is never a pass: missing facts leave the site unknown, and any failure wins over unknowns', () => {
  assert.equal(evaluateUrban({}).status, 'unknown')
  assert.equal(evaluateUrban({ inUrbanizedArea: true }).status, 'unknown')
  assert.equal(evaluateUrban({ inUrbanizedArea: false }).status, 'not-urban')
})

// -------------------------------------------------------------------------- site facts

const HEADER = 'state,city,project,inUrbanizedArea,principalCity,inApprovedArea,tractDensity,nearFixedRouteTransit,boundaryVintage,source,retrieved,notes\n'
const SRC = 'https://example.org/census,2026-11-09'

test('site facts: good rows load; rows without a source, date or the right Census vintage are rejected', () => {
  const csv = HEADER + [
    `IN,Indianapolis,*,true,true,UNKNOWN,UNKNOWN,UNKNOWN,2020,${SRC},city-wide`,
    `IN,Indianapolis,Monon 35,UNKNOWN,UNKNOWN,UNKNOWN,5200,true,2020,${SRC},site-level`,
    'IN,Gary,*,true,true,UNKNOWN,UNKNOWN,UNKNOWN,2020,,2026-11-09,no source',
    `IN,Muncie,*,true,true,UNKNOWN,UNKNOWN,UNKNOWN,2010,${SRC},old boundaries`,
    `IN,Fishers,*,maybe,true,UNKNOWN,UNKNOWN,UNKNOWN,2020,${SRC},bad value`,
    `IN,Evansville,*,true,true,UNKNOWN,dense,UNKNOWN,2020,${SRC},bad density`,
    `IN,Indianapolis,*,true,true,UNKNOWN,UNKNOWN,UNKNOWN,2020,${SRC},duplicate`,
  ].join('\n')
  const { facts, warnings } = siteFactsFromCsv(csv)
  assert.deepEqual(facts.map((f) => [f.city, f.project]), [['Indianapolis', '*'], ['Indianapolis', 'Monon 35']])
  assert.equal(warnings.length, 5)
  assert.match(warnings.join(' '), /no source URL/)
  assert.match(warnings.join(' '), /2010/)
  assert.throws(() => siteFactsFromCsv('state,city\nIN,Gary\n'), /must start with these columns/)
})

test('site facts: a project row adds to the city-wide row, and cities match regardless of case', () => {
  const { facts } = siteFactsFromCsv(HEADER + `IN,Indianapolis,*,true,true,UNKNOWN,UNKNOWN,UNKNOWN,2020,${SRC},\nIN,Indianapolis,Monon 35,UNKNOWN,UNKNOWN,UNKNOWN,5200,true,2020,${SRC},\n`)
  const f = factsForAward({ state: 'Indiana', city: 'indianapolis', project: 'MONON 35' }, facts)
  assert.deepEqual(f, { inUrbanizedArea: true, principalCity: true, tractDensity: 5200, nearFixedRouteTransit: true })
  assert.deepEqual(factsForAward({ state: 'Indiana', city: 'Gary', project: 'x' }, facts), {})
})

// ------------------------------------------------------- certain urban counts from awards

const A = (over) => ({ state: 'Indiana', pathway: '4%', year: 2024, project: 'P', parent: 'P', city: 'Indianapolis', units: 120, newConstruction: true, ...over })

test('urban lower bounds count only awards that are known new construction AND certainly urban, once per parent', () => {
  const awards = [
    A({ project: 'Big', parent: 'Big' }),
    A({ project: 'Big phase 2', parent: 'Big' }), // same parent: counted once
    A({ project: 'Rehab', parent: 'Rehab', newConstruction: false }),
    A({ project: 'Unknown type', parent: 'U', newConstruction: null }),
    A({ project: 'Rural', parent: 'R', city: 'Smalltown' }),
    A({ project: 'Small', parent: 'S', units: 60 }),
  ]
  const classify = (a) => ({ status: a.city === 'Indianapolis' ? 'urban' : a.city === 'Smalltown' ? 'not-urban' : 'unknown' })
  const got = urbanLowerBounds(awards, classify).get('Indiana|4%|2024')
  assert.deepEqual(got, { eligibleAwardsUrbanLo: 2, awardsAbove100UrbanLo: 1 }) // Big, and Small (not above 100)
})

// -------------------------------------------------------------------- feeding Scale

const files = () => ({ partcCsv: read('partc.csv'), awardHistoryCsv: read('award_history.csv'), awardsCsv: read('awards.csv'), siteFactsCsv: read('site_facts.csv') })
const indiana4 = (built) => built.records.find((r) => r.id === 'indiana-4')
const scaleOf = (built, settings) => {
  const out = rankRecords(built.records, { asOf: '2026-11-09', settings })
  return out.lists.find((l) => l.pathway === '4%').needsVerification.find((r) => r.id === 'indiana-4').criteria.scale
}

test('on the real files today, no site facts exist, so the urban definition changes nothing', () => {
  const built = buildRecords(files())
  assert.deepEqual(built.warnings, [])
  assert.equal(built.stats.awards, 603)
  assert.equal(built.stats.siteFactRows, 0)
  const scale = scaleOf(built)
  assert.deepEqual([scale.status, scale.interval], ['bounded', { lo: 1, hi: 5 }])
})

// Made-up facts: every city in Indiana's 4% awards is certainly urban. TEST ONLY, never saved to the data folder.
function madeUpFactsForIndiana4(awardsCsv, years) {
  const cities = new Set(parseAwards(awardsCsv).awards.filter((a) => a.state === 'Indiana' && a.pathway === '4%' && years.includes(a.year)).map((a) => a.city))
  return HEADER + [...cities].map((c) => `IN,${c},*,true,true,UNKNOWN,5000,true,2020,${SRC},made up for a test`).join('\n') + '\n'
}

test('with site facts, urban 100+ unit awards in 3 of 5 years give Indiana 4% a Scale of 5, but only a proposal until the definition is approved', () => {
  const f = files()
  const built = buildRecords({ ...f, siteFactsCsv: madeUpFactsForIndiana4(f.awardsCsv, [2023, 2024, 2025]) })
  assert.deepEqual(built.warnings, [])
  // Indiana's 4% award lists have 100+ unit new-construction awards in 2023, 2024 and 2025
  const rows = indiana4(built).awardHistory
  assert.deepEqual(rows.filter((r) => r.year <= 2025 && r.awardsAbove100UrbanLo > 0).map((r) => r.year), [2023, 2024, 2025])

  const unapproved = scaleOf(built)
  assert.deepEqual([unapproved.score, unapproved.status], [5, 'proposed'])
  assert.match(unapproved.needs.join(' '), /Approval of the urban definition/)

  const approved = scaleOf(built, { urbanDefinition: { ...URBAN_DEFINITION, approved: true } })
  assert.deepEqual([approved.score, approved.status], [5, 'final'])
})

test('a proposal built on the unapproved definition does not count toward the total; an approved one does', () => {
  const f = files()
  const built = buildRecords({ ...f, siteFactsCsv: madeUpFactsForIndiana4(f.awardsCsv, [2023, 2024, 2025]) })
  const total = (settings) => {
    const out = rankRecords(built.records, { asOf: '2026-11-09', settings })
    return out.lists.find((l) => l.pathway === '4%').needsVerification.find((r) => r.id === 'indiana-4').scores.scale
  }
  assert.equal(total(), null)
  assert.equal(total({ urbanDefinition: { ...URBAN_DEFINITION, approved: true } }), 5)
})

test('only two urban years leaves a range (3 to 5), still a proposal until approval', () => {
  const f = files()
  // Charlestown (2023) and Lafayette (2024) have 100+ unit awards in only one year each
  const facts = HEADER + ['Charlestown', 'Lafayette'].map((c) => `IN,${c},*,true,true,UNKNOWN,5000,true,2020,${SRC},made up for a test`).join('\n') + '\n'
  const built = buildRecords({ ...f, siteFactsCsv: facts })
  const scale = scaleOf(built)
  assert.deepEqual([scale.status, scale.interval], ['proposed', { lo: 3, hi: 5 }])
})
