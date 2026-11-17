// Turns a ranking result into a CSV file (guide section 2: "exportable report, data, and handoff").

const COLUMNS = [
  'Pathway', 'List', 'Rank', 'State', 'Allocator', 'Score', 'Evidence coverage', 'Confidence',
  'Eligibility', 'Shortlist', 'Tie', 'Unstable under weight changes', 'Reason', 'Next deadline',
  'Action', 'Research depth', 'Source notes', 'Run date', 'Model version',
]

const round = (n) => Number(n.toFixed(1))

export function scoreText(score) {
  return score.point !== null ? String(round(score.point)) : `${round(score.lo)} to ${round(score.hi)} (provisional)`
}

export function rankText(r) {
  if (r.rank !== null && r.rank !== undefined) return String(r.rank)
  if (!r.rankRange) return ''
  return `${r.rankRange[0]} to ${r.rankRange[1]} (withheld)`
}

// A cell that starts with = + - @ could be run as a formula by a spreadsheet, so defuse it.
function cell(value) {
  let text = value === null || value === undefined ? '' : String(value)
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

// The "still needed" list as a spreadsheet, so DL3, the reviewer and the research team can each
// take their rows.
export function toQueueCsv(result) {
  const rows = [['Owner', 'State', 'Pathway', 'Type', 'Item', 'Status', 'What is needed', 'Why it is open']]
  for (const q of result.reviewQueue) {
    rows.push([q.owner, q.state, q.pathway, q.kind === 'gate' ? 'Screening gate' : 'Scoring criterion', q.item, q.status, q.needs.join('; '), q.reasons.join('; ')])
  }
  return rows.map((row) => row.map(cell).join(',')).join('\n') + '\n'
}

export function toCsv(result) {
  const rows = [COLUMNS]
  for (const list of result.lists) {
    const add = (r, kind) =>
      rows.push([
        list.pathway,
        kind,
        kind === 'Ranked' ? rankText(r) : '',
        r.state,
        r.allocator,
        kind === 'Benchmark only' ? '' : scoreText(r.score),
        kind === 'Benchmark only' ? '' : `${Math.round((r.evidenceCoverage ?? r.score.coverage) * 100)}%`,
        r.confidence,
        kind === 'Benchmark only' ? 'Benchmark only' : r.gates.status,
        kind === 'Ranked' ? r.shortlistStatus + (r.actionable ? ' (actionable)' : '') : '',
        r.tied ? 'Yes' : '',
        r.stability?.unstable ? 'Yes' : '',
        r.reason,
        r.nextDeadline,
        r.action,
        !r.researched ? 'Nothing yet' : r.screenOnly ? 'Fee screen only (draft)' : 'In depth',
        r.notes,
        r.date,
        result.modelVersion,
      ])
    list.ranked.forEach((r) => add(r, 'Ranked'))
    list.needsVerification.forEach((r) => add(r, 'Needs verification'))
    list.excluded.forEach((r) => add(r, 'Excluded'))
    list.benchmark.forEach((r) => add(r, 'Benchmark only'))
  }
  return rows.map((row) => row.map(cell).join(',')).join('\n') + '\n'
}
