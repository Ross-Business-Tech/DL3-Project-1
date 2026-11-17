// Turns the territory and source lists into the files Andrew asked for: tables (.csv and .xlsx),
// and PDF reports. PDFs are made by the browser's print dialog ("Save as PDF").
import * as XLSX from 'xlsx'
import { SOURCES, TERRITORIES } from './data.js'

// One row per territory, in the same columns the ranking system fills in.
export function territoryRows(list = TERRITORIES) {
  return list.map((t) => ({
    Name: t.name,
    Type: t.kind,
    Score: t.scoreText,
    Status: t.status,
    Research: t.depth,
    'Allocating agency': t.agency,
    'Open questions': t.openQuestions,
    'Sources on file': t.sources,
    'Last checked': t.lastChecked,
    'Developer fee rule': t.feeRule,
    'Credit cap': t.creditCap,
    'Next deadline': t.deadline,
    '9% checks': t.pathways?.[0]?.checks ?? '',
    '4% checks': t.pathways?.[1]?.checks ?? '',
    'Awards flagged for checking (not counted)': t.realFacts?.awardRowsFlaggedCheck ?? '',
    'Approved rules': t.realFacts?.approvedRules ?? '',
  }))
}

export function sourceRows() {
  return SOURCES.map((s) => ({ ID: s.id, Source: s.title, 'What it is used for': s.use, Link: s.url }))
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

export function downloadTerritoriesCsv() {
  download('dl3-territories.csv', new Blob([toCsv(territoryRows())], { type: 'text/csv' }))
}

export function downloadSourcesCsv() {
  download('dl3-sources.csv', new Blob([toCsv(sourceRows())], { type: 'text/csv' }))
}

export function downloadExcel() {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(territoryRows()), 'Territories')
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sourceRows()), 'Sources')
  XLSX.writeFile(wb, 'dl3-ranking-tables.xlsx')
}

// Rows for the chosen states. A state with no data yet still gets a row, marked "Not researched yet".
export function selectedRows(codes, names) {
  return codes.map((code) => {
    const t = TERRITORIES.find((x) => x.id === code)
    return t ?? { id: code, name: names[code] ?? code, kind: 'State', scoreText: 'Not scored yet', status: 'Not researched yet', depth: 'Not researched' }
  })
}

export function downloadSelectedCsv(codes, names) {
  download('dl3-selected-states.csv', new Blob([toCsv(territoryRows(selectedRows(codes, names)))], { type: 'text/csv' }))
}

// A text file for Vijay's pipeline. The site can't run the pipeline itself, so this file lists the
// states and the command to run on a computer with Python.
export function downloadPipelineRequest(codes) {
  const list = codes.join(' ')
  const text = [
    'DL3 pipeline request',
    `States: ${list || '(none selected)'}`,
    '',
    'To run the pipeline for these states, open the dl3-lihtc-model folder on a computer with Python,',
    'then run this command:',
    '',
    `  python run_all.py --inventory ${list}`,
    '',
    'Results are written to the outputs and data folders. Keep them private until DL3 approves them.',
    '',
  ].join('\n')
  download('dl3-pipeline-request.txt', new Blob([text], { type: 'text/plain' }))
}
