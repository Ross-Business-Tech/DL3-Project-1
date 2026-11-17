import { useEffect, useState } from 'react'
import { ModelProvider, useModel } from './model/ModelContext.jsx'
import RankingsPage from './RankingsPage.jsx'
import TerritoriesPage from './TerritoriesPage.jsx'
import TerritoryPage from './TerritoryPage.jsx'
import SourcesPage from './SourcesPage.jsx'
import ReviewQueuePage from './ReviewQueuePage.jsx'
import RunPipelinePage from './RunPipelinePage.jsx'
import DL3InputsPage from './DL3InputsPage.jsx'
import RankingPage from './ranking/RankingPage.jsx'
import './App.css'

const MENU = [
  {
    group: 'Workspace',
    items: [
      { id: 'overview', label: 'Overview' },
      { id: 'rankings', label: 'Rankings' },
      { id: 'territories', label: 'Territories' },
      { id: 'model', label: 'Detailed model' },
    ],
  },
  {
    group: 'Research',
    items: [
      { id: 'sources', label: 'Sources & Evidence' },
      { id: 'queue', label: 'Review Queue' },
      { id: 'run', label: 'Run pipeline' },
      { id: 'inputs', label: 'DL3 inputs' },
    ],
  },
]
const SCORE_PAGES = new Set(['overview', 'rankings', 'territories', 'territory'])

function Overview({ onOpenTerritory, go }) {
  const { territories, stats, manifest, inputStatus } = useModel()
  const presented = territories.filter((t) => t.presented)
  const top = territories.filter((t) => t.estimate !== null).slice(0, 5)
  const cards = [
    { value: String(stats.areas), label: 'States covered' },
    { value: String(stats.scored), label: 'States with a score or estimate' },
    { value: String(stats.passing), label: 'Pass every check' },
    { value: `${stats.researched}%`, label: 'Researched in depth' },
  ]
  return (
    <>
      <section className="stats" aria-label="Key numbers">
        {cards.map((stat, i) => (
          <div className="card" key={stat.label} data-reveal style={{ '--d': `${i * 90}ms` }}>
            <div className="stat-value">{stat.value}</div>
            <div className="stat-label">{stat.label}</div>
          </div>
        ))}
      </section>

      <section className="card" aria-labelledby="pilot-heading" data-reveal>
        <h2 id="pilot-heading">Michigan, Ohio and Indiana</h2>
        {presented.map((t) => (
          <button type="button" className="list-row" key={t.id} onClick={() => onOpenTerritory(t.id)}>
            <span className="rank-num">{t.id}</span>
            <span className="rank-name">
              <strong>{t.name}</strong>
              <span>{t.status} · {t.pipeline?.rules.length ?? 0} approved rules · {t.feeRule}</span>
            </span>
            <span className={`score-pill${t.isEstimate ? ' is-estimate' : ''}`}>{t.scoreText}</span>
          </button>
        ))}
      </section>

      <div className="overview-grid">
        <section className="card" aria-labelledby="top-heading" data-reveal>
          <h2 id="top-heading">Highest across all states</h2>
          {top.length === 0 && <p className="small-note">No state has a score yet.</p>}
          {top.map((t, i) => (
            <button type="button" className="list-row" key={t.id} onClick={() => onOpenTerritory(t.id)}>
              <span className="rank-num">#{i + 1}</span>
              <span className="rank-name">
                <strong>{t.name}</strong>
                <span>{t.status} · {t.depth}</span>
              </span>
              <span className={`score-pill${t.isEstimate ? ' is-estimate' : ''}`}>{t.scoreText}</span>
            </button>
          ))}
        </section>

        <section className="card assistant" aria-labelledby="data-heading" data-reveal="up" style={{ '--d': '120ms' }}>
          <h2 id="data-heading">Data and inputs</h2>
          <p>
            Pipeline data from {manifest?.generated_at ? new Date(manifest.generated_at).toLocaleDateString() : 'no run yet'}
            {manifest?.counts ? `: ${manifest.counts.sources} documents, ${manifest.rules_approved ?? 0} approved rules, ${manifest.counts.awards} award rows.` : '.'}
          </p>
          <p>{inputStatus.usingPlaceholders ? 'Scores use placeholder DL3 terms until DL3 enters its own.' : 'Scores use DL3’s own terms from this browser.'}</p>
          <div className="download-grid">
            <button type="button" className="download-button" onClick={() => go('run')}>Run the pipeline</button>
            <button type="button" className="download-button" onClick={() => go('inputs')}>Enter DL3 inputs</button>
          </div>
        </section>
      </div>
    </>
  )
}

function Shell() {
  const { manifest, modelVersion, inputStatus, viewer } = useModel()
  const [screen, setScreen] = useState('overview')
  const [selectedId, setSelectedId] = useState(null)
  const { territories } = useModel()
  const current = MENU.flatMap((g) => g.items).find((item) => item.id === screen)
  const selected = territories.find((t) => t.id === selectedId)
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
  })

  const openTerritory = (id) => {
    setSelectedId(id)
    setScreen('territory')
  }

  let page
  if (screen === 'overview') page = <Overview onOpenTerritory={openTerritory} go={setScreen} />
  else if (screen === 'rankings') page = <RankingsPage onOpenTerritory={openTerritory} />
  else if (screen === 'territories') page = <TerritoriesPage onOpen={openTerritory} />
  else if (screen === 'territory') page = <TerritoryPage id={selectedId} onBack={() => setScreen('territories')} onSources={() => setScreen('sources')} />
  else if (screen === 'model') page = <div className="legacy-model"><RankingPage /></div>
  else if (screen === 'sources') page = <SourcesPage />
  else if (screen === 'queue') page = <ReviewQueuePage onOpenTerritory={openTerritory} />
  else if (screen === 'run') page = <RunPipelinePage />
  else page = <DL3InputsPage />

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
          {screen === 'overview' && (
            <p>
              Pipeline data: {manifest?.generated_at ? new Date(manifest.generated_at).toLocaleDateString() : 'none yet'} · Model {modelVersion}
              {viewer ? ` · Signed in as ${viewer}` : ''}
            </p>
          )}
          {SCORE_PAGES.has(screen) && inputStatus.usingPlaceholders && (
            <button type="button" className="sample-note" onClick={() => setScreen('inputs')}>
              Scores use placeholder DL3 terms · enter DL3 inputs
            </button>
          )}
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
          className="nav-item"
          aria-current={screen === item.id || (item.id === 'territories' && screen === 'territory') ? 'page' : undefined}
          onClick={() => onPick(item.id)}
        >
          {item.label}
        </button>
      ))}
    </>
  )
}

export default function App() {
  return (
    <ModelProvider>
      <Shell />
    </ModelProvider>
  )
}
