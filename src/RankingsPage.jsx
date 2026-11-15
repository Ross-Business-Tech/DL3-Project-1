import { useState } from 'react'
import { TERRITORIES, TILES } from './data.js'

const byScore = (a, b) => b.score - a.score

// Map view: one tile per state. Tiles with sample details can be clicked.
function TileMap({ onOpen }) {
  const [message, setMessage] = useState('')
  const researched = new Map(TERRITORIES.filter((t) => t.kind === 'State').map((t) => [t.id, t]))

  return (
    <>
      <div className="tile-grid">
        {TILES.map((tile) => {
          const t = researched.get(tile.code)
          const cls = `tile${t ? ' is-data' : ''}`
          return (
            <button
              type="button"
              key={tile.code}
              className={cls}
              style={{ gridColumn: tile.col + 1, gridRow: tile.row + 1 }}
              aria-label={t ? `${t.name}, score ${t.score}` : `${tile.code}, not researched yet`}
              onClick={() => (t ? onOpen(t.id) : setMessage(`${tile.code} has not been researched yet, so there are no details to show.`))}
            >
              {tile.code}
            </button>
          )
        })}
      </div>
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
        {view === 'map' ? <TileMap onOpen={onOpenTerritory} /> : <ListView onOpen={onOpenTerritory} />}
      </div>
      <p className="small-note">Select a state or local area to open its details on the Territories page.</p>
    </>
  )
}
