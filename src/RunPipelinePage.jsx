import { useEffect, useRef, useState } from 'react'
import { useModel } from './model/ModelContext.jsx'
import { checkSetup, cleanStates, findRun, looksLikeKey, newRequestId, plainStatus, recentRuns, runSteps, sealKeys, startRun } from './model/pipelineRun.js'
import { PRESENTED } from './model/territories.js'
import { STATE_NAMES } from './stateNames.js'

const ALL_CODES = Object.keys(STATE_NAMES).filter((c) => c !== 'DC').sort((a, b) => STATE_NAMES[a].localeCompare(STATE_NAMES[b]))
const ACTIVE_KEY = 'dl3-active-run' // only the request id and choices, never the API keys
const SETUP_TEXT = {
  'not-on-this-site': 'Running from the website only works on the team’s own sites (the dev site and the public site), not on test links or a laptop.',
  'no-public-key': 'The pipeline’s public key (public/pipeline-key.json) is missing, so API keys cannot be sent safely yet.',
  offline: 'Could not reach the site’s pipeline connection. Check your internet connection.',
}
const setupText = (p) => SETUP_TEXT[p] ?? (p?.startsWith('github-') ? `GitHub refused the connection (${p.slice(7)}). The site’s GitHub token may be missing or expired.` : null)

function readActive() {
  try {
    return JSON.parse(sessionStorage.getItem(ACTIVE_KEY) ?? 'null')
  } catch {
    return null
  }
}
function writeActive(v) {
  try {
    if (v) sessionStorage.setItem(ACTIVE_KEY, JSON.stringify(v))
    else sessionStorage.removeItem(ACTIVE_KEY)
  } catch {
    // storage blocked: progress just won't survive a reload
  }
}

function Progress({ active, onDone }) {
  const { refreshResults } = useModel()
  const [run, setRun] = useState(null)
  const [steps, setSteps] = useState([])
  const [note, setNote] = useState('')
  const doneRef = useRef(false)

  useEffect(() => {
    let alive = true
    let timer
    const tick = async () => {
      let wait = 8000
      try {
        const r = await findRun(active.requestId)
        if (!alive) return
        setRun(r)
        if (r) wait = 20000
        if (r) setSteps(await runSteps(r.id))
        if (r?.status === 'completed' && !doneRef.current) {
          doneRef.current = true
          if (r.conclusion === 'success') {
            setNote('Loading the new results…')
            let got = false
            for (let i = 0; i < 6 && !got && alive; i++) {
              got = await refreshResults()
              if (!got) await new Promise((res) => setTimeout(res, 10000))
            }
            setNote(got ? 'New results are on every page now.' : 'The run finished, but its results were not found yet. They also arrive with the data pull request once it is merged.')
          }
          onDone(r)
          return
        }
      } catch (e) {
        setNote(e.message)
      }
      timer = setTimeout(tick, wait)
    }
    tick()
    return () => { alive = false; clearTimeout(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active.requestId])

  const shownSteps = steps.filter((s) => !/^(Set up job|Post |Complete job|Run actions\/)/.test(s.name))
  return (
    <section className="card" data-reveal aria-live="polite">
      <h2>{plainStatus(run)}</h2>
      <p className="small-note">
        {active.states.join(', ')}{active.extract ? ' · with Gemini extraction' : ''}{active.recrawl ? ' · re-crawl' : ''} · started {new Date(active.at).toLocaleTimeString()}
        {run?.url && <> · <a href={run.url} target="_blank" rel="noopener noreferrer">full log on GitHub</a></>}
      </p>
      {shownSteps.length > 0 && (
        <ol className="step-list">
          {shownSteps.map((s, i) => (
            <li key={`${s.job}${s.name}${i}`} className={`step is-${s.conclusion ?? s.status}`}>
              <span className="step-dot" aria-hidden="true" />
              {s.name}
              <span className="small-note"> {s.conclusion === 'success' ? 'done' : s.conclusion === 'skipped' ? 'skipped' : s.conclusion ?? (s.status === 'in_progress' ? 'running…' : 'waiting')}</span>
            </li>
          ))}
        </ol>
      )}
      {note && <p className="small-note" role="status">{note}</p>}
      <p className="small-note">
        A run takes from about 10 minutes (a refresh) to over an hour (a new state with Gemini). You can leave this page; the results
        appear on every page when it finishes. New rules wait for a reviewer before they count.
      </p>
    </section>
  )
}

export default function RunPipelinePage() {
  const { manifest, liveResults } = useModel()
  const [setup, setSetup] = useState(null)
  const [states, setStates] = useState(PRESENTED)
  const [extract, setExtract] = useState(false)
  const [recrawl, setRecrawl] = useState(false)
  const [gemini, setGemini] = useState('')
  const [census, setCensus] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [active, setActive] = useState(() => readActive())
  const [history, setHistory] = useState([])

  useEffect(() => {
    checkSetup().then(setSetup)
    recentRuns().then(setHistory)
  }, [])

  const toggle = (c) => setStates((s) => (s.includes(c) ? s.filter((x) => x !== c) : [...s, c]))
  const ready = setup && !setup.problem
  const keyProblem = !looksLikeKey(gemini) ? 'The Gemini key has characters an API key does not use.' : !looksLikeKey(census) ? 'The Census key has characters an API key does not use.' : extract && !gemini.trim() ? 'Gemini extraction needs a Gemini API key.' : ''

  const start = async (e) => {
    e.preventDefault()
    setError('')
    if (keyProblem) return setError(keyProblem)
    if (states.length === 0) return setError('Pick at least one state.')
    setBusy(true)
    try {
      const sealed = await sealKeys({ GEMINI_API_KEY: gemini, CENSUS_API_KEY: census }, setup.publicKey)
      const requestId = newRequestId()
      await startRun({ states, extract, recrawl, requestId, sealed })
      const a = { requestId, states: cleanStates(states), extract, recrawl, at: new Date().toISOString() }
      writeActive(a)
      setActive(a)
      setGemini('')
      setCensus('')
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <section className="card notice" data-reveal>
        <h2>Data on the site</h2>
        <p className="small-note">
          {manifest?.generated_at ? `Pipeline results from ${new Date(manifest.generated_at).toLocaleString()}` : 'No pipeline results yet'}
          {liveResults ? ' (published after this site was built).' : '.'} {manifest?.counts ? `${manifest.counts.sources} documents, ${manifest.rules_approved ?? 0} approved rules, ${manifest.counts.awards} award rows.` : ''}
        </p>
      </section>

      {active && <Progress active={active} onDone={() => { writeActive(null); recentRuns().then(setHistory) }} />}

      <form className="card" data-reveal onSubmit={start}>
        <h2>Run the pipeline</h2>
        {setup === null && <p className="small-note">Checking the connection to the pipeline…</p>}
        {setup?.problem && <p className="small-note warn" role="alert">{setupText(setup.problem)}</p>}

        <h3>States</h3>
        <p className="small-note">Any state works. A state the pipeline has not seen yet is crawled first to find its documents.</p>
        <div className="state-chips" role="group" aria-label="States">
          {ALL_CODES.map((c) => (
            <button type="button" key={c} className="state-chip" aria-pressed={states.includes(c)} onClick={() => toggle(c)} title={STATE_NAMES[c]}>{c}</button>
          ))}
        </div>
        <p className="small-note">
          {states.length === 0 ? 'No states selected.' : `Selected: ${ALL_CODES.filter((c) => states.includes(c)).map((c) => STATE_NAMES[c]).join(', ')}`}
          {' '}<button type="button" className="text-button" onClick={() => setStates(PRESENTED)}>MI · OH · IN</button>
          {' '}<button type="button" className="text-button" onClick={() => setStates([])}>Clear</button>
        </p>

        <h3>What to do</h3>
        <label className="check"><input type="checkbox" checked={extract} onChange={(e) => setExtract(e.target.checked)} /> Read new or changed rulebooks with Gemini (uses your Gemini credit; findings wait for a reviewer)</label>
        <label className="check"><input type="checkbox" checked={recrawl} onChange={(e) => setRecrawl(e.target.checked)} /> Search the agency websites again for new documents</label>

        <h3>Your API keys</h3>
        <p className="small-note">
          Locked in this browser before they are sent, so only the pipeline can read them. They are used for this run only and are
          not saved by the site.
        </p>
        <div className="input-grid">
          <label className="field">
            <span>Gemini API key {extract ? '(needed)' : '(only for Gemini extraction)'}</span>
            <input type="password" autoComplete="off" spellCheck="false" value={gemini} onChange={(e) => setGemini(e.target.value)} />
          </label>
          <label className="field">
            <span>Census API key (blank: use the team’s key)</span>
            <input type="password" autoComplete="off" spellCheck="false" value={census} onChange={(e) => setCensus(e.target.value)} />
          </label>
        </div>
        {error && <p className="small-note warn" role="alert">{error}</p>}
        <div className="download-grid">
          <button type="submit" className="download-button primary" disabled={!ready || busy || Boolean(active)}>
            {busy ? 'Starting…' : active ? 'A run is in progress' : 'Start the run'}
          </button>
        </div>
      </form>

      {history.length > 0 && (
        <section className="card" data-reveal>
          <h2>Recent runs</h2>
          <ul className="source-links">
            {history.slice(0, 6).map((r) => (
              <li key={r.id}>
                {plainStatus(r)} · {r.title.replace(/\s*web-[0-9a-f]+$/, '')} · {r.started ? new Date(r.started).toLocaleString() : ''}
                {r.url && <> · <a href={r.url} target="_blank" rel="noopener noreferrer">log</a></>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  )
}
