import { TERRITORIES } from './data.js'

const byScore = (a, b) => (b.score ?? -1) - (a.score ?? -1)

// The Territories list. Each card opens that territory's own page.
export default function TerritoriesPage({ onOpen }) {
  return (
    <>
      <p className="small-note page-note">Select a territory to open its own page.</p>
      <div className="territory-list">
        {[...TERRITORIES].sort(byScore).map((t, i) => (
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
                <p className="small-note">{t.kind} · {t.status} · Research: {t.depth}</p>
              </div>
              <div className="score-pill">{t.scoreText}</div>
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
            <span className="open-link">View {t.name} →</span>
          </button>
        ))}
      </div>
    </>
  )
}
