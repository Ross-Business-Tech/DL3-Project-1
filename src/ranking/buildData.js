// Puts the data files together: the state sheet, the yearly award table, the award-by-award list
// and the site facts, with the urban definition applied. Plain functions on text, so it runs in
// the browser and in tests alike.

import { SETTINGS, URBAN_DEFINITION } from './config.js'
import { largestNewConstruction, parseAwards, urbanLowerBounds } from './awardAudit.js'
import { attachAwardHistory, awardHistoryFromCsv } from './loadAwardHistory.js'
import { attachInventory, inventoryFromCsv, researchOrder } from './loadInventory.js'
import { applyFeeScreen } from './loadNationalFee.js'
import { recordsFromPartC } from './loadPartC.js'
import { applyResearch } from './loadResearch.js'
import { attachProgramCaps, programCapsFromCsv } from './loadProgramCaps.js'
import { siteFactsFromCsv } from './loadSiteFacts.js'
import { evaluateUrban, factsForAward } from './urban.js'
import { attachPipeline, pipelineFromFiles } from './loadPipeline.js'
import { applyPipelineFacts } from './pipelineFacts.js'

export function buildRecords({ partcCsv, awardHistoryCsv, awardsCsv, siteFactsCsv, programCapsCsv, nationalFee, inventoryCsv, researchFiles, pipelineFiles }, definition = URBAN_DEFINITION) {
  const sheet = recordsFromPartC(partcCsv)
  // Records researched in our own sheet: nothing below overwrites their values.
  const sheetDeep = new Set(sheet.records.filter((r) => r.researched && !r.screenOnly).map((r) => r.id))
  const history = awardHistoryFromCsv(awardHistoryCsv)
  const awards = parseAwards(awardsCsv)
  const siteFacts = siteFactsFromCsv(siteFactsCsv, definition)
  const programCaps = programCapsFromCsv(programCapsCsv ?? '')

  // For every state, pathway and year: how many awards above 100 units are CERTAINLY urban
  // new construction, judged from the award list and the site facts.
  const classify = (award) => evaluateUrban(factsForAward(award, siteFacts.facts), definition)
  const lower = urbanLowerBounds(awards.awards, classify)
  const rows = history.rows.map((row) => {
    const bound = lower.get(`${row.state}|${row.pathway}|${row.year}`)
    return bound ? { ...row, ...bound } : row
  })

  // The 50-state fee screen fills in states we have not researched (and never overwrites ones we have).
  const fee = nationalFee ? applyFeeScreen(sheet.records, nationalFee) : { records: sheet.records, warnings: [], stats: {}, comparison: [] }
  // Project size evidence: where the sheet does not know the largest feasible project, a 101+ unit
  // new-construction award in 2021-2025 shows the program allows one (guide 5D).
  const largest = largestNewConstruction(awards.awards, SETTINGS.scaleWindowYears)
  const sized = fee.records.map((r) => {
    if (typeof r.maxFeasibleUnits === 'number') return r
    const a = largest.get(`${r.state}|${r.pathway}`)
    if (!a || a.units < SETTINGS.minUnits) return r
    return { ...r, maxFeasibleUnits: a.units, unitsEvidence: `A ${a.units}-unit new-construction award (${a.project}, ${a.city}, ${a.year}) shows the program allows a project this size` }
  })
  const merged = attachAwardHistory(sized, rows)
  // The AI research agents' state files fill the remaining gaps (never our own sheet values).
  const research = applyResearch(merged.records, researchFiles ?? [])
  const withCaps = attachProgramCaps(research.records, programCaps.caps)
  // The scraping pipeline's inventory: where each state's documents are (found automatically, not verified).
  const inventory = inventoryFromCsv(inventoryCsv ?? '')
  // The data pipeline's export: approved rules, award rows, cost per unit, top-100 metros, document freshness.
  // Its reviewed facts fill gaps and replace the draft screen and AI research (pipelineFacts.js); our own
  // sheet research is never overwritten.
  const pipeline = pipelineFromFiles(pipelineFiles ?? {})
  const facts = applyPipelineFacts(withCaps.records, pipeline, { awardsCsv: pipelineFiles?.awardsCsv ?? '', sheetDeep })
  const records = attachPipeline(attachInventory(facts.records, inventory.byState), pipeline.byState)
  return {
    records,
    warnings: [...sheet.warnings, ...history.warnings, ...awards.warnings, ...siteFacts.warnings, ...programCaps.warnings, ...fee.warnings, ...merged.warnings, ...research.warnings, ...withCaps.warnings, ...inventory.warnings, ...pipeline.warnings],
    stats: {
      ...sheet.stats,
      awardHistoryRows: history.rows.length,
      awards: awards.awards.length,
      siteFactRows: siteFacts.facts.length,
      programCapRows: programCaps.caps.length,
      ...fee.stats,
      researchedByAgents: research.states.length,
      ...facts.stats,
    },
    research: { states: research.states, comparison: research.comparison },
    feeComparison: fee.comparison,
    pipelineComparison: facts.comparison,
    inventory: { stats: inventory.stats, researchNext: researchOrder(inventory.byState, records) },
    pipeline: { stats: pipeline.stats, generatedAt: pipeline.generatedAt, codeVersion: pipeline.codeVersion },
  }
}
