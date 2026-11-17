import { useState } from 'react'
import { useModel } from './model/ModelContext.jsx'
import { STATE_NAMES } from './stateNames.js'

const TYPE_LABEL = {
  qap_doc: 'Allocation plan (QAP)', qap_page: 'QAP page', award_list: 'Award list', underwriting: 'Underwriting manual',
  program_page: 'Program page', bond_page: 'Bond / 4% page', application: 'Application', statute: 'Law', incentive: 'Local incentive',
  reference_data: 'Census reference data', allocator_list: 'HUD allocator list', program_data: 'HUD program data', news_page: 'News',
}
const where = (code) => (code === 'US' ? 'National' : STATE_NAMES[code] ?? code)

export default function SourcesPage() {
  const { sources, manifest } = useModel()
  const states = [...new Set(sources.map((s) => s.state))]
  const [state, setState] = useState(states.includes('MI') ? 'MI' : states[0] ?? '')
  const shown = sources.filter((s) => s.state === state)
  const stale = sources.filter((s) => s.stale).length

  return (
    <section className="card" data-reveal="scale">
      <h2>Documents the pipeline keeps</h2>
      <p className="small-note">
        {sources.length} public documents and pages, each archived with the date it was retrieved
        {manifest?.generated_at ? ` (export of ${manifest.generated_at.slice(0, 10)})` : ''}.
        {stale ? ` ${stale} are older than 90 days and should be re-checked.` : ' All were checked within 90 days.'}
        {' '}Only rules a named reviewer approved are used; "unknown" status means nobody has confirmed the document is final.
      </p>
      <div className="segmented" role="group" aria-label="Choose a state">
        {states.map((c) => (
          <button key={c} type="button" aria-pressed={state === c} onClick={() => setState(c)}>{where(c)}</button>
        ))}
      </div>
      <div className="source-list">
        {shown.map((s) => (
          <div className="source-row" key={s.id}>
            <span className="source-id">{s.state}</span>
            <div className="source-text">
              <strong>{s.title}</strong>
              <span>
                {TYPE_LABEL[s.type] ?? s.type} · {s.status === 'final' ? 'final' : s.status === 'draft' ? 'draft' : 'status not confirmed'}
                {' · '}retrieved {s.lastRetrieved ?? 'never'}{s.stale ? ' · older than 90 days' : ''}{s.critical ? ' · critical' : ''}
              </span>
            </div>
            {s.url && <a href={s.url} target="_blank" rel="noopener noreferrer" className="text-button">Open</a>}
          </div>
        ))}
      </div>
    </section>
  )
}
