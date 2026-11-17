import { useState } from 'react'
import { useModel } from './model/ModelContext.jsx'
import { downloadExcel, downloadSourcesCsv, downloadTerritoriesCsv } from './exports.js'

// The printable pages. Only the chosen one is visible when printing.
function PrintReport({ mode, territories, sources, manifest }) {
  if (mode === 'territories') {
    return (
      <div className="print-report">
        <h1>DL3 territory report</h1>
        <p>Pipeline data from {manifest?.generated_at?.slice(0, 10) ?? 'the latest run'}. Scores marked ≈ are estimates while evidence is incomplete.</p>
        {territories.map((t) => (
          <section key={t.id} className="print-block">
            <h2>{t.name}</h2>
            <p>{t.kind} · {t.status} · Research: {t.depth} · Score: {t.scoreText}{t.scoreNote ? ` (${t.scoreNote})` : ''}</p>
            <p>Agency: {t.agency}. Open questions: {t.openQuestions}. Sources on file: {t.sources}. Last checked: {t.lastChecked}.</p>
            <p>Fee rule: {t.feeRule}. Credit cap: {t.creditCap}. Next deadline: {t.deadline}.</p>
          </section>
        ))}
      </div>
    )
  }
  if (mode === 'sources') {
    return (
      <div className="print-report">
        <h1>DL3 source report</h1>
        <p>Documents the data pipeline keeps, with the date each was last retrieved.</p>
        <ol>
          {sources.map((s) => (
            <li key={s.id}>
              <strong>{s.state} · {s.title}</strong>
              <div>{s.type} · {s.status} · retrieved {s.lastRetrieved ?? 'never'}{s.stale ? ' · older than 90 days' : ''}</div>
              <div className="print-link">{s.url}</div>
            </li>
          ))}
        </ol>
      </div>
    )
  }
  return null
}

export default function Downloads() {
  const { territories, sources, manifest } = useModel()
  // Printing needs the report on the page first, so pick the report, then print on the next tick.
  const [mode, setMode] = useState(null)
  const printReport = (which) => {
    setMode(which)
    setTimeout(() => {
      window.print()
      setTimeout(() => setMode(null), 300)
    }, 50)
  }

  return (
    <section className="card downloads" aria-labelledby="downloads-heading">
      <h2 id="downloads-heading">Downloads for reviewers</h2>
      <p className="small-note">Tables and reports for review. The numbers match what's on the screen, including your DL3 inputs.</p>
      <div className="download-grid">
        <button type="button" className="download-button" onClick={() => downloadTerritoriesCsv(territories)}>Table (.csv)</button>
        <button type="button" className="download-button" onClick={() => downloadExcel(territories, sources)}>Tables (.xlsx)</button>
        <button type="button" className="download-button" onClick={() => printReport('territories')}>Territory report (PDF)</button>
        <button type="button" className="download-button" onClick={() => printReport('sources')}>Source report (PDF)</button>
        <button type="button" className="download-button" onClick={() => downloadSourcesCsv(sources)}>Sources (.csv)</button>
      </div>
      <p className="small-note">For a PDF, the print window opens. Choose "Save as PDF" as the destination.</p>
      <PrintReport mode={mode} territories={territories} sources={sources} manifest={manifest} />
    </section>
  )
}
