// Turns the territory and source lists into the files reviewers asked for: tables (.csv and .xlsx),
// and PDF reports. PDFs are made by the browser's print dialog ("Save as PDF").
// Every function takes the lists the page is showing, so a download always matches the screen.
import * as XLSX from 'xlsx'

// One row per territory, in the same columns the ranking system fills in.
export function territoryRows(list) {
  return list.map((t) => ({
    Name: t.name,
    Type: t.kind,
    Score: t.scoreText,
    'Score note': t.scoreNote ?? '',
    Status: t.status,
    Research: t.depth,
    'Allocating agency': t.agency,
    'Open questions': t.openQuestions,
    'Sources on file': t.sources,
    'Last checked': t.lastChecked,
    'Developer fee rule': t.feeRule,
    'Credit cap': t.creditCap,
    'Next deadline': t.deadline,
    '9% checks': t.pathways?.find((p) => p.pathway === '9%')?.checks ?? '',
    '4% checks': t.pathways?.find((p) => p.pathway === '4%')?.checks ?? '',
    'Approved pipeline rules': t.pipeline?.rules?.length ?? 0,
  }))
}

export function sourceRows(sources) {
  return sources.map((s) => ({
    ID: s.id, State: s.state, Document: s.title, Type: s.type, Status: s.status, Critical: s.critical ? 'yes' : 'no',
    'Last retrieved': s.lastRetrieved ?? '', Stale: s.stale ? 'yes' : 'no', Link: s.url ?? '',
  }))
}

function download(filename, blob) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

// CSV: commas inside a cell are quoted, and quotes are doubled.
function toCsv(rows) {
  if (rows.length === 0) return ''
  const cols = Object.keys(rows[0])
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
  }
  return [cols.map(esc).join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n') + '\n'
}

export function downloadTerritoriesCsv(territories) {
  download('dl3-territories.csv', new Blob([toCsv(territoryRows(territories))], { type: 'text/csv' }))
}

export function downloadSourcesCsv(sources) {
  download('dl3-sources.csv', new Blob([toCsv(sourceRows(sources))], { type: 'text/csv' }))
}

export function downloadExcel(territories, sources) {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(territoryRows(territories)), 'Territories')
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sourceRows(sources)), 'Sources')
  XLSX.writeFile(wb, 'dl3-ranking-tables.xlsx')
}
