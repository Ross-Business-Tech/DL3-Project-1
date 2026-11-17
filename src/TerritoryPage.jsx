import { useState } from 'react'
import { COMPONENTS } from './ranking/config.js'
import { VENTURE_FACTORS } from './ranking/scoring.js'
import { useModel } from './model/ModelContext.jsx'
import { approvalKey, withDecision } from './model/dl3Inputs.js'

const money = (n) => (typeof n === 'number' ? n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }) : '—')
const CHECK_TEXT = { pass: 'Pass', fail: 'Fail', unknown: 'Not confirmed yet' }

function criterionText(c) {
  if (!c) return '—'
  if (Array.isArray(c.interval)) return `${c.interval[0]}–${c.interval[1]}`
  if (c.score === null || c.score === undefined) return 'Needs input'
  const s = Number.isInteger(c.score) ? c.score : c.score.toFixed(1)
  return c.status === 'final' ? `${s}` : `${s} (${c.status === 'proposed' ? 'proposed' : c.status})`
}

const LABEL = Object.fromEntries(COMPONENTS.map((c) => [c.key, c.label]))
const pct = (x) => `${(x * 100).toFixed(1).replace(/\.0$/, '')}%`

// Where the developer fee behind the fee check comes from, and whether the pipeline's approved rules agree.
function FeeSource({ fee }) {
  if (!fee?.pipeline) return null
  const pf = fee.pipeline
  const rule = `${pf.percents.map(pct).join(' / ')}${pf.cap ? `, capped at ${money(pf.cap)}` : ''}`
  if (fee.fromPipeline) {
    return <p className="small-note">Developer fee {money(fee.gross)} on a {money(fee.tdc)} deal, from reviewer-approved rules ({rule}; {pf.tdcBasis}).{pf.conflicting ? ' The rules disagree, so the lowest fee is used.' : ''}</p>
  }
  if (typeof fee.gross === 'number' && Math.round(fee.gross) !== Math.round(pf.fee)) {
    return (
      <p className="small-note warn">
        The pipeline’s approved rules ({rule}) give a fee of {money(pf.fee)} on a {money(pf.tdc)} deal; our research uses {money(fee.gross)}.
        Our research is kept until someone checks which is right.
      </p>
    )
  }
  return <p className="small-note">The pipeline’s approved rules agree with our research on the developer fee ({rule}).</p>
}

// The scores researchers proposed (Access, Urban, DL3 execution, Venture fit), with DL3's decision on each.
function Proposals({ code, p }) {
  const { inputs, setInputs, viewer } = useModel()
  const [changing, setChanging] = useState(null)
  const decisions = inputs.approvals?.[approvalKey(code, p.pathway)] ?? {}
  const decide = (c, d) => { setInputs(withDecision(inputs, code, p.pathway, c, d, viewer ?? 'DL3')); setChanging(null) }
  const rows = ['access', 'urban', 'execution', 'venture'].map((c) => {
    const d = decisions[c]
    const j = c === 'venture' ? null : p.judgments?.[c]
    const v = c === 'venture' ? p.venture : null
    const was = p.rejected?.[c]?.was
    const has = j || v || was || d
    if (!has) return null
    const proposed = c === 'venture'
      ? (v ?? was) && VENTURE_FACTORS.filter((f) => (v ?? was)[f.key]).map((f) => `${f.label} ${(v ?? was)[f.key].score}`).join(' · ')
      : (j ?? was) && `${(j ?? was).score} / 5`
    const evidence = c === 'venture'
      ? VENTURE_FACTORS.map((f) => (v ?? was)?.[f.key]?.evidence).filter(Boolean).join(' ')
      : (j ?? was)?.evidence
    return { c, d, proposed, evidence, approved: c === 'venture' ? Boolean(v?.approvedBy) : Boolean(j?.approvedBy) }
  }).filter(Boolean)
  if (rows.length === 0) return null
  return (
    <details className="details" open={rows.some((r) => !r.approved && !r.d)}>
      <summary>Scores proposed by researchers: {rows.filter((r) => !r.approved && !r.d).length} waiting for a DL3 decision</summary>
      <ul className="proposal-list">
        {rows.map(({ c, d, proposed, evidence, approved }) => (
          <li key={c} className="proposal">
            <strong>{LABEL[c]}</strong>
            <div>Proposed: {proposed ?? 'no proposal'}{' '}
              <span className="small-note">
                {d?.decision === 'approve' && `· approved by ${d.by} on ${d.on}`}
                {d?.decision === 'change' && `· changed to ${d.score} by ${d.by} on ${d.on}`}
                {d?.decision === 'reject' && `· rejected by ${d.by} on ${d.on}`}
                {!d && approved && '· approved'}
                {!d && !approved && '· waiting for a DL3 decision'}
              </span>
            </div>
            {evidence && <p className="small-note">{evidence.length > 400 ? `${evidence.slice(0, 400)}…` : evidence}</p>}
            {d?.note && <p className="small-note">Note: {d.note}</p>}
            <div className="proposal-actions">
              {d ? (
                <button type="button" className="text-button" onClick={() => decide(c, null)}>Undo decision</button>
              ) : changing === c ? (
                <ChangeForm onCancel={() => setChanging(null)} onSave={(score, note) => decide(c, { decision: 'change', score, note })} />
              ) : (
                <>
                  <button type="button" className="download-button" onClick={() => decide(c, { decision: 'approve' })}>Approve</button>
                  {c !== 'venture' && <button type="button" className="download-button" onClick={() => setChanging(c)}>Change score</button>}
                  <button type="button" className="download-button" onClick={() => decide(c, { decision: 'reject', note: window.prompt('Why reject it? (optional)') ?? undefined })}>Reject</button>
                </>
              )}
            </div>
          </li>
        ))}
      </ul>
      <p className="small-note">Decisions are saved with the DL3 inputs in this browser (and in “Save to a file”). Approved scores count as final.</p>
    </details>
  )
}

function ChangeForm({ onSave, onCancel }) {
  const [score, setScore] = useState('')
  const [note, setNote] = useState('')
  return (
    <div className="change-form">
      <select aria-label="New score" value={score} onChange={(e) => setScore(e.target.value)}>
        <option value="">Score…</option>
        {[0, 1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
      </select>
      <input aria-label="Reason" placeholder="Reason" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />
      <button type="button" className="download-button primary" disabled={score === ''} onClick={() => onSave(Number(score), note)}>Save</button>
      <button type="button" className="text-button" onClick={onCancel}>Cancel</button>
    </div>
  )
}

function Pathway({ code, p, usingPlaceholders }) {
  return (
    <div className="pathway-row">
      <strong>{p.pathway} credits</strong>
      <span>Checks: {p.checks} · Confidence: {p.confidence}</span>
      {p.reason && <p className="small-note">{p.reason}</p>}
      {p.checksList.length > 0 && (
        <table className="facts-table">
          <thead><tr><th>Check</th><th>Result</th><th>Why</th></tr></thead>
          <tbody>
            {p.checksList.map((c) => (
              <tr key={c.label}><td>{c.label}</td><td>{CHECK_TEXT[c.status] ?? c.status}</td><td title={c.detail}>{c.detail?.length > 200 ? `${c.detail.slice(0, 190)}…` : c.detail}</td></tr>
            ))}
          </tbody>
        </table>
      )}
      <FeeSource fee={p.fee} />
      <Proposals code={code} p={p} />
      {p.criteria && (
        <details className="details">
          <summary>Scores by criterion (0–5)</summary>
          <table className="facts-table">
            <thead><tr><th>Criterion</th><th>Weight</th><th>Score</th></tr></thead>
            <tbody>
              {COMPONENTS.map((comp) => (
                <tr key={comp.key}><td>{comp.label}</td><td>{comp.weight}%</td><td>{criterionText(p.criteria[comp.key])}</td></tr>
              ))}
            </tbody>
          </table>
          {p.criteria.economics?.placeholder && usingPlaceholders && (
            <p className="small-note">Developer economics uses placeholder DL3 terms. Enter DL3’s own on the DL3 inputs page.</p>
          )}
        </details>
      )}
      {p.action && <p className="small-note"><strong>Next step:</strong> {p.action}</p>}
    </div>
  )
}

function Evidence({ p }) {
  if (!p) return <p className="small-note">The data pipeline has not collected anything for this state yet. Run it from the Run pipeline page.</p>
  const byTopic = new Map()
  for (const r of p.rules) byTopic.set(r.topicLabel, [...(byTopic.get(r.topicLabel) ?? []), r])
  const years = [...new Set(p.awards.map((a) => a.year))].sort()
  const count = (year, pathway) => p.awards.filter((a) => a.year === year && a.pathway === pathway).reduce((n, a) => n + a.awards, 0)
  const stale = p.documents.filter((d) => d.stale).length
  return (
    <>
      {p.metro && (
        <p className="small-note">
          Top-100 metro screen ({p.metro.vintage ?? 'Census ACS 5-year'}):{' '}
          {p.metro.inTop ? `yes, ${p.metro.count} of the ${p.metro.topN} largest metros; largest is ${p.metro.largest} (#${p.metro.largestRank}).` : `no, not part of any of the ${p.metro.topN} largest metros.`}
        </p>
      )}
      {p.costs.length > 0 && (
        <table className="facts-table">
          <thead><tr><th>Cost per unit</th><th>Year</th><th>Median</th><th>100-unit deal</th></tr></thead>
          <tbody>
            {p.costs.map((c) => (
              <tr key={`${c.pathway}${c.year}`}><td>{c.pathway} ({c.projects} of {c.of} projects)</td><td>{c.year}</td><td>{money(c.median)}</td><td>{money(c.for100Units)}</td></tr>
            ))}
          </tbody>
        </table>
      )}
      {years.length > 0 && (
        <table className="facts-table">
          <thead><tr><th>Awards</th><th>9%</th><th>4%</th><th>Not stated</th></tr></thead>
          <tbody>
            {years.map((y) => (
              <tr key={y}><td>{y}</td><td>{count(y, '9%')}</td><td>{count(y, '4%')}</td><td>{count(y, 'UNKNOWN') + count(y, 'unknown')}</td></tr>
            ))}
          </tbody>
        </table>
      )}
      {byTopic.size > 0 ? (
        <details className="details">
          <summary>Approved rules from the state’s documents: {p.rules.length}</summary>
          {[...byTopic.entries()].map(([topic, rules]) => (
            <div key={topic}>
              <p className="small-note"><strong>{topic}</strong></p>
              <ul className="source-links">
                {rules.map((r, i) => (
                  <li key={`${r.field}${r.page}${i}`}>
                    {r.field.replaceAll('_', ' ')}: <strong>{r.value}</strong>{r.appliesTo !== 'unknown' && ` (${r.appliesTo})`}
                    {r.quote && <span className="quote">“{r.quote.length > 240 ? `${r.quote.slice(0, 240)}…` : r.quote}”</span>}
                    <span className="small-note">
                      {r.url ? <a href={r.url} target="_blank" rel="noopener noreferrer">{r.document ?? 'source'}</a> : (r.document ?? 'source')}
                      {r.page !== null && `, p. ${r.page}`}{r.docStatus === 'draft' && ' · draft document'}{r.reviewedOn && ` · approved ${r.reviewedOn}`}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </details>
      ) : (
        <p className="small-note">No rules have been approved by a reviewer for this state yet.</p>
      )}
      <p className="small-note">
        {p.documents.length} document{p.documents.length === 1 ? '' : 's'} on file
        {stale ? `; ${stale} older than 90 days, re-check before relying on them.` : '; all checked within 90 days.'}
      </p>
    </>
  )
}

// One territory's own page: score, checks, the pipeline's evidence, and where to check it.
export default function TerritoryPage({ id, onBack, onSources }) {
  const { territories, inputStatus } = useModel()
  const t = territories.find((x) => x.id === id)
  if (!t) return <p className="placeholder">That territory could not be found.</p>

  return (
    <>
      <div className="page-actions">
        <button type="button" className="text-button" onClick={onBack}>← Back to territories</button>
      </div>
      <section className="card territory-page" data-reveal>
        <div className="territory-head">
          <div>
            <h2>{t.name}</h2>
            <p className="small-note">{t.status} · Research: {t.depth}</p>
          </div>
          <div className={`score-pill${t.isEstimate ? ' is-estimate' : ''}`}>{t.scoreText}</div>
        </div>
        {t.scoreNote && <p className="small-note">{t.scoreNote}</p>}
        <dl className="detail-grid">
          <div><dt>Allocating agency</dt><dd>{t.agency}</dd></div>
          <div><dt>Open questions</dt><dd>{t.openQuestions}</dd></div>
          <div><dt>Last checked</dt><dd>{t.lastChecked}</dd></div>
          <div><dt>Developer fee rule</dt><dd>{t.feeRule}</dd></div>
          <div><dt>Credit cap</dt><dd>{t.creditCap}</dd></div>
          <div><dt>Next deadline</dt><dd>{t.deadline}</dd></div>
        </dl>

        <div className="pathway-block">
          <h3>9% and 4% results</h3>
          {t.pathways.map((p) => <Pathway key={p.pathway} code={t.id} p={p} usingPlaceholders={inputStatus.usingPlaceholders} />)}
        </div>

        <div className="pathway-block">
          <h3>From the data pipeline</h3>
          <Evidence p={t.pipeline} />
        </div>

        <div className="pathway-block">
          <h3>Where to check this</h3>
          {t.sourceLinks.length === 0 ? (
            <p className="small-note">No agency pages found for this state yet.</p>
          ) : (
            <ul className="source-links">
              {t.sourceLinks.map((l) => (
                <li key={l.url}><a href={l.url} target="_blank" rel="noopener noreferrer">{l.label}</a></li>
              ))}
            </ul>
          )}
          <p className="small-note">Links found by the crawler. Rules count only after a reviewer approves them.</p>
        </div>
        <div className="page-actions">
          <button type="button" className="text-button" onClick={onSources}>See all documents →</button>
        </div>
      </section>
    </>
  )
}
