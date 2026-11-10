// Checks the scraping pipeline's inventory: where each state's documents are (found automatically, not verified).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildRecords } from './buildData.js'
import { rankRecords } from './engine.js'
import { awardCoverage, inventoryFromCsv, parseLinks, parseYears } from './loadInventory.js'
import { awardHistoryFromCsv } from './loadAwardHistory.js'

const read = (name) => readFileSync(new URL(`./data/${name}`, import.meta.url), 'utf8')
const inv = inventoryFromCsv(read('inventory.csv'))
const files = () => ({
  partcCsv: read('partc.csv'), awardHistoryCsv: read('award_history.csv'), awardsCsv: read('awards.csv'), siteFactsCsv: read('site_facts.csv'),
  programCapsCsv: read('program_caps.csv'), nationalFee: JSON.parse(read('national_fee_screen.json')),
})

test('the inventory loads: 55 jurisdictions in the file, the 50 states kept, nothing malformed', () => {
  assert.equal(inv.stats.jurisdictions, 55)
  assert.equal(inv.stats.states, 50) // DC, Puerto Rico, the Virgin Islands, Chicago and New York City are not ranked
  assert.deepEqual(inv.warnings, [])
  assert.ok(inv.byState.has('Michigan') && inv.byState.has('Indiana') && !inv.byState.has('District of Columbia'))
})

test('award-list coverage hints for 2021-2025: 18 states three-plus, 11 one or two, 12 unclear, 9 none', () => {
  assert.deepEqual(inv.stats.awardCoverage, { 'three-plus': 18, 'one-or-two': 11, unclear: 12, none: 9 })
})

test('plan status: a draft or unknown plan is never treated as final', () => {
  assert.deepEqual(inv.stats.qapStatus, { draft: 10, unknown: 29, 'related-only': 1 })
  assert.ok([...inv.byState.values()].every((s) => s.qapStatus !== 'final')) // the pipeline never marks one final automatically
})

test('several links in one cell are split, labeled, and kept only if they are web addresses', () => {
  const al = inv.byState.get('Alabama').links.qapDocuments
  assert.ok(al.length >= 3)
  assert.ok(al.every((l) => l.url.startsWith('https://')))
  assert.deepEqual(al.slice(0, 2).map((l) => l.label), ['2027', '2026'])
  const warnings = []
  const links = parseLinks('https://ok.example/a.pdf [2026]; javascript:alert(1); ftp://x/y; https://ok.example/b', (p) => warnings.push(p))
  assert.deepEqual(links.map((l) => l.url), ['https://ok.example/a.pdf', 'https://ok.example/b'])
  assert.equal(warnings.length, 2)
})

test('a link with several labels keeps them all, and a draft label is remembered', () => {
  const [a, b] = parseLinks('https://ok.example/qap.pdf [2027–2028] [draft]; https://ok.example/final.pdf [2026]')
  assert.deepEqual([a.labels, a.draft], [['2027–2028', 'draft'], true])
  assert.deepEqual([b.labels, b.draft], [['2026'], false])
  const colorado = inv.byState.get('Colorado').links.qapDocuments
  assert.ok(colorado.some((l) => l.draft)) // Colorado's first and fourth drafts are marked
})

test('addresses with spaces are encoded so they still work, and nothing but http(s) is ever kept', () => {
  const [l] = parseLinks('https://archivemhc.com/htc/2025/2025 Qualified Allocation Plan.pdf')
  assert.equal(l.url, 'https://archivemhc.com/htc/2025/2025%20Qualified%20Allocation%20Plan.pdf')
  assert.equal(parseLinks('javascript:alert(1)').length, 0)
  assert.equal(parseLinks('data:text/html,<script>alert(1)</script>').length, 0)
  const all = [...inv.byState.values()].flatMap((s) => [...Object.values(s.links).flat().map((x) => (typeof x === 'string' ? x : x?.url))])
  assert.ok(all.filter(Boolean).every((u) => /^https?:\/\//.test(u) && !/\s/.test(u)))
})

test('year ranges and single years are read, including the en dash', () => {
  assert.deepEqual([...parseYears('2015, 2025–2028')].sort(), [2015, 2025, 2026, 2027, 2028])
  assert.deepEqual([...parseYears('2021-2023')].sort(), [2021, 2022, 2023])
  assert.equal(parseYears('').size, 0)
  assert.equal(awardCoverage(true, parseYears('2005–2026')), 'three-plus')
  assert.equal(awardCoverage(true, parseYears('2020')), 'unclear') // a list exists but not for the window
  assert.equal(awardCoverage(true, parseYears('2018–2021, 2026')), 'one-or-two')
  assert.equal(awardCoverage(false, parseYears('2021–2025')), 'none')
})

test('the crawler UNDERCOUNTS: for Michigan it finds one of the five years, but we have sourced counts for all five', () => {
  assert.equal(inv.byState.get('Michigan').awardCoverage, 'one-or-two')
  const mi = awardHistoryFromCsv(read('award_history.csv')).rows.filter((r) => r.state === 'Michigan' && r.pathway === '9%' && r.year <= 2025)
  assert.equal(mi.length, 5)
  assert.ok(mi.every((r) => r.source.startsWith('http'))) // so "none found" means "not found yet", never "does not exist"
})

test('records get their state\'s document links, and the ranking itself does not change', () => {
  const without = buildRecords(files())
  const withInv = buildRecords({ ...files(), inventoryCsv: read('inventory.csv') })
  assert.deepEqual(withInv.warnings, [])
  assert.equal(withInv.records.filter((r) => r.sources).length, 100) // both pathways of all 50 states
  assert.equal(withInv.records.find((r) => r.id === 'indiana-4').sources.state, 'Indiana')
  assert.equal(without.records.filter((r) => r.sources).length, 0)
  const counts = (b) => rankRecords(b.records, { asOf: '2026-11-10' }).lists.map((l) => l.counts)
  assert.deepEqual(counts(withInv), counts(without))
})

test('the research-next list puts the best award-list coverage first and marks states already researched in depth', () => {
  const next = buildRecords({ ...files(), inventoryCsv: read('inventory.csv') }).inventory.researchNext
  assert.equal(next.length, 50)
  assert.ok(next.slice(0, 18).every((s) => s.coverage === 'three-plus'))
  assert.ok(next.slice(-9).every((s) => s.coverage === 'none'))
  assert.deepEqual(next.filter((s) => s.researchedInDepth).map((s) => s.state).sort(), ['Indiana', 'Michigan', 'Ohio'])
})
