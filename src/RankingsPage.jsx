import { useEffect, useRef, useState } from 'react'
import { TERRITORIES } from './data.js'
import { MAP } from './mapPaths.js'

const byScore = (a, b) => b.score - a.score

// The map's drawing area from the traced image: [x, y, width, height].
const [VX, VY, VW, VH] = MAP.viewBox.split(' ').map(Number)
const MIN_ZOOM = 1
const MAX_ZOOM = 6
// Small states that grow when you hover over them, so they are easy to select with a mouse.
const SMALL = new Set(['CT', 'DC', 'DE', 'MA', 'MD', 'NH', 'NJ', 'RI', 'VT'])

// Keep the visible part of the map inside the drawing area.
function clampView(z, x, y) {
  const w = VW / z
  const h = VH / z
  return { z, x: Math.min(Math.max(x, VX), VX + VW - w), y: Math.min(Math.max(y, VY), VY + VH - h) }
}

// Zoom by `factor`, keeping the point under the pointer (fx, fy: 0-1 across the map) in place.
function zoomAt(v, fx, fy, factor) {
  const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.z * factor))
  const px = v.x + fx * (VW / v.z)
  const py = v.y + fy * (VH / v.z)
  return clampView(z, px - fx * (VW / z), py - fy * (VH / z))
}

const clamp01 = (n) => Math.min(1, Math.max(0, n))

// Map view: the US map from the project's reference image. Researched states are teal and can be clicked.
// Zoom: pinch on a trackpad (or Ctrl + scroll), or use the + and − buttons. Two-finger drag pans when zoomed.
function MapView({ onOpen }) {
  const [message, setMessage] = useState('')
  const [hover, setHover] = useState(null)
  const [view, setView] = useState({ z: MIN_ZOOM, x: VX, y: VY })
  const wrapRef = useRef(null)
  const zoomRef = useRef(MIN_ZOOM)
  zoomRef.current = view.z

  const researched = new Map(TERRITORIES.filter((t) => t.kind === 'State').map((t) => [t.id, t]))

  // Trackpad pinch arrives as a wheel event with ctrlKey. Listen directly so the page itself does not zoom.
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const onWheel = (e) => {
      const rect = el.querySelector('svg').getBoundingClientRect()
      if (e.ctrlKey) {
        e.preventDefault()
        const fx = clamp01((e.clientX - rect.left) / rect.width)
        const fy = clamp01((e.clientY - rect.top) / rect.height)
        setView((v) => zoomAt(v, fx, fy, Math.exp(-e.deltaY * 0.01)))
      } else if (zoomRef.current > 1) {
        e.preventDefault()
        setView((v) => clampView(v.z, v.x + (e.deltaX * VW) / v.z / rect.width, v.y + (e.deltaY * VH) / v.z / rect.height))
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const choose = (code) => {
    const t = researched.get(code)
    if (t) {
      setMessage('')
      onOpen(t.id)
    } else {
      setMessage(`${code} has not been researched yet, so there are no details to show.`)
    }
  }

  // Draw the hovered state last so it sits on top of its neighbors when it grows.
  const entries = Object.entries(MAP.states)
  if (hover) {
    const i = entries.findIndex(([code]) => code === hover)
    if (i >= 0) entries.push(...entries.splice(i, 1))
  }

  const w = VW / view.z
  const h = VH / view.z
  const viewBox = `${view.x} ${view.y} ${w} ${h}`

  return (
    <>
      <div className="map-wrap" ref={wrapRef}>
        <svg className="us-map" viewBox={viewBox} role="group" aria-label="US map. Select a state.">
          {entries.map(([code, d]) => {
            const t = researched.get(code)
            const name = t ? `${t.name}, score ${t.score}` : `${code}, not researched yet`
            const classes = ['state', t && 'is-data', SMALL.has(code) && 'is-small'].filter(Boolean).join(' ')
            return (
              <path
                key={code}
                d={d}
                className={classes}
                role="button"
                tabIndex={0}
                aria-label={name}
                onClick={() => choose(code)}
                onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && choose(code)}
                onMouseEnter={() => setHover(code)}
                onMouseLeave={() => setHover(null)}
                onFocus={() => setHover(code)}
                onBlur={() => setHover(null)}
              >
                <title>{name}</title>
              </path>
            )
          })}
        </svg>
        <div className="zoom-controls" role="group" aria-label="Zoom">
          <button type="button" aria-label="Zoom in" onClick={() => setView((v) => zoomAt(v, 0.5, 0.5, 1.5))}>+</button>
          <button type="button" aria-label="Zoom out" onClick={() => setView((v) => zoomAt(v, 0.5, 0.5, 1 / 1.5))}>−</button>
          <button type="button" aria-label="Reset zoom" onClick={() => setView({ z: MIN_ZOOM, x: VX, y: VY })}>Reset</button>
        </div>
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
        {view === 'map' ? <MapView onOpen={onOpenTerritory} /> : <ListView onOpen={onOpenTerritory} />}
      </div>
      <p className="small-note">Select a state or local area to open its details on the Territories page.</p>
    </>
  )
}
