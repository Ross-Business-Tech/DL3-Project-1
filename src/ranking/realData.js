// The research team's data (draft, retrieved Nov 2026), put together for the ranking page.
// See src/ranking/data/README.md for where each file came from and what is known to be missing.
import awardHistoryCsv from './data/award_history.csv?raw'
import awardsCsv from './data/awards.csv?raw'
import inventoryCsv from './data/inventory.csv?raw'
import nationalFee from './data/national_fee_screen.json'
import partcCsv from './data/partc.csv?raw'
import programCapsCsv from './data/program_caps.csv?raw'
import siteFactsCsv from './data/site_facts.csv?raw'
import { buildRecords } from './buildData.js'
// The data pipeline's export (copied by: cd dl3-lihtc-model && python -m src.report.export_web --site)
import pipelineRulesCsv from './data/pipeline/rules.csv?raw'
import pipelineSourcesCsv from './data/pipeline/sources.csv?raw'
import pipelineCostCsv from './data/pipeline/cost_per_unit.csv?raw'
import pipelineMetroCsv from './data/pipeline/states_in_top_msas.csv?raw'
import pipelineAwardsCsv from './data/pipeline/awards.csv?raw'
import pipelineManifest from './data/pipeline/manifest.json'

// The AI research agents' state files (one JSON per state; see data/research/README.md).
const researchModules = import.meta.glob('./data/research/*.json', { eager: true })
const researchFiles = Object.entries(researchModules).map(([name, mod]) => ({ name, json: mod.default ?? mod }))

export const BUNDLED_PIPELINE_FILES = {
  rulesCsv: pipelineRulesCsv, sourcesCsv: pipelineSourcesCsv, costCsv: pipelineCostCsv, metroCsv: pipelineMetroCsv,
  awardsCsv: pipelineAwardsCsv, manifest: pipelineManifest,
}

/** The records with a given pipeline export (the bundled one, or a newer one fetched from the live site). */
export function buildRealData(pipelineFiles = BUNDLED_PIPELINE_FILES, inventory = inventoryCsv) {
  return buildRecords({ partcCsv, awardHistoryCsv, awardsCsv, siteFactsCsv, programCapsCsv, nationalFee, inventoryCsv: inventory, researchFiles, pipelineFiles })
}

export const REAL_DATA = buildRealData()
