import { useState } from 'react'
import { TERRITORIES } from './data.js'
import { MAP } from './mapPaths.js'

const byScore = (a, b) => b.score - a.score

// Map view: the US map from the project's reference image. Researched states are teal and can be clicked.
function MapView({ onOpen }) {
  const [message, setMessage] = useState('')
  const researched = new Map(TERRITORIES.filter((t) => t.kind === 'State').map((t) => [t.id, t]))

  const choose = (code) => {
    const t = researched.get(code)
    if (t) {
      setMessage('')
      onOpen(t.id)
    } else {
      setMessage(`${code} has not been researched yet, so there are no details to show.`)
    }
  }

  return (
    <>
      <svg className="us-map" viewBox={MAP.viewBox} role="group" aria-label="US map. Select a state.">
        {Object.entries(MAP.states).map(([code, d]) => {
          const t = researched.get(code)
          const name = t ? `${t.name}, score ${t.score}` : `${code}, not researched yet`
          return (
            <path
              key={code}
              d={d}
              className={`state${t ? ' is-data' : ''}`}
              role="button"
              tabIndex={0}
              aria-label={name}
              onClick={() => choose(code)}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && choose(code)}
            >
              <title>{name}</title>
            </path>
          )
        })}
      </svg>
      <div className="legend small-note">
        <span className="legend-item"><span className="swatch is-data" />Researched (sample)</span>
        <span className="legend-item"><span className="swatch" />Not researched yet</span>
      </div>
      {message && <p className="small-note" role="status">{message}</p>}
    </>
  )
}

// List view: every territory, filterable by type. Each row opens its details.
function ListView({ onOpen }) {
  const [kind, setKind] = useState('All')
  const rows = TERRITORIES.filter((t) => kind === 'All' || t.kind === kind).sort(byScore)

  return (
    <>
      <div className="segmented" role="group" aria-label="Location type">
        {['All', 'State', 'Local'].map((k) => (
          <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)}>
            {k === 'All' ? 'All locations' : k === 'State' ? 'States' : 'Local'}
          </button>
        ))}
      </div>
      <div className="list">
        {rows.map((t, i) => (
          <button type="button" className="list-row" key={t.id} onClick={() => onOpen(t.id)}>
            <span className="rank-num">#{i + 1}</span>
            <span className="rank-name">
              <strong>{t.name}</strong>
              <span>{t.kind} · {t.status}</span>
            </span>
            <span className="score-pill">{t.score} / 100</span>
          </button>
        ))}
      </div>
    </>
  )
}

export default function RankingsPage({ onOpenTerritory }) {
  const [view, setView] = useState('map')

  return (
    <>
      <div className="segmented view-toggle" role="group" aria-label="Choose a view">
        <button type="button" aria-pressed={view === 'map'} onClick={() => setView('map')}>Map view</button>
        <button type="button" aria-pressed={view === 'list'} onClick={() => setView('list')}>List view</button>
      </div>
      <div className="card">
        {view === 'map' ? <MapView onOpen={onOpenTerritory} /> : <ListView onOpen={onOpenTerritory} />}
      </div>
      <p className="small-note">Select a state or local area to open its details on the Territories page.</p>
    </>
  )
}
