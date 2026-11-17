// Applies the urban definition (config.js URBAN_DEFINITION) to one project site.
//
// Three tests, ALL must pass (guide 6B):
//   1. Census urban area   the site is inside an Urbanized Area (50,000+) under the 2020 boundaries
//   2. Place               inside the city limits of a principal city, OR inside a DL3-approved
//                          neighborhood or transit corridor
//   3. Built environment   the tract meets the density floor, OR fixed-route transit is within 1/2 mile
//
// Each test answers 'pass', 'fail' or 'unknown'. The site is:
//   'urban'      all three pass
//   'not-urban'  any test fails (nothing else can rescue it)
//   'unknown'    no test fails, but at least one cannot be answered yet

import { URBAN_DEFINITION } from './config.js'

const isNum = (x) => typeof x === 'number' && Number.isFinite(x)
const yn = (v) => (v === true ? 'pass' : v === false ? 'fail' : 'unknown')

/**
 * facts: { inUrbanizedArea, principalCity, inApprovedArea, tractDensity, nearFixedRouteTransit }
 *   booleans use true / false / null (null = unknown); tractDensity is residents per square mile.
 */
export function evaluateUrban(facts = {}, definition = URBAN_DEFINITION) {
  const tests = []

  tests.push({
    key: 'urbanArea',
    label: `Inside a Census Urbanized Area (${definition.boundaryVintage} boundaries)`,
    status: yn(facts.inUrbanizedArea ?? null),
  })

  // Pass if either route is confirmed; fail only if both are ruled out.
  const place = facts.principalCity === true || facts.inApprovedArea === true
    ? 'pass'
    : facts.principalCity === false && facts.inApprovedArea === false ? 'fail' : 'unknown'
  tests.push({ key: 'place', label: 'In a principal city, or a DL3-approved neighborhood or corridor', status: place })

  const dense = isNum(facts.tractDensity) ? facts.tractDensity >= definition.tractDensityFloorPerSqMile : null
  const built = dense === true || facts.nearFixedRouteTransit === true
    ? 'pass'
    : dense === false && facts.nearFixedRouteTransit === false ? 'fail' : 'unknown'
  tests.push({
    key: 'builtEnvironment',
    label: `Tract density of ${definition.tractDensityFloorPerSqMile.toLocaleString('en-US')}+ per square mile, or fixed-route transit within ${definition.transitDistanceMiles} mile`,
    status: built,
  })

  const status = tests.some((t) => t.status === 'fail') ? 'not-urban' : tests.every((t) => t.status === 'pass') ? 'urban' : 'unknown'
  return { status, tests }
}

/** Facts for one award: the city-wide row (project "*") with any project-specific row on top. */
export function factsForAward(award, siteFacts) {
  const rows = siteFacts.filter((f) => f.state === award.state && f.city.toLowerCase() === (award.city ?? '').toLowerCase())
  const merged = {}
  for (const row of [...rows.filter((f) => f.project === '*'), ...rows.filter((f) => f.project.toLowerCase() === award.project.toLowerCase())]) {
    for (const [k, v] of Object.entries(row.facts)) if (v !== null && v !== undefined) merged[k] = v
  }
  return merged
}
