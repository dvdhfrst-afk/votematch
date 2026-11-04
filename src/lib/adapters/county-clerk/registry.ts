/**
 * County-clerk adapter registry.
 *
 * Mirrors the structure of `state-sos/candidacy-registry.ts` but keys on
 * `${USPS_STATE}-${FIPS_COUNTY_3DIGIT}` so adapters are uniquely addressable
 * across the ~3,143 US counties.
 *
 * Examples:
 *   'TX-201'  Harris County, TX
 *   'CA-037'  Los Angeles County, CA
 *   'IL-031'  Cook County, IL
 *   'AZ-013'  Maricopa County, AZ
 *   'NY-061'  New York County, NY
 *
 * Empty for now — no concrete county adapter has been wired up yet. First
 * fills should be the highest-ballot-impact counties (see README.md).
 *
 * Inclusion policy: the same "register every state, ship empty stubs if
 * blocked" rule from the candidacy registry applies once we start filling
 * this in, with one wrinkle — counties without an online portal should NOT
 * be registered as no-op adapters because that hides a real coverage gap.
 * Better to fail-fast and let the office_ballot_coverage view show the
 * county as unsourced.
 */

import type { CountyClerkAdapter } from './base';

/** Two-digit USPS code + 3-digit county FIPS, joined with `-`. */
export type CountyClerkKey = string;

/**
 * Registered concrete county-clerk adapters. Keyed on
 * `${USPS_STATE}-${FIPS_COUNTY_3DIGIT}`.
 *
 * Currently empty — see the README for the priority order to fill.
 */
export const COUNTY_CLERK_ADAPTERS: Record<
  CountyClerkKey,
  () => CountyClerkAdapter
> = {};

/**
 * Look up a concrete county-clerk adapter by state + county FIPS.
 * Returns `null` when nothing is registered for that pair — callers should
 * treat that as "no filing-direct coverage available; fall back to SoS".
 */
export function getCountyClerkAdapter(
  state: string,
  fips_county: string,
): CountyClerkAdapter | null {
  const key = `${state.toUpperCase()}-${fips_county.padStart(3, '0')}`;
  const factory = COUNTY_CLERK_ADAPTERS[key];
  return factory ? factory() : null;
}

/** All registered county-clerk adapter keys, for diagnostics + audit views. */
export function listCountyClerkAdapterKeys(): CountyClerkKey[] {
  return Object.keys(COUNTY_CLERK_ADAPTERS).sort();
}
