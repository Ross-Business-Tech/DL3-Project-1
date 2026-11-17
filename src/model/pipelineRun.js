// Run the data pipeline from the website.
//
// The site is static, so it cannot run Python. It asks GitHub to run the "DL3 data pipeline" workflow
// (.github/workflows/pipeline.yml) through here.now proxy routes declared in public/.herenow/proxy.json.
// The GitHub token lives in a here.now variable and is added on the server; the browser never sees it.
//
// The visitor's Gemini and Census keys are sealed in this browser with the pipeline's PUBLIC key
// (public/pipeline-key.json, RSA-OAEP SHA-256). Only the workflow holds the private key, so the keys are never
// readable in the request, in GitHub, or in this public repository. They are not stored by the site.

export const ROUTES = {
  run: '/api/pipeline/run', // POST -> GitHub workflow_dispatch
  runs: '/api/pipeline/runs', // GET  -> the workflow's recent runs
  run_detail: (id) => `/api/pipeline/actions/runs/${encodeURIComponent(id)}/jobs`, // GET -> steps of one run
  data: (name) => `/api/pipeline-data/${encodeURIComponent(name)}`, // GET -> newest website files on the Drive
}
export const PUBLIC_KEY_URL = '/pipeline-key.json'
export const BRANCH = 'development'
const STATE = /^[A-Z]{2,4}$/

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)))
const b64url = (text) => btoa(text).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')

/** Seal API keys with the pipeline's public key. Same format src/run_keys.py unseals ("v1:..."). */
export async function sealKeys(values, jwk, subtle = globalThis.crypto.subtle) {
  const key = await subtle.importKey('jwk', jwk, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt'])
  const body = {}
  for (const [name, value] of Object.entries(values)) {
    const v = (value ?? '').trim()
    if (!v) continue
    body[name] = b64(await subtle.encrypt({ name: 'RSA-OAEP' }, key, new TextEncoder().encode(v)))
  }
  return Object.keys(body).length ? `v1:${b64url(JSON.stringify(body))}` : ''
}

export function cleanStates(list) {
  const out = []
  for (const s of list) {
    const code = String(s).trim().toUpperCase()
    if (STATE.test(code) && !out.includes(code)) out.push(code)
  }
  return out
}

export const looksLikeKey = (v) => v.trim() === '' || /^[A-Za-z0-9_\-.]{8,200}$/.test(v.trim())

export function newRequestId() {
  const a = new Uint8Array(6)
  globalThis.crypto.getRandomValues(a)
  return `web-${[...a].map((x) => x.toString(16).padStart(2, '0')).join('')}`
}

/** The body GitHub's workflow_dispatch expects. */
export function dispatchBody({ states, extract, recrawl, requestId, sealed }) {
  return {
    ref: BRANCH,
    inputs: { states: cleanStates(states).join(' '), extract: Boolean(extract), recrawl: Boolean(recrawl), request_id: requestId, keys: sealed ?? '' },
  }
}

// A missing proxy route falls through to the site's own page (HTML), so check it really is JSON.
async function jsonOf(res) {
  if (!res.ok || !(res.headers?.get?.('content-type') ?? 'application/json').includes('json')) return null
  try {
    return await res.json()
  } catch {
    return null
  }
}

async function readError(res) {
  try {
    const j = await res.json()
    return j.message ?? j.error ?? JSON.stringify(j).slice(0, 200)
  } catch {
    return res.statusText
  }
}

/** Is running from the website set up on this site? (Proxy routes only exist on the team's own sites.) */
export async function checkSetup(fetchFn = globalThis.fetch) {
  const out = { publicKey: null, proxy: false, problem: null }
  try {
    const k = await fetchFn(PUBLIC_KEY_URL, { cache: 'no-store' })
    const jwk = await jsonOf(k)
    if (jwk?.kty === 'RSA' && jwk.n && jwk.e) out.publicKey = jwk
  } catch {
    // no key file
  }
  try {
    const r = await fetchFn(ROUTES.runs, { cache: 'no-store' })
    const j = r.ok ? await jsonOf(r) : null
    out.proxy = Boolean(j?.workflow_runs)
    if (!out.proxy) out.problem = r.ok || r.status === 404 ? 'not-on-this-site' : `github-${r.status}`
  } catch {
    out.problem = 'offline'
  }
  if (!out.publicKey && !out.problem) out.problem = 'no-public-key'
  return out
}

export async function startRun(opts, fetchFn = globalThis.fetch) {
  const res = await fetchFn(ROUTES.run, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(dispatchBody(opts)),
  })
  if (res.status !== 204 && !res.ok) throw new Error(`GitHub did not start the run (${res.status}: ${await readError(res)}).`)
}

/** The workflow run started with this request id, or null while GitHub is still queuing it. */
export async function findRun(requestId, fetchFn = globalThis.fetch) {
  const res = await fetchFn(ROUTES.runs, { cache: 'no-store' })
  const j = await jsonOf(res)
  if (!j) throw new Error(`Could not read the run status (${res.status}).`)
  return summarizeRuns(j.workflow_runs ?? []).find((r) => r.title.includes(requestId)) ?? null
}

export async function recentRuns(fetchFn = globalThis.fetch) {
  try {
    const j = await jsonOf(await fetchFn(ROUTES.runs, { cache: 'no-store' }))
    return summarizeRuns(j?.workflow_runs ?? [])
  } catch {
    return []
  }
}

export function summarizeRuns(runs) {
  return runs.map((r) => ({
    id: r.id,
    title: r.display_title ?? r.name ?? '',
    status: r.status, // queued | in_progress | completed
    conclusion: r.conclusion, // success | failure | cancelled | null
    url: /^https:\/\/github\.com\//.test(r.html_url ?? '') ? r.html_url : null,
    started: r.run_started_at ?? r.created_at ?? null,
    updated: r.updated_at ?? null,
  }))
}

/** Step-by-step progress of one run, for the progress list. */
export async function runSteps(runId, fetchFn = globalThis.fetch) {
  const j = await jsonOf(await fetchFn(ROUTES.run_detail(runId), { cache: 'no-store' }))
  return (j?.jobs ?? []).flatMap((job) => (job.steps ?? []).map((s) => ({ job: job.name, name: s.name, status: s.status, conclusion: s.conclusion })))
}

export function plainStatus(run) {
  if (!run) return 'Waiting for GitHub to start the run…'
  if (run.status === 'queued' || run.status === 'waiting' || run.status === 'pending') return 'Queued: waiting for a GitHub runner'
  if (run.status !== 'completed') return 'Running'
  return { success: 'Finished', failure: 'Stopped with an error', cancelled: 'Cancelled', timed_out: 'Ran out of time' }[run.conclusion] ?? `Finished (${run.conclusion})`
}

// ------------------------------------------------------------------ newest results

const LIVE_FILES = {
  rulesCsv: 'rules.csv', sourcesCsv: 'sources.csv', costCsv: 'cost_per_unit.csv', metroCsv: 'states_in_top_msas.csv', awardsCsv: 'awards.csv',
}

/**
 * The newest pipeline export published to the here.now Drive, if it is newer than `sinceIso`.
 * Returns null when there is nothing newer or the site has no data route (test links, local).
 */
export async function fetchNewerResults(sinceIso, fetchFn = globalThis.fetch) {
  let manifest
  try {
    manifest = await jsonOf(await fetchFn(ROUTES.data('manifest.json'), { cache: 'no-store' }))
  } catch {
    return null
  }
  if (!manifest?.generated_at || (sinceIso && manifest.generated_at <= sinceIso)) return null
  const files = { manifest }
  for (const [k, name] of Object.entries(LIVE_FILES)) {
    const r = await fetchFn(ROUTES.data(name), { cache: 'no-store' })
    const type = r.headers?.get?.('content-type') ?? 'text/csv'
    if (!r.ok || type.includes('html')) return null // a half-published set (or no data route) is never used
    files[k] = await r.text()
  }
  let inventory = null
  try {
    const r = await fetchFn(ROUTES.data('inventory.csv'), { cache: 'no-store' })
    if (r.ok && !(r.headers?.get?.('content-type') ?? '').includes('html')) inventory = await r.text()
  } catch {
    // keep the bundled inventory
  }
  return { files, inventory }
}
