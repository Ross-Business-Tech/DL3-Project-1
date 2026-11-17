import { useMemo, useState } from 'react'
import { COMPONENTS, RESEARCH_VIEW_SETTINGS } from './config.js'
import { defaultWeights } from './engine.js'
import { profilesHtml } from './report.js'
import { refreshDemo, withAssumptionSensitivity } from './sensitivity.js'
import { rankText, scoreText, toCsv, toQueueCsv } from './export.js'
import { REAL_DATA } from './realData.js'
import { SAMPLE_AS_OF, SAMPLE_RECORDS } from './sampleData.js'
import './RankingPage.css'

const round = (n) => Number(n.toFixed(1))
const money = (n) => `$${n.toLocaleString('en-US')}`
const TODAY = new Date().toISOString().slice(0, 10)
const STATUS_TEXT = { pass: '✓ Pass', fail: '✗ Fail', unknown: '? Unknown' }
const METHOD_TEXT = { calculated: 'calculated', entered: 'typed in', judgment: 'judgment', assumed: 'what-if assumption' }

// How one criterion's 0-5 result reads on screen.
function criterionText(c) {
  const range = c.interval ? `${round(c.interval.lo)}–${round(c.interval.hi)}` : null
  if (c.status === 'assumed') return `Assumed ${round(c.score)}`
  if (c.status === 'final') return `${round(c.score)} / 5`
  if (c.status === 'bounded') return `${range} / 5`
  if (c.status === 'proposed') return `${range ?? round(c.score)} / 5 (AI)`
  return 'Unknown'
}


// Where a reviewer can check a state: the plan, award lists and bond program the scraping pipeline found.
// Found automatically and NOT verified; the crawler can miss things or pick up a draft.
function SourceLinks({ sources }) {
  if (!sources) return null
  const L = sources.links
  const seen = new Set()
  const items = [
    L.qapCurrent && ['Latest non-draft plan', L.qapCurrent],
    L.qapPage && ['Plan page', L.qapPage],
    L.applicationRound && ['Application round', L.applicationRound],
    L.bondProgram && ['Bond program (4%)', L.bondProgram],
    L.underwritingManual && ['Underwriting manual', L.underwritingManual],
    ...L.awardLists.slice(0, 3).map((a, i) => [`Award list${a.label ? ` (${a.label})` : ` ${i + 1}`}`, a.url]),
  ].filter((x) => x && !seen.has(x[1]) && seen.add(x[1]))
  if (items.length === 0 && !sources.agency) return <p className="small">The scraping pipeline found no documents for this state yet.</p>
  return (
    <>
      <p className="small"><strong>Where to check this</strong> (found automatically by the scraping pipeline, not verified)</p>
      <ul className="srcs small">
        {items.map(([label, url]) => (
          <li key={url}><a href={url} target="_blank" rel="noopener noreferrer">{label}</a></li>
        ))}
      </ul>
      {sources.qapStatus && sources.qapStatus !== 'unknown' && (
        <p className="small">Plan status: {sources.qapStatus === 'draft' ? 'the crawler flagged a draft plan, so do not treat it as a rule' : 'only related documents were found, not the plan itself'}.</p>
      )}
      {sources.qapStatus === 'unknown' && <p className="small">Plan status: draft or final is not confirmed.</p>}
      {sources.awardYearsText && <p className="small">Award lists the crawler saw: {sources.awardYearsText}. A hint only; real coverage can be wider.</p>}
      {sources.crawl.errors > 0 && <p className="small warn">The crawler had {sources.crawl.errors} error{sources.crawl.errors === 1 ? '' : 's'} on this site, so this list may be incomplete.</p>}
    </>
  )
}

const fieldText = (f) => (f.charAt(0).toUpperCase() + f.slice(1)).replace(/_/g, ' ')
const dateText = (iso) => (iso ? iso.slice(0, 10) : 'unknown')

// What the data pipeline (dl3-lihtc-model/) adds for a state: rules a named person approved, with page and
// quote; its award rows for this pathway; cost per unit; the top-100 metro screen; document freshness.
// Evidence only: nothing here changes a gate or a score.
function PipelineEvidence({ p, pathway }) {
  if (!p) return null
  const awards = p.awards.filter((a) => a.pathway === pathway)
  const otherAwards = p.awards.filter((a) => a.pathway !== pathway && a.pathway !== '9%' && a.pathway !== '4%')
  const cost = p.costs.find((c) => c.pathway === pathway)
  const byTopic = new Map()
  for (const r of p.rules) byTopic.set(r.topicLabel, [...(byTopic.get(r.topicLabel) ?? []), r])
  const stale = p.documents.filter((d) => d.stale)
  return (
    <>
      <p className="small"><strong>From the data pipeline</strong> (collected from official documents; rules shown only after a person approved them)</p>
      {p.metro && (
        <p className="small">
          Top-100 metro screen ({p.metro.vintage ?? 'Census ACS 5-year'}):{' '}
          {p.metro.inTop
            ? <>yes, part of {p.metro.count} of the {p.metro.topN} largest metro areas; largest is {p.metro.largest} (#{p.metro.largestRank}).</>
            : <>no, not part of any of the {p.metro.topN} largest metro areas.</>}
        </p>
      )}
      {cost && (
        <p className="small">
          Total development cost per unit ({pathway}, {cost.year}): median {money(cost.median)} from {cost.projects} of {cost.of} projects
          {cost.min !== null && cost.max !== null && <> (range {money(cost.min)}–{money(cost.max)})</>}; a 100-unit deal at the median is about {money(cost.for100Units)}.
        </p>
      )}
      {awards.length > 0 && (
        <details className="details">
          <summary>Award rows the pipeline collected for {pathway}: {awards.reduce((n, a) => n + a.awards, 0)}</summary>
          <table className="parts">
            <tbody>
              <tr><td><strong>Year</strong></td><td className="num"><strong>Awards</strong></td><td className="num"><strong>101+ units</strong></td></tr>
              {awards.map((a) => (
                <tr key={a.year}><td>{a.year}</td><td className="num">{a.awards}</td><td className="num">{a.units100}</td></tr>
              ))}
            </tbody>
          </table>
          <p className="small">Spreadsheet rows read in code plus PDF rows a person approved. Rows still needing a check are left out. A cross-check on our own award research, not used in the score.</p>
        </details>
      )}
      {otherAwards.length > 0 && (
        <p className="small">{otherAwards.reduce((n, a) => n + a.awards, 0)} more award rows do not say whether they are 9% or 4%.</p>
      )}
      {byTopic.size > 0 && (
        <details className="details">
          <summary>Approved rules from the plan: {p.rules.length}</summary>
          {[...byTopic.entries()].map(([topic, rules]) => (
            <div key={topic}>
              <p className="small"><strong>{topic}</strong></p>
              <ul className="srcs small">
                {rules.map((r, i) => (
                  <li key={`${r.field}${r.page}${i}`}>
                    {fieldText(r.field)}: <strong>{r.value}</strong>{r.appliesTo !== 'unknown' && ` (${r.appliesTo})`}
                    {r.quote && <span className="block">“{r.quote.length > 220 ? `${r.quote.slice(0, 220)}…` : r.quote}”</span>}
                    <span className="block">
                      {r.url ? <a href={r.url} target="_blank" rel="noopener noreferrer">{r.document ?? 'source'}</a> : (r.document ?? 'source')}
                      {r.page !== null && `, p. ${r.page}`}{r.docStatus === 'draft' && ' · draft document'}{r.reviewedOn && ` · approved ${r.reviewedOn}`}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </details>
      )}
      {p.documents.length > 0 && (
        <p className={`small ${stale.length ? 'warn' : ''}`}>
          {p.documents.length} source document{p.documents.length === 1 ? '' : 's'} kept by the pipeline
          {stale.length ? `; ${stale.length} older than the 90-day limit, recheck before relying on them` : '; all checked within 90 days'}.
        </p>
      )}
    </>
  )
}

// What the program's rules allow for a single project, with the source it came from.
function ProgramLimits({ caps }) {
  if (!caps) return null
  const unitCap = caps.unitCap === 'none-stated' ? 'No cap stated in the rules' : caps.unitCap === 'unknown' ? 'Not checked yet' : `${caps.unitCap} units`
  const rows = [
    ['Maximum credit per project', caps.maxCreditText ?? 'Not found'],
    ['Unit cap', unitCap],
    ['Cost cap', caps.costCapText ?? 'Not found'],
    ['Bond volume cap per project', caps.bondVolumeCap !== null ? money(caps.bondVolumeCap) : 'Not found'],
    ['Developer fee limit', caps.developerFeeLimitText ?? 'Not found'],
    ['Maximum credit per unit', caps.creditPerUnitAt120 !== null ? `${money(caps.creditPerUnitAt120)} at 120 units, ${money(caps.creditPerUnitAt200)} at 200 units` : 'Not calculable'],
  ]
  return (
    <>
      <p className="small"><strong>What the program rules allow for one project</strong></p>
      <table className="parts">
        <tbody>
          {rows.map(([label, value]) => (
            <tr key={label}><td>{label}</td><td className="num wrap">{value}</td></tr>
          ))}
        </tbody>
      </table>
      <p className="small">
        Source: <a href={caps.source} target="_blank" rel="noopener noreferrer">official document</a>, retrieved {caps.retrieved}. Fee limits are in each program’s own terms (often a share of eligible basis), not DL3’s 10%-of-total-cost test.
      </p>
    </>
  )
}

function CriteriaList({ criteria }) {
  return (
    <>
      <table className="parts">
        <tbody>
          {COMPONENTS.map((comp) => {
            const c = criteria[comp.key]
            return (
              <tr key={comp.key}>
                <td>
                  {comp.label}
                  <span className="small block">{c.status === 'unresolved' ? 'needs input' : METHOD_TEXT[c.method]}{c.status === 'proposed' && ', AI-researched, awaiting DL3 review'}</span>
                </td>
                <td className="num">{comp.weight}%</td>
                <td className="num">{criterionText(c)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {COMPONENTS.map((comp) => {
        const c = criteria[comp.key]
        if (c.status === 'final' && c.method === 'entered') return null
        const lines = c.status === 'final' ? c.reasons : c.needs
        if (lines.length === 0) return null
        return (
          <p className="small" key={comp.key}>
            <strong>{comp.label}{c.status === 'final' ? '' : ' still needs'}:</strong> {lines.join(' · ')}
          </p>
        )
      })}
    </>
  )
}

function ScoreBar({ score }) {
  return (
    <div className="bar" role="img" aria-label={`Score ${scoreText(score)} out of 100`}>
      {score.point === null && <div className="bar-range" style={{ left: `${score.lo}%`, width: `${score.hi - score.lo}%` }} />}
      <div className="bar-fill" style={{ width: `${score.lo}%` }} />
    </div>
  )
}

function CheckList({ checks }) {
  return (
    <ul className="checks">
      {checks.map((c) => (
        <li key={c.key}>
          <span className={`ck ck-${c.status}`}>{STATUS_TEXT[c.status]}</span> {c.label}
          <span className="small block">{c.detail}</span>
        </li>
      ))}
    </ul>
  )
}

function Details({ r }) {
  return (
    <details className="details">
      <summary>Why this score</summary>
      <CriteriaList criteria={r.criteria} />
      <EconomicsBlock detail={r.economicsDetail} />
      <AssumptionChanges changes={r.assumptionChanges} />
      <ProgramLimits caps={r.programCaps} />
      <SourceLinks sources={r.sources} />
      <PipelineEvidence p={r.pipeline} pathway={r.pathway} />
      {Object.entries(r.evidence).map(([key, text]) => (
        <p className="small" key={key}>
          <strong>{COMPONENTS.find((c) => c.key === key)?.label}:</strong> {text}
        </p>
      ))}
      {r.stability.changes.length > 0 && (
        <>
          <p className="small"><strong>Changes when a weight moves 20%:</strong></p>
          <ul className="small">{r.stability.changes.slice(0, 5).map((c) => <li key={c}>{c}</li>)}</ul>
        </>
      )}
      {r.warnings.map((w) => <p className="small warn" key={w}>{w}</p>)}
      {r.overrides.map((o) => (
        <p className="small" key={`${o.component}${o.date}`}>
          Override on {COMPONENTS.find((c) => c.key === o.component)?.label}: {o.from ?? 'unknown'} to {o.to}, approved by {o.approver} on {o.date} ({o.reason}).
        </p>
      ))}
    </details>
  )
}

function RankedCard({ r }) {
  return (
    <li className={`card ${r.actionable ? 'is-actionable' : ''}`}>
      <div className="card-head">
        <span className={`rank ${r.rank === null ? 'rank-open' : ''}`} title={r.rank === null ? 'Rank withheld: missing evidence could change it' : undefined}>
          {r.estimateRank ? `#${r.estimateRank}` : rankText(r).replace(' (withheld)', '').replace(' to ', '–')}
        </span>
        <div className="grow">
          <h3>{r.state}</h3>
          <p className="small">{r.allocator}</p>
        </div>
        <div className="score">
          <strong>{r.score.point !== null ? round(r.score.point) : r.score.estimate != null ? round(r.score.estimate) : `${round(r.score.lo)}–${round(r.score.hi)}`}</strong>
          <span className="small">{r.score.point !== null ? 'out of 100' : r.score.estimate != null ? `best estimate (range ${round(r.score.lo)}–${round(r.score.hi)})` : 'provisional'}</span>
        </div>
      </div>
      <ScoreBar score={r.score} />
      <div className="chips">
        <span className={`chip conf-${r.confidence.toLowerCase()}`}>{r.confidence} confidence</span>
        {r.previewOnly && <span className="chip warn">Provisional: checks still open</span>}
        {r.assumptionChanges?.length > 0 && <span className="chip warn">Sensitive to assumptions</span>}
        {feeCheckOf(r)?.denominatorSensitive && <span className="chip warn">Fee result depends on the cost definition</span>}
        {r.actionable && <span className="chip good">Actionable shortlist</span>}
        {r.tied && <span className="chip">Tied</span>}
        {r.provisional && <span className="chip warn">Evidence {Math.round((r.evidenceCoverage ?? r.score.coverage) * 100)}% complete</span>}
        {r.stability.unstable && <span className="chip warn">Unstable if weights change</span>}
        {r.overridden && <span className="chip">Override logged</span>}
      </div>
      <p className="small">{r.reason}</p>
      <p className="small">
        <strong>Next:</strong> {r.action}
        {r.nextDeadline && <> · Deadline {r.nextDeadline}</>}
      </p>
      <Details r={r} />
    </li>
  )
}

// A researched jurisdiction that is held for verification or excluded: show exactly why.
function CheckCard({ r }) {
  return (
    <li className="card">
      <div className="card-head">
        <div className="grow">
          <h3>{r.state}</h3>
          <p className="small">{r.allocator}</p>
        </div>
        <span className={`chip conf-${r.confidence.toLowerCase()}`}>{r.confidence} confidence</span>
      </div>
      {(r.assumptionChanges?.length > 0 || feeCheckOf(r)?.denominatorSensitive) && (
        <div className="chips">
          {r.assumptionChanges?.length > 0 && <span className="chip warn">Sensitive to assumptions</span>}
          {feeCheckOf(r)?.denominatorSensitive && <span className="chip warn">Fee result depends on the cost definition</span>}
        </div>
      )}
      <p className="small">{r.reason}</p>
      <details className="details">
        <summary>The five checks and scoring status</summary>
        <CheckList checks={r.gates.checks} />
        <p className="small"><strong>Scoring status</strong> (not used until the checks pass):</p>
        <CriteriaList criteria={r.criteria} />
        <EconomicsBlock detail={r.economicsDetail} />
        <AssumptionChanges changes={r.assumptionChanges} />
        <ProgramLimits caps={r.programCaps} />
        <SourceLinks sources={r.sources} />
        <PipelineEvidence p={r.pipeline} pathway={r.pathway} />
        {r.nextDeadline && <p className="small"><strong>Next deadline:</strong> {r.nextDeadline}</p>}
        {r.notes && <p className="small"><strong>Research notes:</strong> {r.notes}</p>}
      </details>
    </li>
  )
}

function Section({ title, hint, children }) {
  return (
    <section className="side">
      <h2>{title}</h2>
      {hint && <p className="small">{hint}</p>}
      {children}
    </section>
  )
}

// Which checks are holding researched jurisdictions back, most common first.
function blockers(items) {
  const counts = new Map()
  for (const r of items) {
    for (const c of r.gates.checks) {
      if (c.status === 'pass') continue
      const entry = counts.get(c.key) ?? { label: c.label, unknown: 0, fail: 0 }
      entry[c.status]++
      counts.set(c.key, entry)
    }
  }
  return [...counts.values()].sort((a, b) => b.unknown + b.fail - (a.unknown + a.fail))
}

// Weights that do not total 100 are rescaled to 100 (all zero falls back to the guide's weights).
function rescaleWeights(w) {
  const total = COMPONENTS.reduce((s, c) => s + (Number(w[c.key]) || 0), 0)
  return total > 0 ? Object.fromEntries(COMPONENTS.map((c) => [c.key, ((Number(w[c.key]) || 0) * 100) / total])) : defaultWeights()
}

// Developer economics, laid out the way guide 5B asks: gross fee, DL3 retained fee, cash at each
// milestone, deferred amount, present value. Placeholder terms are said out loud.
function EconomicsBlock({ detail }) {
  if (!detail) return null
  const pct = (x) => `${(x * 100).toFixed(2)}%`
  const t = detail.terms
  const rows = [
    ['Approved gross fee', `${money(detail.approvedGrossFee)} (${pct(detail.grossFeeToTdc)} of cost)`],
    [`DL3 retained fee (${Math.round(t.dl3Share * 100)}% share)`, `${money(Math.round(detail.retainedFee))} (${pct(detail.retainedFeeToTdc)})`],
    ['Cash at closing / construction / completion', `${money(Math.round(detail.cash.closing))} / ${money(Math.round(detail.cash.construction))} / ${money(Math.round(detail.cash.completion))}`],
    [`Deferred, paid later (${Math.round(t.deferredShare * 100)}%)`, money(Math.round(detail.deferredAmount))],
    ['Present value of receipts, if DL3 wins', money(Math.round(detail.presentValue))],
    [`Expected pursuit value (${Math.round(t.awardProbability * 100)}% chance to win)`, money(Math.round(detail.expectedPursuitValue))],
    ['Downside: cash / present value', `${money(Math.round(detail.downside.nonDeferredCash))} / ${money(Math.round(detail.downside.presentValue))}`],
  ]
  return (
    <>
      <p className="small"><strong>Developer economics</strong> (guide 5B, with placeholder terms)</p>
      <table className="parts">
        <tbody>
          {rows.map(([a, b]) => (
            <tr key={a}><td>{a}</td><td className="num wrap">{b}</td></tr>
          ))}
        </tbody>
      </table>
      <p className="small">
        Placeholders until DL3 sets its own: {Math.round(t.dl3Share * 100)}% share and {Math.round(t.deferredShare * 100)}% deferred (the guide’s illustration); cash at years {t.years.closing}, {t.years.construction} and {t.years.completion}; deferred fee repaid in years {t.deferredRepaymentYears[0]}–{t.deferredRepaymentYears[1]} with {Math.round(t.deferredRepaymentProbability * 100)}% likelihood; {Math.round(t.closeProbability * 100)}% chance of closing and {Math.round(t.completeProbability * 100)}% of completing; {Math.round(t.discountRate * 100)}% discount rate. Downside: {Math.round(t.downside.deferredShareIncrease * 100)} points more deferred, a {t.downside.delayYears}-year delay, {Math.round(t.downside.deferredRepaymentProbability * 100)}% repayment.
      </p>
    </>
  )
}

function AssumptionChanges({ changes }) {
  if (!changes || changes.length === 0) return null
  return (
    <>
      <p className="small"><strong>What changes if an assumption moves</strong> (guide 7B)</p>
      <ul className="small">{changes.map((c) => <li key={c}>{c}</li>)}</ul>
    </>
  )
}

const feeCheckOf = (r) => r.gates.checks.find((c) => c.key === 'fee')

// How a state's developer fee looks against the 10% rule, in plain words.
function feeResult(r) {
  const check = r.gates.checks.find((c) => c.key === 'fee')
  if (r.benchmarkOnly) return { text: 'Benchmark only', tone: '' }
  if (check.status === 'pass') return { text: 'Passes', tone: 'good' }
  if (check.status === 'fail') return { text: r.gates.status === 'Fail' ? 'Fails, excluded' : 'Fails, held for verification', tone: 'warn' }
  if (/not verified yet/.test(check.detail)) return { text: 'Would pass, rule not verified', tone: 'warn' }
  if (r.feeScreen?.fee == null) return { text: 'No fee rule found', tone: 'warn' }
  return { text: 'Not established', tone: 'warn' }
}

function FeeScreenList({ rows }) {
  return (
    <ul className="fee-list">
      {rows.map((r) => {
        const check = r.gates.checks.find((c) => c.key === 'fee')
        const result = feeResult(r)
        const s = r.feeScreen
        const ratio = check.ratio ?? s.ratio ?? null
        return (
          <li key={r.id}>
            <details className="fee-row">
              <summary>
                <span className="fee-state">{r.state}</span>
                <span className="fee-pct">{ratio !== null ? `${(ratio * 100).toFixed(2)}%` : '–'}</span>
                <span className={`chip ${result.tone}`}>{result.text}{check.denominatorSensitive ? ' · depends on the cost definition' : ''}</span>
              </summary>
              <div className="fee-body small">
                <p><strong>Rule:</strong> {s.ruleText ?? 'No fee rule found.'}</p>
                {s.encoding && <p><strong>How it was modelled:</strong> {s.encoding}</p>}
                {s.fee !== null && <p><strong>Fee at the example project (dashboard):</strong> {money(s.fee)}</p>}
                <p><strong>This tool’s reading:</strong> {check.detail}.</p>
                {s.ruleVerified === false && s.binding && <p><strong>Dashboard note:</strong> {s.binding}</p>}
                <p>
                  <strong>Review:</strong> {s.status}; {s.qa === 'not reviewed' ? 'not independently reviewed' : `independent review: ${s.qa}`}. Confidence: {r.confidence}.
                  {s.url && <> <a href={s.url} target="_blank" rel="noopener noreferrer">Fee rule source</a></>}
                </p>
                <SourceLinks sources={r.sources} />
              </div>
            </details>
          </li>
        )
      })}
    </ul>
  )
}

export default function RankingPage() {
  const [dataset, setDataset] = useState('research') // 'research' | 'real' | 'preview' | 'sample'
  // PREVIEW placeholders. Every one is a stand-in for something DL3 has not decided yet.
  const [what, setWhat] = useState({ dl3Share: 60, deferred: 40, hurdle: 1000000, pvHurdle: 1000000, fillThree: true, includeOpen: true })
  // Which cost the 10% fee test uses (guide section 5 is the proposed default; section 1 is the alternative).
  const [denominator, setDenominator] = useState('tdc')
  // Editable weights (guide 9C: "editable scoring settings"). If they do not total 100 they are rescaled.
  const [weights, setWeights] = useState(defaultWeights())
  const weightTotal = COMPONENTS.reduce((s, c) => s + (Number(weights[c.key]) || 0), 0)
  const [demo, setDemo] = useState(null)
  const real = useMemo(() => withAssumptionSensitivity(REAL_DATA.records, { asOf: TODAY, settings: { feeDenominator: denominator } }), [denominator])
  // Researched scores: AI-researched judgments count (labeled), with the settings in config.js.
  const research = useMemo(
    () => withAssumptionSensitivity(REAL_DATA.records, { asOf: TODAY, settings: { ...RESEARCH_VIEW_SETTINGS, feeDenominator: denominator } }),
    [denominator],
  )
  const preview = useMemo(
    () =>
      withAssumptionSensitivity(REAL_DATA.records, {
        asOf: TODAY,
        weights: rescaleWeights(weights),
        settings: {
          feeDenominator: denominator,
          deriveEconomicsFromFee: true,
          requirePresentValue: true,
          economicsAssumptions: { dl3Share: what.dl3Share / 100, deferredShare: what.deferred / 100 },
          economicsHurdles: { minRetainedCash: what.hurdle, minPresentValue: what.pvHurdle },
          fillUnknownScore: what.fillThree ? 3 : null,
          previewIncludeOpenChecks: what.includeOpen,
        },
      }),
    [what, denominator, weights],
  )
  const sample = useMemo(() => withAssumptionSensitivity(SAMPLE_RECORDS, { asOf: SAMPLE_AS_OF, settings: { feeDenominator: denominator } }), [denominator])
  const result = dataset === 'research' ? research : dataset === 'real' ? real : dataset === 'preview' ? preview : sample
  const setNumber = (field, max) => (e) => setWhat({ ...what, [field]: Math.min(max, Math.max(0, Number(e.target.value) || 0)) })
  const [pathway, setPathway] = useState('9%')
  const list = result.lists.find((l) => l.pathway === pathway) ?? result.lists[0]

  // Three depths of evidence: researched in depth, fee screen only (draft from the team dashboard), nothing yet.
  const researched = list.needsVerification.filter((r) => r.researched && !r.screenOnly)
  const screened = list.needsVerification.filter((r) => r.screenOnly)
  const unresearched = list.needsVerification.filter((r) => !r.researched)
  const feeRows = [...list.ranked, ...list.needsVerification, ...list.excluded, ...list.benchmark]
    .filter((r) => r.feeScreen)
    .sort((a, b) => a.state.localeCompare(b.state))
  const feeTally = { pass: 0, fail: 0, unverified: 0, none: 0 }
  for (const r of feeRows) {
    const t = feeResult(r).text
    if (t === 'Benchmark only') continue
    if (t === 'Passes') feeTally.pass++
    else if (t.startsWith('Fails')) feeTally.fail++
    else if (t.startsWith('Would pass')) feeTally.unverified++
    else feeTally.none++
  }
  const totalPass = result.lists.reduce((n, l) => n + l.counts.pass, 0)
  const researchedNames = [...new Set(REAL_DATA.records.filter((r) => r.researched && !r.screenOnly).map((r) => r.state))]

  const queue = result.reviewQueue.filter((q) => q.pathway === list.pathway)
  const byOwner = [...new Set(queue.map((q) => q.owner))].map((owner) => ({ owner, items: queue.filter((q) => q.owner === owner) }))

  function save(name, text, type = 'text/csv') {
    const url = URL.createObjectURL(new Blob([text], { type }))
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.click()
    URL.revokeObjectURL(url)
  }
  const download = () => save(`dl3-state-ranking-${dataset}-${result.asOf}.csv`, toCsv(result))
  const downloadQueue = () => save(`dl3-open-items-${dataset}-${result.asOf}.csv`, toQueueCsv(result))
  const downloadProfiles = () =>
    save(
      `dl3-pilot-profiles-${dataset}-${result.asOf}.html`,
      profilesHtml(result, {
        title: dataset === 'preview' ? 'DL3 LIHTC pilot profiles (PREVIEW with placeholders)' : 'DL3 LIHTC pilot profiles',
        status: dataset === 'preview' ? 'PREVIEW, not a result: scores use placeholders DL3 has not approved.' : 'Draft research data, not reviewed by DL3.',
      }),
      'text/html',
    )

  return (
    <main className="ranking">
      <header>
        <p className="eyebrow">DL3 LIHTC opportunity model</p>
        <h1>State ranking</h1>
        <div className="seg" role="group" aria-label="Which data to show">
          <button aria-pressed={dataset === 'research'} className={dataset === 'research' ? 'on' : ''} onClick={() => setDataset('research')}>Researched scores</button>
          <button aria-pressed={dataset === 'real'} className={dataset === 'real' ? 'on' : ''} onClick={() => setDataset('real')}>Evidence only</button>
          <button aria-pressed={dataset === 'preview'} className={dataset === 'preview' ? 'on' : ''} onClick={() => setDataset('preview')}>What-if</button>
          <button aria-pressed={dataset === 'sample'} className={dataset === 'sample' ? 'on' : ''} onClick={() => setDataset('sample')}>Sample (made up)</button>
        </div>
        <label className="denom">
          <span>Fee test measured against</span>
          <select value={denominator} onChange={(e) => setDenominator(e.target.value)}>
            <option value="tdc">Total development cost (guide section 5, default)</option>
            <option value="net">Cost less fee, land and reserves (guide section 1)</option>
          </select>
        </label>
        {dataset === 'research' && (
          <p className="banner">
            <strong>Researched scores.</strong> AI research agents gathered cited evidence (from search excerpts of agency documents; the agency sites themselves were blocked, so fee rules are marked unverified) for {REAL_DATA.stats.researchedByAgents} states on top of our own research. Their 0–5 judgments count here, marked “AI”, and have not been reviewed by DL3. Developer economics uses placeholder terms; Scale and Funding use statewide award counts until the urban filter has site facts. States with a check still open are ranked provisionally; a state that failed a check is never ranked. Where evidence is still missing, the big number is a best estimate: the middle of the range the score could fall in, and states are ordered by it.
          </p>
        )}
        {dataset === 'research' ? null : dataset === 'preview' ? (
          <>
            <p className="banner">
              <strong>Preview, not a result.</strong> These scores use placeholders DL3 has not approved. Change them below and everything re-scores.
              {!what.fillThree && ' Criteria with no evidence stay unknown, so scores are ranges.'}
              {what.fillThree && ' Every criterion with no evidence is assumed to score 3, so most of each score is an assumption.'}
              {what.includeOpen && ' States researched in depth whose checks are still open are included; a state that failed a check never is.'}
            </p>
            <div className="whatif">
              <label>
                <span>DL3’s share of each fee (%)</span>
                <input type="number" inputMode="numeric" min="0" max="100" value={what.dl3Share} onChange={setNumber('dl3Share', 100)} />
              </label>
              <label>
                <span>Share of that paid later (%)</span>
                <input type="number" inputMode="numeric" min="0" max="100" value={what.deferred} onChange={setNumber('deferred', 100)} />
              </label>
              <label>
                <span>Cash DL3 needs in hand ($)</span>
                <input type="number" inputMode="numeric" min="0" step="100000" value={what.hurdle} onChange={setNumber('hurdle', 1e9)} />
              </label>
              <label>
                <span>Present value DL3 needs ($)</span>
                <input type="number" inputMode="numeric" min="0" step="100000" value={what.pvHurdle} onChange={setNumber('pvHurdle', 1e9)} />
              </label>
              <label className="check">
                <input type="checkbox" checked={what.fillThree} onChange={(e) => setWhat({ ...what, fillThree: e.target.checked })} />
                <span>Assume 3 for any criterion with no evidence</span>
              </label>
              <label className="check">
                <input type="checkbox" checked={what.includeOpen} onChange={(e) => setWhat({ ...what, includeOpen: e.target.checked })} />
                <span>Include states whose checks are still open</span>
              </label>
              <details className="details">
                <summary>Weights (total {round(weightTotal)}{Math.abs(weightTotal - 100) > 1e-9 ? ', rescaled to 100' : ''})</summary>
                <div className="weights">
                  {COMPONENTS.map((c) => (
                    <label key={c.key}>
                      <span>{c.label}</span>
                      <input type="number" inputMode="numeric" min="0" max="100" value={weights[c.key]} onChange={(e) => setWeights({ ...weights, [c.key]: Math.min(100, Math.max(0, Number(e.target.value) || 0)) })} />
                    </label>
                  ))}
                  <button type="button" className="download" onClick={() => setWeights(defaultWeights())}>Reset to the guide’s proposed weights</button>
                </div>
              </details>
              <p className="small">
                Placeholders: 60% and 40% are the guide’s own illustration; the cash and present-value targets, timing, probabilities, discount rate and downside case are stand-ins for DL3’s real terms (each card shows the full calculation). Developer economics is calculated from each state’s fee; the other six criteria have no data yet.
              </p>
            </div>
          </>
        ) : dataset === 'real' ? (
          <p className="banner">
            Draft research data, not yet reviewed by DL3. Only {REAL_DATA.stats.researchedStates} of {REAL_DATA.stats.states} states
            ({researchedNames.join(', ')}) are researched in depth. The other states have only a fee screen (a draft from the team dashboard; only the fee check uses it) or nothing yet.
            {totalPass === 0 && ' No state has passed every check yet, so nothing is ranked.'}
          </p>
        ) : (
          <p className="banner">
            Sample data only. Every state, number and score here is made up to show how the ranking works. Nothing on this page is a real result.
          </p>
        )}
      </header>

      <div className="tabs" role="tablist" aria-label="Credit pathway">
        {result.lists.map((l) => (
          <button key={l.pathway} role="tab" aria-selected={l.pathway === list.pathway} className={l.pathway === list.pathway ? 'on' : ''} onClick={() => setPathway(l.pathway)}>
            {l.pathway} credit
            <span className="small"> {l.ranked.length} ranked</span>
          </button>
        ))}
      </div>

      <p className="small summary">
        {list.counts.total} states in the {list.pathway} pathway: {list.counts.pass} passed every check{list.counts.previewRanked ? `, ${list.counts.previewRanked} ranked as a preview with checks still open` : ''}, {list.counts.needsVerification} need verification
        ({researched.length} researched in depth, {screened.length} fee screen only, {unresearched.length} nothing yet), {list.counts.fail} failed a check.
        {list.counts.benchmark > 0 && ` Illinois is shown for benchmarking only.`}
      </p>

      <section>
        <h2>Ranking</h2>
        {list.ranked.length > 0 ? (
          <ol className="plain">{list.ranked.map((r) => <RankedCard key={r.id} r={r} />)}</ol>
        ) : (
          <div className="empty">
            <p><strong>No state has passed every check yet.</strong> A state is only ranked once all five checks pass, and unknown never counts as a pass.</p>
            {blockers(researched).length > 0 && (
              <>
                <p className="small">What is holding the {researched.length} researched {researched.length === 1 ? 'state' : 'states'} back:</p>
                <ul className="small">
                  {blockers(researched).map((b) => (
                    <li key={b.label}>
                      {b.label}: {b.unknown > 0 && `${b.unknown} unknown`}{b.unknown > 0 && b.fail > 0 && ', '}{b.fail > 0 && `${b.fail} fail on current data`}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
      </section>

      {researched.length > 0 && (
        <Section title="Researched, needs verification" hint="Some evidence is still unknown or low confidence. These are not scored until it is checked.">
          <ul className="plain">{researched.map((r) => <CheckCard key={r.id} r={r} />)}</ul>
        </Section>
      )}

      {list.excluded.some((r) => !r.screenOnly) && (
        <Section title="Excluded" hint="Failed a check on evidence that is not low confidence, so they are left out however well they might score. Kept here for the coverage report.">
          <ul className="plain">{list.excluded.filter((r) => !r.screenOnly).map((r) => <CheckCard key={r.id} r={r} />)}</ul>
        </Section>
      )}

      {feeRows.length > 0 && (
        <Section
          title="Fee screen for every state (draft)"
          hint="From the team dashboard, not produced by this tool. Fee is for the guide's example project (120 units, $40,000,000 total development cost; where a rule needs an eligible base, 75% of cost). Only the fee check uses it: sponsor path, financing and project size are still unknown for these states. A fee that passes only on a rule the dashboard calls unverified does not count as a pass."
        >
          <details className="details">
            <summary>
              {feeTally.pass} pass · {feeTally.fail} fail · {feeTally.unverified} would pass on an unverified rule · {feeTally.none} no fee established (Illinois, benchmark only, is listed but not counted)
            </summary>
            <FeeScreenList rows={feeRows} />
          </details>
        </Section>
      )}

      {dataset !== 'sample' && REAL_DATA.pipeline.stats.states > 0 && (
        <Section
          title="From the data pipeline"
          hint={`Collected from official documents by the team's pipeline (export of ${dateText(REAL_DATA.pipeline.generatedAt)}). Each state's card shows the details under “Why this score”. Rules appear only after a named person approved them. None of this changes a score yet.`}
        >
          <ul className="names small">
            <li><strong>{REAL_DATA.pipeline.stats.approvedRules}</strong> approved rules for {REAL_DATA.pipeline.stats.statesWithRules.join(', ') || 'no state yet'}</li>
            <li><strong>{REAL_DATA.pipeline.stats.awardRows}</strong> award rows collected</li>
            <li><strong>{REAL_DATA.pipeline.stats.statesInTopMetros}</strong> of the 50 states and DC are part of a top-100 metro area (Census ACS 5-year)</li>
            {REAL_DATA.pipeline.stats.statesOutsideTopMetros.length > 0 && (
              <li>Not part of one: {REAL_DATA.pipeline.stats.statesOutsideTopMetros.join(', ')}</li>
            )}
          </ul>
          {REAL_DATA.pipeline.stats.staleCritical.length > 0 && (
            <p className="small warn">Critical sources older than 90 days: {REAL_DATA.pipeline.stats.staleCritical.join('; ')}</p>
          )}
        </Section>
      )}

      {dataset !== 'sample' && REAL_DATA.inventory.researchNext.length > 0 && (
        <Section
          title="Where to research next"
          hint="From the team's scraping pipeline, which crawled each agency's site to find the plan and award lists. It undercounts: for Michigan it found one of the five years, but we have sourced counts for all five. So 'none' means 'not found yet', not 'does not exist'."
        >
          {[
            ['three-plus', 'Award lists for at least 3 of the 5 years 2021–2025'],
            ['one-or-two', 'Award lists for 1 or 2 of those years'],
            ['unclear', 'Award lists found, years unclear'],
            ['none', 'No award list found yet'],
          ].map(([key, label]) => {
            const states = REAL_DATA.inventory.researchNext.filter((s) => s.coverage === key)
            return (
              <details className="details" key={key}>
                <summary>{label}: {states.length} {states.length === 1 ? 'state' : 'states'}</summary>
                <ul className="names small">
                  {states.map((s) => (
                    <li key={s.state}>
                      <strong>{s.state}</strong>{s.researchedInDepth ? ' (researched in depth)' : ''}
                      {s.yearsText ? ` · years seen: ${s.yearsText}` : ''}
                    </li>
                  ))}
                </ul>
              </details>
            )
          })}
        </Section>
      )}

      {unresearched.length > 0 && (
        <Section title="Nothing found yet">
          <details className="details">
            <summary>{unresearched.length} {unresearched.length === 1 ? 'state has' : 'states have'} no fee rule or other data yet (agency name only)</summary>
            <ul className="names small">
              {unresearched.map((r) => (
                <li key={r.id}><strong>{r.state}</strong> · {r.allocator}</li>
              ))}
            </ul>
          </details>
        </Section>
      )}

      {list.benchmark.length > 0 && (
        <Section title="Benchmark only" hint="Researched for comparison and rule changes, but kept out of the active new-development shortlist.">
          <ul className="plain">
            {list.benchmark.map((r) => (
              <li key={r.id} className="side-row">
                <strong>{r.state}</strong>
                <span className="small">{r.allocator}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {queue.length > 0 && (
        <Section
          title="Still needed to finish scoring"
          hint={`${queue.length} open items for the researched states in the ${list.pathway} pathway, grouped by who can supply them.`}
        >
          <ul className="plain">
            {byOwner.map(({ owner, items }) => (
              <li key={owner} className="side-row">
                <details className="details">
                  <summary><strong>{owner}</strong> · {items.length} {items.length === 1 ? 'item' : 'items'}</summary>
                  <ul className="needs small">
                    {items.map((q) => (
                      <li key={`${q.id}-${q.kind}-${q.key}`}>
                        <strong>{q.state}</strong>, {q.item}: {q.needs.length > 0 ? q.needs.join('; ') : q.reasons.join('; ')}
                      </li>
                    ))}
                  </ul>
                </details>
              </li>
            ))}
          </ul>
          <button className="download" onClick={downloadQueue}>Download open items (CSV)</button>
        </Section>
      )}

      {dataset !== 'sample' && (
        <Section
          title="Refresh demo"
          hint="What happens when a source changes (guide sections 2 and 10): the change flows through the checks, the lists and the economics, and a change report says exactly what moved. This simulates one change; the data files are not touched."
        >
          {demo ? (
            <>
              <p className="small">{demo.description}</p>
              {demo.changes.length === 0 ? (
                <p className="small">Nothing changed.</p>
              ) : (
                <ul className="plain">
                  {demo.changes.map((c) => (
                    <li key={c.id} className="side-row">
                      <strong>{c.state}, {c.pathway}</strong>
                      <ul className="small">{c.changes.map((m) => <li key={m}>{m}</li>)}</ul>
                    </li>
                  ))}
                </ul>
              )}
              <button className="download" onClick={() => setDemo(null)}>Clear the demo</button>
            </>
          ) : (
            <button
              className="download"
              onClick={() => setDemo(refreshDemo(REAL_DATA.records, { asOf: TODAY, settings: { feeDenominator: denominator } }))}
            >
              Simulate Indiana’s fee rule changing from 15% to 12%
            </button>
          )}
        </Section>
      )}

      <Section title="How it works">
        <details className="details">
          <summary>Weights and rules</summary>
          <table className="parts">
            <tbody>
              {COMPONENTS.map((c) => (
                <tr key={c.key}><td>{c.label}</td><td className="num">{c.weight}%</td></tr>
              ))}
            </tbody>
          </table>
          <ul className="small">
            <li>Each factor is scored 0 to 5. Score = sum of (weight × score) ÷ 5, out of 100.</li>
            <li>
              “Urban” means all three: inside a Census Urbanized Area ({result.settings.urbanDefinition.boundaryVintage} boundaries); inside a principal city or a DL3-approved neighborhood or transit corridor; and a dense enough tract
              ({result.settings.urbanDefinition.tractDensityFloorPerSqMile.toLocaleString('en-US')}+ residents per square mile) or fixed-route transit within {result.settings.urbanDefinition.transitDistanceMiles} mile.
              {result.settings.urbanDefinition.approved ? '' : ' This definition is proposed, not yet approved, and its density number is a placeholder, so scores that rest on it are shown as proposals and do not count yet.'}
            </li>
            <li>A state must have room for a project of 101+ units, a developer fee above 10% of development cost, a sponsor path, and workable financing, with sources checked in the last {result.settings.staleAfterDays} days.</li>
            <li>A failure that rests on low-confidence evidence is held for verification, not excluded.</li>
            <li>Missing factors give a range, never a guess. A rank is withheld when missing evidence could change it.</li>
            <li>Every weight is moved up and down 20% to see whether the order changes.</li>
            <li>Weights and thresholds are proposals until DL3 approves them. Model version {result.modelVersion}, run date {result.asOf}.</li>
          </ul>
        </details>
        <button className="download" onClick={downloadProfiles}>Download pilot profiles (printable report)</button>
        <button className="download" onClick={download}>Download full report (CSV)</button>
      </Section>
    </main>
  )
}
