// Turns a ranking result into a CSV file (guide section 2: "exportable report, data, and handoff").

const COLUMNS = [
  'Pathway', 'List', 'Rank', 'State', 'Allocator', 'Score', 'Evidence coverage', 'Confidence',
  'Eligibility', 'Shortlist', 'Tie', 'Unstable under weight changes', 'Reason', 'Next deadline',
  'Action', 'Researched', 'Source notes', 'Run date', 'Model version',
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
        kind === 'Benchmark only' ? '' : `${Math.round(r.score.coverage * 100)}%`,
        r.confidence,
        kind === 'Benchmark only' ? 'Benchmark only' : r.gates.status,
        kind === 'Ranked' ? r.shortlistStatus + (r.actionable ? ' (actionable)' : '') : '',
        r.tied ? 'Yes' : '',
        r.stability?.unstable ? 'Yes' : '',
        r.reason,
        r.nextDeadline,
        r.action,
        r.researched ? 'Yes' : 'No',
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
