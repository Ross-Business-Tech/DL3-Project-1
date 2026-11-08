// The research team's data sheet (draft, retrieved Nov 8, 2026), loaded for the ranking page.
// See src/ranking/data/README.md for where it came from and what is known to be missing.
import partcCsv from './data/partc.csv?raw'
import { recordsFromPartC } from './loadPartC.js'

export const REAL_DATA = recordsFromPartC(partcCsv)
