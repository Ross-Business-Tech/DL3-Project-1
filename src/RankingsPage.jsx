import { useEffect, useRef, useState } from 'react'
import { TERRITORIES } from './data.js'
import { MAP } from './mapPaths.js'
import Downloads from './Downloads.jsx'

// Unscored areas go last.
const byScore = (a, b) => (b.score ?? -1) - (a.score ?? -1)

// The map's drawing area from the traced image: [x, y, width, height].
const [VX, VY, VW, VH] = MAP.viewBox.split(' ').map(Number)
const MIN_ZOOM = 1
const MAX_ZOOM = 6
// Small states grow more on hover so they are easy to pick with a mouse. Every state grows a little.
const SMALL = new Set(['CT', 'DC', 'DE', 'MA', 'MD', 'NH', 'NJ', 'RI', 'VT'])
const grow = (code) => (SMALL.has(code) ? 2.4 : 1.06)

// Full names for the map's states, shown when you hover over one.
const STATE_NAMES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
  CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky',
  LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire',
  NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota',
  OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina',
  SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia',
  WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
}

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

  // Mobile only: two fingers pinch to zoom. Touch events only, so desktop mouse and trackpad are unchanged.
  const pinchActive = useRef(false)
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const touches = new Map()
    let pinchDist = null

    const down = (e) => {
      if (e.pointerType !== 'touch') return
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (touches.size === 2) {
        const [a, b] = [...touches.values()]
        pinchDist = Math.hypot(a.x - b.x, a.y - b.y)
        pinchActive.current = true
        dragRef.current = { moved: true }
      }
    }
    const move = (e) => {
      if (e.pointerType !== 'touch') return
      const p = touches.get(e.pointerId)
      if (!p) return
      p.x = e.clientX
      p.y = e.clientY
      if (touches.size !== 2 || !pinchDist) return
      const [a, b] = [...touches.values()]
      const dist = Math.hypot(a.x - b.x, a.y - b.y)
      const rect = el.querySelector('svg').getBoundingClientRect()
      const fx = clamp01(((a.x + b.x) / 2 - rect.left) / rect.width)
      const fy = clamp01(((a.y + b.y) / 2 - rect.top) / rect.height)
      const factor = dist / pinchDist
      pinchDist = dist
      setView((v) => zoomAt(v, fx, fy, factor))
    }
    const up = (e) => {
      if (e.pointerType !== 'touch') return
      touches.delete(e.pointerId)
      if (touches.size < 2) {
        pinchDist = null
        pinchActive.current = false
      }
    }

    el.addEventListener('pointerdown', down)
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
    return () => {
      el.removeEventListener('pointerdown', down)
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
    }
  }, [])

  // Click and drag to move the map, only when it is zoomed in.
  const startDrag = (e) => {
    // Ignore the second finger of a pinch; the pinch handler above deals with it.
    if (viewRef.current.z <= 1 || e.button !== 0 || e.isPrimary === false) return
    const svg = e.currentTarget
    const pointerId = e.pointerId
    const start = { x: e.clientX, y: e.clientY, view: viewRef.current, moved: false }
    dragRef.current = { moved: false }

    const onMove = (ev) => {
      if (ev.pointerId !== pointerId) return
      // While pinching, the pinch sets the zoom: keep this drag's start point at the current view,
      // so the map continues smoothly from there when the pinch ends.
      if (pinchActive.current) {
        start.x = ev.clientX
        start.y = ev.clientY
        start.view = viewRef.current
        return
      }
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
      <div className="map-wrap" ref={wrapRef} style={{ touchAction: 'none' }}>
        {hover && (
          <div className="map-label" aria-hidden="true">
            <strong>{STATE_NAMES[hover] ?? hover}</strong>
            <span>
              {researched.get(hover) ? researched.get(hover).scoreText : 'Not researched yet'}
            </span>
          </div>
        )}
        <svg
          className={`us-map${zoomed ? ' is-zoomed' : ''}`}
          viewBox={viewBox}
          role="group"
          aria-label="US map. Select a state."
          onPointerDown={startDrag}
        >
          {entries.map(([code, d]) => {
            const t = researched.get(code)
            const name = t ? `${t.name}, ${t.scoreText}` : `${code}, not researched yet`
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
        {['All', 'State'].map((k) => (
          <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)}>
            {k === 'All' ? 'All locations' : 'States'}
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
            <span className="score-pill">{t.scoreText}</span>
          </button>
        ))}
      </div>
    </>
  )
}

export default function RankingsPage({ onOpenTerritory }) {
  const [view, setView] = useState('list')

  return (
    <>
      <Downloads />
      <div className="segmented view-toggle" role="group" aria-label="Choose a view">
        <button type="button" aria-pressed={view === 'list'} onClick={() => setView('list')}>List</button>
        <button type="button" aria-pressed={view === 'map'} onClick={() => setView('map')}>Map</button>
      </div>
      <div className="card" data-reveal="scale">
        {view === 'map' ? <MapView onOpen={onOpenTerritory} /> : <ListView onOpen={onOpenTerritory} />}
      </div>
      <p className="small-note">Select a state or local area to open its details on the Territories page.</p>
    </>
  )
}
