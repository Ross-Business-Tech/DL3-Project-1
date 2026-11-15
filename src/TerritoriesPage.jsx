import { useEffect } from 'react'
import { TERRITORIES } from './data.js'

const byScore = (a, b) => b.score - a.score

export default function TerritoriesPage({ selectedId, onBack }) {
  // When a territory was picked on the Rankings page, jump to its card.
  useEffect(() => {
    if (!selectedId) return
    document.getElementById(`t-${selectedId}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [selectedId])

  return (
    <>
      <div className="page-actions">
        <button type="button" className="text-button" onClick={onBack}>← Back to rankings</button>
      </div>
      <div className="territory-list">
        {[...TERRITORIES].sort(byScore).map((t, i) => (
          <section
            key={t.id}
            id={`t-${t.id}`}
            data-reveal
            style={{ '--d': `${Math.min(i, 4) * 90}ms` }}
            className={`card territory-card${selectedId === t.id ? ' is-selected' : ''}`}
            aria-labelledby={`t-${t.id}-name`}
          >
            <div className="territory-head">
              <div>
                <h2 id={`t-${t.id}-name`}>{t.name}</h2>
                <p className="small-note">{t.kind} · {t.status} · Research: {t.depth}</p>
              </div>
              <div className="score-pill">{t.score} / 100</div>
            </div>
            <dl className="detail-grid">
              <div><dt>Allocating agency</dt><dd>{t.agency}</dd></div>
              <div><dt>Open questions</dt><dd>{t.openQuestions}</dd></div>
              <div><dt>Sources on file</dt><dd>{t.sources}</dd></div>
              <div><dt>Last checked</dt><dd>{t.lastChecked}</dd></div>
              <div><dt>Developer fee rule</dt><dd>{t.feeRule}</dd></div>
              <div><dt>Credit cap</dt><dd>{t.creditCap}</dd></div>
              <div><dt>Next deadline</dt><dd>{t.deadline}</dd></div>
            </dl>
          </section>
        ))}
      </div>
    </>
  )
}
