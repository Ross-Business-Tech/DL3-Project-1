// Checks how each criterion gets its 0-5 score (guide 6, 7A, 8).
import test from 'node:test'
import assert from 'node:assert/strict'
import { SETTINGS } from './config.js'
import { rankRecords } from './engine.js'
import { attachAwardHistory, awardHistoryFromCsv } from './loadAwardHistory.js'
import { fundingFromHistory, scoreEconomics, scoreJudgment, scoreScale, scoreVenture } from './scoring.js'

const S = { ...SETTINGS, economicsHurdles: { ...SETTINGS.economicsHurdles } }
const YEARS = [2021, 2022, 2023, 2024, 2025]

// An award-history row for one year. `large` = awards above 100 units; null = unknown.
const yr = (year, large, extra = {}) => ({
  year, complete: true, eligibleAwards: 6, awardsAbove100Units: large, qualifiedApplications: 18, urbanFiltered: true, ...extra,
})
const hist = (...larges) => larges.map((n, i) => yr(YEARS[i], n))
const scale = (record) => scoreScale({ maxFeasibleUnits: 140, ...record }, S)

// ------------------------------------------------------------------------------ Scale

test('Scale: no feasible project above 100 units scores 0, and 101 units is feasible', () => {
  const none = scoreScale({ maxFeasibleUnits: 100 }, S)
  assert.deepEqual([none.score, none.status], [0, 'final'])
  assert.notEqual(scoreScale({ maxFeasibleUnits: 101, awardHistory: hist(1, 1, 1, 0, 0) }, S).score, 0)
})

test('Scale: unknown feasibility stays unresolved', () => {
  const r = scoreScale({ maxFeasibleUnits: null, awardHistory: hist(1, 1, 1, 1, 1) }, S)
  assert.equal(r.status, 'unresolved')
  assert.equal(r.score, null)
  assert.match(r.needs[0], /largest feasible project size/i)
})

test('Scale: 100+ unit awards in at least 3 of the 5 years scores 5', () => {
  const r = scale({ awardHistory: hist(2, 0, 1, 0, 3) })
  assert.deepEqual([r.score, r.status], [5, 'final'])
  // three large years is enough even when the other two years are unknown
  assert.equal(scale({ awardHistory: [yr(2021, 1), yr(2022, 1), yr(2023, 1)] }).score, 5)
})

test('Scale: isolated large awards (fewer than 3 years) score 3 once nothing can change that', () => {
  assert.equal(scale({ awardHistory: hist(0, 0, 4, 0, 0) }).score, 3) // one year
  assert.equal(scale({ awardHistory: hist(1, 0, 0, 2, 0) }).score, 3) // two years
  // 1 large year + 1 unknown year: even if the unknown year is large, that is only 2 of 5
  const r = scale({ awardHistory: [yr(2021, 1), yr(2022, 0), yr(2023, 0), yr(2024, 0)] })
  assert.deepEqual([r.score, r.status], [3, 'final'])
})

test('Scale: missing years can leave a range instead of a guess', () => {
  const r = scale({ awardHistory: [yr(2021, 1), yr(2022, 1)] }) // 2 large + 3 unknown: could still reach 3
  assert.equal(r.status, 'bounded')
  assert.deepEqual(r.interval, { lo: 3, hi: 5 })
  assert.match(r.needs.join(' '), /2023, 2024, 2025/)
  // no history at all: only "feasible, so not 0" is known
  const none = scale({ awardHistory: [] })
  assert.deepEqual(none.interval, { lo: 1, hi: 5 })
})

test('Scale: feasible on paper but no 100+ unit awards needs a written-evidence 1 or 2', () => {
  const r = scale({ awardHistory: hist(0, 0, 0, 0, 0) })
  assert.equal(r.status, 'bounded')
  assert.deepEqual(r.interval, { lo: 1, hi: 2 })
  assert.match(r.needs.join(' '), /written evidence/)
})

test('Scale: awards not filtered to urban projects do not count', () => {
  const r = scale({ awardHistory: hist(2, 2, 2, 2, 2).map((h) => ({ ...h, urbanFiltered: false })) })
  assert.equal(r.status, 'bounded')
  assert.notEqual(r.score, 5)
  assert.match(r.needs.join(' '), /urban definition/)
})

test('Scale: 2026 year-to-date and years outside the window never count toward 3 of 5', () => {
  const r = scale({ awardHistory: [yr(2026, 5, { complete: false }), yr(2020, 5), yr(2021, 1), yr(2022, 1)] })
  assert.equal(r.status, 'bounded') // only 2 large years inside 2021-2025; 2020 and 2026 are ignored
})

// -------------------------------------------------------------------------- Economics

const E = (over) => scoreEconomics({ economics: { retainedNetCash: 500_000, presentValue: 450_000, downsidePasses: true, ...over } }, {
  ...S, economicsHurdles: { minRetainedCash: 400_000, minPresentValue: 350_000, strongMultiple: 1.5 },
})

test('Economics: no positive retained net fee cash is a 0 even without hurdles', () => {
  const r = scoreEconomics({ economics: { retainedNetCash: 0 } }, S)
  assert.deepEqual([r.score, r.status], [0, 'final'])
})

test('Economics: without DL3 hurdles the criterion stays a range and says what is needed', () => {
  const r = scoreEconomics({ economics: { retainedNetCash: 500_000, presentValue: 450_000 } }, S)
  assert.equal(r.status, 'bounded')
  assert.deepEqual(r.interval, { lo: 1, hi: 5 })
  assert.equal(r.needs.filter((n) => /hurdle/.test(n)).length, 2)
})

test('Economics: meets the hurdles = 3; 1.5x both plus the downside test = 5', () => {
  assert.equal(E({}).score, 3) // 500k >= 400k and 450k >= 350k, but below 1.5x (600k / 525k)
  assert.equal(E({ retainedNetCash: 620_000, presentValue: 530_000 }).score, 5)
  assert.equal(E({ retainedNetCash: 620_000, presentValue: 530_000, downsidePasses: false }).score, 3)
  const open = E({ retainedNetCash: 620_000, presentValue: 530_000, downsidePasses: null })
  assert.deepEqual(open.interval, { lo: 3, hi: 5 })
})

test('Economics: positive cash below the hurdles needs a written-evidence 1 or 2', () => {
  const r = E({ retainedNetCash: 300_000 })
  assert.deepEqual(r.interval, { lo: 1, hi: 2 })
})

// ------------------------------------------------------------------------- Judgments

test('Judgment: a proposal does not count until a named person approves it', () => {
  const proposed = scoreJudgment({ judgments: { access: { score: 4, evidence: 'Eligible sponsor with a scoring plan', proposedBy: 'AI' } } }, 'access')
  assert.deepEqual([proposed.score, proposed.status], [4, 'proposed'])
  const approved = scoreJudgment({ judgments: { access: { score: 4, evidence: 'Eligible sponsor', approvedBy: 'A. Reviewer', approvedOn: '2026-11-10' } } }, 'access')
  assert.equal(approved.status, 'final')
})

test('Judgment: a score with no evidence, or not 0-5, stays unresolved', () => {
  assert.equal(scoreJudgment({ judgments: { urban: { score: 3, evidence: '  ' } } }, 'urban').status, 'unresolved')
  assert.equal(scoreJudgment({ judgments: { urban: { score: 7, evidence: 'x' } } }, 'urban').status, 'unresolved')
  assert.equal(scoreJudgment({ judgments: { urban: { score: 2.5, evidence: 'x' } } }, 'urban').status, 'unresolved')
  assert.equal(scoreJudgment({}, 'execution').status, 'unresolved')
})

// --------------------------------------------------------------------------- Venture

const factor = (score, evidence = 'Cited evidence') => ({ score, evidence })
const ALL5 = { historicSuccess: factor(4), anchorInstitutions: factor(3), availableProperty: factor(5), emergingMomentum: factor(2), localLeadership: factor(3) }

test('Venture: the average of five supported factors, once a person approves it', () => {
  const unapproved = scoreVenture({ venture: ALL5 })
  assert.deepEqual([unapproved.score, unapproved.status], [3.4, 'proposed'])
  const approved = scoreVenture({ venture: { ...ALL5, approvedBy: 'A. Reviewer', approvedOn: '2026-11-10' } })
  assert.deepEqual([approved.score, approved.status], [3.4, 'final'])
})

test('Venture: unsupported factors give an interval, and evidence-free factors do not count', () => {
  const partial = scoreVenture({
    venture: { historicSuccess: factor(4), anchorInstitutions: factor(3), availableProperty: factor(5, ''), approvedBy: 'A. Reviewer', approvedOn: '2026-11-10' },
  })
  assert.equal(partial.status, 'bounded')
  assert.deepEqual(partial.interval, { lo: 7 / 5, hi: 22 / 5 }) // 2 supported (sum 7), 3 unsupported at 0 / at 5
  assert.equal(scoreVenture({}).status, 'unresolved')
})

// ----------------------------------------------------------------- Funding from history

test('Funding: yearly averages come from complete, urban-filtered years in the window only', () => {
  const f = fundingFromHistory(
    { awardHistory: [yr(2021, 0, { eligibleAwards: 4, qualifiedApplications: 8 }), yr(2022, 0, { eligibleAwards: 6, qualifiedApplications: 20 }), yr(2023, 0, { eligibleAwards: 9, urbanFiltered: false }), yr(2026, 0, { complete: false })] },
    S,
  )
  assert.deepEqual([f.eligibleAwardsPerYear, f.qualifiedApplicationsPerYear, f.years], [5, 14, [2021, 2022]])
  assert.equal(fundingFromHistory({ awardHistory: [] }, S), null)
})

// -------------------------------------------------- award history file and the engine

const HEADER = 'state,pathway,year,yearComplete,eligibleAwards,awardsAbove100Units,qualifiedApplications,urbanFiltered,source,retrieved,notes\n'
const SRC = 'https://example.org/awards.pdf,2026-11-08'

test('Award history file: good rows load; uncited, impossible and duplicate rows are rejected with a reason', () => {
  const csv = HEADER + [
    `Michigan,9%,2023,true,6,2,18,true,${SRC},ok`,
    `Michigan,9%,2024,true,UNKNOWN,UNKNOWN,UNKNOWN,true,${SRC},counts unknown`,
    'Michigan,9%,2022,true,6,2,18,true,,2026-11-08,no source',
    `Michigan,9%,2021,true,6,9,18,true,${SRC},more big awards than awards`,
    `Michigan,9%,2023,true,6,2,18,true,${SRC},duplicate`,
    `Michigan,5%,2023,true,6,2,18,true,${SRC},bad pathway`,
  ].join('\n')
  const { rows, warnings } = awardHistoryFromCsv(csv)
  assert.deepEqual(rows.map((r) => r.year), [2023, 2024])
  assert.equal(rows[1].awardsAbove100Units, null)
  assert.equal(warnings.length, 4)
  assert.match(warnings.join(' '), /no source URL/)
  assert.match(warnings.join(' '), /larger than eligibleAwards/)
  assert.match(warnings.join(' '), /appears twice/)
  assert.throws(() => awardHistoryFromCsv('state,year\nx,1\n'), /must start with these columns/)
})

test('Award history rows attach to the matching state and pathway; unmatched rows are reported', () => {
  const { rows } = awardHistoryFromCsv(HEADER + `Michigan,9%,2023,true,6,2,18,true,${SRC},ok\n` + `Nowhere,9%,2023,true,6,2,18,true,${SRC},ok\n`)
  const { records, warnings } = attachAwardHistory([{ state: 'Michigan', pathway: '9%' }, { state: 'Michigan', pathway: '4%' }], rows)
  assert.equal(records[0].awardHistory.length, 1)
  assert.equal(records[1].awardHistory, undefined)
  assert.match(warnings[0], /Nowhere 9%/)
})

const base = {
  id: 'x', state: 'X', pathway: '9%', confidence: 'High', maxFeasibleUnits: 140, approvedGrossFee: 4_800_000,
  totalDevelopmentCost: 40_000_000, sponsorPath: true, financingPath: true, criticalSourceDates: ['2026-10-20'],
}
const run = (records, options = {}) => rankRecords(records, { asOf: '2026-11-08', ...options })
const first = (out) => out.lists[0].ranked[0]

test('Engine: Scale is calculated from the award history and shown as a calculated criterion', () => {
  const out = run([{ ...base, awardHistory: hist(2, 0, 1, 0, 3) }])
  const r = first(out)
  assert.equal(r.scores.scale, 5)
  assert.deepEqual([r.criteria.scale.method, r.criteria.scale.status], ['calculated', 'final'])
})

test('Engine: a typed-in score always wins over a calculated one', () => {
  const r = first(run([{ ...base, awardHistory: hist(2, 0, 1, 0, 3), scores: { scale: 3 } }]))
  assert.equal(r.scores.scale, 3)
  assert.equal(r.criteria.scale.method, 'entered')
})

test('Engine: ranges from a criterion flow into the total, and unapproved proposals stay out of it', () => {
  const rec = { ...base, awardHistory: [yr(2021, 1), yr(2022, 1)], judgments: { access: { score: 4, evidence: 'x', proposedBy: 'AI' } } }
  const r = first(run([rec]))
  assert.deepEqual(r.scores.scale, { lo: 3, hi: 5 })
  assert.equal(r.scores.access, null) // proposed, not approved: not counted
  assert.ok(r.score.unknown.includes('scale') && r.score.unknown.includes('access'))
  // with the preview switch on, the proposal counts
  const preview = first(run([rec], { settings: { countProposed: true } }))
  assert.equal(preview.scores.access, 4)
})

test('Engine: every criterion can reach a score, and the total matches the formula', () => {
  const rec = {
    ...base,
    awardHistory: hist(2, 0, 1, 0, 3), // Scale 5
    funding: { eligibleAwardsPerYear: 6, qualifiedApplicationsPerYear: 12 }, // Funding (only state: 50th percentile -> 3)
    economics: { retainedNetCash: 620_000, presentValue: 530_000, downsidePasses: true }, // Economics 5
    judgments: {
      access: { score: 4, evidence: 'e', approvedBy: 'R', approvedOn: '2026-11-09' },
      urban: { score: 3, evidence: 'e', approvedBy: 'R', approvedOn: '2026-11-09' },
      execution: { score: 3, evidence: 'e', approvedBy: 'R', approvedOn: '2026-11-09' },
    },
    venture: { ...ALL5, approvedBy: 'R', approvedOn: '2026-11-09' }, // 3.4
  }
  const out = run([rec], { settings: { economicsHurdles: { minRetainedCash: 400_000, minPresentValue: 350_000 } } })
  const r = first(out)
  assert.deepEqual(Object.values(r.criteria).map((c) => c.status), Array(7).fill('final'))
  assert.deepEqual(r.criteria.funding.score, 3)
  // (25*5 + 20*3 + 15*4 + 10*5 + 10*3 + 10*3 + 10*3.4) / 5
  assert.ok(Math.abs(r.score.point - (125 + 60 + 60 + 50 + 30 + 30 + 34) / 5) < 1e-9)
  assert.deepEqual(out.reviewQueue, [])
})

test('Engine: the still-needed list names the criterion, who can supply it, and what is missing', () => {
  const out = run([{ ...base, sponsorPath: null }])
  const queue = out.reviewQueue
  assert.equal(queue.filter((q) => q.kind === 'criterion').length, 7)
  assert.ok(queue.some((q) => q.kind === 'gate' && q.key === 'sponsor' && /DL3/.test(q.owner)))
  const scale = queue.find((q) => q.key === 'scale')
  assert.match(scale.owner, /Research/)
  assert.ok(scale.needs.length > 0)
  // sorted by owner, and benchmark-only or unresearched states never appear
  const withNoise = run([{ ...base, sponsorPath: null }, { ...base, id: 'bench', state: 'Bench', benchmarkOnly: true }, { ...base, id: 'u', state: 'U', researched: false }])
  assert.deepEqual([...new Set(withNoise.reviewQueue.map((q) => q.state))], ['X'])
})
