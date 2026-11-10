import { useMemo, useState } from 'react'
import { COMPONENTS } from './config.js'
import { rankRecords } from './engine.js'
import { rankText, scoreText, toCsv, toQueueCsv } from './export.js'
import { REAL_DATA } from './realData.js'
import { SAMPLE_AS_OF, SAMPLE_RECORDS } from './sampleData.js'
import './RankingPage.css'

const round = (n) => Number(n.toFixed(1))
const TODAY = new Date().toISOString().slice(0, 10)
const STATUS_TEXT = { pass: '✓ Pass', fail: '✗ Fail', unknown: '? Unknown' }
const METHOD_TEXT = { calculated: 'calculated', entered: 'typed in', judgment: 'judgment', assumed: 'what-if assumption' }

// How one criterion's 0-5 result reads on screen.
function criterionText(c) {
  const range = c.interval ? `${round(c.interval.lo)}–${round(c.interval.hi)}` : null
  if (c.status === 'assumed') return `Assumed ${round(c.score)}`
  if (c.status === 'final') return `${round(c.score)} / 5`
  if (c.status === 'bounded') return `${range} / 5`
  if (c.status === 'proposed') return `Proposed ${range ?? round(c.score)}`
  return 'Unknown'
}

const money = (n) => `$${n.toLocaleString('en-US')}`

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
                  <span className="small block">{c.status === 'unresolved' ? 'needs input' : METHOD_TEXT[c.method]}{c.status === 'proposed' && ', awaiting approval'}</span>
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
      <ProgramLimits caps={r.programCaps} />
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
          {rankText(r).replace(' (withheld)', '').replace(' to ', '–')}
        </span>
        <div className="grow">
          <h3>{r.state}</h3>
          <p className="small">{r.allocator}</p>
        </div>
        <div className="score">
          <strong>{r.score.point !== null ? round(r.score.point) : `${round(r.score.lo)}–${round(r.score.hi)}`}</strong>
          <span className="small">{r.score.point !== null ? 'out of 100' : 'provisional'}</span>
        </div>
      </div>
      <ScoreBar score={r.score} />
      <div className="chips">
        <span className={`chip conf-${r.confidence.toLowerCase()}`}>{r.confidence} confidence</span>
        {r.previewOnly && <span className="chip warn">Preview only: checks still open</span>}
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
      <p className="small">{r.reason}</p>
      <details className="details">
        <summary>The five checks and scoring status</summary>
        <CheckList checks={r.gates.checks} />
        <p className="small"><strong>Scoring status</strong> (not used until the checks pass):</p>
        <CriteriaList criteria={r.criteria} />
        <ProgramLimits caps={r.programCaps} />
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
                <span className={`chip ${result.tone}`}>{result.text}</span>
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
              </div>
            </details>
          </li>
        )
      })}
    </ul>
  )
}

export default function RankingPage() {
  const [dataset, setDataset] = useState('real') // 'real' | 'preview' | 'sample'
  // PREVIEW placeholders. Every one is a stand-in for something DL3 has not decided yet.
  const [what, setWhat] = useState({ dl3Share: 60, deferred: 40, hurdle: 1000000, fillThree: true, includeOpen: true })
  const real = useMemo(() => rankRecords(REAL_DATA.records, { asOf: TODAY }), [])
  const preview = useMemo(
    () =>
      rankRecords(REAL_DATA.records, {
        asOf: TODAY,
        settings: {
          deriveEconomicsFromFee: true,
          requirePresentValue: false,
          economicsAssumptions: { dl3Share: what.dl3Share / 100, deferredShare: what.deferred / 100 },
          economicsHurdles: { minRetainedCash: what.hurdle },
          fillUnknownScore: what.fillThree ? 3 : null,
          previewIncludeOpenChecks: what.includeOpen,
        },
      }),
    [what],
  )
  const sample = useMemo(() => rankRecords(SAMPLE_RECORDS, { asOf: SAMPLE_AS_OF }), [])
  const result = dataset === 'real' ? real : dataset === 'preview' ? preview : sample
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

  function save(name, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }))
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.click()
    URL.revokeObjectURL(url)
  }
  const download = () => save(`dl3-state-ranking-${dataset}-${result.asOf}.csv`, toCsv(result))
  const downloadQueue = () => save(`dl3-open-items-${dataset}-${result.asOf}.csv`, toQueueCsv(result))

  return (
    <main className="ranking">
      <header>
        <p className="eyebrow">DL3 LIHTC opportunity model</p>
        <h1>State ranking</h1>
        <div className="seg" role="group" aria-label="Which data to show">
          <button aria-pressed={dataset === 'real'} className={dataset === 'real' ? 'on' : ''} onClick={() => setDataset('real')}>Real data (draft)</button>
          <button aria-pressed={dataset === 'preview'} className={dataset === 'preview' ? 'on' : ''} onClick={() => setDataset('preview')}>Preview scores</button>
          <button aria-pressed={dataset === 'sample'} className={dataset === 'sample' ? 'on' : ''} onClick={() => setDataset('sample')}>Sample (made up)</button>
        </div>
        {dataset === 'preview' ? (
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
              <label className="check">
                <input type="checkbox" checked={what.fillThree} onChange={(e) => setWhat({ ...what, fillThree: e.target.checked })} />
                <span>Assume 3 for any criterion with no evidence</span>
              </label>
              <label className="check">
                <input type="checkbox" checked={what.includeOpen} onChange={(e) => setWhat({ ...what, includeOpen: e.target.checked })} />
                <span>Include states whose checks are still open</span>
              </label>
              <p className="small">
                Placeholders: 60% and 40% are the guide’s own illustration, and the cash target is a stand-in for DL3’s real number. The present-value test is not applied. Developer economics is calculated from each state’s fee; the other six criteria have no data yet.
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
        <button className="download" onClick={download}>Download full report (CSV)</button>
      </Section>
    </main>
  )
}
