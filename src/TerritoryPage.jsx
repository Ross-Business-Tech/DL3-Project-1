import { TERRITORIES } from './data.js'

// One territory's own page: its full details, with links back to the list and to its sources.
export default function TerritoryPage({ id, onBack, onSources }) {
  const t = TERRITORIES.find((x) => x.id === id)
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
        <p className="small-note">
          Rule values stay as "Needs verification" until a reviewer confirms them.
        </p>
        <div className="page-actions">
          <button type="button" className="text-button" onClick={onSources}>See sources and evidence →</button>
        </div>
      </section>
    </>
  )
}
