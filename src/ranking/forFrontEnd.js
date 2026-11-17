// Real results in the shape the team's front end uses (branch claude/epic-hamilton-532vgr, src/data.js,
// the TERRITORIES list). Its own comment says: "When the research and scoring work is ready, this file
// is the one place to swap in real results." This builds that list from a ranking result.
//
// One difference matters: the front end expects every territory to have a numeric `score` and sorts
// by it. Real scores only exist once a state passes every check and all seven criteria have evidence,
// so `score` is null until then and `scoreText` says why (for example "Not scored yet" or a range).
// The front end's sort needs `(b.score ?? -1) - (a.score ?? -1)` to put unscored states last.

import { US_STATES } from './usStates.js'

const CODE = Object.fromEntries(Object.entries(US_STATES).map(([code, name]) => [name, code]))
const pct = (x) => `${(x * 100).toFixed(2)}%`
const r1 = (n) => Number(n.toFixed(1))

function feeText(r) {
  const c = r.gates.checks.find((k) => k.key === 'fee')
  if (c.ratio === null || c.ratio === undefined) return `${r.pathway}: not established`
  const word = c.status === 'pass' ? 'passes' : c.status === 'fail' ? (r.gates.status === 'Fail' ? 'fails' : 'fails, held for verification') : 'rule not verified'
  return `${r.pathway}: ${word} at ${pct(c.ratio)}`
}

/** @returns {object[]} one entry per state, best-evidenced first, in the front end's field names. */
export function territoriesFromResult(result) {
  const all = result.lists.flatMap((l) => [...l.ranked, ...l.needsVerification, ...l.excluded, ...l.benchmark])
  const byState = new Map()
  for (const r of all) {
    if (!byState.has(r.state)) byState.set(r.state, [])
    byState.get(r.state).push(r)
  }
  const out = []
  for (const [state, rows] of byState) {
    rows.sort((a, b) => b.pathway.localeCompare(a.pathway)) // 9% first
    const scored = rows.filter((r) => r.score.point !== null && result.lists.some((l) => l.ranked.includes(r)) && !r.previewOnly)
    const best = scored.sort((a, b) => b.score.point - a.score.point)[0]
    const ranked = rows.filter((r) => result.lists.some((l) => l.ranked.includes(r)))
    const deep = rows.some((r) => r.researched && !r.screenOnly)
    const screen = rows.some((r) => r.screenOnly)
    const status = rows.some((r) => r.gates.status === 'Pass')
      ? 'Complete'
      : rows.every((r) => r.gates.status === 'Fail')
        ? 'Excluded'
        : deep ? 'Review' : 'Incomplete'
    // When the sources behind this state were last retrieved (ISO dates sort as text).
    const dates = rows.flatMap((r) => r.criticalSourceDates ?? []).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    const links = rows[0].sources?.links
    const linkCount = links ? [links.qapCurrent, links.qapPage, links.bondProgram, links.applicationRound, links.underwritingManual].filter(Boolean).length + links.awardLists.length : 0
    out.push({
      id: CODE[state] ?? state,
      name: state,
      kind: 'State',
      score: best ? r1(best.score.point) : null,
      scoreText: best
        ? `${r1(best.score.point)} / 100`
        : ranked.length > 0
          ? `${r1(Math.min(...ranked.map((r) => r.score.lo)))}-${r1(Math.max(...ranked.map((r) => r.score.hi)))} (range; evidence incomplete)`
          : 'Not scored yet',
      status,
      depth: deep ? 'In depth' : screen ? 'Fee screen only' : 'Not researched',
      agency: rows[0].allocator ?? rows[0].sources?.agency ?? 'Unknown',
      openQuestions: result.reviewQueue.filter((q) => q.state === state).length,
      sources: linkCount,
      lastChecked: dates.sort().at(-1) ?? 'Not checked',
      feeRule: rows.map(feeText).join(' · '),
      creditCap: rows.map((r) => r.programCaps?.maxCreditText).find(Boolean) ?? 'Needs verification',
      deadline: rows.map((r) => r.nextDeadline).find(Boolean) ?? 'Needs verification',
      pathways: rows.map((r) => ({ pathway: r.pathway, checks: r.gates.status, confidence: r.confidence, reason: r.reason ?? null })),
    })
  }
  const rankDepth = { 'In depth': 0, 'Fee screen only': 1, 'Not researched': 2 }
  return out.sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || rankDepth[a.depth] - rankDepth[b.depth] || a.name.localeCompare(b.name))
}
