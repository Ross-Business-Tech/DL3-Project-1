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

export const REAL_DATA = buildRecords({ partcCsv, awardHistoryCsv, awardsCsv, siteFactsCsv, programCapsCsv, nationalFee, inventoryCsv })
// REAL_DATA.inventory.researchNext lists the 50 states, best award-list coverage first.
