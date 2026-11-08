// Reads the research team's "Part C" data sheet (CSV) and turns each row into a record for the
// ranking engine. The sheet is used exactly as received; this loader copes with its quirks
// and reports every problem it finds instead of guessing.
//
// Rules: "UNKNOWN" (or anything not clearly a number/true/false) becomes null = unknown. Nothing
// is filled in or estimated, and free-text notes are kept for display but never scored.

const EXPECTED_COLUMNS = [
  'id', 'state', 'pathway', 'allocator', 'maxFeasibleUnits', 'approvedGrossFee',
  'totalDevelopmentCost', 'feeAsPercentOfTDC', 'sponsorPath', 'financingPath',
  'criticalSourceDates', 'eligibleAwardsPerYear', 'qualifiedApplicationsPerYear',
  'yearsCovered', 'awardsAbove100Units', 'nextDeadline', 'confidence', 'notes',
]

// Small RFC 4180 parser: quoted fields, commas and line breaks inside quotes, "" escapes.
export function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  const src = text.replace(/^﻿/, '')
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { field += '"'; i++ }
      else if (ch === '"') quoted = false
      else field += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') { row.push(field); field = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++
      row.push(field); field = ''
      if (row.some((f) => f.trim() !== '')) rows.push(row)
      row = []
    } else field += ch
  }
  row.push(field)
  if (row.some((f) => f.trim() !== '')) rows.push(row)
  return rows
}

const clean = (v) => (v ?? '').trim()
const isUnknown = (v) => clean(v) === '' || /^unknown\b/i.test(clean(v))
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function number(value, field, warn) {
  if (isUnknown(value)) return null
  const s = clean(value).replaceAll(',', '')
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s)
  warn(`${field}: "${clean(value)}" is not a plain number, so it was treated as unknown`)
  return null
}

function bool(value, field, warn) {
  const s = clean(value).toLowerCase()
  if (s === 'true') return true
  if (s === 'false') return false
  if (!isUnknown(value)) warn(`${field}: "${clean(value)}" is not true or false, so it was treated as unknown`)
  return null
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

/**
 * @returns {{ records: object[], warnings: string[], stats: object }}
 */
export function recordsFromPartC(csvText) {
  const rows = parseCsv(csvText)
  const warnings = []
  const [header, ...body] = rows
  if (!header || EXPECTED_COLUMNS.some((c, i) => clean(header[i]) !== c)) {
    throw new Error('The data sheet does not start with the expected column names, so it was not loaded.')
  }

  const records = []
  const seen = new Set()
  let repairedRows = 0
  let skippedRows = 0

  body.forEach((raw, index) => {
    const line = index + 2 // row number in the file, counting the header as 1
    let fields = raw
    let agencyRetrieved = null

    // Quirk: researchers' "agency only" rows carry one extra column holding a date, which pushes
    // the confidence value into the notes. Drop that column and keep the date separately.
    if (fields.length === EXPECTED_COLUMNS.length + 1 && /\(agency only\)/i.test(fields[11])) {
      agencyRetrieved = clean(fields[11]).split(' ')[0]
      fields = [...fields.slice(0, 11), ...fields.slice(12)]
      repairedRows++
    }
    if (fields.length !== EXPECTED_COLUMNS.length) {
      warnings.push(`Row ${line} has ${fields.length} columns instead of ${EXPECTED_COLUMNS.length}, so it was skipped.`)
      skippedRows++
      return
    }

    const f = Object.fromEntries(EXPECTED_COLUMNS.map((c, i) => [c, clean(fields[i])]))
    const warn = (message) => warnings.push(`${f.state} ${f.pathway} (row ${line}) ${message}`)
    if (f.pathway !== '9%' && f.pathway !== '4%') {
      warnings.push(`Row ${line} has pathway "${f.pathway}", so it was skipped.`)
      skippedRows++
      return
    }
    const id = `${slug(f.state)}-${f.pathway === '9%' ? '9' : '4'}`
    if (seen.has(id)) {
      warnings.push(`Row ${line} repeats ${f.state} ${f.pathway}, so it was skipped.`)
      skippedRows++
      return
    }
    seen.add(id)

    const unitsMatch = /^(\d+)\b/.exec(f.maxFeasibleUnits)
    const approvedGrossFee = number(f.approvedGrossFee, 'approvedGrossFee', warn)
    const totalDevelopmentCost = number(f.totalDevelopmentCost, 'totalDevelopmentCost', warn)
    const statedPercent = number(f.feeAsPercentOfTDC, 'feeAsPercentOfTDC', warn)
    if (statedPercent !== null && approvedGrossFee !== null && totalDevelopmentCost) {
      const computed = (approvedGrossFee / totalDevelopmentCost) * 100
      if (Math.abs(computed - statedPercent) > 0.01) {
        warn(`says the fee is ${statedPercent}% of cost, but the dollar amounts give ${computed.toFixed(2)}%`)
      }
    }

    const dates = f.criticalSourceDates.split(';').map(clean).filter((d) => ISO_DATE.test(d))
    const confidence = ['High', 'Medium', 'Low'].find((c) => c.toLowerCase() === f.confidence.toLowerCase()) ?? 'Low'
    if (confidence === 'Low' && f.confidence.toLowerCase() !== 'low') warn(`has confidence "${f.confidence}", so it was treated as Low`)

    const maxFeasibleUnits = unitsMatch ? Number(unitsMatch[1]) : null
    const sponsorPath = bool(f.sponsorPath, 'sponsorPath', warn)
    const financingPath = bool(f.financingPath, 'financingPath', warn)
    const researched =
      maxFeasibleUnits !== null || approvedGrossFee !== null || totalDevelopmentCost !== null ||
      sponsorPath !== null || financingPath !== null || dates.length > 0

    records.push({
      id,
      sourceId: f.id,
      state: f.state,
      pathway: f.pathway,
      allocator: f.allocator,
      maxFeasibleUnits,
      approvedGrossFee,
      totalDevelopmentCost,
      sponsorPath,
      financingPath,
      criticalSourceDates: dates,
      // The sheet's award and application columns are free text ("13 pure new construction (3 + 3 ...")
      // unless they are a plain number, and only plain numbers can feed the funding index.
      funding: {
        eligibleAwardsPerYear: number(f.eligibleAwardsPerYear, 'eligibleAwardsPerYear', () => {}),
        qualifiedApplicationsPerYear: number(f.qualifiedApplicationsPerYear, 'qualifiedApplicationsPerYear', () => {}),
      },
      confidence,
      nextDeadline: isUnknown(f.nextDeadline) ? null : f.nextDeadline,
      // Illinois is research-only in the guide (section 1): benchmark, never shortlisted.
      benchmarkOnly: f.state === 'Illinois' || /excluded from the active new-development shortlist/i.test(f.notes),
      researched,
      notes: f.notes || null,
      sheetText: {
        eligibleAwards: f.eligibleAwardsPerYear,
        applications: f.qualifiedApplicationsPerYear,
        yearsCovered: f.yearsCovered,
        awardsAbove100Units: f.awardsAbove100Units,
        maxFeasibleUnits: f.maxFeasibleUnits,
        agencyRetrieved,
      },
      // No component scores come from the sheet: every factor starts as unknown.
      scores: {},
    })
  })

  const researchedRows = records.filter((r) => r.researched)
  const states = new Set(records.map((r) => r.state))
  const stats = {
    rows: records.length,
    repairedRows,
    skippedRows,
    states: states.size,
    researchedStates: new Set(researchedRows.map((r) => r.state)).size,
    researchedRows: researchedRows.length,
  }
  return { records, warnings, stats }
}
