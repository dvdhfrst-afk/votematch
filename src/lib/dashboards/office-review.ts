/**
 * Office-review dashboard — source-of-truth view for the governing-bodies
 * + offices catalog. Read-only v1; reviewer workflow features come in v2.
 *
 * Surfaces:
 *   - Aggregate per chamber_type (count of bodies, count of seats, % auth)
 *   - Per-state sanity (state Senate / State House size vs expected)
 *   - Body matrix: filterable + sortable; mismatch warnings when
 *     body.size_total != count of attached offices
 *   - Standalone offices (governing_body_id IS NULL) by office_type
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export type ChamberType =
  | "legislative_upper" | "legislative_lower" | "legislative_unicameral"
  | "city_council" | "city_commission" | "town_council" | "township_board"
  | "selectboard" | "county_commission" | "county_council" | "school_board"
  | "special_district_board" | "state_supreme_court" | "appellate_court"
  | "municipal_court" | "state_board_of_education"
  | "public_service_commission" | "state_board_of_regents" | "other";

export interface BodyRow {
  id: string;
  canonical_name: string;
  short_name: string | null;
  chamber_type: ChamberType;
  jurisdiction_id: string;
  jurisdiction_name: string;
  jurisdiction_type: string;
  fips_state: string | null;
  size_total: number;
  size_authoritative: boolean;
  /** body_structure_verified: the engine's "we fetched a primary source and
   *  extracted body structure" signal (write.ts). Distinct from the stricter
   *  size_authoritative self-attestation. Surfaced so daily verification work
   *  is visible even when the agent conservatively leaves authoritative=false. */
  body_structure_verified: boolean;
  attached_offices_count: number;
  mismatch: boolean;                  // size_total !== attached_offices_count
  has_description: boolean;
  has_powers_summary: boolean;
  citation_count: number;
  last_verified_at: string | null;
  verified_by: string | null;
  data_quality_tier: string | null;
}

/**
 * One row per jurisdiction (entity) that owns at least one body or
 * standalone office. The user's actual unit of work — "Salt Lake City"
 * has a council, mayor's office, prosecutor, municipal court etc. Showing
 * those together (rather than spread across body + standalone-office
 * lists) matches how local-government research is actually done.
 */
export interface EntityRow {
  id: string;                       // jurisdiction_id
  name: string;
  short_name: string | null;
  type: string;                     // city, county, township, school_district, special_district, state agency, etc
  fips_state: string | null;
  level: string;                    // federal | state | county | municipal | school | special | judicial
  bodies_count: number;
  bodies_verified: number;          // size_authoritative=true
  bodies_mismatched: number;        // size_total != attached_offices_count
  bodies_seats: number;             // sum(size_total)
  standalone_offices_count: number; // offices with governing_body_id IS NULL
  standalone_offices_verified: number; // offices.meta.research_extracted.authoritative=true
  total_positions: number;          // bodies_seats + standalone_offices_count
}

export interface StandaloneRow {
  id: string;
  canonical_name: string;
  level: string;
  jurisdiction_name: string;
  fips_state: string | null;
  office_type_slug: string | null;
  data_quality_tier: string | null;
  /** True if a standalone-office research agent has written verified
   *  editorial content to offices.meta.research_extracted. */
  research_verified: boolean;
  research_citation_count: number;
  research_last_verified_at: string | null;
  research_verified_by: string | null;
}

export interface OfficeReviewData {
  generatedAt: string;
  totals: {
    bodies: number;
    offices_total: number;
    offices_parented: number;
    offices_standalone: number;
    bodies_authoritative: number;
    /** body_structure_verified=true — the engine's primary-source-fetched
     *  signal. Surfaced alongside (not instead of) bodies_authoritative so
     *  daily verification work is visible without loosening the strict KPI. */
    bodies_structure_verified: number;
    /** bodies whose last_verified_at is within the last 7 days — "researched
     *  this cycle" recency, so the strip shows fresh activity. */
    bodies_verified_run_7d: number;
    bodies_compiled: number;
    bodies_mismatched: number;
    citations_present: number;
    standalone_research_verified: number;       // offices with research_extracted.authoritative = true
    standalone_research_started: number;        // offices with any research_extracted record
  };
  byChamberType: Map<ChamberType, { bodies: number; seats: number; auth: number }>;
  byState: Map<string, { bodies: number; auth: number; mismatches: number }>;
  /**
   * Federal + per-state rollup. Federal = bodies whose jurisdiction.type='nation'
   * (US House + US Senate). State rows pool ALL bodies that share fips_state:
   * state-level (legislature, judicial, boards) AND local (county, city,
   * township, school, special-district, judicial-district). Sorted: Federal
   * first, then states alphabetical.
   */
  byStateRollup: Array<{
    state_name: string;
    fips: string | null;
    // ── Aggregate totals (kept for back-compat with the entity rollup) ──
    bodies: number;
    seats: number;
    verified: number;
    mismatched: number;
    bodies_state_level: number;   // jurisdiction.type='state'
    bodies_local_level: number;   // jurisdiction.type in (county|municipality|township|school_district|special_district|judicial_district|federal_district|territory)
    standalone_offices: number;
    standalone_offices_verified: number;
    entities: number;
    /** Governing bodies with an official roster source URL on record (what the
     *  Map Sources sweep fills). Optional: only the fast SQL main-view path
     *  populates it; the heavy fallback leaves it undefined (renders as "—"). */
    mapped_bodies?: number;
    // ── State-level breakdown (jurisdiction.type='state') ──
    // Each column in the user-facing state table is rendered as
    // "validated/total" — so we track both numerator and denominator for
    // every cell.
    state_bodies: number;                // = bodies_state_level (denominator)
    state_bodies_verified: number;       // size_authoritative=true (numerator)
    state_bodies_seats: number;          // sum(size_total)
    state_bodies_seats_verified: number; // sum(size_total) where size_authoritative
    state_standalone: number;
    state_standalone_verified: number;   // research-verified standalone
    // ── Local-level breakdown (everything else under this fips) ──
    local_bodies: number;                // = bodies_local_level (denominator)
    local_bodies_verified: number;
    local_bodies_seats: number;
    local_bodies_seats_verified: number;
    local_standalone: number;
    local_standalone_verified: number;
  }>;
  entities: EntityRow[];
  bodies: BodyRow[];
  standalone: StandaloneRow[];
  stateLegSanity: Array<{
    state: string;
    chamber: "Senate" | "House";
    catalogued: number;
    expected: number;
    ok: boolean;
  }>;
}

// State legislative chamber sizes — authoritative per state constitutions /
// Ballotpedia state legislative pages, verified 2026-05-25.
const STATE_LEG_SIZES: Record<string, { senate: number; house: number | null }> = {
  Alabama: { senate: 35, house: 105 },
  Alaska: { senate: 20, house: 40 },
  Arizona: { senate: 30, house: 60 },
  Arkansas: { senate: 35, house: 100 },
  California: { senate: 40, house: 80 },
  Colorado: { senate: 35, house: 65 },
  Connecticut: { senate: 36, house: 151 },
  Delaware: { senate: 21, house: 41 },
  Florida: { senate: 40, house: 120 },
  Georgia: { senate: 56, house: 180 },
  Hawaii: { senate: 25, house: 51 },
  Idaho: { senate: 35, house: 70 },
  Illinois: { senate: 59, house: 118 },
  Indiana: { senate: 50, house: 100 },
  Iowa: { senate: 50, house: 100 },
  Kansas: { senate: 40, house: 125 },
  Kentucky: { senate: 38, house: 100 },
  Louisiana: { senate: 39, house: 105 },
  Maine: { senate: 35, house: 151 },
  Maryland: { senate: 47, house: 141 },
  Massachusetts: { senate: 40, house: 160 },
  Michigan: { senate: 38, house: 110 },
  Minnesota: { senate: 67, house: 134 },
  Mississippi: { senate: 52, house: 122 },
  Missouri: { senate: 34, house: 163 },
  Montana: { senate: 50, house: 100 },
  Nebraska: { senate: 49, house: null }, // unicameral
  Nevada: { senate: 21, house: 42 },
  "New Hampshire": { senate: 24, house: 400 },
  "New Jersey": { senate: 40, house: 80 },
  "New Mexico": { senate: 42, house: 70 },
  "New York": { senate: 63, house: 150 },
  "North Carolina": { senate: 50, house: 120 },
  "North Dakota": { senate: 47, house: 94 },
  Ohio: { senate: 33, house: 99 },
  Oklahoma: { senate: 48, house: 101 },
  Oregon: { senate: 30, house: 60 },
  Pennsylvania: { senate: 50, house: 203 },
  "Rhode Island": { senate: 38, house: 75 },
  "South Carolina": { senate: 46, house: 124 },
  "South Dakota": { senate: 35, house: 70 },
  Tennessee: { senate: 33, house: 99 },
  Texas: { senate: 31, house: 150 },
  Utah: { senate: 29, house: 75 },
  Vermont: { senate: 30, house: 150 },
  Virginia: { senate: 40, house: 100 },
  Washington: { senate: 49, house: 98 },
  "West Virginia": { senate: 34, house: 100 },
  Wisconsin: { senate: 33, house: 99 },
  Wyoming: { senate: 31, house: 60 },
};

// Pagination helper that ALWAYS uses .order('id') for stable reads.
async function paged<T>(
  build: () => any,
  pageSize = 1000,
): Promise<T[]> {
  const all: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await build().order("id").range(from, from + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...(data as T[]));
    if (data.length < pageSize) break;
  }
  return all;
}

export async function fetchOfficeReviewData(
  supabase: SupabaseClient,
): Promise<OfficeReviewData> {
  // Load all governing_bodies with jurisdiction info.
  const bodiesRaw = await paged<any>(() =>
    supabase
      .from("governing_bodies")
      .select(
        `id, canonical_name, short_name, chamber_type, jurisdiction_id,
         size_total, size_authoritative, body_structure_verified, description, powers_summary,
         citations, last_verified_at, verified_by, meta,
         jurisdiction:jurisdictions!inner(name, type, fips_state)`,
      ),
  );

  // Count attached offices per body
  const attachedByBody = new Map<string, number>();
  const offices = await paged<{ id: string; canonical_name: string; level: string | null; jurisdiction_id: string | null; governing_body_id: string | null; office_type_id: string | null; meta: any }>(() =>
    supabase
      .from("offices")
      .select("id, canonical_name, level, jurisdiction_id, governing_body_id, office_type_id, meta"),
  );
  for (const o of offices) {
    if (!o.governing_body_id) continue;
    attachedByBody.set(o.governing_body_id, (attachedByBody.get(o.governing_body_id) ?? 0) + 1);
  }

  // Load jurisdictions (for standalone display) + office_types (for slugs)
  const jurs = await paged<{ id: string; name: string; fips_state: string | null; type: string }>(() =>
    supabase.from("jurisdictions").select("id, name, fips_state, type"),
  );
  const jurById = new Map(jurs.map((j) => [j.id, j]));
  const ots = await paged<{ id: string; slug: string }>(() =>
    supabase.from("office_types").select("id, slug"),
  );
  const otById = new Map(ots.map((o) => [o.id, o.slug]));

  // Build BodyRow[]
  const bodies: BodyRow[] = [];
  for (const b of bodiesRaw) {
    const j = Array.isArray(b.jurisdiction) ? b.jurisdiction[0] : b.jurisdiction;
    const attached = attachedByBody.get(b.id) ?? 0;
    bodies.push({
      id: b.id,
      canonical_name: b.canonical_name,
      short_name: b.short_name,
      chamber_type: b.chamber_type,
      jurisdiction_id: b.jurisdiction_id,
      jurisdiction_name: j?.name ?? "(unknown)",
      jurisdiction_type: j?.type ?? "(unknown)",
      fips_state: j?.fips_state ?? null,
      size_total: b.size_total ?? 0,
      size_authoritative: !!b.size_authoritative,
      body_structure_verified: !!b.body_structure_verified,
      attached_offices_count: attached,
      mismatch: (b.size_total ?? 0) !== attached,
      has_description: !!(b.description && b.description.length > 0),
      has_powers_summary: !!(b.powers_summary && b.powers_summary.length > 0),
      citation_count: Array.isArray(b.citations) ? b.citations.length : 0,
      last_verified_at: b.last_verified_at ?? null,
      verified_by: b.verified_by ?? null,
      data_quality_tier: b.meta?.data_quality_tier ?? null,
    });
  }

  // Standalone offices (governing_body_id IS NULL) — group by office_type
  // for the v1 view; full list goes on a separate page later.
  const standalone: StandaloneRow[] = [];
  for (const o of offices) {
    if (o.governing_body_id) continue;
    const j = o.jurisdiction_id ? jurById.get(o.jurisdiction_id) : undefined;
    const research = (o.meta && typeof o.meta === 'object' && o.meta.research_extracted && typeof o.meta.research_extracted === 'object')
      ? (o.meta.research_extracted as any) : null;
    const researchCitations = Array.isArray(research?.citations) ? research.citations : [];
    standalone.push({
      id: o.id,
      canonical_name: o.canonical_name,
      level: o.level ?? "(unknown)",
      jurisdiction_name: j?.name ?? "(unknown)",
      fips_state: j?.fips_state ?? null,
      office_type_slug: o.office_type_id ? otById.get(o.office_type_id) ?? null : null,
      data_quality_tier: o.meta?.data_quality_tier ?? null,
      research_verified: !!research?.authoritative,
      research_citation_count: researchCitations.length,
      research_last_verified_at: research?.last_verified_at ?? null,
      research_verified_by: research?.verified_by ?? null,
    });
  }

  // Aggregates
  const byChamberType = new Map<ChamberType, { bodies: number; seats: number; auth: number }>();
  for (const b of bodies) {
    const c = byChamberType.get(b.chamber_type) ?? { bodies: 0, seats: 0, auth: 0 };
    c.bodies += 1;
    c.seats += b.size_total;
    if (b.size_authoritative) c.auth += 1;
    byChamberType.set(b.chamber_type, c);
  }
  const byState = new Map<string, { bodies: number; auth: number; mismatches: number }>();
  for (const b of bodies) {
    const key = b.fips_state ?? "—";
    const c = byState.get(key) ?? { bodies: 0, auth: 0, mismatches: 0 };
    c.bodies += 1;
    if (b.size_authoritative) c.auth += 1;
    if (b.mismatch) c.mismatches += 1;
    byState.set(key, c);
  }

  // ── Entity rollup (per-jurisdiction) ────────────────────────────────
  // Build one EntityRow per jurisdiction that owns at least one body or
  // standalone office. This is the new primary work surface — picking a
  // city/county/township shows all its bodies + standalone offices at once,
  // which matches how local-government research actually clusters.
  const TYPE_TO_LEVEL: Record<string, string> = {
    nation: 'federal',
    state: 'state',
    federal_district: 'federal',
    territory: 'state',
    county: 'county',
    municipality: 'municipal',
    city: 'municipal',
    town: 'municipal',
    township: 'municipal',
    village: 'municipal',
    borough: 'municipal',
    school_district: 'school',
    special_district: 'special',
    judicial_district: 'judicial',
    state_agency: 'state',
  };
  // O(1) office-by-id lookup for the entity rollup AND the per-state
  // standalone-office count below. `.find()` per standalone-row would be
  // O(standalone × offices) ≈ 65k × 453k ≈ 30B ops — too slow.
  const officeById = new Map<string, typeof offices[number]>();
  for (const o of offices) officeById.set(o.id, o);

  const entityMap = new Map<string, EntityRow>();
  function getOrCreateEntity(jid: string, j: { name: string; type: string; fips_state: string | null }, shortName: string | null): EntityRow {
    let e = entityMap.get(jid);
    if (!e) {
      e = {
        id: jid,
        name: j.name,
        short_name: shortName,
        type: j.type,
        fips_state: j.fips_state,
        level: TYPE_TO_LEVEL[j.type] ?? 'other',
        bodies_count: 0,
        bodies_verified: 0,
        bodies_mismatched: 0,
        bodies_seats: 0,
        standalone_offices_count: 0,
        standalone_offices_verified: 0,
        total_positions: 0,
      };
      entityMap.set(jid, e);
    }
    return e;
  }
  // Bodies → their owning jurisdiction's entity row
  for (const b of bodies) {
    const j = jurById.get(b.jurisdiction_id);
    if (!j) continue;
    const e = getOrCreateEntity(b.jurisdiction_id, j, null);
    e.bodies_count += 1;
    e.bodies_seats += b.size_total;
    if (b.body_structure_verified) e.bodies_verified += 1;
    if (b.mismatch) e.bodies_mismatched += 1;
  }
  // Standalone offices → their owning jurisdiction's entity row
  for (const s of standalone) {
    // standalone[] doesn't carry jurisdiction_id directly — look it up via
    // the originating office row.
    const o = officeById.get(s.id);
    if (!o || !o.jurisdiction_id) continue;
    const j = jurById.get(o.jurisdiction_id);
    if (!j) continue;
    const e = getOrCreateEntity(o.jurisdiction_id, j, null);
    e.standalone_offices_count += 1;
    if (s.research_verified) e.standalone_offices_verified += 1;
  }
  for (const e of entityMap.values()) {
    e.total_positions = e.bodies_seats + e.standalone_offices_count;
  }
  const entities: EntityRow[] = Array.from(entityMap.values());

  // By-state rollup: Federal (nation jurisdictions) + one bucket per state,
  // pooling local bodies (county/city/township/school/special-district/etc.)
  // that share fips_state. Gives a "how much have we covered for each state"
  // view that mirrors how the user thinks about coverage.
  const fipsToName = new Map<string, string>();
  for (const j of jurs) {
    if (j.type === 'state' && j.fips_state) fipsToName.set(j.fips_state, j.name);
  }
  // Fallback for territories / federal_district that may not appear as type='state'
  for (const j of jurs) {
    if ((j.type === 'territory' || j.type === 'federal_district') && j.fips_state && !fipsToName.has(j.fips_state)) {
      fipsToName.set(j.fips_state, j.name);
    }
  }
  type RollupRow = OfficeReviewData['byStateRollup'][number];
  const rollup = new Map<string, RollupRow>();
  // Track distinct entity ids per state so the "entities" column counts
  // jurisdictions, not bodies or offices.
  const entityIdsPerState = new Map<string, Set<string>>();
  for (const b of bodies) {
    let key: string;
    let stateName: string;
    let fips: string | null;
    let isStateLevel = false;
    if (b.jurisdiction_type === 'nation') {
      key = 'Federal';
      stateName = 'Federal';
      // 'US' is the synthetic FIPS bucket that the dashboard server's SQL
      // aggregations use for nation-type rows. Setting it here lets the
      // state-table hydrator find the Federal row's live counts in
      // /api/state-progress responses.
      fips = 'US';
    } else if (b.fips_state) {
      stateName = fipsToName.get(b.fips_state) ?? `(fips ${b.fips_state})`;
      key = stateName;
      fips = b.fips_state;
      // Territories (VI, Guam, PR, AS, MP) are top-level jurisdictions like
      // states — their legislature + governor are state-equivalent, not "local."
      if (b.jurisdiction_type === 'state' || b.jurisdiction_type === 'territory') isStateLevel = true;
    } else {
      key = '(unknown)';
      stateName = '(unknown)';
      fips = null;
    }
    const c: RollupRow = rollup.get(key) ?? {
      state_name: stateName, fips,
      bodies: 0, seats: 0, verified: 0, mismatched: 0,
      bodies_state_level: 0, bodies_local_level: 0,
      standalone_offices: 0, standalone_offices_verified: 0,
      entities: 0,
      state_bodies: 0, state_bodies_verified: 0, state_bodies_seats: 0, state_bodies_seats_verified: 0,
      state_standalone: 0, state_standalone_verified: 0,
      local_bodies: 0, local_bodies_verified: 0, local_bodies_seats: 0, local_bodies_seats_verified: 0,
      local_standalone: 0, local_standalone_verified: 0,
    };
    c.bodies += 1;
    c.seats += b.size_total;
    if (b.body_structure_verified) c.verified += 1;
    if (b.mismatch) c.mismatched += 1;
    // Nation-type bodies (US House, US Senate) live in the Federal row.
    // Treat them as "state-level" for that row so Federal's State columns
    // populate (US House: 0/435 verified, US Senate: 0/100 verified, etc).
    // The "Federal row local-level" cells stay empty by design — there's
    // no notion of "local" within Federal.
    const goesInStateBucket = isStateLevel || b.jurisdiction_type === 'nation';
    if (goesInStateBucket) {
      if (isStateLevel) c.bodies_state_level += 1;
      c.state_bodies += 1;
      c.state_bodies_seats += b.size_total;
      if (b.body_structure_verified) {
        c.state_bodies_verified += 1;
        c.state_bodies_seats_verified += b.size_total;
      }
    } else {
      c.bodies_local_level += 1;
      c.local_bodies += 1;
      c.local_bodies_seats += b.size_total;
      if (b.body_structure_verified) {
        c.local_bodies_verified += 1;
        c.local_bodies_seats_verified += b.size_total;
      }
    }
    rollup.set(key, c);
    // Track which entity (jurisdiction) sits in this state.
    let s = entityIdsPerState.get(key);
    if (!s) { s = new Set<string>(); entityIdsPerState.set(key, s); }
    s.add(b.jurisdiction_id);
  }
  // Standalone offices also contribute to the per-state rollup. Without
  // this, the by-state view was undercounting half the work (the user
  // flagged this — mayors, sheriffs, DAs, judges all live here).
  for (const s of standalone) {
    const o = officeById.get(s.id);
    if (!o || !o.jurisdiction_id) continue;
    const j = jurById.get(o.jurisdiction_id);
    if (!j) continue;
    let key: string;
    let stateName: string;
    let fips: string | null;
    if (j.type === 'nation') {
      key = 'Federal';
      stateName = 'Federal';
      fips = 'US';
    } else if (j.fips_state) {
      stateName = fipsToName.get(j.fips_state) ?? `(fips ${j.fips_state})`;
      key = stateName;
      fips = j.fips_state;
    } else {
      key = '(unknown)';
      stateName = '(unknown)';
      fips = null;
    }
    const c = rollup.get(key) ?? {
      state_name: stateName, fips,
      bodies: 0, seats: 0, verified: 0, mismatched: 0,
      bodies_state_level: 0, bodies_local_level: 0,
      standalone_offices: 0, standalone_offices_verified: 0,
      entities: 0,
      state_bodies: 0, state_bodies_verified: 0, state_bodies_seats: 0, state_bodies_seats_verified: 0,
      state_standalone: 0, state_standalone_verified: 0,
      local_bodies: 0, local_bodies_verified: 0, local_bodies_seats: 0, local_bodies_seats_verified: 0,
      local_standalone: 0, local_standalone_verified: 0,
    };
    c.standalone_offices += 1;
    if (s.research_verified) c.standalone_offices_verified += 1;
    // State-level vs local-level: same predicate as bodies. Nation-type
    // standalones (e.g., President, federal AG) belong to the Federal row's
    // state-level bucket — there's no "local" within Federal.
    if (j.type === 'state' || j.type === 'nation' || j.type === 'territory') {
      c.state_standalone += 1;
      if (s.research_verified) c.state_standalone_verified += 1;
    } else {
      c.local_standalone += 1;
      if (s.research_verified) c.local_standalone_verified += 1;
    }
    rollup.set(key, c);
    let ents = entityIdsPerState.get(key);
    if (!ents) { ents = new Set<string>(); entityIdsPerState.set(key, ents); }
    ents.add(o.jurisdiction_id);
  }
  // Finalise the entity counts.
  for (const [key, ents] of entityIdsPerState) {
    const c = rollup.get(key);
    if (c) c.entities = ents.size;
  }
  const byStateRollup: RollupRow[] = [...rollup.values()].sort((a, b) => {
    if (a.state_name === 'Federal') return -1;
    if (b.state_name === 'Federal') return 1;
    if (a.state_name === '(unknown)') return 1;
    if (b.state_name === '(unknown)') return -1;
    return a.state_name.localeCompare(b.state_name);
  });

  // State leg sanity table
  const stateLegSanity: OfficeReviewData["stateLegSanity"] = [];
  for (const [stateName, exp] of Object.entries(STATE_LEG_SIZES).sort()) {
    const senate = bodies.find(
      (b) => b.jurisdiction_name === stateName && b.chamber_type === "legislative_upper",
    );
    if (senate) {
      stateLegSanity.push({
        state: stateName,
        chamber: "Senate",
        catalogued: senate.size_total,
        expected: exp.senate,
        ok: senate.size_total === exp.senate,
      });
    } else {
      stateLegSanity.push({ state: stateName, chamber: "Senate", catalogued: 0, expected: exp.senate, ok: false });
    }
    if (exp.house !== null) {
      const house = bodies.find(
        (b) => b.jurisdiction_name === stateName && b.chamber_type === "legislative_lower",
      );
      if (house) {
        stateLegSanity.push({
          state: stateName,
          chamber: "House",
          catalogued: house.size_total,
          expected: exp.house,
          ok: house.size_total === exp.house,
        });
      } else {
        stateLegSanity.push({ state: stateName, chamber: "House", catalogued: 0, expected: exp.house, ok: false });
      }
    }
  }

  // Totals
  const totals = {
    bodies: bodies.length,
    offices_total: offices.length,
    offices_parented: bodies.reduce((s, b) => s + b.attached_offices_count, 0),
    offices_standalone: standalone.length,
    bodies_authoritative: bodies.filter((b) => b.size_authoritative).length,
    bodies_structure_verified: bodies.filter((b) => b.body_structure_verified).length,
    bodies_verified_run_7d: (() => {
      const cutoff = Date.now() - 7 * 86400e3;
      return bodies.filter((b) => b.last_verified_at && new Date(b.last_verified_at).getTime() >= cutoff).length;
    })(),
    // "compiled" = not structurally verified (was: not size_authoritative).
    // Now that the strip shows structural-verified explicitly, compiled should
    // mean "no primary-source fetch proven", i.e. !body_structure_verified —
    // otherwise the 117 structurally-verified bodies were mislabeled compiled.
    bodies_compiled: bodies.filter((b) => !b.body_structure_verified).length,
    bodies_mismatched: bodies.filter((b) => b.mismatch).length,
    citations_present: bodies.filter((b) => b.citation_count > 0).length,
    standalone_research_verified: standalone.filter((s) => s.research_verified).length,
    standalone_research_started: standalone.filter((s) => s.research_last_verified_at !== null).length,
  };

  return {
    generatedAt: new Date().toISOString(),
    totals,
    byChamberType,
    byState,
    byStateRollup,
    entities,
    bodies,
    standalone,
    stateLegSanity,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Render
// ────────────────────────────────────────────────────────────────────────────

function esc(s: unknown): string {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
const fmt = (n: number) => n.toLocaleString("en-US");
const pct = (a: number, b: number) => (b === 0 ? 0 : Math.round((a / b) * 100));

export function renderOfficeReviewHTML(data: OfficeReviewData): string {
  const { totals, byChamberType, byStateRollup, entities, bodies, standalone, stateLegSanity, generatedAt } = data;

  const generatedAtDisplay =
    new Date(generatedAt).toISOString().replace("T", " ").slice(0, 16) + " UTC";

  // Format a "validated / total" cell. When total === 0 we render "—" so
  // the table doesn't read "0/0 verified" for jurisdictions that have no
  // catalogued bodies/offices in that bucket.
  const ratio = (verified: number, total: number): string => {
    if (total === 0) return '<span style="color:var(--civic-text-muted)">—</span>';
    const cls = verified === total ? 'good' : verified === 0 ? 'bad' : 'warn';
    const color = cls === 'good' ? 'var(--state-success-fg,#2c6b3a)' : cls === 'bad' ? 'var(--state-error-fg,#8b2e2e)' : 'var(--state-warn-fg,#b66b0a)';
    return `<span style="color:${color};font-weight:600">${fmt(verified)}</span><span style="color:var(--civic-text-muted)">/${fmt(total)}</span>`;
  };

  const rollupRows = byStateRollup
    .map((r) => {
      const statePositionsVerified = r.state_bodies_seats_verified + r.state_standalone_verified;
      const statePositionsTotal = r.state_bodies_seats + r.state_standalone;
      const localPositionsVerified = r.local_bodies_seats_verified + r.local_standalone_verified;
      const localPositionsTotal = r.local_bodies_seats + r.local_standalone;
      const allPositionsVerified = statePositionsVerified + localPositionsVerified;
      const allPositionsTotal = statePositionsTotal + localPositionsTotal;
      const fips = r.fips ?? '';
      // Status pill: green if everything verified, amber if any, red if 0,
      // grey if nothing in the catalog. Computed from positions ratio.
      let statusCls: string, statusLabel: string;
      if (allPositionsTotal === 0) { statusCls = 'empty'; statusLabel = 'no data'; }
      else if (allPositionsVerified === 0) { statusCls = 'todo'; statusLabel = 'to verify'; }
      else if (allPositionsVerified < allPositionsTotal) { statusCls = 'partial'; statusLabel = 'in progress'; }
      else { statusCls = 'done'; statusLabel = 'verified'; }
      return `<tr class="click-row" data-fips="${esc(fips)}" data-state-name="${esc(r.state_name)}">
        <td><strong>${esc(r.state_name)}</strong></td>
        <td class="num cell-sb">${ratio(r.state_bodies_verified, r.state_bodies)}</td>
        <td class="num cell-ss">${ratio(r.state_standalone_verified, r.state_standalone)}</td>
        <td class="num cell-sp">${ratio(statePositionsVerified, statePositionsTotal)}</td>
        <td class="num cell-lb">${ratio(r.local_bodies_verified, r.local_bodies)}</td>
        <td class="num cell-ls">${ratio(r.local_standalone_verified, r.local_standalone)}</td>
        <td class="num cell-lp">${ratio(localPositionsVerified, localPositionsTotal)}</td>
        <td class="num upcoming-cell" data-fips="${esc(fips)}">—</td>
        <td class="num">${r.mapped_bodies != null ? ratio(r.mapped_bodies, r.bodies) : '<span style="color:var(--civic-text-muted)">—</span>'}</td>
        <td class="cell-status"><span class="status-pill ${statusCls}">${statusLabel}</span></td>
        <td style="text-align:center;white-space:nowrap">${/^(\d{2}|US)$/.test(fips) ? `<button class="run-state-btn" data-fips="${esc(fips)}" data-name="${esc(r.state_name)}" title="Source + verify just ${esc(r.state_name)} — soft-launch this jurisdiction">▶ Run</button> <button class="map-state-btn" data-fips="${esc(fips)}" data-name="${esc(r.state_name)}" title="Map source URLs for just ${esc(r.state_name)} (find official roster pages)">⌖ Map</button>` : ''}</td>
      </tr>`;
    })
    .join("\n");

  const chamberRows = [...byChamberType.entries()]
    .sort((a, b) => b[1].bodies - a[1].bodies)
    .map(([c, t]) => {
      const aPct = pct(t.auth, t.bodies);
      return `<tr><td>${esc(c)}</td><td class="num">${fmt(t.bodies)}</td><td class="num">${fmt(t.seats)}</td><td class="num">${fmt(t.auth)}</td><td class="num">${aPct}%</td></tr>`;
    })
    .join("\n");

  const sanityRows = stateLegSanity
    .map((r) => {
      const cls = r.ok ? "ok" : "warn";
      const diff = r.catalogued - r.expected;
      const diffStr = diff === 0 ? "✓" : (diff > 0 ? `+${diff}` : `${diff}`);
      return `<tr class="${cls}"><td>${esc(r.state)}</td><td>${r.chamber}</td><td class="num">${r.catalogued}</td><td class="num">${r.expected}</td><td class="num">${diffStr}</td></tr>`;
    })
    .join("\n");

  // Body matrix — show top N by mismatch + size_authoritative (worst first).
  // Mismatch rows first; then non-authoritative; then rest.
  // Verification rank for sorting: authoritative (2) > structurally verified
  // (1) > neither (0). Worst (least verified) bubbles to the top so reviewers
  // see what still needs work first.
  const vrank = (b: BodyRow) => (b.size_authoritative ? 2 : b.body_structure_verified ? 1 : 0);
  const sortedBodies = [...bodies].sort((a, b) => {
    if (a.mismatch !== b.mismatch) return a.mismatch ? -1 : 1;
    const ra = vrank(a), rb = vrank(b);
    if (ra !== rb) return ra - rb;
    return a.canonical_name.localeCompare(b.canonical_name);
  });
  const initialDisplayCap = 250;
  // SSR-cap to keep the HTML payload sane. Previously we SSR'd all 74k
  // bodies (~35MB HTML) then the JS filter hid most. Now we SSR the
  // worst-1500 (mismatched + unverified pile to the top by the sort
  // above) and let users narrow via filters. Server-side search comes
  // later if needed.
  const SSR_BODY_CAP = 1500;
  const bodyRows = sortedBodies
    .slice(0, SSR_BODY_CAP)
    .map((b) => {
      const mismatchCls = b.mismatch ? " mismatch" : "";
      const authPill = b.size_authoritative
        ? '<span class="pill auth-yes">authoritative</span>'
        : b.body_structure_verified
        ? '<span class="pill cite-yes">structural</span>'
        : '<span class="pill auth-no">unverified</span>';
      const citePill = b.citation_count > 0
        ? `<span class="pill cite-yes">${b.citation_count}</span>`
        : '<span class="pill cite-no">0</span>';
      return `<tr id="body-${esc(b.id)}" class="brow${mismatchCls}" data-chamber="${esc(b.chamber_type)}" data-state="${esc(b.fips_state ?? "—")}" data-mismatch="${b.mismatch ? "1" : "0"}" data-auth="${b.size_authoritative ? "1" : "0"}" data-struct="${b.body_structure_verified ? "1" : "0"}">
  <td>${esc(b.canonical_name)}</td>
  <td>${esc(b.jurisdiction_name)}</td>
  <td>${esc(b.chamber_type)}</td>
  <td class="num">${b.size_total}</td>
  <td class="num">${b.attached_offices_count}</td>
  <td class="num">${authPill}</td>
  <td class="num">${citePill}</td>
  <td>${esc(b.verified_by ?? "—")}</td>
</tr>`;
    })
    .join("\n");

  // Standalone office summary by office_type
  const standaloneByType = new Map<string, number>();
  for (const o of standalone) {
    const k = o.office_type_slug ?? "(no slug)";
    standaloneByType.set(k, (standaloneByType.get(k) ?? 0) + 1);
  }
  const standaloneRows = [...standaloneByType.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([slug, n]) => `<tr><td>${esc(slug)}</td><td class="num">${fmt(n)}</td></tr>`)
    .join("\n");

  return `<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=" crossorigin="" />
<style>
  .or-root { font-family: var(--civic-font-sans, system-ui); color: var(--civic-text, #1a1917); padding: 24px 32px 64px; max-width: 88rem; margin: 0 auto; }
  .or-root h1 { font-family: var(--civic-font-display, Georgia, serif); font-size: 32px; font-weight: 700; letter-spacing: -.02em; margin: 8px 0; }
  .or-root h2 { font-family: var(--civic-font-display); font-size: 20px; font-weight: 600; margin: 1.6em 0 .4em; padding-bottom: .3em; border-bottom: 1px solid var(--civic-border, #d5d3cc); }
  .or-root .kicker { font-family: var(--civic-font-mono, ui-monospace, monospace); font-size: 11px; letter-spacing: .12em; text-transform: uppercase; color: var(--civic-text-muted, #57544d); font-weight: 600; }
  .or-root .lede { font-family: var(--civic-font-serif, Georgia, serif); font-size: 17px; line-height: 1.5; color: var(--civic-text); margin: .5em 0 1.2em; max-width: 60rem; }

  /* Compact-totals strip — one line replacing the old 9-card grid.
     Reads at-a-glance: bodies (verified · mismatched) · offices (parented · standalone · researched).
     Click any number to scroll to the relevant section. */
  .or-totals-strip {
    display: flex; flex-wrap: wrap; gap: 8px 18px; align-items: baseline;
    background: var(--civic-surface, #fff); border: 1px solid var(--civic-border, #d5d3cc);
    border-radius: 8px; padding: 12px 16px; margin: 14px 0 22px;
    font-family: var(--civic-font-mono, ui-monospace, monospace); font-size: 13px;
  }
  .or-totals-strip .group { display: inline-flex; align-items: baseline; gap: 8px; }
  .or-totals-strip .group + .group::before { content: "·"; color: var(--civic-text-muted, #57544d); margin-right: 8px; }
  .or-totals-strip .big {
    font-family: var(--civic-font-display, Georgia, serif); font-size: 20px; font-weight: 700;
    line-height: 1; letter-spacing: -.02em; color: var(--civic-text);
  }
  .or-totals-strip .lbl { color: var(--civic-text-muted); text-transform: uppercase; font-size: 10px; letter-spacing: .06em; font-weight: 600; }
  .or-totals-strip .detail { color: var(--civic-text-secondary, #3e3b36); font-size: 12px; }
  .or-totals-strip .good { color: var(--state-success-fg, #2c6b3a); }
  .or-totals-strip .warn { color: var(--state-warn-fg, #b66b0a); }
  .or-totals-strip .bad  { color: var(--state-error-fg, #8b2e2e); }
  .or-totals-strip a { color: inherit; text-decoration: none; border-bottom: 1px dotted currentColor; }
  .or-totals-strip a:hover { border-bottom-style: solid; }

  /* Per-state breakdown — primary view. Big sortable table, every row
     click jumps you to the matrix below filtered to that state. */
  .or-state-table th { user-select: none; }
  .or-state-table tr.click-row { cursor: pointer; }
  .or-state-table tr.click-row:hover td { background: #e1ebf3 !important; }
  .or-state-table .progress-bar { display: inline-block; vertical-align: middle; width: 70px; height: 8px; background: var(--civic-surface-sunken, #f4f4f2); border-radius: 4px; overflow: hidden; margin-right: 6px; }
  .or-state-table .progress-bar > span { display: block; height: 100%; background: var(--state-success-fg, #2c6b3a); }
  .or-state-table .status-pill { font-family: var(--civic-font-mono); font-size: 10px; padding: 2px 8px; border-radius: 999px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; display: inline-block; }
  .or-state-table .status-pill.todo { background: #fbf0d9; color: #b66b0a; border: 1px solid #e3c582; }
  .or-state-table .status-pill.partial { background: #e1ebf3; color: #2f4e6e; border: 1px solid #a8c3d8; }
  .or-state-table .status-pill.done { background: #e4f2ea; color: #2c6b3a; border: 1px solid #a6cfb6; }
  .or-state-table .status-pill.empty { background: #f5e1de; color: #8b2e2e; border: 1px solid #d19a95; }

  /* Map layer-toggle — segmented control above the choropleth. */
  .or-map-layers { display: inline-flex; border: 1px solid var(--civic-border, #d5d3cc); border-radius: 6px; overflow: hidden; margin: 6px 0 8px; font-family: var(--civic-font-mono, ui-monospace, monospace); font-size: 11px; }
  .or-map-layers button {
    background: var(--civic-surface, #fff); color: var(--civic-text-secondary, #3e3b36);
    border: 0; border-right: 1px solid var(--civic-border, #d5d3cc);
    padding: 6px 12px; cursor: pointer; font-family: inherit; font-size: inherit; font-weight: 600;
    text-transform: uppercase; letter-spacing: .04em;
  }
  .or-map-layers button:last-child { border-right: 0; }
  .or-map-layers button.active { background: var(--civic-primary, #1a2f5c); color: #fff; }
  .or-map-layers button:hover:not(.active) { background: var(--civic-surface-sunken, #f4f4f2); }

  /* Collapsible-section styling — sections after the state table are
     <details closed> by default per the user's "minimize all charts after
     1" feedback. The summary looks like an h2, the body indents slightly,
     and the disclosure triangle uses the same accent color as h2 borders. */
  .or-section { margin: 1.6em 0 .4em; border-bottom: 1px solid var(--civic-border, #d5d3cc); }
  .or-section > summary {
    list-style: none; cursor: pointer; padding: .4em 0;
    display: flex; align-items: center; gap: .5em;
  }
  .or-section > summary::-webkit-details-marker { display: none; }
  .or-section > summary::before {
    content: "▸"; font-family: var(--civic-font-mono); color: var(--civic-text-muted);
    transition: transform .15s; display: inline-block;
    font-size: 14px; line-height: 1; margin-right: 4px;
  }
  .or-section[open] > summary::before { transform: rotate(90deg); }
  .or-section > summary:hover { background: var(--civic-surface-sunken, #f4f4f2); }
  .or-section > .or-section-body { padding-bottom: .8em; }
  /* When closed, give a hint about what's inside the section without
     forcing the user to open it. Lazy-load placeholders fill in too. */
  .or-section .lazy-pending { color: var(--civic-text-muted); font-style: italic; font-size: 13px; padding: 1em 0; }

  /* legacy stat cards retained for the "ingestion health" row below the fold */
  .or-stat-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin: 14px 0; }
  @media (max-width:780px) { .or-stat-grid { grid-template-columns: repeat(2, 1fr); } }
  .or-stat { background: var(--civic-surface, #fff); border: 1px solid var(--civic-border, #d5d3cc); border-radius: 8px; padding: 12px 14px; border-left: 3px solid var(--civic-primary, #1a2f5c); }
  .or-stat .num { font-family: var(--civic-font-display, Georgia, serif); font-size: 26px; font-weight: 700; color: var(--civic-text); line-height: 1; letter-spacing: -.025em; }
  .or-stat .label { font-family: var(--civic-font-mono); font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: var(--civic-text-muted); margin-top: 6px; font-weight: 600; }
  .or-stat.warn { border-left-color: var(--state-warn-fg, #b66b0a); }
  .or-stat.bad { border-left-color: var(--state-error-fg, #8b2e2e); }
  .or-stat.good { border-left-color: var(--state-success-fg, #2c6b3a); }

  .or-root table { font-size: 13px; border-collapse: collapse; width: 100%; background: var(--civic-surface, #fff); border: 1px solid var(--civic-border, #d5d3cc); border-radius: 8px; overflow: hidden; }
  .or-root table th, .or-root table td { border-bottom: 1px solid var(--civic-border, #d5d3cc); padding: 7px 11px; text-align: left; vertical-align: top; }
  .or-root table th { background: var(--civic-surface-sunken, #f4f4f2); color: var(--civic-primary, #1a2f5c); font-family: var(--civic-font-mono, ui-monospace, monospace); font-size: 10.5px; text-transform: uppercase; letter-spacing: .05em; font-weight: 600; cursor: pointer; }
  .or-root table tbody tr:nth-child(even) td { background: var(--civic-surface-muted, #faf8f5); }
  .or-root td.num { font-family: var(--civic-font-mono); font-variant-numeric: tabular-nums; text-align: right; }
  .or-root tr.warn td { color: var(--state-warn-fg, #b66b0a); }
  .or-root tr.warn td:first-child::before { content: "⚠ "; }
  .or-root tr.ok td:first-child::before { content: "✓ "; color: var(--state-success-fg, #2c6b3a); }
  .or-root tr.brow.mismatch td:first-child::before { content: "⚠ "; }
  .or-root tr.brow.mismatch td { background-color: #fbf0d9 !important; }
  .or-root tr.brow:target td { background-color: #e1ebf3 !important; outline: 2px solid #2f4e6e; outline-offset: -2px; }
  .or-root tr.brow:target td:first-child::after { content: " ← linked from candidate review"; color: #2f4e6e; font-family: var(--civic-font-mono, monospace); font-size: 11px; }

  .pill { font-family: var(--civic-font-mono); font-size: 10px; padding: 2px 8px; border-radius: 999px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; display: inline-block; }
  .pill.auth-yes { background: #e4f2ea; color: #2c6b3a; border: 1px solid #a6cfb6; }
  .pill.auth-no { background: #fbf0d9; color: #b66b0a; border: 1px solid #e3c582; }
  .pill.cite-yes { background: #e1ebf3; color: #2f4e6e; border: 1px solid #a8c3d8; }
  .pill.cite-no { background: #f5e1de; color: #8b2e2e; border: 1px solid #d19a95; }

  .filter-row { display: flex; gap: 10px 14px; margin: 10px 0; align-items: center; flex-wrap: wrap; padding: 12px 14px; background: var(--civic-surface, #fff); border: 1px solid var(--civic-border, #d5d3cc); border-radius: 8px; }
  .filter-row label { font-family: var(--civic-font-mono); font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: var(--civic-text-muted); font-weight: 600; display: inline-flex; gap: 6px; align-items: center; }
  .filter-row select, .filter-row input { font-family: var(--civic-font-sans, system-ui); font-size: 13px; padding: 6px 10px; border: 1px solid var(--civic-border); border-radius: 4px; background: var(--civic-surface); }
  .filter-row #b-counter { margin-left: auto; font-family: var(--civic-font-mono); font-size: 11px; color: var(--civic-text-muted); }
  .filter-row button { font-family: var(--civic-font-mono); font-size: 11px; color: var(--civic-primary); background: none; border: 1px solid var(--civic-border); border-radius: 4px; padding: 4px 9px; cursor: pointer; }
</style>
<div class="or-root">
  <header>
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:1em;flex-wrap:wrap">
      <div>
        <div class="kicker">Operational visibility · governing-bodies + offices · regenerated ${esc(generatedAtDisplay)}</div>
        <h1>Office Review — source of truth</h1>
      </div>
      <a href="/admin/candidate-review" target="_blank" rel="noopener"
         style="font-family:var(--civic-font-mono,ui-monospace,monospace);font-size:12px;letter-spacing:.06em;text-transform:uppercase;font-weight:600;background:var(--civic-primary,#1a2f5c);color:#fff;padding:9px 16px;border-radius:6px;text-decoration:none;white-space:nowrap;align-self:center;border:none;display:inline-block"
         title="Open the candidate-research dashboard in a new tab">
        Candidate review →
      </a>
    </div>
  </header>

  <!-- ── Ingestion engine on/off control ──────────────────────────────── -->
  <style>
    /* Stable two-engine stack: each engine has a fixed CONTROLS row and a
       separate STATUS row, so live status text never reflows the buttons. */
    /* z-index above Leaflet's panes/controls (which go up to ~1000) so the
       sticky header isn't painted behind the coverage map while scrolling. */
    .ingest-stack { position:sticky; top:0; z-index:1100; display:flex; flex-direction:column; gap:8px; margin:10px 0 16px; }
    .engine { background:var(--civic-surface,#fff); border:1px solid var(--civic-border,#d5d3cc); border-radius:8px;
      padding:8px 14px; box-shadow:0 2px 10px rgba(0,0,0,.07); }
    .engine-controls { display:flex; align-items:center; gap:11px; flex-wrap:wrap; min-height:30px; }
    .engine-status { display:flex; align-items:center; gap:10px; flex-wrap:nowrap; margin-top:7px; padding-top:7px;
      border-top:1px solid var(--civic-border,#ece9e2); min-height:21px; overflow:hidden;
      font-family:var(--civic-font-mono,ui-monospace,monospace); font-size:12px; }
    .ingest-stack .lbl { font-family:var(--civic-font-mono,ui-monospace,monospace); font-size:11px; letter-spacing:.06em; text-transform:uppercase; color:var(--civic-text-muted,#57544d); font-weight:700; }
    .ingest-stack .tag { font-family:var(--civic-font-mono,monospace); font-size:10px; color:var(--civic-text-muted,#57544d); border:1px solid var(--civic-border,#ddd); border-radius:4px; padding:1px 6px; white-space:nowrap; }
    .ingest-stack button { font-family:var(--civic-font-mono,monospace); font-size:12px; font-weight:700; letter-spacing:.04em; text-transform:uppercase; color:#fff; border:none; border-radius:6px; padding:7px 14px; cursor:pointer; }
    #bb-ingest-dot, #li-dot { width:11px; height:11px; border-radius:50%; display:inline-block; background:#b5b5b5; flex:0 0 auto; }
    #bb-ingest-dot.on, #li-dot.on { background:#2c6b3a; animation:bbpulse 1.6s infinite; }
    @keyframes bbpulse { 0%{box-shadow:0 0 0 0 rgba(44,107,58,.5);} 70%{box-shadow:0 0 0 7px rgba(44,107,58,0);} 100%{box-shadow:0 0 0 0 rgba(44,107,58,0);} }
    .engine-status .grow { margin-left:auto; color:var(--civic-text-muted); font-size:11px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .or-state-table tr.bb-live > td { background:#fff4cc !important; }
    .or-root tr.brow.bb-live > td { background:#fff1bf !important; }
    .run-state-btn { font-family:var(--civic-font-mono,ui-monospace,monospace); font-size:10px; font-weight:700; letter-spacing:.03em; background:var(--civic-primary,#1a2f5c); color:#fff; border:none; border-radius:4px; padding:3px 10px; cursor:pointer; }
    .run-state-btn:disabled { opacity:.7; }
    .map-state-btn { font-family:var(--civic-font-mono,ui-monospace,monospace); font-size:10px; font-weight:700; letter-spacing:.03em; background:#5a4b8a; color:#fff; border:none; border-radius:4px; padding:3px 10px; cursor:pointer; }
    .map-state-btn:disabled { opacity:.7; }
  </style>
  <div class="ingest-stack">
    <style>
      #svc-health { display:flex; align-items:center; gap:16px; flex-wrap:wrap; background:var(--civic-surface,#fff); border:1px solid var(--civic-border,#d5d3cc); border-radius:8px; padding:5px 14px; box-shadow:0 2px 10px rgba(0,0,0,.07); font-family:var(--civic-font-mono,ui-monospace,monospace); font-size:11px; }
      #svc-health .svc { display:inline-flex; align-items:center; gap:5px; color:var(--civic-text-secondary,#3e3b36); }
      #svc-health .svc-dot { width:9px; height:9px; border-radius:50%; background:#b5b5b5; flex:0 0 auto; }
      #svc-health .svc-dot.up { background:var(--state-success-fg,#2c6b3a); }
      #svc-health .svc-dot.down { background:var(--state-error-fg,#8b2e2e); }
      #svc-health .svc-detail { color:var(--civic-text-muted,#57544d); font-size:10px; }
    </style>
    <div id="svc-health" title="Live status of the services mapping + ingestion need running. Red = down -> that pathway will fail.">
      <span class="lbl">Services</span>
      <span class="svc" data-svc="postgres"><span class="svc-dot"></span>DB</span>
      <span class="svc" data-svc="ollama"><span class="svc-dot"></span>Ollama</span>
      <span class="svc" data-svc="jina"><span class="svc-dot"></span>Jina <span class="svc-detail"></span></span>
      <span class="svc" data-svc="cf_bypass"><span class="svc-dot"></span>CF-bypass <span class="svc-detail"></span></span>
      <span class="svc" data-svc="worker"><span class="svc-dot"></span>Local worker</span>
      <span class="svc" data-svc="mapping"><span class="svc-dot"></span>Mapping</span>
    </div>
    <!-- Engine 1 — Claude (cloud): finds sources, verifies, hard reads -->
    <div class="engine">
      <div class="engine-controls">
        <span class="lbl">Ingestion engine</span>
        <span class="tag">Claude · cloud</span>
        <button id="bb-ingest-on" style="background:#2c6b3a">▶ Turn ON</button>
        <button id="bb-ingest-off" style="background:#8b2e2e">■ Turn OFF</button>
        <span class="bb-cap" style="font-size:11px;color:var(--civic-text-secondary,#3e3b36);font-family:var(--civic-font-mono,monospace)">Budget $<input id="bb-budget" type="number" min="1" step="10" value="500" style="width:62px;font-family:inherit;font-size:11px;padding:2px 4px;border:1px solid var(--civic-border,#ccc);border-radius:4px"></span>
        <span class="bb-cap" style="font-size:11px;color:var(--civic-text-secondary,#3e3b36);font-family:var(--civic-font-mono,monospace)">Hours <input id="bb-hours" type="number" min="0.1" step="0.5" value="8" style="width:48px;font-family:inherit;font-size:11px;padding:2px 4px;border:1px solid var(--civic-border,#ccc);border-radius:4px"></span>
        <span class="bb-cap" style="font-size:11px;color:var(--civic-text-secondary,#3e3b36);font-family:var(--civic-font-mono,monospace)">Parallel <input id="bb-parallel" type="number" min="1" max="24" step="1" value="6" style="width:42px;font-family:inherit;font-size:11px;padding:2px 4px;border:1px solid var(--civic-border,#ccc);border-radius:4px"></span>
        <span class="bb-cap" style="font-size:11px;color:var(--civic-text-secondary,#3e3b36);font-family:var(--civic-font-mono,monospace)" title="Share of governing bodies with an official source URL on record. Map Sources finds + records them so ingestion looks in the right place first.">Sources <b id="bb-src-pct" style="color:var(--civic-primary,#1a2f5c)">…</b> <span id="bb-src-when" style="color:var(--civic-text-muted,#57544d)"></span></span>
        <button id="bb-src-map" style="background:#1a2f5c" title="Full source-mapping sweep for ALL jurisdictions/bodies/offices. Records each official source URL; ingestion then tries the mapped source first.">↻ Map Sources</button>
        <span class="bb-cap" id="bb-usage" style="font-size:11px;color:var(--civic-text-secondary,#3e3b36);font-family:var(--civic-font-mono,monospace)" title="Claude plan usage — 5-hour and weekly windows. Runs/sweeps are blocked when a window is over threshold.">Plan <b id="bb-usage-val">…</b></span>
        <button id="bb-autoresume" style="background:#6b6b6b" title="When ON: pauses Claude ingestion + mapping above the 80% plan-usage gate, remembers what was running, and auto-restarts that same work once usage falls back under the resume watermark. Local ingestion keeps working throughout.">⟳ Auto-resume: …</button>
      </div>
      <div class="engine-status">
        <span id="bb-ingest-dot"></span>
        <span id="bb-ingest-state" style="font-weight:700">checking…</span>
        <span id="bb-ingest-now" style="color:var(--civic-text-secondary,#3e3b36)"></span>
        <span id="bb-ingest-run" style="font-weight:700;color:var(--state-success-fg,#2c6b3a)"></span>
        <span id="bb-ingest-count" style="font-weight:700;color:var(--civic-primary,#1a2f5c)"></span>
        <span id="bb-autoresume-state" style="color:var(--civic-text-muted)"></span>
        <span id="bb-ingest-detail" class="grow"></span>
      </div>
    </div>
    <!-- Engine 2 — Local ($0 Ollama): structures rosters, resolves people, freshness, triage -->
    <div class="engine">
      <div class="engine-controls">
        <span class="lbl">Local ingestion</span>
        <span class="tag" title="Runs entirely on local Ollama models — no Claude quota. Processes already-mapped offices while the Claude engine maps.">$0 · local Ollama</span>
        <button id="li-on" style="background:#2c6b3a">▶ Turn ON</button>
        <button id="li-off" style="background:#8b2e2e">■ Turn OFF</button>
        <span class="bb-cap" style="font-size:11px;color:var(--civic-text-muted,#57544d);font-family:var(--civic-font-mono,monospace)">structure rosters → resolve people → freshness → triage</span>
      </div>
      <div class="engine-status">
        <span id="li-dot"></span>
        <span id="li-state" style="font-weight:700">checking…</span>
        <span id="li-now" style="color:var(--civic-text-secondary,#3e3b36)"></span>
        <span id="li-count" style="font-weight:700;color:var(--civic-primary,#1a2f5c)"></span>
        <span id="li-detail" class="grow"></span>
      </div>
    </div>
  </div>
  <script>
  (function(){
    var dot=document.getElementById('bb-ingest-dot'), stateEl=document.getElementById('bb-ingest-state');
    var nowEl=document.getElementById('bb-ingest-now'), detailEl=document.getElementById('bb-ingest-detail'), countEl=document.getElementById('bb-ingest-count');
    var onBtn=document.getElementById('bb-ingest-on'), offBtn=document.getElementById('bb-ingest-off');
    var budgetEl=document.getElementById('bb-budget'), hoursEl=document.getElementById('bb-hours'), parallelEl=document.getElementById('bb-parallel'), runEl=document.getElementById('bb-ingest-run');
    function clearHi(){ var els=document.querySelectorAll('.bb-live'); for(var i=0;i<els.length;i++) els[i].classList.remove('bb-live'); }
    function applyHi(s){
      clearHi();
      var act=s.activity||{}, ids=act.inflight_ids||[];
      for(var i=0;i<ids.length;i++){ var r=document.getElementById('body-'+ids[i]); if(r) r.classList.add('bb-live'); }
      if(act.scope && act.scope!=='national'){ var sr=document.querySelector('.or-state-table tr[data-fips="'+act.scope+'"]'); if(sr) sr.classList.add('bb-live'); }
    }
    function refresh(){
      fetch('/api/ingestion/status',{cache:'no-store'}).then(function(r){return r.json();}).then(function(s){
        var act=s.activity||{};
        var globalOn=(s.keepalive==='Ready' && s.sourcing);
        var running = s.orchestrator || globalOn;
        dot.className = running ? 'on' : '';
        stateEl.textContent = running ? '● RUNNING' : '○ stopped';
        stateEl.style.color = running ? '#2c6b3a' : '#8b2e2e';
        nowEl.textContent = (running && act.message && act.phase && act.phase!=='idle') ? ('— '+act.message) : (running ? '— starting…' : '');
        var bits=['keepalive='+s.keepalive,'sourcing='+(s.sourcing?'on':'off')];
        if(act.scope && act.scope!=='national') bits.push('scope='+act.scope);
        if(s.cooldown) bits.push('cooling down');
        detailEl.textContent=bits.join(' · ');
        onBtn.disabled=globalOn; offBtn.disabled=!running;
        onBtn.style.opacity=globalOn?'0.45':'1'; offBtn.style.opacity=running?'1':'0.45';
        // Lock the budget/hours fields while a run is live (the run already
        // captured them); show live elapsed + spend vs the caps.
        if(budgetEl) budgetEl.disabled = running; if(hoursEl) hoursEl.disabled = running; if(parallelEl) parallelEl.disabled = running;
        if(runEl){
          if(running && act.spent_usd!=null){
            var eh=(act.elapsed_hours||0).toFixed(1), hc=(act.hours_cap||0);
            var sp=(act.spent_usd||0).toFixed(2), bc=(act.budget_cap||0);
            runEl.textContent = '⏱ '+eh+'/'+hc+'h  ·  $'+sp+'/'+bc;
            runEl.style.color = (act.spent_usd/Math.max(1,act.budget_cap) > 0.9) ? '#b66b0a' : '#2c6b3a';
          } else { runEl.textContent=''; }
        }
        if(countEl && s.electing_total!=null){ var ct = s.electing_verified+'/'+s.electing_total+' electing bodies'; if(s.electing_office_total!=null && s.electing_office_total>0){ ct += '  ·  '+s.electing_office_verified+'/'+s.electing_office_total+' electing offices'; } ct += ' verified'; if(s.jur_total!=null && s.jur_total>0){ ct += '  ·  '+s.jur_done+'/'+s.jur_total+' electing jurisdictions'; } if(s.jur_all_total!=null && s.jur_all_total>0){ ct += '  ·  '+s.jur_all_done+'/'+s.jur_all_total+' all jurisdictions'; } countEl.textContent = ct; }
        // Source-mapping coverage + last-mapped + LIVE sweep progress.
        var pctEl=document.getElementById('bb-src-pct'), whenEl=document.getElementById('bb-src-when'), mapBtn=document.getElementById('bb-src-map');
        if(pctEl && s.source_coverage_pct!=null){
          var raw = (s.source_bodies_with_source!=null) ? (' ('+Number(s.source_bodies_with_source).toLocaleString()+'/'+Number(s.source_bodies_total||0).toLocaleString()+')') : '';
          pctEl.textContent = s.source_coverage_pct+'%'+raw;
          pctEl.style.color = s.source_coverage_pct<10?'#8b2e2e':(s.source_coverage_pct<60?'#b66b0a':'#2c6b3a');
        }
        if(whenEl){
          if(s.source_mapping_active){
            var scs=s.source_mapping_scopes||[];
            var txt = scs.length ? scs.map(function(x){ return (x.scope?x.scope+' ':'')+x.cell; }).join('  ·  ') : (s.source_mapping_cell||'…');
            whenEl.textContent = '· ● mapping '+txt; whenEl.style.color='#2c6b3a';
          }
          else { whenEl.textContent = s.source_mapped_at ? ('· last '+String(s.source_mapped_at).slice(0,10)) : '· never mapped'; whenEl.style.color='var(--civic-text-muted,#57544d)'; }
        }
        if(mapBtn && mapBtn.textContent!=='↻ mapping…' && mapBtn.textContent!=='■ stopping…'){
          if(s.source_mapping_active){ mapBtn.textContent='■ Stop mapping'; mapBtn.dataset.active='1'; mapBtn.disabled=false; mapBtn.style.background='#8b2e2e'; }
          else { mapBtn.textContent='↻ Map Sources'; mapBtn.dataset.active='0'; mapBtn.disabled=false; mapBtn.style.background='#1a2f5c'; }
        }
        // Plan usage (server-cached; runs/sweeps are gated on it).
        var uEl=document.getElementById('bb-usage-val');
        if(uEl){
          if(s.usage_5h!=null && s.usage_5h>=0){
            uEl.textContent='5h '+Math.round(s.usage_5h)+'% · 7d '+Math.round(s.usage_7d)+'%'+(s.usage_ok===false?' ⛔':'');
            uEl.style.color = (s.usage_ok===false) ? '#8b2e2e' : (Math.max(s.usage_5h,s.usage_7d)>=60 ? '#b66b0a' : '#2c6b3a');
          } else { uEl.textContent='—'; uEl.style.color='var(--civic-text-muted,#57544d)'; }
        }
        // Auto-resume governor (Claude pathways only).
        var arBtn=document.getElementById('bb-autoresume'), arState=document.getElementById('bb-autoresume-state');
        if(arBtn){ var en=!!s.autoresume_enabled; arBtn.textContent='⟳ Auto-resume: '+(en?'ON':'OFF'); arBtn.style.background=en?'#2c6b3a':'#6b6b6b'; }
        if(arState){
          if(s.autoresume_paused){ var pf=(s.autoresume_usage&&s.autoresume_usage.fh!=null)?Math.round(s.autoresume_usage.fh):'80'; var rp=(s.autoresume_resume_pct!=null)?s.autoresume_resume_pct:25; arState.textContent='⏸ paused at '+pf+'% — resumes < '+rp+'%'; arState.style.color='#b66b0a'; }
          else if(s.autoresume_enabled){ arState.textContent='armed'; arState.style.color='#2c6b3a'; }
          else { arState.textContent=''; }
        }
        // Revert per-row Run buttons to '▶ Run' unless that row is the active scope.
        var scope=act.scope, rbs=document.querySelectorAll('.run-state-btn');
        for(var i=0;i<rbs.length;i++){ var rb=rbs[i], f=rb.getAttribute('data-fips');
          if(running && scope && f===scope){ rb.textContent='● running'; rb.disabled=true; }
          else { rb.textContent='▶ Run'; rb.disabled=false; }
        }
        applyHi(s);
      }).catch(function(){ stateEl.textContent='status unavailable'; });
    }
    function act(p){ stateEl.textContent='working…'; fetch(p,{cache:'no-store'}).then(function(){ setTimeout(refresh,1500); }).catch(function(){ setTimeout(refresh,1500); }); }
    onBtn.addEventListener('click',function(){ if(confirm('Turn the ingestion engine ON? It will run continuously (sourcing + verifying) and use Claude quota until you turn it OFF.')) act('/api/ingestion/on'); });
    offBtn.addEventListener('click',function(){ act('/api/ingestion/off'); });
    var arBtn2=document.getElementById('bb-autoresume');
    if(arBtn2) arBtn2.addEventListener('click',function(){
      var en=arBtn2.textContent.indexOf('ON')>=0;
      if(!en && !confirm('Arm auto-resume? When plan usage crosses 80%, Claude ingestion + mapping are paused and the same work auto-restarts once usage drops below the resume watermark. Local ingestion keeps running the whole time.')) return;
      fetch(en?'/api/autoresume/off':'/api/autoresume/on',{cache:'no-store'}).then(function(){ setTimeout(refresh,800); }).catch(function(){ setTimeout(refresh,800); });
    });
    var srcMapBtn=document.getElementById('bb-src-map');
    if(srcMapBtn) srcMapBtn.addEventListener('click',function(){
      // Toggle: if a sweep is active, this button stops it; otherwise start all.
      if(srcMapBtn.dataset.active==='1'){
        if(!confirm('Stop source mapping? Kills the running sweep (global or per-state). Already-mapped sources are kept.')) return;
        srcMapBtn.disabled=true; srcMapBtn.textContent='■ stopping…';
        fetch('/api/sources/map/off',{cache:'no-store'}).then(function(){ setTimeout(refresh,1200); }).catch(function(){ setTimeout(refresh,1200); });
        return;
      }
      var parallel=(parallelEl&&parallelEl.value)||'6';
      if(!confirm('Full source-mapping sweep for ALL jurisdictions, bodies, and offices?\\nFinds + records each official source URL (uses Claude quota). Runs in the background; coverage % climbs as it goes. Click again to stop.')) return;
      srcMapBtn.disabled=true; srcMapBtn.textContent='↻ mapping…';
      fetch('/api/sources/map?fips=all&parallel='+encodeURIComponent(parallel),{cache:'no-store'})
        .then(function(r){return r.json();})
        .then(function(j){ if(j&&!j.ok&&j.error){ alert(j.error); srcMapBtn.textContent='↻ Map Sources'; srcMapBtn.disabled=false; } else { srcMapBtn.textContent=(j&&j.ok)?'■ Stop mapping':'✕ err'; } setTimeout(refresh,1500); })
        .catch(function(){ srcMapBtn.textContent='✕ err'; srcMapBtn.disabled=false; });
    });
    // Per-row "Map" buttons — scoped source-mapping for one state. CAPTURE phase
    // (same as Run) so it beats the row click-to-filter handler.
    document.addEventListener('click',function(ev){
      var b = ev.target && ev.target.closest && ev.target.closest('.map-state-btn');
      if(!b) return;
      ev.preventDefault(); ev.stopPropagation();
      var fips=b.getAttribute('data-fips'), name=b.getAttribute('data-name');
      var parallel=(parallelEl&&parallelEl.value)||'6';
      if(!confirm('Map source URLs for '+name+' now?\\nFinds + records official roster pages for '+name+' (uses Claude quota). Runs in the background; stop anytime with the header\\'s Stop mapping button.')) return;
      b.disabled=true; b.textContent='⌖ starting…';
      fetch('/api/sources/map?fips='+encodeURIComponent(fips)+'&parallel='+encodeURIComponent(parallel),{cache:'no-store'})
        .then(function(r){return r.json();})
        .then(function(j){ if(j&&!j.ok&&j.error){ alert(j.error); b.textContent='⌖ Map'; b.disabled=false; } else { b.textContent=(j&&j.ok)?'● mapping':'✕ err'; setTimeout(function(){ b.textContent='⌖ Map'; b.disabled=false; },4000); } setTimeout(refresh,1500); })
        .catch(function(){ b.textContent='✕ err'; b.disabled=false; });
    }, true);
    // Per-row "Run" buttons (soft-launch one jurisdiction). CAPTURE phase so the
    // handler fires before — and overrides — the row's click-to-filter handler.
    // (The old bubble + inline stopPropagation combo silently swallowed clicks.)
    document.addEventListener('click',function(ev){
      var b = ev.target && ev.target.closest && ev.target.closest('.run-state-btn');
      if(!b) return;
      ev.preventDefault(); ev.stopPropagation();
      var fips=b.getAttribute('data-fips'), name=b.getAttribute('data-name');
      var budget=(budgetEl&&budgetEl.value)||'100', hours=(hoursEl&&hoursEl.value)||'8', parallel=(parallelEl&&parallelEl.value)||'6';
      if(!confirm('Source + verify '+name+' now?\\nCeilings: $'+budget+' budget, '+hours+'h window.\\nUses Claude quota; stops at whichever ceiling hits first (or when '+name+' is done).')) return;
      b.disabled=true; b.textContent='▶ starting…';
      fetch('/api/ingestion/run-state?fips='+encodeURIComponent(fips)+'&budget='+encodeURIComponent(budget)+'&hours='+encodeURIComponent(hours)+'&parallel='+encodeURIComponent(parallel),{cache:'no-store'})
        .then(function(r){return r.json();})
        .then(function(j){ if(j&&!j.ok&&j.error){ alert(j.error); b.textContent='▶ Run'; b.disabled=false; } else { b.textContent = (j&&j.ok)?'● running':'✕ err'; } setTimeout(refresh,1500); })
        .catch(function(){ b.textContent='✕ err'; b.disabled=false; });
    }, true);
    refresh(); setInterval(refresh,5000);
  })();
  // ── Local-ingestion engine bar (polls its own status endpoint) ──────
  (function(){
    var dot=document.getElementById('li-dot'), st=document.getElementById('li-state');
    var now=document.getElementById('li-now'), cnt=document.getElementById('li-count'), det=document.getElementById('li-detail');
    var onB=document.getElementById('li-on'), offB=document.getElementById('li-off');
    if(!dot||!onB) return;
    var PHASE={structuring:'structuring rosters…',reconciling:'reconciling to bodies…',freshness:'checking freshness…',triage:'triaging misses…',idle:'idle',stopped:'stopped',ollama_down:'⚠ Ollama (model backend) down — auto-restarting'};
    function fmt(n){ return (n==null?0:Number(n)).toLocaleString(); }
    function refreshLI(){
      fetch('/api/local-ingest/status',{cache:'no-store'}).then(function(r){return r.json();}).then(function(s){
        var running=!!s.running;
        dot.classList.toggle('on',running);
        st.textContent = running ? '● RUNNING' : '○ stopped';
        st.style.color = running ? '#2c6b3a' : '#8b2e2e';
        var ph=s.phase||'idle';
        now.textContent = running ? ('— '+(PHASE[ph]||ph)) : '';
        now.style.color = (ph==='ollama_down') ? '#b66b0a' : 'var(--civic-text-secondary,#3e3b36)';
        cnt.textContent = (s.bodies!=null) ? (fmt(s.bodies)+' bodies · '+fmt(s.members)+' members · '+fmt(s.people)+' people') : '';
        var bits=[];
        if(s.queued!=null && s.queued>0) bits.push(s.queued+' queued → Claude');
        if(running && !s.worker_alive) bits.push('starting…');
        if(s.ts) bits.push('upd '+String(s.ts).slice(11,19)+'Z');
        det.textContent = bits.join(' · ');
        onB.disabled=running; offB.disabled=!running;
        onB.style.opacity=running?'0.45':'1'; offB.style.opacity=running?'1':'0.45';
      }).catch(function(){ st.textContent='status unavailable'; });
    }
    function actLI(p,msg){ if(msg && !confirm(msg)) return; st.textContent='working…'; fetch(p,{cache:'no-store'}).then(function(){ setTimeout(refreshLI,1500); }).catch(function(){ setTimeout(refreshLI,1500); }); }
    onB.addEventListener('click',function(){ actLI('/api/local-ingest/on','Turn Local ingestion ON? Runs $0 local Ollama processing (structure → resolve people → freshness → triage) over already-mapped offices until you turn it OFF.'); });
    offB.addEventListener('click',function(){ actLI('/api/local-ingest/off'); });
    refreshLI(); setInterval(refreshLI,5000);
  })();
  // ── Services health strip (dependency status the pipeline needs) ────
  (function(){
    var el=document.getElementById('svc-health'); if(!el) return;
    var label={postgres:'Postgres DB',ollama:'Ollama (local model backend)',jina:'Jina (JS render for smart_fetch)',cf_bypass:'CF-bypass (Playwright JS tier)',worker:'Local-ingest worker',mapping:'Map Sources sweep'};
    var keys=['postgres','ollama','jina','cf_bypass','worker','mapping'];
    function refreshSvc(){
      fetch('/api/health/services',{cache:'no-store'}).then(function(r){return r.json();}).then(function(s){
        keys.forEach(function(k){
          var span=el.querySelector('.svc[data-svc="'+k+'"]'); if(!span) return;
          var dot=span.querySelector('.svc-dot'), det=span.querySelector('.svc-detail');
          var up=!!(s[k]&&s[k].up);
          dot.className='svc-dot '+(up?'up':'down');
          if(det) det.textContent=(!up)?'down':'';
          span.title=(label[k]||k)+': '+(up?('up'+(s[k].ms?(' '+s[k].ms+'ms'):'')):'DOWN');
        });
      }).catch(function(){});
    }
    refreshSvc(); setInterval(refreshSvc,15000);
  })();
  </script>

  <p class="lede">Foundational civic-architecture progress: bodies + offices + the elections they're up for. Launch-ready means this table goes green — at which point candidate ingestion + position research take over (tracked separately). The Researched-candidates column previews that next-layer work.</p>

  <!-- ── Compact totals strip ─────────────────────────────────────────── -->
  <div class="or-totals-strip">
    <span class="group">
      <span class="big" id="bb-stat-bodies">${fmt(totals.bodies)}</span>
      <span class="lbl">Bodies</span>
      <span class="detail">
        <span class="good" title="body_structure_verified = primary source fetched + structure extracted (the engine's per-run verification signal)"><a href="#sec-matrix">${fmt(totals.bodies_structure_verified)} structurally verified</a></span>
        ·
        <span class="good" title="size_authoritative = agent self-attested authoritative (stricter; the funder KPI)">${fmt(totals.bodies_authoritative)} authoritative</span>
        ·
        <span title="bodies whose last verification run was in the last 7 days">${fmt(totals.bodies_verified_run_7d)} researched 7d</span>
        ·
        <span class="warn">${fmt(totals.bodies_compiled)} unverified</span>
        ·
        <span class="bad"><a href="#sec-matrix">${fmt(totals.bodies_mismatched)} mismatched</a></span>
      </span>
    </span>
    <span class="group">
      <span class="big" id="bb-stat-offices">${fmt(totals.offices_total)}</span>
      <span class="lbl">Offices</span>
      <span class="detail">
        ${fmt(totals.offices_parented)} parented
        ·
        ${fmt(totals.offices_standalone)} standalone
        ·
        <span class="good">${fmt(totals.standalone_research_verified)} research-verified</span>
      </span>
    </span>
    <span class="group">
      <span class="big">${fmt(totals.citations_present)}</span>
      <span class="lbl">Cited</span>
      <span class="detail">bodies with ≥1 citation</span>
    </span>
    <span class="group" style="margin-left:auto">
      <a href="/methodology" target="_blank" rel="noopener" style="font-size:11px;color:var(--civic-text-muted);border:none">what does "verified" mean?</a>
    </span>
  </div>

  <!-- ── Coverage map (sits above section 1 per user request) ────────── -->
  <h2 id="sec-map" style="margin-top:.5em">Coverage map <span style="font-size:11px;color:var(--civic-text-muted);font-weight:normal;letter-spacing:0;text-transform:none">·  live</span></h2>
  <p style="font-size:13px;color:var(--civic-text-muted);margin:.3em 0 .6em">
    Visual summary of state-by-state ingestion progress. Pick a layer; hover a state for the breakdown.
  </p>
  <div class="or-map-layers" role="group" aria-label="Map layer">
    <button type="button" data-layer="composite" class="active">Composite</button>
    <button type="button" data-layer="bodies">Bodies verified</button>
    <button type="button" data-layer="offices">Offices w/ incumbent</button>
    <button type="button" data-layer="candidates">Candidates loaded</button>
  </div>
  <div id="bb-map" style="height: 460px; width: 100%; border: 1px solid var(--civic-border, #d5d3cc); border-radius: 8px; background: #f4f4f2;"></div>
  <div id="bb-map-status" style="font-size:11px;color:var(--civic-text-muted);margin:6px 0 0;font-family:var(--civic-font-mono,ui-monospace,monospace)">map loading…</div>
  <div id="bb-map-legend" style="display:flex;gap:8px;margin:8px 0 0;align-items:center;font-size:11px;font-family:var(--civic-font-mono,ui-monospace,monospace);color:var(--civic-text-muted)">
    <span style="background:#cc3333;color:#fff;padding:2px 6px;border-radius:3px">0% red</span>
    <span style="background:#dd9933;color:#fff;padding:2px 6px;border-radius:3px">25%</span>
    <span style="background:#dddd33;color:#222;padding:2px 6px;border-radius:3px">50% yellow</span>
    <span style="background:#99cc55;color:#222;padding:2px 6px;border-radius:3px">75%</span>
    <span style="background:#33cc66;color:#fff;padding:2px 6px;border-radius:3px">100% green</span>
    <span>· hover for breakdown</span>
    <span style="margin-left:10px;padding:1px 7px;border-radius:4px;background:rgb(34,170,68);color:#fff;font-weight:700">READY</span>
    <span>= all gates pass (bodies · offices · candidates · contacts) → beta + outreach</span>
  </div>

  <!-- ── 1 · By state — PRIMARY VIEW (open by default) ───────────────── -->
  <h2 id="sec-state">1 · By state — pick where to work next</h2>
  <p style="font-size:13px;color:var(--civic-text-muted);margin:.3em 0 .6em">
    Federal first, then alphabetical. Numbers pool everything sharing a state's fips:
    state legislature + judicial + boards + all county / municipal / township / school
    district / special-district bodies underneath. Click a row to filter the matrix
    below to just that state.
  </p>
  <table class="or-state-table" id="state-table">
    <thead>
      <tr>
        <th rowspan="2" data-sort="name" style="vertical-align:bottom">Jurisdiction</th>
        <th colspan="3" style="text-align:center;border-bottom:1px solid var(--civic-border);background:var(--civic-surface-sunken)">State-level</th>
        <th colspan="3" style="text-align:center;border-bottom:1px solid var(--civic-border);background:var(--civic-surface-sunken)">Local-level</th>
        <th rowspan="2" data-sort="upcoming" style="vertical-align:bottom" title="Offices up for election in this cycle (current calendar year)">Upcoming<br>elections</th>
        <th rowspan="2" data-sort="mapped" style="vertical-align:bottom" title="Governing bodies with an official roster source URL on record / total bodies. This is what the Map Sources sweep fills — the foundation ingestion reads from.">Mapped<br>sources</th>
        <th rowspan="2" data-sort="status" style="vertical-align:bottom">Status</th>
        <th rowspan="2" style="vertical-align:bottom" title="Soft-launch sourcing + verification for just this jurisdiction">Run</th>
      </tr>
      <tr>
        <th data-sort="sb"  title="State legislature, judicial, statewide boards — verified/total">Bodies</th>
        <th data-sort="ssa" title="Statewide standalone offices (governor, AG, secretary of state, etc) — verified/total">Standalone</th>
        <th data-sort="sp"  title="State-level positions verified / total (sum of body seats + standalone offices)">Positions</th>
        <th data-sort="lb"  title="County/municipal/township/school/special-district bodies — verified/total">Bodies</th>
        <th data-sort="lsa" title="Local standalone offices (mayors, sheriffs, DAs, judges) — verified/total">Standalone</th>
        <th data-sort="lp"  title="Local positions verified / total">Positions</th>
      </tr>
    </thead>
    <tbody id="state-tbody">
${rollupRows}
    </tbody>
  </table>
  <div id="bb-state-status" style="font-size:11px;color:var(--civic-text-muted);margin:6px 0 0;font-family:var(--civic-font-mono,ui-monospace,monospace)">live upcoming-elections counts loading…</div>

  <!-- Sections 2-8 live on a separate view (/admin/office-review/matrices); this
       page shows a link, that page shows only #matrices-block. Same render, CSS-gated. -->
  <p id="matrices-link" class="lede" style="margin-top:1.4em"><a href="/admin/office-review/matrices" style="color:var(--civic-primary,#1a2f5c);font-weight:600;text-decoration:none;border-bottom:1px dotted currentColor">▸ Detail matrices — entities · chamber types · sanity check · governing-body matrix · standalone offices · ingestion health →</a></p>
  <div id="matrices-block">
  <p style="margin:0 0 1.1em"><a href="/admin/office-review" style="color:var(--civic-primary,#1a2f5c);font-weight:600;font-family:var(--civic-font-mono,ui-monospace,monospace);font-size:13px;text-decoration:none">← back to office review</a></p>
  <!-- ── 2 · Entities (collapsed by default) ──────────────────────────── -->
  <details class="or-section">
    <summary><h2 id="sec-entities" style="display:inline-block;border:none;padding:0;margin:0;cursor:pointer">2 · Entities (${fmt(entities.length)} jurisdictions)</h2></summary>
    <div class="or-section-body" style="margin-top:.6em">
  <p style="font-size:13px;color:var(--civic-text-muted);margin:.3em 0 .6em">
    One row per jurisdiction with at least one body or standalone office —
    cities, counties, townships, school districts, special districts, state
    agencies. This is the unit the user organizes work around: "Salt Lake
    City" has a council + mayor + prosecutor + municipal court, all in one
    row. Click a row to filter the body matrix below; standalone offices
    for the entity are shown in section 6.
  </p>
  <div class="filter-row">
    <label for="esearch">Search <input id="esearch" type="search" placeholder="entity name, type…" style="min-width:240px"></label>
    <label for="estate">State
      <select id="estate"><option value="">all</option>${
        Array.from(new Set(entities.map(e => e.fips_state).filter((s): s is string => !!s))).sort().map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join("")
      }</select>
    </label>
    <label for="etype">Type
      <select id="etype"><option value="">all</option>${
        Array.from(new Set(entities.map(e => e.type))).sort().map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join("")
      }</select>
    </label>
    <label for="elevel">Level
      <select id="elevel"><option value="">all</option>${
        Array.from(new Set(entities.map(e => e.level))).sort().map(l => `<option value="${esc(l)}">${esc(l)}</option>`).join("")
      }</select>
    </label>
    <label for="emismatch">Mismatch only <input id="emismatch" type="checkbox"></label>
    <label for="enostandalone">Has standalone offices only <input id="enostandalone" type="checkbox"></label>
    <button id="eclear" type="button">Clear</button>
    <span id="e-counter"></span>
  </div>
  <table id="entities-table">
    <thead><tr>
      <th data-sort="name">Entity</th>
      <th data-sort="type">Type</th>
      <th data-sort="state">State</th>
      <th data-sort="bodies">Bodies</th>
      <th data-sort="standalone">Standalone offices</th>
      <th data-sort="positions">Positions</th>
      <th data-sort="verified">Bodies verified</th>
      <th data-sort="mismatch">Mismatched</th>
    </tr></thead>
    <tbody id="erows">
${
  // SSR-sort: most-mismatched first, then most-positions, then alphabetical.
  // Cap at 500 rows in SSR to keep page size manageable — filter UI lets
  // the user surface the rest. (Same pattern as the body matrix.)
  [...entities]
    .sort((a, b) => {
      if (a.bodies_mismatched !== b.bodies_mismatched) return b.bodies_mismatched - a.bodies_mismatched;
      if (a.total_positions !== b.total_positions) return b.total_positions - a.total_positions;
      return a.name.localeCompare(b.name);
    })
    .map((e) => {
      const vPct = pct(e.bodies_verified, e.bodies_count);
      const vPill = e.bodies_count === 0 ? '' : (vPct === 100 ? '<span class="pill auth-yes">all verified</span>' : vPct > 0 ? `<span class="pill cite-yes">${vPct}%</span>` : `<span class="pill auth-no">${e.bodies_verified}/${e.bodies_count}</span>`);
      return `<tr class="erow click-row" data-entity-id="${esc(e.id)}" data-entity-name="${esc(e.name)}" data-state="${esc(e.fips_state ?? '')}" data-type="${esc(e.type)}" data-level="${esc(e.level)}" data-mismatch="${e.bodies_mismatched > 0 ? '1' : '0'}" data-has-standalone="${e.standalone_offices_count > 0 ? '1' : '0'}">
        <td>${esc(e.name)}${e.short_name ? ` <span style="color:var(--civic-text-muted);font-size:11px">(${esc(e.short_name)})</span>` : ''}</td>
        <td><span style="font-family:var(--civic-font-mono);font-size:11px;color:var(--civic-text-secondary)">${esc(e.type)}</span></td>
        <td class="num"><span style="font-family:var(--civic-font-mono);font-size:11px">${esc(e.fips_state ?? '—')}</span></td>
        <td class="num">${fmt(e.bodies_count)}${e.bodies_seats > 0 ? ` <span style="color:var(--civic-text-muted);font-size:11px">(${fmt(e.bodies_seats)} seats)</span>` : ''}</td>
        <td class="num">${fmt(e.standalone_offices_count)}${e.standalone_offices_verified > 0 ? ` <span class="good" style="color:var(--state-success-fg,#2c6b3a);font-size:11px">(${fmt(e.standalone_offices_verified)} ✓)</span>` : ''}</td>
        <td class="num"><strong>${fmt(e.total_positions)}</strong></td>
        <td class="num">${vPill}</td>
        <td class="num">${e.bodies_mismatched > 0 ? `<span class="bad" style="color:var(--state-error-fg,#8b2e2e);font-weight:600">${fmt(e.bodies_mismatched)}</span>` : '0'}</td>
      </tr>`;
    })
    .slice(0, 500)
    .join("\n")
}
    </tbody>
  </table>
    </div>
  </details>

  <!-- ── 3 · By chamber type (collapsed by default) ───────────────────── -->
  <details class="or-section">
    <summary><h2 style="display:inline-block;border:none;padding:0;margin:0;cursor:pointer">3 · By chamber type</h2></summary>
    <div class="or-section-body" style="margin-top:.6em">
  <table>
    <thead><tr><th>chamber_type</th><th>bodies</th><th>seats</th><th>verified</th><th>verified %</th></tr></thead>
    <tbody>
${chamberRows}
    </tbody>
  </table>
    </div>
  </details>

  <!-- ── 4 · State legislative sanity check (collapsed) ───────────────── -->
  <details class="or-section">
    <summary><h2 style="display:inline-block;border:none;padding:0;margin:0;cursor:pointer">4 · State legislative sanity check</h2></summary>
    <div class="or-section-body" style="margin-top:.6em">
  <p style="font-size:13px;color:var(--civic-text-muted);margin:.3em 0 .6em">Catalogued body size vs expected size per state constitution / Ballotpedia. Mismatches indicate either undercount (offices not catalogued) or overcount (residual dups).</p>
  <table>
    <thead><tr><th>State</th><th>Chamber</th><th>Catalogued</th><th>Expected</th><th>Δ</th></tr></thead>
    <tbody>
${sanityRows}
    </tbody>
  </table>
    </div>
  </details>

  <!-- ── 5 · Governing-body matrix (collapsed) ───────────────────────── -->
  <details class="or-section">
    <summary><h2 id="sec-matrix" style="display:inline-block;border:none;padding:0;margin:0;cursor:pointer">5 · Governing-body matrix (${fmt(bodies.length)} bodies)</h2></summary>
    <div class="or-section-body" style="margin-top:.6em">
  <div class="filter-row">
    <label for="bsearch">Search <input id="bsearch" type="search" placeholder="body, jurisdiction…" style="min-width:240px"></label>
    <label for="bchamber">Chamber
      <select id="bchamber"><option value="">all</option>${[...byChamberType.keys()].map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("")}</select>
    </label>
    <label for="bauth">Verified
      <select id="bauth"><option value="">all</option><option value="1">verified</option><option value="0">compiled</option></select>
    </label>
    <label for="bstate">State
      <select id="bstate"><option value="">all</option>${
        // Build a sorted unique list of fips_state codes from bodies.
        // The state table's click handler sets this select to the row's
        // data-fips so the matrix narrows to just that state's bodies.
        Array.from(new Set(bodies.map(b => b.fips_state).filter((s): s is string => !!s))).sort().map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join("")
      }</select>
    </label>
    <label for="bmismatch">Mismatch only <input id="bmismatch" type="checkbox"></label>
    <button id="bclear" type="button">Clear</button>
    <span id="b-counter"></span>
  </div>
  <table id="bodies-table">
    <thead><tr>
      <th data-sort="name">Canonical name</th>
      <th data-sort="jur">Jurisdiction</th>
      <th data-sort="chamber">Chamber</th>
      <th data-sort="size">Size</th>
      <th data-sort="attached">Attached</th>
      <th data-sort="auth">Verified</th>
      <th data-sort="cites">Citations</th>
      <th data-sort="verified_by">Verified by</th>
    </tr></thead>
    <tbody id="brows">
${bodyRows}
    </tbody>
  </table>
    </div>
  </details>

  <!-- ── 6 · Standalone offices by office_type (collapsed) ────────────── -->
  <details class="or-section">
    <summary><h2 id="sec-standalone" style="display:inline-block;border:none;padding:0;margin:0;cursor:pointer">6 · Standalone offices by office_type (${fmt(standalone.length)} offices)</h2></summary>
    <div class="or-section-body" style="margin-top:.6em">
  <p style="font-size:13px;color:var(--civic-text-muted);margin:.3em 0 .6em">Offices with no governing_body_id — executives, single-judge courts, single-officer roles.</p>
  <table>
    <thead><tr><th>office_type slug</th><th>count</th></tr></thead>
    <tbody>
${standaloneRows}
    </tbody>
  </table>
    </div>
  </details>

  <!-- ── 7 · Verified standalone offices (collapsed) ──────────────────── -->
  <details class="or-section">
    <summary><h2 style="display:inline-block;border:none;padding:0;margin:0;cursor:pointer">7 · Verified standalone offices (${fmt(totals.standalone_research_verified)} researched)</h2></summary>
    <div class="or-section-body" style="margin-top:.6em">
  <p style="font-size:13px;color:var(--civic-text-muted);margin:.3em 0 .6em">Standalone offices that have been researched by a per-level agent. Editorial content (description, powers, salary, vacancy rules, current officeholder) stored in offices.meta.research_extracted.</p>
${totals.standalone_research_started === 0
    ? '<p style="font-size:13px;color:var(--civic-text-muted);font-style:italic">No standalone offices researched yet. Run <code>npx tsx --env-file=.env.local scripts/research-office.ts --office-id &lt;uuid&gt;</code> or fire the <code>research-bodies.manual</code> Inngest event.</p>'
    : `<table>
    <thead><tr><th>Canonical name</th><th>Jurisdiction</th><th>office_type</th><th>Verified</th><th>Citations</th><th>Verified by</th><th>Verified at</th></tr></thead>
    <tbody>
${standalone
  .filter((s) => s.research_last_verified_at !== null)
  .sort((a, b) => (b.research_last_verified_at ?? '').localeCompare(a.research_last_verified_at ?? ''))
  .slice(0, 100)
  .map((s) => {
    const pill = s.research_verified
      ? '<span class="pill auth-yes">verified</span>'
      : '<span class="pill auth-no">attempted</span>';
    const verifiedAt = s.research_last_verified_at
      ? new Date(s.research_last_verified_at).toISOString().slice(0, 16).replace('T', ' ')
      : '—';
    return `<tr><td>${esc(s.canonical_name)}</td><td>${esc(s.jurisdiction_name)}</td><td>${esc(s.office_type_slug ?? '—')}</td><td class="num">${pill}</td><td class="num">${s.research_citation_count}</td><td>${esc(s.research_verified_by ?? '—')}</td><td>${verifiedAt}</td></tr>`;
  })
  .join('\n')}
    </tbody>
  </table>`}
    </div>
  </details>

  <!-- ── 8 · Ingestion health (collapsed) ─────────────────────────────── -->
  <details class="or-section">
    <summary><h2 style="display:inline-block;border:none;padding:0;margin:0;cursor:pointer">8 · Ingestion health <span style="font-size:11px;color:var(--civic-text-muted);font-weight:normal;letter-spacing:0;text-transform:none">·  body_research adapter · live</span></h2></summary>
    <div class="or-section-body" style="margin-top:.6em">
  <div id="bb-ingestion-health" style="display:grid;grid-template-columns:repeat(6,1fr);gap:8px;font-size:12px;font-family:var(--civic-font-mono,ui-monospace,monospace);margin:6px 0 14px">
    <div class="or-stat good"><div class="num" id="bb-ih-success" style="font-size:18px">—</div><div class="label">Success 7d</div></div>
    <div class="or-stat warn"><div class="num" id="bb-ih-partial" style="font-size:18px">—</div><div class="label">Partial 7d</div></div>
    <div class="or-stat bad"><div class="num" id="bb-ih-failed" style="font-size:18px">—</div><div class="label">Failed 7d</div></div>
    <div class="or-stat bad"><div class="num" id="bb-ih-unproductive" style="font-size:18px">—</div><div class="label">Unproductive 7d</div></div>
    <div class="or-stat"><div class="num" id="bb-ih-running" style="font-size:18px">—</div><div class="label">Currently running</div></div>
    <div class="or-stat"><div class="num" id="bb-ih-rate" style="font-size:18px">—</div><div class="label">Success rate 7d</div></div>
  </div>
  <div id="bb-ih-failures" style="font-size:11px;color:var(--civic-text-muted);font-family:var(--civic-font-mono,ui-monospace,monospace);margin:0 0 10px">recent failures will appear here</div>
    </div>
  </details>
  </div><!-- /matrices-block -->
</div>
<script>
(function(){
  const tbody = document.getElementById('brows');
  if (!tbody) return;
  const rows = Array.from(tbody.querySelectorAll('tr.brow'));
  const counter = document.getElementById('b-counter');
  const $ = (id) => document.getElementById(id);
  const search = $('bsearch'), chamber = $('bchamber'), auth = $('bauth'), state = $('bstate'), mismatchOnly = $('bmismatch'), clearBtn = $('bclear');
  const INITIAL_CAP = ${initialDisplayCap};
  function render() {
    const q = (search.value || '').toLowerCase().trim();
    const c = chamber.value;
    const a = auth.value;
    const st = state.value;
    const m = mismatchOnly.checked;
    const hasFilter = !!(q || c || a || st || m);
    let visible = rows.filter(r => {
      if (c && r.dataset.chamber !== c) return false;
      if (a && r.dataset.auth !== a) return false;
      if (st && r.dataset.state !== st) return false;
      if (m && r.dataset.mismatch !== '1') return false;
      if (!q) return true;
      return r.textContent.toLowerCase().includes(q);
    });
    if (!hasFilter && visible.length > INITIAL_CAP) visible = visible.slice(0, INITIAL_CAP);
    tbody.innerHTML = '';
    visible.forEach(r => tbody.appendChild(r));
    counter.textContent = hasFilter ? (visible.length + ' shown (filtered from ' + rows.length + ')') : ('top ' + visible.length + ' of ' + rows.length + ' (filter for more)');
  }
  [search, chamber, auth, state, mismatchOnly].forEach(el => { el.addEventListener('input', render); el.addEventListener('change', render); });
  clearBtn.addEventListener('click', () => { search.value=''; chamber.value=''; auth.value=''; state.value=''; mismatchOnly.checked=false; render(); });
  render();

  // ── Click-to-drill: state table → entities table ────────────────────
  // Clicking any row in #state-table filters the entities section to that
  // state's jurisdictions AND scrolls there. Entities are the user's
  // actual work unit (a city, a county, …), so we land them on entities
  // first, not on the 74k-row body matrix.
  document.querySelectorAll('#state-table tbody tr.click-row').forEach(function(row){
    row.addEventListener('click', function(){
      var f = row.getAttribute('data-fips') || '';
      if (!f) return;
      var estate = document.getElementById('estate');
      if (estate) {
        estate.value = f;
        estate.dispatchEvent(new Event('change'));
      }
      var entitiesEl = document.getElementById('entities-table');
      if (entitiesEl) entitiesEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });

  // ── Entity-table filtering + click-to-drill ─────────────────────────
  // Mirror of the body-matrix filter logic, applied to #erows. Click an
  // entity row to filter the body matrix below to that entity's bodies
  // AND scroll there. (Standalone offices for the entity show separately
  // in section 7 — we could also filter that list in a future pass.)
  var etbody = document.getElementById('erows');
  if (etbody) {
    var erows = Array.from(etbody.querySelectorAll('tr.erow'));
    var $e = function(id){ return document.getElementById(id); };
    var esearch = $e('esearch'), estate = $e('estate'), etype = $e('etype'),
        elevel = $e('elevel'), emism = $e('emismatch'), enostan = $e('enostandalone'),
        eclear = $e('eclear'), ecounter = $e('e-counter');
    var EINIT_CAP = 250;
    function erender(){
      var q = (esearch.value || '').toLowerCase().trim();
      var st = estate.value;
      var tp = etype.value;
      var lv = elevel.value;
      var m = emism.checked;
      var ns = enostan.checked;
      var hasFilter = !!(q || st || tp || lv || m || ns);
      var visible = erows.filter(function(r){
        if (st && r.dataset.state !== st) return false;
        if (tp && r.dataset.type !== tp) return false;
        if (lv && r.dataset.level !== lv) return false;
        if (m && r.dataset.mismatch !== '1') return false;
        if (ns && r.dataset.hasStandalone !== '1') return false;
        if (!q) return true;
        return r.textContent.toLowerCase().includes(q);
      });
      if (!hasFilter && visible.length > EINIT_CAP) visible = visible.slice(0, EINIT_CAP);
      etbody.innerHTML = '';
      visible.forEach(function(r){ etbody.appendChild(r); });
      ecounter.textContent = hasFilter ? (visible.length + ' shown (filtered from ' + erows.length + ')') : ('top ' + visible.length + ' of ' + erows.length + ' (filter for more)');
    }
    [esearch, estate, etype, elevel, emism, enostan].forEach(function(el){
      el.addEventListener('input', erender);
      el.addEventListener('change', erender);
    });
    eclear.addEventListener('click', function(){
      esearch.value=''; estate.value=''; etype.value=''; elevel.value=''; emism.checked=false; enostan.checked=false;
      erender();
    });
    erender();

    // Entity-row click → filter body matrix to that entity's jurisdiction.
    // We carry state via data-state (fips), then narrow by searching name —
    // the body matrix has no entity-id column, but bodies named after their
    // jurisdiction are reliable (e.g. "Salt Lake City Council" filtered by
    // "salt lake city" matches).
    erows.forEach(function(row){
      row.addEventListener('click', function(){
        var stateFips = row.getAttribute('data-state') || '';
        var entityName = row.getAttribute('data-entity-name') || '';
        if (stateFips) {
          state.value = stateFips;
        }
        if (entityName) {
          search.value = entityName;
        }
        render();
        var matrix = document.getElementById('bodies-table');
        if (matrix) matrix.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
  }

  // ── State-table hydration from /api/state-progress ───────────────────
  // The SSR rows show body counts (from byStateRollup) but not live offices /
  // incumbent counts. Pull those from the fast aggregation endpoint and
  // fill in the "Offices (live)" + "w/ incumbent" + "Status" cells.
  // Status pill rule:
  //   empty   — bodies_total === 0 (catalog gap)
  //   todo    — bodies_total > 0 but verified === 0
  //   partial — bodies_verified > 0 but not all
  //   done    — bodies_verified === bodies_total
  async function hydrateStateTable() {
    var statusEl = document.getElementById('bb-state-status');
    try {
      var r = await fetch('/api/state-progress', { cache: 'no-store' });
      var d = await r.json();
      var byFips = {};
      for (var i=0; i<(d.rows||[]).length; i++) byFips[d.rows[i].fips] = d.rows[i];
      // Render a "verified/total" cell identical to the SSR ratio() helper so
      // the live values match the initial render exactly.
      function liveRatio(verified, total){
        if (total === 0) return '<span style="color:var(--civic-text-muted)">—</span>';
        var cls = verified === total ? 'good' : verified === 0 ? 'bad' : 'warn';
        var color = cls === 'good' ? 'var(--state-success-fg,#2c6b3a)' : cls === 'bad' ? 'var(--state-error-fg,#8b2e2e)' : 'var(--state-warn-fg,#b66b0a)';
        return '<span style="color:'+color+';font-weight:600">'+verified.toLocaleString()+'</span><span style="color:var(--civic-text-muted)">/'+total.toLocaleString()+'</span>';
      }
      document.querySelectorAll('#state-table tbody tr.click-row').forEach(function(row){
        var f = row.getAttribute('data-fips') || '';
        var p = byFips[f];
        if (!p) return;
        // Live verified-ratio cells (bodies/offices/positions, state + local).
        // These mirror byStateRollup so a Run is reflected without a full reload.
        var sPosV = (p.state_bodies_seats_verified||0) + (p.state_standalone_verified||0);
        var sPosT = (p.state_bodies_seats||0) + (p.state_standalone||0);
        var lPosV = (p.local_bodies_seats_verified||0) + (p.local_standalone_verified||0);
        var lPosT = (p.local_bodies_seats||0) + (p.local_standalone||0);
        function setCell(sel, v, t){ var c = row.querySelector(sel); if (c && t != null) c.innerHTML = liveRatio(v||0, t||0); }
        setCell('.cell-sb', p.state_bodies_verified, p.state_bodies);
        setCell('.cell-ss', p.state_standalone_verified, p.state_standalone);
        setCell('.cell-sp', sPosV, sPosT);
        setCell('.cell-lb', p.local_bodies_verified, p.local_bodies);
        setCell('.cell-ls', p.local_standalone_verified, p.local_standalone);
        setCell('.cell-lp', lPosV, lPosT);
        // Status pill recomputed from the all-positions ratio.
        var allV = sPosV + lPosV, allT = sPosT + lPosT;
        var sc = row.querySelector('.cell-status');
        if (sc && (p.state_bodies != null)) {
          var cls, lbl;
          if (allT === 0) { cls='empty'; lbl='no data'; }
          else if (allV === 0) { cls='todo'; lbl='to verify'; }
          else if (allV < allT) { cls='partial'; lbl='in progress'; }
          else { cls='done'; lbl='verified'; }
          sc.innerHTML = '<span class="status-pill '+cls+'">'+lbl+'</span>';
        }
        // Upcoming-elections column: count of offices up for election in
        // the current calendar year. Federal row is populated now that the
        // SQL aggregations include nation-type jurisdictions under 'US'.
        var uc = row.querySelector('.upcoming-cell');
        if (uc) {
          var n = p.positions_with_upcoming_election || 0;
          if (n === 0) {
            uc.innerHTML = '<span style="color:var(--civic-text-muted)">0</span>';
          } else {
            uc.innerHTML = '<strong>' + n.toLocaleString() + '</strong>';
          }
        }
        // (Mapped-sources column is server-rendered from the rollup; no poll.)
      });
      if (statusEl) statusEl.textContent = 'updated ' + new Date(d.generated_at).toLocaleTimeString() + ' · ' + (d.rows||[]).length + ' states';
    } catch (e) {
      if (statusEl) statusEl.textContent = 'state-progress fetch failed: ' + e.message;
    }
  }
  hydrateStateTable();
  setInterval(hydrateStateTable, 10000);  // live verified ratios update ~10s after a Run completes

  // If linked from candidate-review via #body-<uuid>, ensure that row is in
  // the rendered DOM (it may have been clipped by the 250-row initial cap),
  // then scroll to it + highlight via :target.
  const hash = window.location.hash;
  if (hash && hash.startsWith('#body-')) {
    const targetId = hash.slice(1);
    if (!document.getElementById(targetId)) {
      // Find the row in our cached set and inject it at top of tbody
      const target = rows.find(r => r.id === targetId);
      if (target) {
        tbody.insertBefore(target.cloneNode(true), tbody.firstChild);
        // The browser doesn't re-trigger :target after DOM mutation; re-set
        // the hash to force a re-evaluation.
        const h = hash;
        history.replaceState(null, '', '#');
        setTimeout(() => { window.location.hash = h; }, 0);
      }
    }
    setTimeout(() => {
      const el = document.getElementById(targetId);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 100);
  }
})();
</script>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=" crossorigin=""></script>
<script>
// Coverage map: choropleth of US states + DC + territories, shaded by
// composite progress score. Auto-refreshes every 20s. Hover shows a
// breakdown (bodies verified / offices populated / etc).
(function(){
  if (typeof L === 'undefined') {
    const s = document.getElementById('bb-map-status');
    if (s) s.textContent = 'Leaflet failed to load (offline?). Map disabled.';
    return;
  }
  const mapEl = document.getElementById('bb-map');
  if (!mapEl) return;

  // Color scale: red (0) → orange → yellow (0.5) → light green → green (1)
  // Composite score from /api/state-progress weights bodies-verified at 0.6 and
  // offices-with-tenure at 0.4. Candidates dimension will be added once we have
  // candidates data — that'll push the green further when validated.
  function color(score) {
    if (score == null || isNaN(score)) return '#e7e3d8'; // unknown grey
    const stops = [
      { s: 0.00, c: [204,  51,  51] }, // red
      { s: 0.25, c: [221, 153,  51] }, // orange
      { s: 0.50, c: [221, 221,  51] }, // yellow
      { s: 0.75, c: [153, 204,  85] }, // light green
      { s: 1.00, c: [ 51, 204, 102] }, // green
    ];
    for (let i = 0; i < stops.length - 1; i++) {
      const a = stops[i], b = stops[i + 1];
      if (score <= b.s) {
        const t = (score - a.s) / (b.s - a.s || 1);
        const r = Math.round(a.c[0] + (b.c[0] - a.c[0]) * t);
        const g = Math.round(a.c[1] + (b.c[1] - a.c[1]) * t);
        const bl = Math.round(a.c[2] + (b.c[2] - a.c[2]) * t);
        return 'rgb(' + r + ',' + g + ',' + bl + ')';
      }
    }
    return 'rgb(51,204,102)';
  }

  const map = L.map('bb-map', { zoomControl: true, attributionControl: false }).setView([39.8, -96.5], 4);
  // Light tile layer for context.
  L.tileLayer('https://cartodb-basemaps-{s}.global.ssl.fastly.net/light_all/{z}/{x}/{y}.png', {
    maxZoom: 8, minZoom: 3, subdomains: 'abcd',
  }).addTo(map);

  let geoLayer = null;
  let lastProgress = {};
  // Active layer — wired up via the segmented control above the map.
  // Maps to the *score field name* on each /api/state-progress row.
  let currentLayer = 'composite'; // composite | bodies | offices | candidates
  const LAYER_FIELD = {
    composite:  'score',
    bodies:     'score_bodies',
    offices:    'score_offices',
    candidates: 'score_candidates',
  };
  const LAYER_LABEL = {
    composite:  'Composite (0.5·bodies + 0.3·offices + 0.2·candidates)',
    bodies:     'Bodies verified',
    offices:    'Offices with current incumbent',
    candidates: 'Candidates loaded (active / bodies)',
  };

  function update(feature, layer, stats) {
    const field = LAYER_FIELD[currentLayer] || 'score';
    const score = stats ? stats[field] : null;
    // READY states render solid green regardless of layer/score — "ready" =
    // all four rollout gates pass (bodies, offices, candidates, contacts) and
    // the state can go out for beta + candidate outreach.
    const isReady = !!(stats && stats.ready);
    layer.setStyle({
      fillColor: isReady ? 'rgb(34,170,68)' : color(score),
      fillOpacity: 0.78,
      color: isReady ? '#0c5a26' : '#1a1917',
      weight: isReady ? 1.4 : 0.6,
    });
    const name = feature.properties.NAME || feature.properties.name || 'Unknown';
    const pct = (n, d) => d > 0 ? Math.round(100 * n / d) + '%' : '—';
    if (stats) {
      // Readiness checklist — mirrors the state-by-state rollout gates.
      let readyHtml = '';
      const rc = stats.ready_checks;
      if (rc) {
        const line = (label, c) => {
          const mark = c.ok ? '<span style="color:#2c6b3a">✓</span>' : '<span style="color:#8b2e2e">✗</span>';
          const detail = c.den > 0 ? (c.num + '/' + c.den + ' (' + pct(c.num, c.den) + ')') : 'n/a';
          return mark + ' ' + label + ': ' + detail + '<br>';
        };
        readyHtml = '<br><strong>' + (stats.ready ? '🟢 READY — beta + outreach' : 'Readiness') + '</strong><br>'
          + line('Bodies verified', rc.bodies)
          + line('Offices resolved', rc.offices)
          + line('Candidates loaded', rc.candidates)
          + line('Candidates contactable', rc.contacts);
      }
      layer.bindTooltip(
        '<strong>' + name + (isReady ? ' 🟢' : '') + '</strong><br>'
        + 'Active layer: <em>' + LAYER_LABEL[currentLayer] + '</em><br>'
        + 'Score: ' + (score == null ? '—' : (score * 100).toFixed(0) + '%') + '<br>'
        + '<br>'
        + 'Bodies verified: ' + (stats.bodies_verified || 0) + ' / ' + (stats.bodies_total || 0) + ' (' + pct(stats.bodies_verified, stats.bodies_total) + ')<br>'
        + 'Offices w/ incumbent: ' + (stats.offices_with_tenure || 0) + ' / ' + (stats.offices_total || 0) + ' (' + pct(stats.offices_with_tenure, stats.offices_total) + ')<br>'
        + 'Candidacies (active/total): ' + (stats.candidacies_active || 0) + ' / ' + (stats.candidacies_total || 0)
        + readyHtml,
        { sticky: true }
      );
    } else {
      layer.bindTooltip('<strong>' + name + '</strong><br>(no data — likely not in catalog yet)', { sticky: true });
    }
  }

  function applyProgress(progress) {
    lastProgress = progress;
    if (!geoLayer) return;
    geoLayer.eachLayer((layer) => {
      // PublicaMundi US-states GeoJSON puts the FIPS code at feature.id
      // (top-level, per the GeoJSON spec). Other sources stash it in
      // properties.STATE or properties.id — check all three so we work
      // regardless of which upstream the proxy was lucky enough to reach.
      const f = layer.feature;
      const raw = String(f.id ?? f.properties?.STATE ?? f.properties?.id ?? '');
      const fips = raw.padStart(2, '0');
      const stats = progress[fips];
      update(f, layer, stats);
    });
  }

  async function refresh() {
    const status = document.getElementById('bb-map-status');
    try {
      const r = await fetch('/api/state-progress', { cache: 'no-store' });
      const d = await r.json();
      const byFips = {};
      for (const row of (d.rows || [])) byFips[row.fips] = row;
      applyProgress(byFips);
      if (status) status.textContent = 'updated ' + new Date(d.generated_at).toLocaleTimeString() + ' · ' + (d.rows || []).length + ' jurisdictions reporting';
    } catch (e) {
      if (status) status.textContent = 'progress fetch failed: ' + e.message;
    }
  }
  async function refreshStats() {
    try {
      const r = await fetch('/api/header-stats', { cache: 'no-store' });
      const d = await r.json();
      const setN = (id, v) => { const el = document.getElementById(id); if (el && typeof v === 'number') el.textContent = v.toLocaleString(); };
      setN('bb-stat-bodies', d.bodies_total);
      setN('bb-stat-bodies-auth', d.bodies_verified);
    } catch {}
  }

  // Fetch the US states GeoJSON from our same-origin server. This avoids
  // the previous browser-to-CDN fetches that ad blockers and corporate
  // proxies were silently killing — the map would stick on "map loading…"
  // because the upstream request hung forever rather than rejecting.
  async function loadGeo() {
    const r = await fetch('/api/us-states.geojson');
    if (!r.ok) {
      throw new Error('server says ' + r.status + ' — ' + (await r.text()).slice(0, 120));
    }
    return await r.json();
  }

  const mapStatus = document.getElementById('bb-map-status');
  if (mapStatus) mapStatus.textContent = 'loading state polygons…';
  loadGeo().then((geo) => {
    if (mapStatus) mapStatus.textContent = 'loading per-state scores…';
    geoLayer = L.geoJSON(geo, {
      style: { fillColor: '#e7e3d8', fillOpacity: 0.5, color: '#888', weight: 0.5 },
    }).addTo(map);
    return refresh().then(refreshStats);
  }).catch((e) => {
    if (mapStatus) mapStatus.textContent = 'GeoJSON load failed: ' + e.message + ' — map shows tiles only.';
    // eslint-disable-next-line no-console
    console.error('[coverage map] GeoJSON failed:', e);
  });

  // Auto-refresh both progress + header stats every 20s.
  setInterval(refresh, 20000);
  setInterval(refreshStats, 20000);

  // ── Map layer-toggle wiring ─────────────────────────────────────────
  // Click any of the segmented buttons above the map to recolor the
  // choropleth by that layer. No re-fetch needed — applyProgress() just
  // reads a different score field from the cached lastProgress.
  document.querySelectorAll('.or-map-layers button').forEach(function(btn){
    btn.addEventListener('click', function(){
      var layer = btn.getAttribute('data-layer');
      if (!layer) return;
      currentLayer = layer;
      document.querySelectorAll('.or-map-layers button').forEach(function(b){ b.classList.toggle('active', b === btn); });
      applyProgress(lastProgress);
    });
  });

  // Ingestion health — populates the per-status cards + recent-failures
  // strip from /api/ingestion-health. Refresh every 30s.
  async function refreshIngestionHealth() {
    try {
      const r = await fetch('/api/ingestion-health', { cache: 'no-store' });
      const d = await r.json();
      const last7 = d.last_7d || {};
      const setN = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = typeof v === 'number' ? v.toLocaleString() : (v == null ? '0' : String(v)); };
      setN('bb-ih-success', (last7.success || 0) + (last7.unchanged || 0));
      setN('bb-ih-partial', last7.partial || 0);
      setN('bb-ih-failed', last7.failed || 0);
      setN('bb-ih-unproductive', last7.unproductive || 0);
      setN('bb-ih-running', last7.running || 0);
      const rate = d.success_rate_7d;
      const rateEl = document.getElementById('bb-ih-rate');
      if (rateEl) rateEl.textContent = rate == null ? '—' : (rate * 100).toFixed(0) + '%';
      const stuck = d.stuck_running || 0;
      const failures = (d.recent_failures || []).slice(0, 5);
      const failEl = document.getElementById('bb-ih-failures');
      if (failEl) {
        if (stuck === 0 && failures.length === 0) {
          failEl.textContent = "No failures in last 24h. " + ((last7.success || 0) + (last7.partial || 0) + (last7.unchanged || 0) > 0 ? "Ingestion engine looks healthy." : "Engine has not run yet today.");
          failEl.style.color = 'var(--state-success-fg, #2c6b3a)';
        } else {
          const stuckMsg = stuck > 0 ? \`<strong style="color:var(--state-error-fg,#8b2e2e)">⚠ \${stuck} run(s) stuck in 'running' >30 min — likely crashed.</strong>  \` : '';
          const failMsg = failures.length > 0
            ? 'Recent failures: ' + failures.map(f => \`\${f.body_id?.slice(0, 8) ?? '?'}@\${f.state_fips ?? '?'} (\${f.status}: \${(f.error_summary ?? '').slice(0, 60)})\`).join('  ·  ')
            : '';
          failEl.innerHTML = stuckMsg + failMsg;
          failEl.style.color = 'var(--civic-text-muted)';
        }
      }
    } catch (e) {
      // silent
    }
  }
  refreshIngestionHealth();
  setInterval(refreshIngestionHealth, 30000);
})();
</script>`;
}
