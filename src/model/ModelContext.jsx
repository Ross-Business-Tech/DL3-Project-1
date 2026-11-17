// One place that holds the data every page shows: the ranking (run in this browser with DL3's own inputs),
// the pipeline's evidence and documents, and whether newer pipeline results have been published.
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { BUNDLED_PIPELINE_FILES, REAL_DATA, buildRealData } from '../ranking/realData.js'
import { withAssumptionSensitivity } from '../ranking/sensitivity.js'
import { MODEL_VERSION } from '../ranking/config.js'
import { applyStateInputs, inputStatus, loadInputs, saveInputs, settingsFor, clearInputs } from './dl3Inputs.js'
import { buildTerritories, codeOf, overviewStats, sourcesFromCsv } from './territories.js'
import { fetchNewerResults } from './pipelineRun.js'

const ModelContext = createContext(null)
const today = () => new Date().toISOString().slice(0, 10)

export function ModelProvider({ children }) {
  const [data, setData] = useState({ built: REAL_DATA, files: BUNDLED_PIPELINE_FILES, live: false })
  const [inputs, setInputsState] = useState(() => loadInputs())
  const [viewer, setViewer] = useState(null)
  const [liveCheck, setLiveCheck] = useState('checking') // checking | newer | current | unavailable

  // Who is signed in (here.now's access gate). Display only.
  useEffect(() => {
    let alive = true
    fetch('./.herenow/me', { cache: 'no-store' })
      .then((r) => (r.ok && (r.headers.get('content-type') ?? '').includes('json') ? r.json() : null))
      .then((j) => alive && setViewer(typeof j?.email === 'string' ? j.email : null))
      .catch(() => {})
    return () => { alive = false }
  }, [])

  const refreshResults = useCallback(async () => {
    setLiveCheck('checking')
    const since = data.files.manifest?.generated_at ?? null
    const newer = await fetchNewerResults(since)
    if (!newer) {
      setLiveCheck((s) => (s === 'checking' ? 'current' : s))
      return false
    }
    setData({ built: buildRealData(newer.files, newer.inventory ?? undefined), files: newer.files, live: true })
    setLiveCheck('newer')
    return true
  }, [data.files.manifest])

  // On load: use the newest published results if the pipeline ran since this site was built.
  useEffect(() => {
    refreshResults()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const setInputs = useCallback((next) => setInputsState(saveInputs(next)), [])
  const resetInputs = useCallback(() => setInputsState(clearInputs()), [])

  const model = useMemo(() => {
    const records = applyStateInputs(data.built.records, inputs, codeOf, viewer ?? 'DL3')
    const result = withAssumptionSensitivity(records, { asOf: today(), settings: settingsFor(inputs) })
    const territories = buildTerritories(result, records)
    return {
      records,
      result,
      territories,
      stats: overviewStats(territories),
      sources: sourcesFromCsv(data.files.sourcesCsv),
      manifest: data.files.manifest ?? null,
      liveResults: data.live,
      warnings: data.built.warnings ?? [],
      modelVersion: MODEL_VERSION,
    }
  }, [data, inputs, viewer])

  const value = useMemo(
    () => ({ ...model, inputs, inputStatus: inputStatus(inputs), setInputs, resetInputs, viewer, liveCheck, refreshResults }),
    [model, inputs, setInputs, resetInputs, viewer, liveCheck, refreshResults],
  )
  return <ModelContext.Provider value={value}>{children}</ModelContext.Provider>
}

export function useModel() {
  const m = useContext(ModelContext)
  if (!m) throw new Error('useModel must be used inside <ModelProvider>')
  return m
}
