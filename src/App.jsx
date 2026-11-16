import { useEffect, useState } from 'react'
import { TERRITORIES } from './data.js'
import RankingsPage from './RankingsPage.jsx'
import TerritoriesPage from './TerritoriesPage.jsx'
import TerritoryPage from './TerritoryPage.jsx'
import SourcesPage from './SourcesPage.jsx'
import './App.css'

// The menu from the Final Build mock-up.
const MENU = [
  {
    group: 'Workspace',
    items: [
      { id: 'overview', label: 'Overview' },
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

// Screens that are built. Everything else shows "Coming soon".
const BUILT = new Set(['overview', 'rankings', 'territories', 'sources'])
const SAMPLE_NOTE = new Set(['overview', 'rankings', 'territories', 'territory'])

const SAMPLE_STATS = [
  { value: '60', label: 'States & territories' },
  { value: '12', label: 'Priority opportunities' },
  { value: '8', label: 'Need review' },
  { value: '94%', label: 'Research completeness' },
]

function Overview({ onOpenTerritory }) {
  const top = [...TERRITORIES].sort((a, b) => b.score - a.score).slice(0, 3)
  return (
    <>
      <section className="stats" aria-label="Key numbers">
        {SAMPLE_STATS.map((stat, i) => (
          <div className="card" key={stat.label} data-reveal style={{ '--d': `${i * 90}ms` }}>
            <div className="stat-value">{stat.value}</div>
            <div className="stat-label">{stat.label}</div>
          </div>
        ))}
      </section>

      <div className="overview-grid">
        <section className="card" aria-labelledby="top-heading" data-reveal>
          <h2 id="top-heading">Current rankings</h2>
          {top.map((t, i) => (
            <button type="button" className="list-row" key={t.id} onClick={() => onOpenTerritory(t.id)}>
              <span className="rank-num">#{i + 1}</span>
              <span className="rank-name">
                <strong>{t.name}</strong>
                <span>{t.kind} · {t.status}</span>
              </span>
              <span className="score-pill">{t.score} / 100</span>
            </button>
          ))}
        </section>

        <section className="card assistant" aria-labelledby="assistant-heading" data-reveal="up" style={{ '--d': '120ms' }}>
          <h2 id="assistant-heading">AI ranking assistant</h2>
          <p>Review research, resolve missing information, and regenerate rankings.</p>
          <p className="small-note">Coming in a later step.</p>
        </section>
      </div>
    </>
  )
}

function ComingSoon({ title }) {
  return (
    <section className="card coming-soon" data-reveal>
      <h2>{title}</h2>
      <p>Coming soon.</p>
    </section>
  )
}

function App() {
  const [screen, setScreen] = useState('overview')
  const [selectedId, setSelectedId] = useState(null)
  const current = MENU.flatMap((g) => g.items).find((item) => item.id === screen)
  // A territory's own page takes its name as the title and is still under the Territories menu item.
  const selected = TERRITORIES.find((t) => t.id === selectedId)
  const title = screen === 'territory' ? selected?.name ?? 'Territory' : current?.label ?? ''

  // A new page starts at the top, so its title is not hidden under the header.
  useEffect(() => {
    window.scrollTo({ top: 0 })
  }, [screen, selectedId])

  // Scroll reveal: anything marked data-reveal slides or fades in the first time it reaches the screen.
  useEffect(() => {
    const targets = document.querySelectorAll('[data-reveal]:not(.is-visible)')
    if (!('IntersectionObserver' in window)) {
      targets.forEach((el) => el.classList.add('is-visible'))
      return
    }
    const io = new IntersectionObserver(
      (entries) =>
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add('is-visible')
            io.unobserve(e.target)
          }
        }),
      { threshold: 0.12 },
    )
    targets.forEach((el) => io.observe(el))
    return () => io.disconnect()
  }, [screen, selectedId])

  // Opening a territory from any page shows that territory's own page.
  const openTerritory = (id) => {
    setSelectedId(id)
    setScreen('territory')
  }

  let page
  if (screen === 'overview') page = <Overview onOpenTerritory={openTerritory} />
  else if (screen === 'rankings') page = <RankingsPage onOpenTerritory={openTerritory} />
  else if (screen === 'territories') page = <TerritoriesPage onOpen={openTerritory} />
  else if (screen === 'territory') page = <TerritoryPage id={selectedId} onBack={() => setScreen('territories')} onSources={() => setScreen('sources')} />
  else if (screen === 'sources') page = <SourcesPage />
  else page = <ComingSoon title={current.label} />

  return (
    <div className="app">
      <header className="site-header">
        <div className="brand">
          <span className="brand-name">DL3</span>
          <span className="brand-sub">Investment Intelligence</span>
        </div>
        <nav className="nav" aria-label="Main menu">
          {MENU.map((group, gi) => (
            <Group key={group.group} group={group} first={gi === 0} screen={screen} onPick={setScreen} />
          ))}
        </nav>
      </header>

      <section className="page-band">
        <div className="page-band-inner">
          <div className="band-rule" aria-hidden="true" />
          <h1>{title}</h1>
          {screen === 'overview' && <p>Last ranking update: November 2026</p>}
          {SAMPLE_NOTE.has(screen) && <span className="sample-note">Sample numbers for design only</span>}
        </div>
      </section>

      <main className="main">{page}</main>
    </div>
  )
}

function Group({ group, first, screen, onPick }) {
  return (
    <>
      {!first && <span className="nav-divider" aria-hidden="true" />}
      {group.items.map((item) => (
        <button
          type="button"
          key={item.id}
          className={`nav-item${BUILT.has(item.id) ? '' : ' is-soon'}`}
          aria-current={screen === item.id ? 'page' : undefined}
          title={BUILT.has(item.id) ? undefined : 'Coming soon'}
          onClick={() => onPick(item.id)}
        >
          {item.label}
        </button>
      ))}
    </>
  )
}

export default App
