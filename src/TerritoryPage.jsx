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
        {t.realFacts && (
          <div className="pathway-block">
            <h3>Public facts (not scored)</h3>
            <p className="small-note">
              From public agency sources. {t.realFacts.awardRowsFlaggedCheck} award rows flagged for checking are left out of the counts below.
            </p>
            <table className="facts-table">
              <thead>
                <tr><th>Year</th><th>9% awards</th><th>4% awards</th><th>Pathway unknown</th></tr>
              </thead>
              <tbody>
                {Object.entries(t.realFacts.awardsByYear).map(([year, c]) => (
                  <tr key={year}>
                    <td>{year}</td><td>{c['9%']}</td><td>{c['4%']}</td><td>{c.Unknown}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="small-note">
              Approved rules: {t.realFacts.approvedRules}. Not yet reviewed: {t.realFacts.notReviewedRules}.
            </p>
          </div>
        )}

        <div className="pathway-block">
          <h3>9% and 4% results</h3>
          {t.pathways.map((p) => (
            <div className="pathway-row" key={p.pathway}>
              <strong>{p.pathway} credits</strong>
              <span>Checks: {p.checks} · Confidence: {p.confidence}</span>
              <p className="small-note">{p.reason}</p>
            </div>
          ))}
        </div>

        <div className="pathway-block">
          <h3>Where to check this</h3>
          {t.sourceLinks.length === 0 ? (
            <p className="small-note">No public pages found for this area yet.</p>
          ) : (
            <ul className="source-links">
              {t.sourceLinks.map((l) => (
                <li key={l.url}>
                  <a href={l.url} target="_blank" rel="noopener noreferrer">{l.label}</a>
                </li>
              ))}
            </ul>
          )}
          <p className="small-note">Found automatically and not yet verified by a reviewer.</p>
        </div>

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
