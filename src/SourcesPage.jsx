import { SOURCES } from './data.js'

export default function SourcesPage() {
  return (
    <>
      <section className="card" data-reveal="scale">
        <h2>Source register</h2>
        <p className="small-note">
          The public pages the team starts from. Each one is re-checked before its rules are used,
          and the date it was last retrieved is added by the research pipeline.
        </p>
        <div className="source-list">
          {SOURCES.map((s, i) => (
            <div className="source-row" key={s.id} data-reveal style={{ '--d': `${Math.min(i, 5) * 70}ms` }}>
              <span className="source-id">{s.id}</span>
              <div className="source-text">
                <strong>{s.title}</strong>
                <span>{s.use}</span>
              </div>
              <a href={s.url} target="_blank" rel="noopener noreferrer" className="text-button">Open page</a>
            </div>
          ))}
        </div>
      </section>
    </>
  )
}
