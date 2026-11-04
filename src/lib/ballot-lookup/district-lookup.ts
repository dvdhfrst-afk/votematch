/**
 * District-based ballot resolution (state-generic).
 *
 * When precinct lookup returns null (everywhere outside Utah's loaded
 * precincts), we resolve the ballot straight from the geocoded point:
 *
 *   1. Point-in-polygon against `political_districts` (Census TIGER geometry)
 *      via the `lookup_districts_for_point` RPC -> the containing
 *      us_congressional + state_house + state_senate (+ any other district
 *      types present) districts for that point.
 *   2. Match those districts to office rows by (district_type -> office_type
 *      slug, state_fips, numeric district number parsed from seat_designation),
 *      PLUS every statewide + federal-statewide office for that state
 *      (governor, US senator, secretary of state, ...). Only offices that have
 *      an upcoming election in the window are kept.
 *   3. Return the set of upcoming election IDs. The caller feeds those into the
 *      exact same `v_voter_races` / `v_voter_candidates` render path the
 *      precinct flow uses, so party-grouping, dedup, and data-quality badges
 *      all come for free.
 *
 * There is NO per-state logic here. The three districted office types are
 * discovered generically from `office_types.slug`; anything else at state /
 * federal level is treated as statewide. Any state whose shapes are loaded in
 * `political_districts` and whose offices carry live elections resolves.
 *
 * Dedup guard (requirement #3): a state can carry BOTH a compiled and an
 * authoritative office row for the same (level, office-type, district) with
 * live elections (e.g. Arizona's legacy compiled "House of Representatives
 * LD-N" rows alongside authoritative per-seat rows). We dedupe those to a
 * single election per (level, office-type-slug, district-number, date, type)
 * so the ballot never renders the race twice, preferring the authoritative
 * tier when both carry candidates. (In the current AZ data the authoritative
 * per-seat house rows have NO elections, so only the compiled LD-N rows
 * surface anyway; the guard is defensive and generic, not AZ-specific.)
 */
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Cache-busting version for the address-keyed ballot cache (see
 * `loadBallotForAddress` in src/app/ballot/page.tsx). It lives HERE, next to
 * the resolver, on purpose: the resolver's output shape is what the cache
 * stores, so any change to what `resolveDistrictBallotElectionIds` returns
 * (new election-selection logic, added/removed races, changed dedup) can leave
 * an OLD cached payload served for up to the 600s TTL. Bumping this constant
 * forces every address key to miss and recompute.
 *
 * Bump this whenever the resolver's selection/dedup logic changes. History:
 *   v1 -> v2 (2026-07): "nearest upcoming election" collapse (primary-over-
 *            general) landed in the resolver; a v1 cache could still serve the
 *            pre-collapse double-race payload, so the key had to change.
 */
export const BALLOT_CACHE_VERSION = 'v2';

/** One district polygon that contains the voter's point. */
export interface ContainingDistrict {
  district_type: string; // 'us_congressional' | 'state_house' | 'state_senate' | 'county' | ...
  district_number: string; // as stored, may be zero-padded ('05', '014')
  district_name: string | null;
  state_fips: string | null;
}

/**
 * Map from a `political_districts.district_type` to the `office_types.slug`
 * that represents the elected office for that district. State-generic. Add a
 * row here only when a new district-type layer is loaded that maps to an
 * office type; unknown district types simply don't contribute offices (they're
 * still returned to the caller for display/debug).
 */
const DISTRICT_TYPE_TO_OFFICE_SLUG: Record<string, string> = {
  us_congressional: 'us_representative',
  state_house: 'state_representative',
  state_senate: 'state_senator',
};

/** The office-type slugs that are districted (map to a political_districts layer). */
const DISTRICTED_OFFICE_SLUGS = new Set(
  Object.values(DISTRICT_TYPE_TO_OFFICE_SLUG),
);

/** Strip leading zeros / non-digits so '05' and '5' and 'District 5' compare equal. */
export function numericDistrict(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;
  const n = parseInt(digits, 10);
  return Number.isFinite(n) ? String(n) : null;
}

/**
 * Point-in-polygon: return every `political_districts` row containing the
 * given lat/lng. Uses the `lookup_districts_for_point` RPC (PostGIS
 * ST_Contains behind a SQL function, mirroring `lookup_precinct`).
 *
 * Returns [] on RPC error (e.g. the migration hasn't been applied yet) so the
 * caller degrades to an honest "no coverage" state rather than crashing.
 */
export async function lookupDistrictsForPoint(
  lat: number,
  lng: number,
  supabase: SupabaseClient,
): Promise<ContainingDistrict[]> {
  try {
    const { data, error } = await supabase.rpc('lookup_districts_for_point', {
      p_lng: lng,
      p_lat: lat,
    });
    if (error || !data) return [];
    return (data as ContainingDistrict[]).filter((d) => d && d.district_type);
  } catch {
    return [];
  }
}

/** A live office matched to the voter, with its upcoming election. */
export interface MatchedElection {
  office_id: string;
  office_slug: string | null;
  level: string;
  tier: string | null; // meta.data_quality_tier
  district_number: string | null; // numeric, null for statewide
  election_id: string;
  election_date: string;
  election_type: string;
  /** Number of candidacies on THIS election (used to break office duplicates). */
  candidacyCount: number;
}

/**
 * Given the containing districts, resolve the set of UPCOMING election IDs the
 * voter should see: districted offices whose (type, number) matches a
 * containing district, PLUS every statewide/federal-statewide office for the
 * state. Application-side SELECTs only (no new DB function beyond the PIP RPC).
 *
 * `todayIso` is the inclusive lower bound (YYYY-MM-DD) for election_date so the
 * current cycle's upcoming primary + general both surface; past contests drop.
 */
export async function resolveElectionIdsForDistricts(
  districts: ContainingDistrict[],
  supabase: SupabaseClient,
  opts: { todayIso?: string } = {},
): Promise<{ electionIds: string[]; stateFips: string | null; matched: MatchedElection[] }> {
  const stateFips =
    districts.map((d) => d.state_fips).find((f): f is string => !!f) ?? null;
  if (!stateFips) return { electionIds: [], stateFips: null, matched: [] };

  const todayIso = opts.todayIso ?? new Date().toISOString().slice(0, 10);

  // Build the set of (office-slug, numeric-district) pairs the voter is in.
  const districtedWanted = new Set<string>(); // `${slug}:${numericDistrict}`
  for (const d of districts) {
    const slug = DISTRICT_TYPE_TO_OFFICE_SLUG[d.district_type];
    const num = numericDistrict(d.district_number);
    if (slug && num) districtedWanted.add(`${slug}:${num}`);
  }

  // Pull every state+federal office in the state that has an upcoming election,
  // with its office_type slug and tier. One round-trip; then filter in JS to
  // (a) statewide offices and (b) districted offices matching the voter's set.
  //
  // We select the nested elections so we can see every upcoming election row
  // per office. Note: we do NOT keep both a primary and a later general for the
  // same seat — the nearest-upcoming collapse below reduces each seat to one
  // election so the ballot never renders the seat twice (once with candidates,
  // once as an empty general card).
  const { data, error } = await supabase
    .from('offices')
    .select(
      `
      id,
      level,
      seat_designation,
      meta,
      office_type:office_types ( slug ),
      jurisdiction:jurisdictions!jurisdiction_id!inner ( fips_state ),
      elections ( id, election_date, election_type, candidacies ( count ) )
    `,
    )
    .eq('jurisdiction.fips_state', stateFips)
    .in('level', ['state', 'federal'])
    .eq('is_active', true);

  if (error || !data) return { electionIds: [], stateFips, matched: [] };

  type OfficeRow = {
    id: string;
    level: string;
    seat_designation: string | null;
    meta: { data_quality_tier?: string } | null;
    office_type: { slug: string | null } | { slug: string | null }[] | null;
    elections: Array<{
      id: string;
      election_date: string;
      election_type: string;
      candidacies?: Array<{ count: number }> | { count: number } | null;
    }> | null;
  };

  const matched: MatchedElection[] = [];

  for (const row of data as unknown as OfficeRow[]) {
    // Supabase can return the embedded one-to-one relation as an object or a
    // single-element array depending on FK inference; normalize both.
    const otRaw = row.office_type;
    const slug = Array.isArray(otRaw) ? otRaw[0]?.slug ?? null : otRaw?.slug ?? null;
    const tier = row.meta?.data_quality_tier ?? null;

    // Is this office districted (one of the three types that map to a
    // political_districts layer)? If so, it only counts when its parsed
    // district number is one the voter is inside. Otherwise treat it as
    // statewide (governor, US senator, SoS, AG, treasurer, ...).
    const isDistrictedType = slug != null && DISTRICTED_OFFICE_SLUGS.has(slug);

    let districtNumber: string | null = null;
    if (isDistrictedType) {
      districtNumber = numericDistrict(row.seat_designation);
      // A districted office we can't parse a number from, or whose number the
      // voter isn't inside, is skipped.
      if (!districtNumber || !districtedWanted.has(`${slug}:${districtNumber}`)) {
        continue;
      }
    }

    const upcoming = (row.elections ?? []).filter(
      (e) => e.election_date && e.election_date.slice(0, 10) >= todayIso,
    );
    for (const e of upcoming) {
      // Supabase returns an aggregate embed as either [{count}] or {count}.
      const cRaw = e.candidacies;
      const candidacyCount = Array.isArray(cRaw)
        ? cRaw[0]?.count ?? 0
        : cRaw?.count ?? 0;
      matched.push({
        office_id: row.id,
        office_slug: slug,
        level: row.level,
        tier,
        district_number: districtNumber,
        election_id: e.id,
        election_date: e.election_date,
        election_type: e.election_type,
        candidacyCount,
      });
    }
  }

  // Dedup guard (#3): a state can carry MULTIPLE office rows for the same
  // (level, office-type, district) — e.g. Arizona's legacy compiled
  // "Arizona House of Representatives LD-N" offices alongside authoritative
  // per-seat "Seat N" rows. We collapse duplicates that cover the same
  // (level, office-slug, district-number, election_date, election_type) down to
  // ONE election so the race never renders twice.
  //
  // Preference order (per the 2026-06 AZ data audit): the compiled LD-N house
  // offices hold ALL the real elections + candidacies while the authoritative
  // "Seat N" offices are EMPTY (0 elections, 0 candidacies, no district
  // linkage). So we must NOT blanket-prefer authoritative — that would hide
  // every real candidate. Correct generic rule:
  //   1. prefer the office whose election actually HAS candidacies,
  //   2. then the one with MORE candidacies,
  //   3. tie-break by authoritative tier.
  // (In practice the empty Seat-N offices never even reach here because they
  // have no upcoming elections to filter in, but this rule is robust if they
  // ever did.)
  const tierRank = (t: string | null): number =>
    t === 'authoritative' ? 3 : t === 'compiled' ? 2 : t === 'default' ? 1 : 0;

  /** Higher is better. */
  function better(a: MatchedElection, b: MatchedElection): MatchedElection {
    const aHas = a.candidacyCount > 0 ? 1 : 0;
    const bHas = b.candidacyCount > 0 ? 1 : 0;
    if (aHas !== bHas) return aHas > bHas ? a : b;
    if (a.candidacyCount !== b.candidacyCount) {
      return a.candidacyCount > b.candidacyCount ? a : b;
    }
    if (tierRank(a.tier) !== tierRank(b.tier)) {
      return tierRank(a.tier) > tierRank(b.tier) ? a : b;
    }
    return a; // stable
  }

  const best = new Map<string, MatchedElection>();
  for (const m of matched) {
    const key = [
      m.level,
      m.office_slug ?? 'unknown',
      m.district_number ?? 'statewide',
      m.election_date.slice(0, 10),
      m.election_type,
    ].join('|');
    const cur = best.get(key);
    best.set(key, cur ? better(cur, m) : m);
  }

  // Nearest-upcoming collapse (AZ July-21 blocker fix). An office can carry
  // BOTH an upcoming primary (e.g. 2026-07-21) AND the later general
  // (2026-11-03). Emitting both election IDs makes the ballot render the seat
  // twice: a candidate-bearing primary card AND an empty "No candidates"
  // general card. Product rule: when an office has an upcoming primary and a
  // later general, surface ONLY the nearest upcoming election (the primary);
  // when only a general exists, surface it. The `todayIso` filter above already
  // dropped past elections, so the earliest remaining date per seat IS the
  // nearest upcoming contest. We collapse per (level, office-slug, district),
  // independent of election_type, keeping the earliest date.
  const nearestBySeat = new Map<string, MatchedElection>();
  for (const m of best.values()) {
    const seatKey = [
      m.level,
      m.office_slug ?? 'unknown',
      m.district_number ?? 'statewide',
    ].join('|');
    const cur = nearestBySeat.get(seatKey);
    if (
      !cur ||
      m.election_date < cur.election_date ||
      (m.election_date === cur.election_date && m.election_id < cur.election_id)
    ) {
      nearestBySeat.set(seatKey, m);
    }
  }

  const deduped = [...nearestBySeat.values()];
  const electionIds = [...new Set(deduped.map((m) => m.election_id))];
  return { electionIds, stateFips, matched: deduped };
}

/**
 * End-to-end district resolution from a geocoded point: PIP -> election IDs.
 * Returns empty electionIds when the point falls outside every loaded district
 * polygon, or when no matched office has an upcoming election.
 */
export async function resolveDistrictBallotElectionIds(
  lat: number,
  lng: number,
  supabase: SupabaseClient,
  opts: { todayIso?: string } = {},
): Promise<{
  electionIds: string[];
  stateFips: string | null;
  districts: ContainingDistrict[];
}> {
  const districts = await lookupDistrictsForPoint(lat, lng, supabase);
  if (districts.length === 0) {
    return { electionIds: [], stateFips: null, districts: [] };
  }
  const { electionIds, stateFips } = await resolveElectionIdsForDistricts(
    districts,
    supabase,
    opts,
  );
  return { electionIds, stateFips, districts };
}
