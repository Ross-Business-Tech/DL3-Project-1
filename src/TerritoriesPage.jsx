import { useState } from 'react'
import { useModel } from './model/ModelContext.jsx'

const byScore = (a, b) => (b.estimate ?? -1) - (a.estimate ?? -1) || a.name.localeCompare(b.name)
const FILTERS = [['Presented', 'MI · OH · IN'], ['Deep', 'Researched in depth'], ['All', 'All states']]

// The Territories list. Each card opens that territory's own page.
export default function TerritoriesPage({ onOpen }) {
  const { territories } = useModel()
  const [filter, setFilter] = useState('Presented')
  const rows = territories
    .filter((t) => filter === 'All' || (filter === 'Presented' ? t.presented : t.depth === 'In depth'))
    .sort(byScore)
  return (
    <>
      <div className="segmented" role="group" aria-label="Which states">
        {FILTERS.map(([k, label]) => (
          <button key={k} type="button" aria-pressed={filter === k} onClick={() => setFilter(k)}>{label}</button>
        ))}
      </div>
      <p className="small-note page-note">Select a territory to open its own page. {rows.length} shown.</p>
      <div className="territory-list">
        {rows.map((t, i) => (
          <button
            type="button"
            key={t.id}
            data-reveal
            style={{ '--d': `${Math.min(i, 4) * 90}ms` }}
            className="card territory-card territory-button"
            onClick={() => onOpen(t.id)}
            aria-label={`${t.name}: open details`}
          >
            <div className="territory-head">
              <div>
                <h2>{t.name}</h2>
                <p className="small-note">{t.status} · Research: {t.depth}</p>
              </div>
              <div className={`score-pill${t.isEstimate ? ' is-estimate' : ''}`}>{t.scoreText}</div>
            </div>
            <dl className="detail-grid">
              <div><dt>Allocating agency</dt><dd>{t.agency}</dd></div>
              <div><dt>Open questions</dt><dd>{t.openQuestions}</dd></div>
              <div><dt>Approved rules</dt><dd>{t.pipeline?.rules.length ?? 0}</dd></div>
              <div><dt>Last checked</dt><dd>{t.lastChecked}</dd></div>
              <div><dt>Developer fee rule</dt><dd>{t.feeRule}</dd></div>
              <div><dt>Credit cap</dt><dd>{t.creditCap}</dd></div>
            </dl>
            <span className="open-link">View {t.name} →</span>
          </button>
        ))}
      </div>
    </>
  )
}
