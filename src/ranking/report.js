// Pilot profiles report (guide 8B): one self-contained HTML file DL3 can open, print or forward.
// "Each shortlisted profile should include the jurisdiction and program; suggested urban markets;
// gate results; five-year award and developer evidence; current QAP priorities and amendments;
// normalized economics; DL3 execution path; Venture Development assessment; risks; open questions;
// application checklist; deadlines; and recommended next action with owner."
// Items the data cannot support yet say so explicitly instead of being left out.
//
// Every value from a data file is escaped before it goes into the HTML, and only http(s) links are
// written, so nothing in a data file can run as code in the report.

import { COMPONENTS } from './config.js'

const esc = (v) => String(v ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
const safeHref = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? esc(u) : null)
const link = (u, text) => (safeHref(u) ? `<a href="${safeHref(u)}">${esc(text)}</a>` : esc(text))
const money = (n) => (typeof n === 'number' && Number.isFinite(n) ? `$${Math.round(n).toLocaleString('en-US')}` : 'unknown')
const pct = (x) => (typeof x === 'number' && Number.isFinite(x) ? `${(x * 100).toFixed(2)}%` : 'unknown')
const r1 = (n) => Number(n.toFixed(1))

function criterionText(c) {
  if (c.status === 'assumed') return `Assumed ${r1(c.score)} (what-if)`
  if (c.status === 'final') return `${r1(c.score)} / 5${c.placeholder ? ' (placeholder terms)' : ''}`
  if (c.interval) return `${r1(c.interval.lo)} to ${r1(c.interval.hi)}${c.status === 'proposed' ? ' (proposed)' : ''}`
  if (c.status === 'proposed') return `Proposed ${r1(c.score)}`
  return 'Unknown'
}

const scoreText = (r) => (r.score.point !== null ? `${r1(r.score.point)} / 100` : `${r1(r.score.lo)} to ${r1(r.score.hi)} (range: evidence incomplete)`)
const table = (head, rows) => `<div class="tw"><table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`

// The decisions both the ranking tool and the scraping pipeline list as open (guide 11B).
export const OPEN_DECISIONS = [
  'Fee denominator: section 1 (total development cost less fee, land and reserves) or section 5 (total development cost). The tool shows both.',
  'DL3 minimum retained-cash and present-value hurdles, and DL3\'s contractual fee share. Until then Developer economics is only previewed with placeholders.',
  'Approval of the proposed urban definition (Census urbanized area, principal city or approved area, density or transit; the 3,000 per square mile figure is a placeholder).',
  'Confirmation of the three pilot jurisdictions (Michigan, Ohio, Indiana are assumed).',
  'Whether DL3 has an eligible sponsor or partner path in each pilot state. No state can pass every check until this is answered.',
  'How the five Venture Development factors are scored, and who reviews judgment scores.',
  'Who operates the model after the sprint.',
]

function nextAction(r, queue) {
  const items = queue.filter((q) => q.id === r.id)
  const gate = items.find((q) => q.kind === 'gate')
  const pick = gate ?? items[0]
  if (r.gates.status === 'Fail') return 'Excluded on firm evidence; keep in the coverage report and re-check only if the rule changes.'
  if (!pick) return 'Prepare the profile for DL3 review.'
  return `${pick.item}: ${pick.needs.join('; ') || pick.reasons.join('; ')} (owner: ${pick.owner})`
}

function profile(r, result) {
  const queue = result.reviewQueue
  const gates = table(['Check', 'Result', 'Detail'], r.gates.checks.map((c) => [esc(c.label), esc(c.status), esc(c.detail)]))
  const crit = table(['Criterion', 'Weight', 'Score', 'How'], COMPONENTS.map((c) => {
    const k = r.criteria[c.key]
    return [esc(c.label), `${esc(r1(result.weights[c.key]))}%`, esc(criterionText(k)), esc(k.status === 'unresolved' ? `needs: ${k.needs.join('; ')}` : k.reasons.slice(0, 2).join('; '))]
  }))
  const e = r.economicsDetail
  const econ = e
    ? table(['Item', 'Value'], [
        ['Approved gross fee', `${money(e.approvedGrossFee)} (${pct(e.grossFeeToTdc)} of total development cost)`],
        [`DL3 retained fee (${Math.round(e.terms.dl3Share * 100)}% share)`, `${money(e.retainedFee)} (${pct(e.retainedFeeToTdc)})`],
        ['Cash at closing / during construction / at completion', `${money(e.cash.closing)} / ${money(e.cash.construction)} / ${money(e.cash.completion)}`],
        ['Deferred (paid later)', money(e.deferredAmount)],
        ['Present value of expected net receipts, if DL3 wins', money(e.presentValue)],
        [`Expected pursuit value (${Math.round(e.terms.awardProbability * 100)}% chance of winning)`, money(e.expectedPursuitValue)],
        ['Downside: cash in hand / present value', `${money(e.downside.nonDeferredCash)} / ${money(e.downside.presentValue)}`],
      ].map(([a, b]) => [esc(a), esc(b)])) + '<p class="note">Placeholder terms (the guide\'s 60% / 40% illustration and stand-in timing, probabilities and discount rate) until DL3 sets its own.</p>'
    : '<p>No economics: the fee is not established on a verified rule.</p>'
  const hist = (r.awardHistory ?? []).length > 0
    ? table(['Year', 'Complete', 'New-construction awards', 'Above 100 units', 'Qualified applications', 'Urban-filtered', 'Source'], r.awardHistory.map((h) => [
        esc(h.year), h.complete ? 'yes' : 'year to date', esc(h.eligibleAwards ?? 'unknown'), esc(h.awardsAbove100Units ?? 'unknown'), esc(h.qualifiedApplications ?? 'unknown'), h.urbanFiltered ? 'yes' : 'no', link(h.source, 'source'),
      ]))
    : '<p>No yearly award history loaded for this program.</p>'
  const caps = r.programCaps
    ? table(['Limit', 'Value'], [
        ['Maximum credit per project', caps0(r.programCaps.maxCreditText)],
        ['Unit cap', r.programCaps.unitCap === 'none-stated' ? 'No cap stated in the rules' : esc(r.programCaps.unitCap)],
        ['Cost cap', caps0(r.programCaps.costCapText)],
        ['Developer fee limit (program terms)', caps0(r.programCaps.developerFeeLimitText)],
      ]) + `<p class="note">Source: ${link(r.programCaps.source, 'official document')}, retrieved ${esc(r.programCaps.retrieved)}.</p>`
    : '<p>No program limits loaded.</p>'
  const risks = [
    ...r.gates.checks.filter((c) => c.status !== 'pass').map((c) => `${c.label}: ${c.detail}`),
    ...(r.assumptionChanges ?? []).map((m) => `Sensitive to an assumption. ${m}`),
    ...(r.stability?.changes ?? []).slice(0, 3).map((m) => `Sensitive to weights. ${m}`),
  ]
  const open = queue.filter((q) => q.id === r.id)
  const src = r.sources?.links
  const sourceLinks = src
    ? [src.qapCurrent && link(src.qapCurrent, 'Latest non-draft plan'), src.qapPage && link(src.qapPage, 'Plan page'), src.bondProgram && link(src.bondProgram, 'Bond program'), ...src.awardLists.slice(0, 3).map((a, i) => link(a.url, `Award list ${a.label ?? i + 1}`))].filter(Boolean).join(' · ')
    : ''
  return `
<section class="profile">
  <h2>${esc(r.state)}, ${esc(r.pathway)} credit</h2>
  <p class="meta">${esc(r.allocator ?? '')} · Checks: <strong>${esc(r.gates.status)}</strong> · Confidence: ${esc(r.confidence)} · Score: ${esc(scoreText(r))}</p>
  <h3>Gate results</h3>${gates}
  <h3>Normalized economics</h3>${econ}
  <h3>Scores by criterion</h3>${crit}
  <h3>Five-year award evidence</h3>${hist}
  <h3>Program rules for one project</h3>${caps}
  <h3>Suggested urban markets, DL3 execution path, Venture Development</h3>
  <p>Not assessed yet: these need the approved urban definition and site facts, DL3's own staffing and partner plan, and evidence for named neighborhoods. See open questions.</p>
  <h3>Risks</h3>${risks.length ? `<ul>${risks.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p>None flagged.</p>'}
  <h3>Open questions and owners</h3>${open.length ? `<ul>${open.map((q) => `<li><strong>${esc(q.item)}</strong> (${esc(q.owner)}): ${esc(q.needs.join('; ') || q.reasons.join('; '))}</li>`).join('')}</ul>` : '<p>None.</p>'}
  <h3>Application checklist</h3><p>Not prepared: application assistance is a stretch item (guide 10) and needs the selected round's official package.</p>
  <h3>Deadlines</h3><p>${esc(r.nextDeadline ?? 'Not established')}</p>
  <h3>Sources and research notes</h3><p>${sourceLinks || 'No document links.'}</p>${r.notes ? `<p class="note">${esc(r.notes)}</p>` : ''}
  <h3>Recommended next action</h3><p>${esc(nextAction(r, queue))}</p>
</section>`
}

function caps0(text) {
  return esc(text ?? 'Not found')
}

/** The whole report as one HTML string. `title` and `status` describe the run. */
export function profilesHtml(result, { title = 'DL3 LIHTC pilot profiles', status = 'Draft research data, not reviewed by DL3.' } = {}) {
  const all = result.lists.flatMap((l) => [...l.ranked, ...l.needsVerification, ...l.excluded])
  const pilots = all.filter((r) => r.researched && !r.screenOnly).sort((a, b) => a.state.localeCompare(b.state) || b.pathway.localeCompare(a.pathway))
  const summary = result.lists.map((l) => `<tr><td>${esc(l.pathway)}</td><td>${l.counts.total}</td><td>${l.counts.pass}</td><td>${l.counts.needsVerification + (l.counts.previewRanked ?? 0)}</td><td>${l.counts.fail}</td><td>${l.ranked.length ? esc(l.ranked.map((r) => `${r.state} (${scoreText(r)})`).join('; ')) : 'Nothing ranked: no state has passed every check'}</td></tr>`).join('')
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
body{font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1b1f2a;max-width:960px;margin:0 auto;padding:24px 16px}
h1{font-size:26px;margin:0 0 4px}h2{font-size:21px;margin:32px 0 4px;padding-top:16px;border-top:2px solid #1f3864}h3{font-size:15px;margin:18px 0 6px;color:#1f3864}
.tw{overflow-x:auto;-webkit-overflow-scrolling:touch}table{width:100%;min-width:520px;border-collapse:collapse;font-size:13px;margin:4px 0}td,th{overflow-wrap:break-word}th,td{border:1px solid #d9dde4;padding:5px 7px;text-align:left;vertical-align:top}th{background:#f3f5f8}
.meta,.note{color:#5b6474;font-size:13px}.banner{background:#fff4e5;border:1px solid #f3c88a;border-radius:6px;padding:10px 12px}
a{color:#2f5bea}@media print{h2{page-break-before:always}}
</style></head><body>
<h1>${esc(title)}</h1>
<p class="meta">Run ${esc(result.asOf)} · model ${esc(result.modelVersion)} · fee measured against ${esc(result.settings.feeDenominator === 'net' ? 'cost less fee, land and reserves (guide section 1)' : 'total development cost (guide section 5)')}</p>
<p class="banner">${esc(status)} Scores are calculated in code from the data files, so the same inputs always give the same result. Unknown evidence never counts as a pass, and no national ranking is claimed (guide section 10).</p>
<h2 style="border:0;margin-top:16px">Summary</h2>
<div class="tw"><table><thead><tr><th>Pathway</th><th>States</th><th>Passed every check</th><th>Held for verification</th><th>Excluded</th><th>Ranked</th></tr></thead><tbody>${summary}</tbody></table></div>
<h3>Decisions needed from DL3</h3><ul>${OPEN_DECISIONS.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>
<h3>Weights used</h3><p>${COMPONENTS.map((c) => `${esc(c.label)} ${esc(r1(result.weights[c.key]))}%`).join(' · ')}</p>
${pilots.map((r) => profile(r, result)).join('\n')}
</body></html>
`
}
