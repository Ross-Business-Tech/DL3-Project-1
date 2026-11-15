import { Fragment, useState } from 'react'
import './App.css'

// The menu from the Final Build mock-up. Only Overview is built so far.
const MENU = [
  {
    group: 'Workspace',
    items: [
      { id: 'overview', label: 'Overview', ready: true },
      { id: 'rankings', label: 'Rankings' },
      { id: 'territories', label: 'Territories' },
      { id: 'ai-review', label: 'AI Review' },
      { id: 'history', label: 'Ranking History' },
    ],
  },
  {
    group: 'Research',
    items: [
      { id: 'sources', label: 'Sources & Evidence' },
      { id: 'queue', label: 'Review Queue' },
      { id: 'settings', label: 'Settings' },
    ],
  },
]

// Made-up numbers for the design only. These are not real rankings.
const SAMPLE_STATS = [
  { value: '60', label: 'States & territories' },
  { value: '12', label: 'Priority opportunities' },
  { value: '8', label: 'Need review' },
  { value: '94%', label: 'Research completeness' },
]

const SAMPLE_TOP = [
  { name: 'Territory A', note: 'Example location', score: 92 },
  { name: 'Territory B', note: 'Example location', score: 89 },
  { name: 'Territory C', note: 'Example location', score: 86 },
]

function Overview() {
  return (
    <>
      <section className="stats" aria-label="Key numbers">
        {SAMPLE_STATS.map((stat) => (
          <div className="card" key={stat.label}>
            <div className="stat-value">{stat.value}</div>
            <div className="stat-label">{stat.label}</div>
          </div>
        ))}
      </section>

      <div className="overview-grid">
        <section className="card" aria-labelledby="top-heading">
          <h2 id="top-heading">Current rankings</h2>
          {SAMPLE_TOP.map((place, i) => (
            <div className="rank-row" key={place.name}>
              <div className="rank-num">#{i + 1}</div>
              <div className="rank-name">
                <strong>{place.name}</strong>
                <span>{place.note}</span>
              </div>
              <div className="score-pill">{place.score} / 100</div>
            </div>
          ))}
        </section>

        <section className="card assistant" aria-labelledby="assistant-heading">
          <h2 id="assistant-heading">AI ranking assistant</h2>
          <p>Review research, resolve missing information, and regenerate rankings.</p>
          <p className="small">Coming in a later step.</p>
        </section>
      </div>
    </>
  )
}

function ComingSoon({ title }) {
  return (
    <p className="placeholder">{title} is coming in a later step.</p>
  )
}

function App() {
  const [screen, setScreen] = useState('overview')
  const current = MENU.flatMap((g) => g.items).find((item) => item.id === screen)

  return (
    <div className="app">
      <header className="site-header">
        <div className="brand">
          <span className="brand-name">DL3</span>
          <span className="brand-sub">Investment Intelligence</span>
        </div>
        <nav className="nav" aria-label="Main menu">
          {MENU.map((group, gi) => (
            <Fragment key={group.group}>
              {gi > 0 && <span className="nav-divider" aria-hidden="true" />}
              {group.items.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  className="nav-item"
                  aria-current={screen === item.id ? 'page' : undefined}
                  onClick={() => setScreen(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </Fragment>
          ))}
        </nav>
      </header>

      <section className="page-band">
        <div className="page-band-inner">
          <div className="band-rule" aria-hidden="true" />
          <h1>{current.label}</h1>
          {screen === 'overview' && (
            <>
              <p>Last ranking update: November 2026</p>
              <span className="sample-note">Sample numbers for design only</span>
            </>
          )}
        </div>
      </section>

      <main className="main">
        {screen === 'overview' ? <Overview /> : <ComingSoon title={current.label} />}
      </main>
    </div>
  )
}

export default App
