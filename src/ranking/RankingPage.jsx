import { useMemo, useState } from 'react'
import { COMPONENTS } from './config.js'
import { rankRecords } from './engine.js'
import { rankText, scoreText, toCsv } from './export.js'
import { SAMPLE_AS_OF, SAMPLE_RECORDS } from './sampleData.js'
import './RankingPage.css'

const round = (n) => Number(n.toFixed(1))

function ScoreBar({ score }) {
  return (
    <div className="bar" role="img" aria-label={`Score ${scoreText(score)} out of 100`}>
      {score.point === null && <div className="bar-range" style={{ left: `${score.lo}%`, width: `${score.hi - score.lo}%` }} />}
      <div className="bar-fill" style={{ width: `${score.lo}%` }} />
    </div>
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

function SideList({ title, hint, items }) {
  if (items.length === 0) return null
  return (
    <section className="side">
      <h2>{title}</h2>
      <p className="small">{hint}</p>
      <ul className="plain">
        {items.map((r) => (
          <li key={r.id} className="side-row">
            <strong>{r.state}</strong>
            <span className="small">{r.reason}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

export default function RankingPage() {
  const result = useMemo(() => rankRecords(SAMPLE_RECORDS, { asOf: SAMPLE_AS_OF }), [])
  const [pathway, setPathway] = useState(result.lists[0].pathway)
  const list = result.lists.find((l) => l.pathway === pathway)

  function download() {
    const url = URL.createObjectURL(new Blob([toCsv(result)], { type: 'text/csv' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `dl3-state-ranking-${result.asOf}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <main className="ranking">
      <header>
        <p className="eyebrow">DL3 LIHTC opportunity model</p>
        <h1>State ranking</h1>
        <p className="banner">
          Sample data only. Every state, number and score here is made up to show how the ranking works. Nothing on this page is a real result.
        </p>
      </header>

      <div className="tabs" role="tablist" aria-label="Credit pathway">
        {result.lists.map((l) => (
          <button key={l.pathway} role="tab" aria-selected={l.pathway === pathway} className={l.pathway === pathway ? 'on' : ''} onClick={() => setPathway(l.pathway)}>
            {l.pathway} credit
            <span className="small"> {l.ranked.length} ranked</span>
          </button>
        ))}
      </div>

      <p className="small summary">
        {list.counts.total} jurisdictions in the {list.pathway} pathway: {list.counts.pass} passed the gates, {list.counts.needsVerification} need verification, {list.counts.fail} failed a gate.
      </p>

      <section>
        <h2>Ranking</h2>
        {list.ranked.length === 0 ? <p>No jurisdiction has passed every gate yet.</p> : <ol className="plain">{list.ranked.map((r) => <RankedCard key={r.id} r={r} />)}</ol>}
      </section>

      <SideList title="Needs verification" hint="Unknown or stale evidence cannot pass. These are not scored until it is checked." items={list.needsVerification} />
      <SideList title="Excluded" hint="Failed a gate, so they are left out however well they might score. Kept here for the coverage report." items={list.excluded} />

      <section className="side">
        <h2>How it works</h2>
        <details className="details" open={false}>
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
            <li>Missing factors give a range, never a guess. A rank is withheld when missing evidence could change it.</li>
            <li>Every weight is moved up and down 20% to see whether the order changes.</li>
            <li>Weights and thresholds are proposals until DL3 approves them. Model version {result.modelVersion}, run date {result.asOf}.</li>
          </ul>
        </details>
        <button className="download" onClick={download}>Download full report (CSV)</button>
      </section>
    </main>
  )
}
