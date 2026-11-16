// Checks how the AI research agents' state files are loaded and scored.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { RESEARCH_VIEW_SETTINGS, SETTINGS } from './config.js'
import { buildRecords } from './buildData.js'
import { rankRecords } from './engine.js'
import { applyResearch, readResearchFile } from './loadResearch.js'

const read = (name) => readFileSync(new URL(`./data/${name}`, import.meta.url), 'utf8')
const U = 'https://agency.example.gov/qap.pdf'
const J = (score) => ({ score, evidence: 'Cited evidence.', sources: [U] })
const PATH = (over = {}) => ({
  fee: { approvedGrossFee: 5_217_391, rule: '15% of costs excluding the fee', basis: 'costs excl. fee', arithmetic: '0.15/1.15 x 40M', ruleVerified: true, source: U, quote: '...' },
  maxFeasibleUnits: { value: 180, evidence: 'A 180-unit new-construction award in 2024', source: U },
  sponsorPath: { value: true, evidence: 'Joint ventures with an experienced in-state partner are allowed', source: U },
  financingPath: { value: true, evidence: 'Annual competitive round', source: U },
  awardsByYear: [2021, 2022, 2023, 2024, 2025].map((year, i) => ({ year, newConstructionAwards: 10 + i, above100Units: i % 2, applications: 30 + i, source: U })),
  oversubscription: { requestedToAvailable: 2.4, source: U },
  nextDeadline: 'February 2027',
  scores: { access: J(3), urban: J(4), execution: J(3) },
  confidence: 'Medium',
  ...over,
})
const FILE = (over = {}) => ({
  state: 'Alabama', researchedOn: '2026-11-16', agency: 'AHFA',
  pathways: { '9%': PATH(), '4%': PATH({ confidence: 'Low' }) },
  venture: { market: 'Birmingham: Southside', historicSuccess: J(3), anchorInstitutions: J(5), availableProperty: J(3), emergingMomentum: J(3), localLeadership: J(3) },
  notes: 'Example',
  ...over,
})
const base = () => buildRecords({ partcCsv: read('partc.csv'), awardHistoryCsv: read('award_history.csv'), awardsCsv: read('awards.csv'), siteFactsCsv: read('site_facts.csv'), programCapsCsv: read('program_caps.csv'), nationalFee: JSON.parse(read('national_fee_screen.json')) }).records

test('a research file is validated: values without a source and scores without evidence are dropped', () => {
  const f = FILE()
  f.pathways['9%'].scores.urban = { score: 4, evidence: '', sources: [U] } // no evidence
  f.pathways['9%'].scores.execution = { score: 9, evidence: 'x', sources: [U] } // not 0-5
  f.pathways['9%'].sponsorPath = { value: true, evidence: 'x', source: 'not a link' }
  f.pathways['9%'].awardsByYear.push({ year: 2024, newConstructionAwards: 1, above100Units: 5, applications: 2, source: U }) // more big than total
  const r = readResearchFile(f)
  const p = r.pathways['9%']
  assert.equal(p.judgments.urban, null)
  assert.equal(p.judgments.execution, null)
  assert.equal(p.sponsorPath, null)
  assert.equal(p.awardsByYear.length, 5)
  assert.throws(() => readResearchFile({ ...f, state: 'Atlantis' }), /not a state/)
  assert.throws(() => readResearchFile({ ...f, researchedOn: 'today' }), /researchedOn/)
})

test('research fills an unresearched state: fee, gates, award history, judgments and Venture factors', () => {
  const { records } = applyResearch(base(), [{ name: 'alabama.json', json: FILE() }])
  const al = records.find((r) => r.id === 'alabama-9')
  assert.deepEqual([al.approvedGrossFee, al.totalDevelopmentCost, al.feeRuleVerified, al.maxFeasibleUnits, al.sponsorPath, al.financingPath], [5_217_391, 40_000_000, true, 180, true, true])
  assert.deepEqual([al.researched, al.screenOnly, al.confidence, al.criticalSourceDates], [true, false, 'Medium', ['2026-11-16']])
  assert.equal(al.awardHistory.length, 5)
  assert.ok(al.awardHistory.every((h) => h.urbanFiltered === false && h.fromAgent))
  assert.equal(al.judgments.access.proposedBy, 'AI research agent')
  assert.equal(al.judgments.access.approvedBy, undefined) // never marked as approved by DL3
  assert.equal(Object.keys(al.venture).length, 5)
  assert.match(al.notes, /AI-researched 2026-11-16 \(not yet reviewed by DL3\)/)
})

test('our own pilot research is never overwritten; differences are listed', () => {
  const f = FILE({ state: 'Indiana' })
  f.pathways['4%'].fee.approvedGrossFee = 4_500_000
  const { records, comparison } = applyResearch(base(), [{ name: 'indiana.json', json: f }])
  const in4 = records.find((r) => r.id === 'indiana-4')
  assert.equal(in4.approvedGrossFee, 4_800_000) // the research pack's number stays
  assert.equal(in4.maxFeasibleUnits, 234) // sheet value stays
  assert.deepEqual(comparison.find((c) => c.pathway === '4%'), { state: 'Indiana', pathway: '4%', research: 4_800_000, agent: 4_500_000 })
  // but a gap is filled: Indiana 9% had no fee in our research
  assert.equal(records.find((r) => r.id === 'indiana-9').approvedGrossFee, 5_217_391)
  // and our sourced award counts are not replaced; only empty years are filled
  const in9 = records.find((r) => r.id === 'indiana-9').awardHistory
  assert.equal(in9.find((h) => h.year === 2021).eligibleAwards, 18) // from our yearly table, not the agent's 10
})

test('in the normal view, AI judgments do not count; in the researched-scores view they do, labeled', () => {
  const { records } = applyResearch(base(), [{ name: 'alabama.json', json: FILE() }])
  const find = (out) => out.lists.find((l) => l.pathway === '9%')
  const normal = find(rankRecords(records, { asOf: '2026-11-16' }))
  const al = [...normal.ranked, ...normal.needsVerification].find((r) => r.id === 'alabama-9')
  assert.equal(al.scores.access, null) // proposed, so not counted
  assert.equal(al.gates.status, 'Pass') // the gates are facts with sources, so they do count
  const researched = find(rankRecords(records, { asOf: '2026-11-16', settings: RESEARCH_VIEW_SETTINGS }))
  const r = researched.ranked.find((x) => x.id === 'alabama-9')
  assert.equal(r.scores.access, 3)
  assert.equal(r.criteria.access.status, 'proposed')
  assert.ok(r.score.point !== null || r.score.hi - r.score.lo < 100)
})

test('the researched-scores view can give a full numeric score when every criterion has evidence', () => {
  const { records } = applyResearch(base(), [{ name: 'alabama.json', json: FILE() }])
  const out = rankRecords(records, { asOf: '2026-11-16', settings: RESEARCH_VIEW_SETTINGS })
  const r = out.lists.find((l) => l.pathway === '9%').ranked.find((x) => x.id === 'alabama-9')
  // Economics: $5.217M -> 60% x 60% = $1.878M cash (>= 1.5x $1M), PV about $1.75M (>= $1.5M), downside passes -> 5
  assert.equal(r.criteria.economics.score, 5)
  // Scale: 101+ feasible, statewide big awards in 2022 and 2024 only -> isolated -> 3
  assert.equal(r.criteria.scale.score, 3)
  assert.match(r.criteria.scale.reasons.join(' '), /statewide/)
  // Funding: computed from statewide counts (one state with data in this test -> middle percentile -> 3)
  assert.equal(r.criteria.funding.status, 'final')
  // Venture: average of 3, 5, 3, 3, 3 = 3.4
  assert.equal(r.criteria.venture.score, 3.4)
  assert.ok(r.score.point !== null)
  // (25*5 + 20*fund + 15*3 + 10*3 + 10*4 + 10*3 + 10*3.4) / 5
  assert.ok(Math.abs(r.score.point - (125 + 20 * r.criteria.funding.score + 45 + 30 + 40 + 30 + 34) / 5) < 1e-9)
})

test('the statewide settings are off by default', () => {
  assert.equal(SETTINGS.scaleAcceptStatewide, false)
  assert.equal(SETTINGS.fundingAcceptStatewide, false)
  assert.equal(SETTINGS.countProposed, false)
})
