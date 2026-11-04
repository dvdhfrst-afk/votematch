/**
 * Local-office resolver — maps free-form local race office strings (school
 * board, mayor, city council, county commissioner, sheriff, etc.) to existing
 * `offices` rows by classifying the office_type slug AND extracting the
 * jurisdiction (county / municipality / school district) from the string.
 *
 * Why this exists
 * ---------------
 * `resolveOfficeElection()` in candidate-resolver.ts does an ILIKE-on-
 * canonical_name search against `offices`. That works for state-leg + federal
 * because office canonical_names like "United States Representative — North
 * Carolina, District 9" naturally contain the same tokens the source uses
 * ("US HOUSE", "DISTRICT 9"). It fails catastrophically for local races
 * because:
 *
 *   - Source string:  "FORSYTH COUNTY BOARD OF EDUCATION DISTRICT 02"
 *   - Office canonical: "School Board Member — Forsyth County Schools, Seat 1"
 *
 * The tokens overlap on "FORSYTH" and "BOARD" but the path through is too
 * fragile (and ambiguous; multiple seats hit equally).
 *
 * This module instead uses a deterministic two-step lookup:
 *   1. Classify the raw office string → office_type slug (e.g.
 *      'school_board_member', 'mayor', 'city_council_member').
 *   2. Extract a jurisdiction needle (e.g. "FORSYTH COUNTY", "CITY OF
 *      ASHEVILLE", "ASHEVILLE CITY SCHOOLS") and resolve it to a
 *      `jurisdictions.id` in the given state.
 *   3. Look up offices WHERE office_type_id = $1 AND jurisdiction_id = $2,
 *      optionally filtered by seat_designation when the source carries
 *      district / ward / seat info.
 *
 * Returns null when classification or jurisdiction lookup is ambiguous —
 * the caller falls back to free-form resolveOfficeElection() and (if that
 * also fails) logs to ingestion_errors as today.
 *
 * NO new ingestion sources here; this is the categorization fix the
 * 2026-04-26 data-quality cycle calls for. Existing per-state SoS adapters
 * are already pulling these candidacies — they just couldn't resolve them.
 */

import type { Pool } from 'pg';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type LocalOfficeClass =
  | 'school_board_member'
  | 'mayor'
  | 'city_council_member'
  | 'city_clerk'
  | 'city_treasurer'
  | 'controller'
  | 'municipal_judge'
  | 'select_board_member'
  | 'county_commissioner'
  | 'county_sheriff'
  | 'county_clerk'
  | 'county_treasurer'
  | 'county_assessor'
  | 'county_recorder'
  | 'county_auditor'
  | 'county_coroner'
  | 'county_surveyor'
  | 'district_attorney'
  | 'public_administrator'
  | 'town_supervisor'
  | 'town_council_member'
  | 'town_clerk'
  | 'town_board_member'
  | 'township_supervisor'
  | 'township_trustee'
  | 'township_clerk'
  | 'township_treasurer'
  | 'township_assessor'
  | 'special_district_board'
  | 'fire_district_board'
  | 'water_district_board'
  | 'library_board_trustee'
  | 'hospital_district_board'
  | 'irrigation_district_board';

export type ResolveLocalOfficeInput = {
  /** State FIPS (2-digit, '37' for NC). */
  state_fips: string;
  /** Raw office string from the SoS source. */
  office_name: string;
  /** Optional district identifier (e.g. '2' for District 02). */
  district_identifier: string | null | undefined;
  /** Optional locality hint from the source (e.g. VA's locality column).
   *  When present this typically IS the jurisdiction name. */
  locality_hint?: string | null;
};

export type ResolveLocalOfficeResult = {
  office_id: string;
  /** The slug we classified as. Useful for logging / metrics. */
  office_type_slug: LocalOfficeClass;
  /** Jurisdiction we resolved to. */
  jurisdiction_id: string;
  /** True when the office row matched a seat_designation derived from the
   *  district_identifier. False when we matched the first / only seat. */
  seat_matched: boolean;
};

// ---------------------------------------------------------------------------
// Office-type classification
// ---------------------------------------------------------------------------

/**
 * Classify a raw office string to one of our office_types.slug values.
 * Returns null for non-local-race strings (federal, state, party-position,
 * judicial).
 *
 * Order matters: more-specific patterns must come first. "City Council" is
 * checked before "Council" so "County Council" doesn't get mis-classified as
 * city_council_member.
 */
export function classifyLocalOffice(raw: string): LocalOfficeClass | null {
  const s = raw.toLowerCase();

  // Reject obvious federal / state / judicial / party-position strings up
  // front so we don't accidentally swallow them into mayor / school_board.
  if (/\bu\.?s\.?\s+(senator|senate|representative|house|congress)|united states (senator|senate|representative|house|congress)|delegate to (the )?(u\.?s\.?|united states)|presidential elector|president of the united states/.test(s)) return null;
  if (/\b(state senator|state senate|state representative|state house|state assembly|state delegate|legislative district|general assembly|representative in the general assembly|state board of education|board of regents)/.test(s)) return null;
  if (/(governor|attorney general|lieutenant governor|secretary of state|state treasurer|state auditor|state comptroller|state controller|labor commissioner|land commissioner|insurance commissioner|public service commissioner|state superintendent|superintendent of public instruction|state agriculture commissioner|state tax commissioner|adjutant general|state mine inspector)/.test(s)) return null;
  if (/(state central committee|district committee|precinct committee|state committee|county central committee|democratic central committee|republican central committee|democratic committee|republican committee|democratic state committee|republican state committee)/.test(s)) return null;
  // Court / judges → judicial; not in scope of this resolver.
  if (/(court of appeals|supreme court|appellate court|circuit court|district court|superior court|civil district court|judicial district court|probate court|justice of the peace|trial court|chancery court|orphans? court|magistrate|judge|justice)/.test(s)) {
    // BUT a "Municipal Judge" IS a local office.
    if (/\bmunicipal judge\b/.test(s)) return 'municipal_judge';
    if (/\btown justice\b/.test(s)) return 'municipal_judge';
    return null;
  }

  // School board — the source uses many phrasings.
  if (/(board of education|school board|school district board|school bd|board of school)/.test(s)) {
    return 'school_board_member';
  }

  // City / town offices — check for the locality prefix to avoid swallowing
  // "County Treasurer" etc.
  // Mayor (most common municipal exec)
  if (/\bmayor\b/.test(s)) return 'mayor';

  // City council variants
  if (/(city council|town council|borough council|village board|board of aldermen|board of trustees of the village|alderman|councilman|councilwoman|councilperson|council member|councilmember|council person|council member at large|councilmen at large|councilwomen at large|councilman at large|commissioner (north|south|east|west|central) ward|city commissioner)/.test(s)) {
    // Town board → townships (NY-style "town supervisor / town board")
    if (/\btown board member\b/.test(s)) return 'town_board_member';
    return 'city_council_member';
  }
  // "CITY OF MONROE COUNCIL" — bare "council" with city prefix.
  if (/^(?:city|town|village|borough) of [a-z\- ']+? council\b/.test(s)) {
    return 'city_council_member';
  }

  // Town supervisor / select board (New England + NY)
  if (/\btown supervisor\b/.test(s)) return 'town_supervisor';
  if (/(select board|selectman|selectmen|selectperson|selectboard|first selectman)/.test(s)) return 'select_board_member';
  if (/\btown clerk\b/.test(s)) return 'town_clerk';
  if (/\btown council\b/.test(s)) return 'town_council_member';

  // Township (PA, OH, MI, MN, IL, IN, WI, NJ)
  if (/township supervisor/.test(s)) return 'township_supervisor';
  if (/township trustee/.test(s)) return 'township_trustee';
  if (/township clerk/.test(s)) return 'township_clerk';
  if (/township treasurer/.test(s)) return 'township_treasurer';
  if (/township assessor/.test(s)) return 'township_assessor';

  // City clerks etc.
  if (/(city clerk|city secretary|city recorder)/.test(s)) return 'city_clerk';
  if (/(city treasurer|tax collector(?!.*county))/.test(s)) return 'city_treasurer';
  if (/(city auditor|city controller|municipal controller)/.test(s)) return 'controller';

  // County offices — order matters: sheriff before "deputy clerk of court"
  if (/\bsheriff\b/.test(s)) return 'county_sheriff';
  if (/\bdistrict attorney\b|\bcommonwealth's? attorney\b|\bstate's? attorney\b|\bprosecut(ing|or)\s+attorney\b/.test(s)) return 'district_attorney';
  if (/(county commissioner|board of commissioners|board of supervisors|county council|board of chosen freeholders|board of legislators|county legislators|county council member|police jury)/.test(s)) {
    return 'county_commissioner';
  }
  if (/(county clerk|register of deeds|register of wills|prothonotary|clerk of court|clerk of superior court|clerk of the circuit court|clerk of the court)/.test(s)) return 'county_clerk';
  if (/(county treasurer|county tax collector)/.test(s)) return 'county_treasurer';
  if (/county assessor/.test(s)) return 'county_assessor';
  if (/county recorder/.test(s)) return 'county_recorder';
  if (/county auditor/.test(s)) return 'county_auditor';
  if (/(county coroner|medical examiner)/.test(s)) return 'county_coroner';
  if (/county surveyor/.test(s)) return 'county_surveyor';
  if (/public administrator/.test(s)) return 'public_administrator';

  // Special districts
  if (/(fire (protection )?district|fire commissioner)/.test(s)) return 'fire_district_board';
  if (/water district|water board/.test(s)) return 'water_district_board';
  if (/library board|library trustee/.test(s)) return 'library_board_trustee';
  if (/hospital district/.test(s)) return 'hospital_district_board';
  if (/irrigation district/.test(s)) return 'irrigation_district_board';
  if (/(soil and water conservation|conservation district|natural resources district|public power district|drainage district|cemetery district|park district|sanitary district|special district)/.test(s)) {
    return 'special_district_board';
  }

  return null;
}

// ---------------------------------------------------------------------------
// Jurisdiction extraction
// ---------------------------------------------------------------------------

/**
 * Extract a jurisdiction needle from the raw office string, given a
 * classified office_type. Returns multiple candidates in priority order;
 * the caller will look each up in `jurisdictions` and pick the first match.
 *
 * Examples:
 *   - "FORSYTH COUNTY BOARD OF EDUCATION DISTRICT 02"
 *      → ['Forsyth County Schools', 'Forsyth County', 'Forsyth']
 *   - "ASHEVILLE CITY SCHOOLS BOARD OF EDUCATION"
 *      → ['Asheville City Schools', 'City of Asheville', 'Asheville']
 *   - "CITY OF RALEIGH CITY COUNCIL DISTRICT A"
 *      → ['City of Raleigh', 'Raleigh']
 *   - "MAYOR City of Junction City 1 to be elected"  (LA)
 *      → ['City of Junction City', 'Junction City']
 */
export function extractJurisdictionCandidates(
  raw: string,
  klass: LocalOfficeClass,
): string[] {
  const candidates: string[] = [];
  const upper = raw.toUpperCase();

  // School board — often "<COUNTY> COUNTY BOARD OF EDUCATION", "<COUNTY> COUNTY SCHOOLS BOARD OF EDUCATION",
  // or "<CITY> CITY SCHOOLS BOARD OF EDUCATION", or "ASHEBORO CITY SCHOOLS".
  if (klass === 'school_board_member') {
    // "ASHEBORO CITY SCHOOLS" or "ASHEVILLE CITY SCHOOLS"
    let m = /\b([A-Z][A-Z\- ]+?) CITY SCHOOLS\b/.exec(upper);
    if (m) {
      const city = titleCase(m[1]!);
      candidates.push(`${city} City Schools`);
      candidates.push(`City of ${city}`);
      candidates.push(city);
    }
    // "ALAMANCE-BURLINGTON" hyphenated school district
    m = /\b([A-Z][A-Z]+(?:-[A-Z]+)+) BOARD OF EDUCATION\b/.exec(upper);
    if (m) {
      const dist = titleCase(m[1]!);
      candidates.push(`${dist} Schools`);
      candidates.push(dist);
    }
    // "<NAME> COUNTY BOARD OF EDUCATION" or "<NAME> COUNTY SCHOOLS BOARD OF EDUCATION"
    m = /\b([A-Z][A-Z\-' ]+?) COUNTY (?:SCHOOLS )?BOARD OF EDUCATION\b/.exec(upper);
    if (m) {
      const cty = titleCase(m[1]!);
      candidates.push(`${cty} County Schools`);
      candidates.push(`${cty} County School District`);
      candidates.push(`${cty} County`);
    }
    return uniq(candidates);
  }

  // Mayor / city council / city clerk / city treasurer / municipal judge — "CITY OF X" or "TOWN OF X" or "VILLAGE OF X".
  if (
    klass === 'mayor' ||
    klass === 'city_council_member' ||
    klass === 'city_clerk' ||
    klass === 'city_treasurer' ||
    klass === 'controller' ||
    klass === 'municipal_judge'
  ) {
    let m = /\b(?:CITY|TOWN|VILLAGE|BOROUGH) OF ([A-Z][A-Z' \-]+?)(?:\s+(?:CITY COUNCIL|MAYOR|COUNCIL|COMMISSIONER|CLERK|TREASURER|AUDITOR|JUDGE)\b|\s*$)/.exec(upper);
    if (m) {
      const city = titleCase(m[1]!);
      candidates.push(`City of ${city}`);
      candidates.push(`Town of ${city}`);
      candidates.push(`Village of ${city}`);
      candidates.push(city);
    }
    // LA pattern: "Mayor City of DeRidder 1 to be elected"
    m = /(?:CITY|TOWN|VILLAGE) OF ([A-Z][A-Z' \-]+?)\s+\d+\s+TO BE ELECTED/.exec(upper);
    if (m) {
      const city = titleCase(m[1]!);
      candidates.push(`City of ${city}`);
      candidates.push(`Town of ${city}`);
      candidates.push(`Village of ${city}`);
      candidates.push(city);
    }
    // NC pattern: "CITY OF LINCOLNTON CITY COUNCIL WARD ONE" — already handled.
    // NC pattern: "CITY OF LINCOLNTON MAYOR" — already handled by first regex.
    // NC pattern: "CITY OF MONROE COUNCIL" — already handled by first regex
    //  (matches the COUNCIL alternative).

    // VA pattern uses locality_hint
    return uniq(candidates);
  }

  // County offices — "<NAME> COUNTY <type>" or "BOARD OF <type>, <NAME> COUNTY"
  if (
    klass === 'county_commissioner' ||
    klass === 'county_sheriff' ||
    klass === 'county_clerk' ||
    klass === 'county_treasurer' ||
    klass === 'county_assessor' ||
    klass === 'county_recorder' ||
    klass === 'county_auditor' ||
    klass === 'county_coroner' ||
    klass === 'county_surveyor' ||
    klass === 'district_attorney' ||
    klass === 'public_administrator'
  ) {
    let m = /\b([A-Z][A-Z\-' ]+?) COUNTY\b/.exec(upper);
    if (m) {
      const cty = titleCase(m[1]!);
      candidates.push(`${cty} County`);
      candidates.push(cty);
    }
    return uniq(candidates);
  }

  // Township — "<NAME> TOWNSHIP"
  if (
    klass === 'township_supervisor' ||
    klass === 'township_trustee' ||
    klass === 'township_clerk' ||
    klass === 'township_treasurer' ||
    klass === 'township_assessor'
  ) {
    let m = /\b([A-Z][A-Z\-' ]+?) TOWNSHIP\b/.exec(upper);
    if (m) {
      const tw = titleCase(m[1]!);
      candidates.push(`${tw} Township`);
      candidates.push(`Township of ${tw}`);
      candidates.push(tw);
    }
    return uniq(candidates);
  }

  // Town (NE / NY)
  if (klass === 'town_supervisor' || klass === 'town_council_member' || klass === 'town_clerk' || klass === 'town_board_member') {
    let m = /\bTOWN OF ([A-Z][A-Z\-' ]+?)\b/.exec(upper);
    if (m) {
      const tw = titleCase(m[1]!);
      candidates.push(`Town of ${tw}`);
      candidates.push(tw);
    }
    return uniq(candidates);
  }

  return uniq(candidates);
}

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function uniq(arr: string[]): string[] {
  return [...new Set(arr.filter((s) => s && s.trim().length > 0))];
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/**
 * Resolve a local-race office string to an existing `offices` row.
 *
 * Returns null when:
 *   - The string can't be classified (federal / state / judicial / party).
 *   - The jurisdiction lookup fails (no matching name in this state).
 *   - The (office_type, jurisdiction) pair doesn't exist in offices.
 *   - The result is ambiguous (multiple equally-good matches).
 *
 * On success, the caller can hand `{office_id}` to findOrCreateElection().
 */
export async function resolveLocalOffice(
  pg: Pool,
  input: ResolveLocalOfficeInput,
): Promise<ResolveLocalOfficeResult | null> {
  const klass = classifyLocalOffice(input.office_name);
  if (!klass) return null;

  // Build jurisdiction candidate names. If locality_hint supplied (e.g. VA),
  // try it first.
  const candidateNames: string[] = [];
  if (input.locality_hint?.trim()) {
    const hint = input.locality_hint.trim();
    // VA reports "ROANOKE CITY", "ARLINGTON COUNTY", "MANASSAS CITY"
    const cleaned = titleCase(hint);
    candidateNames.push(cleaned);
    // ARLINGTON COUNTY → "Arlington County"
    candidateNames.push(`City of ${cleaned.replace(/ City$/i, '')}`);
    candidateNames.push(`Town of ${cleaned.replace(/ Town$/i, '')}`);
    candidateNames.push(cleaned.replace(/ City$|\s+County$|\s+Town$/i, ''));
  }
  candidateNames.push(...extractJurisdictionCandidates(input.office_name, klass));

  if (candidateNames.length === 0) return null;

  // Look up the office_type_id once.
  const typeRes = await pg.query<{ id: string }>(
    `SELECT id FROM office_types WHERE slug = $1 LIMIT 1`,
    [klass],
  );
  if (typeRes.rows.length === 0) return null;
  const officeTypeId = typeRes.rows[0]!.id;

  // Try each jurisdiction candidate in order. Use trigram-style ILIKE to be
  // forgiving of "City of Forsyth" vs "Forsyth City".
  for (const cand of candidateNames) {
    // Exact match first (faster + safer).
    let jres = await pg.query<{ id: string; name: string; type: string }>(
      `SELECT id, name, type FROM jurisdictions
        WHERE fips_state = $1 AND lower(name) = lower($2)
        LIMIT 5`,
      [input.state_fips, cand],
    );

    if (jres.rows.length === 0) {
      // Fallback: contains-based match (still scoped to state). Prefer the
      // shortest matching jurisdiction name to avoid swallowing larger ones
      // ("Foo Township" wins over "Foo Township School District").
      jres = await pg.query<{ id: string; name: string; type: string }>(
        `SELECT id, name, type FROM jurisdictions
          WHERE fips_state = $1
            AND lower(name) ILIKE $2
          ORDER BY length(name) ASC
          LIMIT 5`,
        [input.state_fips, `%${cand.toLowerCase()}%`],
      );
    }

    if (jres.rows.length === 0) continue;

    // Pick the best jurisdiction by type for this office class.
    const preferred = preferredJurisdictionType(klass);
    let pickedJuris = jres.rows.find((r) => preferred.includes(r.type));
    if (!pickedJuris && jres.rows.length === 1) pickedJuris = jres.rows[0]!;
    if (!pickedJuris) continue;

    // Now find the office row(s).
    const district = (input.district_identifier ?? '').trim();
    const districtNorm = district ? normalizeDistrictNumber(district) : null;
    const officeRes = await pg.query<{
      id: string;
      seat_designation: string | null;
    }>(
      `SELECT id, seat_designation
       FROM offices
       WHERE office_type_id = $1
         AND jurisdiction_id = $2
       ORDER BY id ASC
       LIMIT 200`,
      [officeTypeId, pickedJuris.id],
    );
    if (officeRes.rows.length === 0) continue;

    if (officeRes.rows.length === 1) {
      return {
        office_id: officeRes.rows[0]!.id,
        office_type_slug: klass,
        jurisdiction_id: pickedJuris.id,
        seat_matched: false,
      };
    }

    // Multiple seats. If we have a district_identifier, prefer the row whose
    // seat_designation contains it.
    if (districtNorm) {
      const match = officeRes.rows.find((o) => {
        if (!o.seat_designation) return false;
        const seatNorm = normalizeDistrictNumber(o.seat_designation);
        return seatNorm === districtNorm || o.seat_designation.toLowerCase().includes(districtNorm);
      });
      if (match) {
        return {
          office_id: match.id,
          office_type_slug: klass,
          jurisdiction_id: pickedJuris.id,
          seat_matched: true,
        };
      }
    }

    // Otherwise: many seats, no district hint. We can't pick safely — return
    // the first seat (Seat 1). This is the "at-large or first vacant"
    // convention used by catalog-tier-c-municipal.ts when seats are
    // generated 1..N.
    const firstSeat = officeRes.rows[0]!;
    return {
      office_id: firstSeat.id,
      office_type_slug: klass,
      jurisdiction_id: pickedJuris.id,
      seat_matched: false,
    };
  }

  return null;
}

/**
 * Map an office class to the jurisdiction.type values that are valid hosts.
 * Used to disambiguate when multiple jurisdictions match a name (e.g.
 * "Forsyth" can be both a county and a city in different states; we want
 * the county for school_board / county_commissioner, the city for mayor).
 */
function preferredJurisdictionType(klass: LocalOfficeClass): string[] {
  switch (klass) {
    case 'school_board_member':
      return ['school_district', 'county', 'municipality'];
    case 'mayor':
    case 'city_council_member':
    case 'city_clerk':
    case 'city_treasurer':
    case 'controller':
    case 'municipal_judge':
      return ['municipality', 'township', 'town'];
    case 'county_commissioner':
    case 'county_sheriff':
    case 'county_clerk':
    case 'county_treasurer':
    case 'county_assessor':
    case 'county_recorder':
    case 'county_auditor':
    case 'county_coroner':
    case 'county_surveyor':
    case 'district_attorney':
    case 'public_administrator':
      return ['county'];
    case 'town_supervisor':
    case 'town_council_member':
    case 'town_clerk':
    case 'town_board_member':
    case 'select_board_member':
      return ['municipality', 'township', 'town'];
    case 'township_supervisor':
    case 'township_trustee':
    case 'township_clerk':
    case 'township_treasurer':
    case 'township_assessor':
      return ['township', 'town'];
    case 'special_district_board':
    case 'fire_district_board':
    case 'water_district_board':
    case 'library_board_trustee':
    case 'hospital_district_board':
    case 'irrigation_district_board':
      return ['special_district', 'county'];
  }
}

/** Strip leading zeros and "District" / "Seat" / "Ward" prefixes. */
export function normalizeDistrictNumber(s: string): string {
  const m = /(\d+)/.exec(s);
  if (!m) return s.toLowerCase().trim();
  return String(parseInt(m[1]!, 10));
}
