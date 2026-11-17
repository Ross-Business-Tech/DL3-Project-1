import { useState } from 'react'
import { useModel } from './model/ModelContext.jsx'
import { codeOf } from './model/territories.js'

const STATUS = { unresolved: 'Needs input', proposed: 'Proposed, needs approval', unknown: 'Not confirmed', 'low-confidence fail': 'Fails on weak evidence', bounded: 'Range only' }

// What still stands between each researched state and a firm score, and who can supply it.
export default function ReviewQueuePage({ onOpenTerritory }) {
  const { result } = useModel()
  const [onlyPresented, setOnlyPresented] = useState(true)
  const queue = result.reviewQueue.filter((q) => !onlyPresented || ['MI', 'OH', 'IN'].includes(codeOf(q.state)))
  const byOwner = new Map()
  for (const q of queue) byOwner.set(q.owner, [...(byOwner.get(q.owner) ?? []), q])

  return (
    <>
      <div className="segmented" role="group" aria-label="Which states">
        <button type="button" aria-pressed={onlyPresented} onClick={() => setOnlyPresented(true)}>MI · OH · IN</button>
        <button type="button" aria-pressed={!onlyPresented} onClick={() => setOnlyPresented(false)}>All researched states</button>
      </div>
      <p className="small-note page-note">
        {queue.length} open items. DL3 items are answered on the DL3 inputs page; rules from the pipeline are approved in the review
        spreadsheet (see the pipeline’s refresh instructions).
      </p>
      {[...byOwner.entries()].map(([owner, items]) => (
        <section className="card" key={owner} data-reveal>
          <h2>{owner}</h2>
          <ul className="queue-list">
            {items.map((q, i) => (
              <li key={`${q.id}${q.key}${i}`}>
                <button type="button" className="text-button" onClick={() => onOpenTerritory(codeOf(q.state))}>{q.state} {q.pathway}</button>
                {' · '}<strong>{q.item}</strong> · {STATUS[q.status] ?? q.status}
                {q.needs?.length > 0 && <span className="small-note block">{q.needs.join(' · ')}</span>}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  )
}
