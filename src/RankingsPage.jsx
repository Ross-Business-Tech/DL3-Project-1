import { useEffect, useRef, useState } from 'react'
import { TERRITORIES } from './data.js'
import { MAP } from './mapPaths.js'

const byScore = (a, b) => b.score - a.score

// The map's drawing area from the traced image: [x, y, width, height].
const [VX, VY, VW, VH] = MAP.viewBox.split(' ').map(Number)
const MIN_ZOOM = 1
const MAX_ZOOM = 6
// Small states grow more on hover so they are easy to pick with a mouse. Every state grows a little.
const SMALL = new Set(['CT', 'DC', 'DE', 'MA', 'MD', 'NH', 'NJ', 'RI', 'VT'])
const grow = (code) => (SMALL.has(code) ? 2.4 : 1.06)

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
// Zoom: pinch on a trackpad (or Ctrl + scroll), or use the + and − buttons.
// When zoomed in: drag with the mouse or a finger to move around, or use two-finger scroll.
function MapView({ onOpen }) {
  const [message, setMessage] = useState('')
  const [hover, setHover] = useState(null)
  const [view, setView] = useState({ z: MIN_ZOOM, x: VX, y: VY })
  const wrapRef = useRef(null)
  const viewRef = useRef(view)
  viewRef.current = view
  const dragRef = useRef({ moved: false })

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
      } else if (viewRef.current.z > 1) {
        e.preventDefault()
        setView((v) => clampView(v.z, v.x + (e.deltaX * VW) / v.z / rect.width, v.y + (e.deltaY * VH) / v.z / rect.height))
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // Click and drag to move the map, only when it is zoomed in.
  const startDrag = (e) => {
    if (viewRef.current.z <= 1 || e.button !== 0) return
    const svg = e.currentTarget
    const start = { x: e.clientX, y: e.clientY, view: viewRef.current, moved: false }
    dragRef.current = { moved: false }

    const onMove = (ev) => {
      const dx = ev.clientX - start.x
      const dy = ev.clientY - start.y
      if (!start.moved && Math.hypot(dx, dy) > 4) start.moved = true
      if (!start.moved) return
      const rect = svg.getBoundingClientRect()
      const w = VW / start.view.z
      const h = VH / start.view.z
      setView(clampView(start.view.z, start.view.x - (dx * w) / rect.width, start.view.y - (dy * h) / rect.height))
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      // A drag should not also count as a click on a state.
      dragRef.current = { moved: start.moved }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const choose = (code) => {
    if (dragRef.current.moved) return
    const t = researched.get(code)
    if (t) {
      setMessage('')
      onOpen(t.id)
    } else {
      setMessage(`${code} has not been researched yet, so there are no details to show.`)
    }
  }

  const entries = Object.entries(MAP.states)
  const zoomed = view.z > 1
  const w = VW / view.z
  const h = VH / view.z
  const viewBox = `${view.x} ${view.y} ${w} ${h}`

  return (
    <>
      <div className="map-wrap" ref={wrapRef} style={{ touchAction: zoomed ? 'none' : 'pan-y' }}>
        <svg
          className={`us-map${zoomed ? ' is-zoomed' : ''}`}
          viewBox={viewBox}
          role="group"
          aria-label="US map. Select a state."
          onPointerDown={startDrag}
        >
          {entries.map(([code, d]) => {
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
                onMouseEnter={() => setHover(code)}
                onMouseLeave={() => setHover(null)}
                onFocus={() => setHover(code)}
                onBlur={() => setHover(null)}
              >
                <title>{name}</title>
              </path>
            )
          })}
          {/* A grown copy of the hovered state, drawn on top. It ignores the mouse, so clicks still reach the real state. */}
          {hover && (
            <path
              key={`copy-${hover}`}
              className="state-copy"
              d={MAP.states[hover]}
              style={{ '--grow': grow(hover) }}
              aria-hidden="true"
            />
          )}
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
        <button type="button" aria-pressed={view === 'map'} onClick={() => setView('map')}>Map</button>
        <button type="button" aria-pressed={view === 'list'} onClick={() => setView('list')}>List</button>
      </div>
      <div className="card" data-reveal="scale">
        {view === 'map' ? <MapView onOpen={onOpenTerritory} /> : <ListView onOpen={onOpenTerritory} />}
      </div>
      <p className="small-note">Select a state or local area to open its details on the Territories page.</p>
    </>
  )
}
