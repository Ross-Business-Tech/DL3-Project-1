import { useMemo, useState } from 'react'
import { COMPONENTS } from './config.js'
import { rankRecords } from './engine.js'
import { rankText, scoreText, toCsv } from './export.js'
import { REAL_DATA } from './realData.js'
import { SAMPLE_AS_OF, SAMPLE_RECORDS } from './sampleData.js'
import './RankingPage.css'

const round = (n) => Number(n.toFixed(1))
const TODAY = new Date().toISOString().slice(0, 10)
const STATUS_TEXT = { pass: '✓ Pass', fail: '✗ Fail', unknown: '? Unknown' }

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
  const funding = r.derived.funding
  return (
    <details className="details">
      <summary>Why this score</summary>
      <table className="parts">
        <tbody>
          {COMPONENTS.map((c) => {
            const s = r.scores[c.key]
            const known = r.score.unknown.includes(c.key) === false
            return (
              <tr key={c.key}>
                <td>{c.label}</td>
                <td className="num">{c.weight}%</td>
                <td className="num">{known ? `${s} / 5` : 'Unknown'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {Object.entries(r.evidence).map(([key, text]) => (
        <p className="small" key={key}>
          <strong>{COMPONENTS.find((c) => c.key === key)?.label}:</strong> {text}
        </p>
      ))}
      {funding?.note && <p className="small">{funding.note}.</p>}
      {funding?.index != null && (
        <p className="small">
          Funding index {round(funding.index)} of 100 (award rate {round(funding.awardRate * 100)}%, from {funding.universe} jurisdictions).
        </p>
      )}
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
        {r.actionable && <span className="chip good">Actionable shortlist</span>}
        {r.tied && <span className="chip">Tied</span>}
        {r.provisional && <span className="chip warn">Evidence {Math.round(r.score.coverage * 100)}% complete</span>}
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
        <summary>The five checks</summary>
        <CheckList checks={r.gates.checks} />
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

export default function RankingPage() {
  const [dataset, setDataset] = useState('real')
  const real = useMemo(() => rankRecords(REAL_DATA.records, { asOf: TODAY }), [])
  const sample = useMemo(() => rankRecords(SAMPLE_RECORDS, { asOf: SAMPLE_AS_OF }), [])
  const result = dataset === 'real' ? real : sample
  const [pathway, setPathway] = useState('9%')
  const list = result.lists.find((l) => l.pathway === pathway) ?? result.lists[0]

  const researched = list.needsVerification.filter((r) => r.researched)
  const unresearched = list.needsVerification.filter((r) => !r.researched)
  const totalPass = result.lists.reduce((n, l) => n + l.counts.pass, 0)
  const researchedNames = [...new Set(REAL_DATA.records.filter((r) => r.researched).map((r) => r.state))]

  function download() {
    const url = URL.createObjectURL(new Blob([toCsv(result)], { type: 'text/csv' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `dl3-state-ranking-${dataset}-${result.asOf}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <main className="ranking">
      <header>
        <p className="eyebrow">DL3 LIHTC opportunity model</p>
        <h1>State ranking</h1>
        <div className="seg" role="group" aria-label="Which data to show">
          <button aria-pressed={dataset === 'real'} className={dataset === 'real' ? 'on' : ''} onClick={() => setDataset('real')}>Real data (draft)</button>
          <button aria-pressed={dataset === 'sample'} className={dataset === 'sample' ? 'on' : ''} onClick={() => setDataset('sample')}>Sample data (made up)</button>
        </div>
        {dataset === 'real' ? (
          <p className="banner">
            Draft research data, retrieved Nov 8, 2026, not yet reviewed by DL3. Only {REAL_DATA.stats.researchedStates} of {REAL_DATA.stats.states} states
            ({researchedNames.join(', ')}) have been researched; the rest list the agency only.
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
        {list.counts.total} states in the {list.pathway} pathway: {list.counts.pass} passed every check, {list.counts.needsVerification} need verification
        ({researched.length} researched, {unresearched.length} not yet researched), {list.counts.fail} failed a check.
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

      {list.excluded.length > 0 && (
        <Section title="Excluded" hint="Failed a check on evidence that is not low confidence, so they are left out however well they might score. Kept here for the coverage report.">
          <ul className="plain">{list.excluded.map((r) => <CheckCard key={r.id} r={r} />)}</ul>
        </Section>
      )}

      {unresearched.length > 0 && (
        <Section title="Not researched yet">
          <details className="details">
            <summary>{unresearched.length} states have only an agency name so far</summary>
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
