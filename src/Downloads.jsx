import { useState } from 'react'
import { SOURCES, TERRITORIES } from './data.js'
import { downloadExcel, downloadPipelineRequest, downloadSelectedCsv, downloadSourcesCsv, downloadTerritoriesCsv } from './exports.js'
import { STATE_NAMES } from './stateNames.js'

// Every jurisdiction the pipeline covers (50 states, DC, Puerto Rico, the U.S. Virgin Islands, Chicago and NYC),
// in alphabetical order by name.
const ALL_CODES = Object.keys(STATE_NAMES).sort((a, b) => STATE_NAMES[a].localeCompare(STATE_NAMES[b]))

// The printable pages. Only the chosen one is visible when printing.
function PrintReport({ mode }) {
  if (mode === 'territories') {
    return (
      <div className="print-report">
        <h1>DL3 territory report</h1>
        <p>Sample data, and public facts where labeled. No area is scored yet.</p>
        {TERRITORIES.map((t) => (
          <section key={t.id} className="print-block">
            <h2>{t.name}</h2>
            <p>{t.kind} · {t.status} · Research: {t.depth} · Score: {t.scoreText}</p>
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
        <p>Public pages the team starts from. Each is re-checked before its rules are used.</p>
        <ol>
          {SOURCES.map((s) => (
            <li key={s.id}>
              <strong>{s.id} {s.title}</strong>
              <div>{s.use}</div>
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
  // Printing needs the report on the page first, so pick the report, then print on the next tick.
  const [mode, setMode] = useState(null)
  const printReport = (which) => {
    setMode(which)
    setTimeout(() => {
      window.print()
      setTimeout(() => setMode(null), 300)
    }, 50)
  }

  const [picked, setPicked] = useState([])
  const toggle = (code) =>
    setPicked((p) => (p.includes(code) ? p.filter((c) => c !== code) : [...p, code]))
  const ordered = ALL_CODES.filter((c) => picked.includes(c))

  return (
    <section className="card downloads" aria-labelledby="downloads-heading">
      <h2 id="downloads-heading">Downloads for reviewers</h2>
      <p className="small-note">Tables and reports for review. The numbers match what's on the screen.</p>
      <div className="download-grid">
        <button type="button" className="download-button" onClick={downloadTerritoriesCsv}>Table (.csv)</button>
        <button type="button" className="download-button" onClick={downloadExcel}>Tables (.xlsx)</button>
        <button type="button" className="download-button" onClick={() => printReport('territories')}>Territory report (PDF)</button>
        <button type="button" className="download-button" onClick={() => printReport('sources')}>Source report (PDF)</button>
        <button type="button" className="download-button" onClick={downloadSourcesCsv}>Sources (.csv)</button>
      </div>
      <p className="small-note">For a PDF, the print window opens. Choose "Save as PDF" as the destination.</p>

      <div className="state-picker">
        <h3>Choose states for the pipeline</h3>
        <p className="small-note">
          The website can't run the pipeline itself. Pick the states here, then download the list and the
          selected data. Running the pipeline happens on a computer with Python.
        </p>
        <div className="state-chips" role="group" aria-label="States">
          {ALL_CODES.map((c) => (
            <button
              type="button"
              key={c}
              className="state-chip"
              aria-pressed={picked.includes(c)}
              onClick={() => toggle(c)}
              data-name={STATE_NAMES[c]}
            >
              {c}
            </button>
          ))}
        </div>
        <p className="small-note">
          {ordered.length === 0 ? 'No states selected.' : `Selected: ${ordered.map((c) => STATE_NAMES[c]).join(', ')}`}
        </p>
        <div className="download-grid">
          <button type="button" className="download-button" onClick={() => setPicked(ALL_CODES)}>Select all</button>
          <button type="button" className="download-button" onClick={() => setPicked([])}>Clear</button>
          <button
            type="button"
            className="download-button"
            disabled={ordered.length === 0}
            onClick={() => downloadSelectedCsv(ordered, STATE_NAMES)}
          >
            Selected states (.csv)
          </button>
          <button
            type="button"
            className="download-button"
            disabled={ordered.length === 0}
            onClick={() => downloadPipelineRequest(ordered)}
          >
            Pipeline request (.txt)
          </button>
        </div>
      </div>

      <PrintReport mode={mode} />
    </section>
  )
}
