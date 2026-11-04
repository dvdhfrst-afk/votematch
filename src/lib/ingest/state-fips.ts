/**
 * state-fips.ts - canonical two-letter postal abbreviation -> FIPS (Federal
 * Information Processing Standards) numeric state code map for Havesay.
 *
 * Stored as two-character, zero-padded strings ('01', '49') because that is how
 * people.state_fips_primary is stored throughout the codebase (see
 * scripts/ingest-state-legislators.ts and discover-and-ingest.ts, which both
 * compare j.fips_state / state_fips_primary as zero-padded text).
 *
 * Covers all 50 states, the District of Columbia, and the five inhabited US
 * territories (American Samoa, Guam, Northern Mariana Islands, Puerto Rico, US
 * Virgin Islands). The territory codes (60-78) are the Census FIPS codes; some
 * congress-legislators rows (Resident Commissioners, Delegates) carry these.
 *
 * No em-dashes / en-dashes anywhere; acronyms spelled out on first use above.
 */

/** Two-letter postal abbreviation (uppercased) -> zero-padded FIPS code. */
export const STATE_ABBR_TO_FIPS: Readonly<Record<string, string>> = {
  AL: '01', AK: '02', AZ: '04', AR: '05', CA: '06', CO: '08', CT: '09',
  DE: '10', DC: '11', FL: '12', GA: '13', HI: '15', ID: '16', IL: '17',
  IN: '18', IA: '19', KS: '20', KY: '21', LA: '22', ME: '23', MD: '24',
  MA: '25', MI: '26', MN: '27', MS: '28', MO: '29', MT: '30', NE: '31',
  NV: '32', NH: '33', NJ: '34', NM: '35', NY: '36', NC: '37', ND: '38',
  OH: '39', OK: '40', OR: '41', PA: '42', RI: '44', SC: '45', SD: '46',
  TN: '47', TX: '48', UT: '49', VT: '50', VA: '51', WA: '53', WV: '54',
  WI: '55', WY: '56',
  // Inhabited US territories (Census FIPS codes).
  AS: '60', // American Samoa
  GU: '66', // Guam
  MP: '69', // Northern Mariana Islands
  PR: '72', // Puerto Rico
  VI: '78', // US Virgin Islands
};

/**
 * Map a two-letter postal abbreviation to its FIPS code, or null when unknown.
 * Case-insensitive and whitespace-tolerant on input.
 */
export function stateAbbrToFips(abbr: string | null | undefined): string | null {
  if (!abbr) return null;
  const key = abbr.trim().toUpperCase();
  return STATE_ABBR_TO_FIPS[key] ?? null;
}
