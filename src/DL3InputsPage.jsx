import { useRef, useState } from 'react'
import { useModel } from './model/ModelContext.jsx'
import { ECONOMIC_FIELDS, sanitize } from './model/dl3Inputs.js'
import { PRESENTED as PRESENTED_DEFAULT } from './model/territories.js'
import { STATE_NAMES } from './stateNames.js'

const ALL_CODES = Object.keys(STATE_NAMES).filter((c) => c !== 'DC').sort((a, b) => STATE_NAMES[a].localeCompare(STATE_NAMES[b]))
const yesNo = (v) => (v === true ? 'yes' : v === false ? 'no' : '')
const fromYesNo = (v) => (v === 'yes' ? true : v === 'no' ? false : undefined)

// DL3's confidential numbers. Kept in this browser only; the ranking re-runs with them as soon as they are saved.
export default function DL3InputsPage() {
  const { inputs, inputStatus, setInputs, resetInputs, viewer } = useModel()
  const [draft, setDraft] = useState(() => structuredClone(inputs))
  const [extraState, setExtraState] = useState('')
  const [message, setMessage] = useState('')
  const fileRef = useRef(null)
  const codes = [...new Set([...PRESENTED_DEFAULT, ...Object.keys(draft.states)])]

  const setEcon = (key, value) => setDraft((d) => ({ ...d, economics: { ...d.economics, [key]: value === '' ? undefined : Number(value) } }))
  const setState = (code, key, value) =>
    setDraft((d) => {
      const s = { ...(d.states[code] ?? {}), [key]: value }
      if (value === undefined || value === '') delete s[key]
      return { ...d, states: { ...d.states, [code]: s } }
    })

  const save = () => {
    const clean = sanitize(draft)
    setInputs(clean)
    setDraft(structuredClone(clean))
    setMessage('Saved in this browser. Every score now uses these numbers.')
  }
  const reset = () => {
    if (!window.confirm('Remove all DL3 inputs from this browser? Scores go back to the placeholders.')) return
    setDraft(structuredClone(resetInputs()))
    setMessage('Cleared. Scores use the placeholders again.')
  }
  const exportFile = () => {
    const blob = new Blob([JSON.stringify(sanitize(draft), null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'dl3-inputs-CONFIDENTIAL.json'
    a.click()
    URL.revokeObjectURL(a.href)
  }
  const importFile = async (e) => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    try {
      setDraft(sanitize(JSON.parse(await f.text())))
      setMessage('Loaded from the file. Check the values, then press Save.')
    } catch {
      setMessage('That file is not a DL3 inputs file.')
    }
  }

  return (
    <>
      <section className="card notice" data-reveal>
        <h2>Confidential: stays in this browser</h2>
        <p className="small-note">
          These numbers are DL3’s own terms. They are saved only in this browser{viewer ? ` (signed in as ${viewer})` : ''} and used by
          the ranking that runs here. They are never sent to a server or published. To give them to a colleague, save them to a file and
          send it privately.
        </p>
        <p className="small-note">
          {inputStatus.usingPlaceholders
            ? `Using placeholders for ${ECONOMIC_FIELDS.length - inputStatus.entered.length} of ${ECONOMIC_FIELDS.length} values. Scores marked ≈ depend on them.`
            : 'All DL3 values entered.'}
          {inputStatus.decisions > 0 && ` ${inputStatus.decisions} decisions on proposed scores (made on the state pages) are saved here too.`}
          {inputs.updatedAt && ` Last saved ${new Date(inputs.updatedAt).toLocaleString()}.`}
        </p>
      </section>

      <section className="card" data-reveal>
        <h2>Fee terms and hurdles</h2>
        <p className="small-note">Leave a box empty to keep the placeholder shown in grey.</p>
        <div className="input-grid">
          {ECONOMIC_FIELDS.map((f) => (
            <label key={f.key} className="field">
              <span>{f.label}</span>
              <span className="field-box">
                {f.unit === '$' && <span className="unit">$</span>}
                <input
                  type="number"
                  inputMode="decimal"
                  min={f.min}
                  max={f.max}
                  step="any"
                  placeholder={String(f.placeholder)}
                  value={draft.economics[f.key] ?? ''}
                  onChange={(e) => setEcon(f.key, e.target.value)}
                />
                {f.unit === '%' && <span className="unit">%</span>}
              </span>
            </label>
          ))}
          <label className="field">
            <span>Fee test measured against</span>
            <select value={draft.feeDenominator ?? ''} onChange={(e) => setDraft((d) => ({ ...d, feeDenominator: e.target.value || null }))}>
              <option value="">Total development cost (proposed default)</option>
              <option value="tdc">Total development cost</option>
              <option value="net">Cost less fee, land and reserves</option>
            </select>
          </label>
        </div>
      </section>

      <section className="card" data-reveal>
        <h2>DL3’s view of each state</h2>
        <p className="small-note">Only DL3 can answer these. Blank means not decided yet; the state then stays “needs verification”.</p>
        <div className="state-inputs">
          {codes.map((code) => {
            const s = draft.states[code] ?? {}
            return (
              <div className="state-input-row" key={code}>
                <strong>{STATE_NAMES[code] ?? code}</strong>
                <label className="field">
                  <span>Ability to execute (0–5)</span>
                  <select value={s.execution ?? ''} onChange={(e) => setState(code, 'execution', e.target.value === '' ? undefined : Number(e.target.value))}>
                    <option value="">Not set</option>
                    {[0, 1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                </label>
                <label className="field">
                  <span>Sponsor or partner path</span>
                  <select value={yesNo(s.sponsorPath)} onChange={(e) => setState(code, 'sponsorPath', fromYesNo(e.target.value))}>
                    <option value="">Not confirmed</option><option value="yes">Yes</option><option value="no">No</option>
                  </select>
                </label>
                <label className="field">
                  <span>Financing path</span>
                  <select value={yesNo(s.financingPath)} onChange={(e) => setState(code, 'financingPath', fromYesNo(e.target.value))}>
                    <option value="">Not confirmed</option><option value="yes">Yes</option><option value="no">No</option>
                  </select>
                </label>
              </div>
            )
          })}
        </div>
        <div className="download-grid">
          <select aria-label="Add a state" value={extraState} onChange={(e) => setExtraState(e.target.value)}>
            <option value="">Add a state…</option>
            {ALL_CODES.filter((c) => !codes.includes(c)).map((c) => <option key={c} value={c}>{STATE_NAMES[c]}</option>)}
          </select>
          <button type="button" className="download-button" disabled={!extraState}
            onClick={() => { setDraft((d) => ({ ...d, states: { ...d.states, [extraState]: d.states[extraState] ?? {} } })); setExtraState('') }}>
            Add
          </button>
        </div>
      </section>

      <section className="card" data-reveal>
        <div className="download-grid">
          <button type="button" className="download-button primary" onClick={save}>Save and re-rank</button>
          <button type="button" className="download-button" onClick={exportFile}>Save to a file</button>
          <button type="button" className="download-button" onClick={() => fileRef.current?.click()}>Load from a file</button>
          <button type="button" className="download-button" onClick={reset}>Clear from this browser</button>
        </div>
        <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={importFile} />
        {message && <p className="small-note" role="status">{message}</p>}
      </section>
    </>
  )
}
