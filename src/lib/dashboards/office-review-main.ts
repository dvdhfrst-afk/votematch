/**
 * office-review-main.ts — FAST main-view data fetch.
 *
 * The main /admin/office-review page only shows the `totals` strip and the
 * per-state `byStateRollup` table. Sections 2-8 (entities / chamber types /
 * sanity check / governing-body matrix / standalone offices / ingestion
 * health) live on /admin/office-review/matrices and are CSS-hidden on main.
 *
 * fetchOfficeReviewData() (office-review.ts) pages EVERY governing_body
 * (~74K), EVERY office (~130K) and EVERY jurisdiction (~71K) over the
 * Supabase REST API and computes everything in JS — a 200-360s cold render.
 *
 * This module computes ONLY `totals` + `byStateRollup` via SQL GROUP BY
 * aggregates over the live Postgres (PG_POOL), returning an OfficeReviewData
 * with entities/bodies/standalone/byChamberType/byState/stateLegSanity left
 * EMPTY (those sections are hidden on the main view, and the renderer maps
 * over empty arrays safely).
 *
 * Numbers MUST match fetchOfficeReviewData() exactly — every field of
 * `totals` and every `byStateRollup` row cell. The verification script
 * scripts/_verify-main-view.ts diffs the two for all states; keep it green.
 */

import type { Pool } from "pg";
import type {
  OfficeReviewData,
  BodyRow,
  EntityRow,
  StandaloneRow,
  ChamberType,
} from "./office-review";

// Mirror of fetchOfficeReviewData()'s rollup key/name logic, expressed in SQL.
//
// In the JS path, byStateRollup buckets a body/standalone by:
//   - jurisdiction.type='nation'      -> key 'Federal', fips 'US'
//   - else jurisdiction.fips_state    -> key = state-name(fips), fips = fips_state
//   - else                            -> key '(unknown)', fips null
// State-name(fips) resolves via type='state' first, then territory/federal_district.
//
// State-level vs local-level split (per the JS path):
//   bodies:      isStateLevel when jurisdiction.type IN ('state','territory');
//                nation-type bodies ALSO go in the state bucket (Federal row).
//   standalone:  state bucket when jurisdiction.type IN ('state','nation','territory'),
//                else local.
//
// Verified predicates (per the JS path):
//   bodies:      body_structure_verified IS TRUE
//   standalone:  meta.research_extracted.authoritative = 'true'
//
// NOTE: unlike /api/state-progress's rollupOfficesSql, we DO NOT drop
// appointed/nonexistent standalone offices from the denominator — the
// office-review byStateRollup counts ALL standalone offices, so we match that.

const ROLLUP_KEY = `
  CASE
    WHEN j.type = 'nation' THEN 'Federal'
    WHEN j.fips_state IS NOT NULL THEN COALESCE(sn.name, '(fips ' || j.fips_state || ')')
    ELSE '(unknown)'
  END`;
const ROLLUP_FIPS = `
  CASE
    WHEN j.type = 'nation' THEN 'US'
    WHEN j.fips_state IS NOT NULL THEN j.fips_state
    ELSE NULL
  END`;
// State-name lookup CTE: best fips -> name (state > territory > federal_district).
// Matches the JS fipsToName map (state first, then territory/federal_district
// fallback).
const STATE_NAMES_CTE = `
  state_names AS (
    SELECT DISTINCT ON (fips_state) fips_state, name
    FROM jurisdictions
    WHERE fips_state IS NOT NULL
      AND type IN ('state','territory','federal_district')
    ORDER BY fips_state,
      CASE type WHEN 'state' THEN 3 WHEN 'territory' THEN 2 WHEN 'federal_district' THEN 1 ELSE 0 END DESC,
      name
  )`;

// Bodies grouped per rollup bucket. is_state = body counts as state-level.
const ROLLUP_BODIES_SQL = `
  WITH ${STATE_NAMES_CTE}
  SELECT
    ${ROLLUP_KEY}  AS state_name,
    ${ROLLUP_FIPS} AS fips,
    count(*)::int AS bodies,
    COALESCE(sum(gb.size_total),0)::int AS seats,
    count(*) FILTER (WHERE gb.body_structure_verified)::int AS verified,
    count(*) FILTER (WHERE gb.size_total <> COALESCE(att.cnt,0))::int AS mismatched,
    count(*) FILTER (WHERE j.type IN ('state','territory'))::int AS bodies_state_level,
    count(*) FILTER (WHERE j.type NOT IN ('state','territory','nation'))::int AS bodies_local_level,
    -- state bucket: state|territory|nation
    count(*) FILTER (WHERE j.type IN ('state','territory','nation'))::int AS state_bodies,
    count(*) FILTER (WHERE j.type IN ('state','territory','nation') AND gb.body_structure_verified)::int AS state_bodies_verified,
    COALESCE(sum(gb.size_total) FILTER (WHERE j.type IN ('state','territory','nation')),0)::int AS state_bodies_seats,
    COALESCE(sum(gb.size_total) FILTER (WHERE j.type IN ('state','territory','nation') AND gb.body_structure_verified),0)::int AS state_bodies_seats_verified,
    -- local bucket: everything else
    count(*) FILTER (WHERE j.type NOT IN ('state','territory','nation'))::int AS local_bodies,
    count(*) FILTER (WHERE j.type NOT IN ('state','territory','nation') AND gb.body_structure_verified)::int AS local_bodies_verified,
    COALESCE(sum(gb.size_total) FILTER (WHERE j.type NOT IN ('state','territory','nation')),0)::int AS local_bodies_seats,
    COALESCE(sum(gb.size_total) FILTER (WHERE j.type NOT IN ('state','territory','nation') AND gb.body_structure_verified),0)::int AS local_bodies_seats_verified,
    -- Mapped: bodies with an official roster source URL on record (Map Sources).
    count(*) FILTER (WHERE EXISTS (
      SELECT 1 FROM primary_source_urls p
      WHERE replace(replace(p.body_kind,'state_',''),'federal_','') = gb.chamber_type
        AND lower(p.jurisdiction_name) = lower(j.name)
        AND p.url_kind = 'roster'))::int AS mapped
  FROM governing_bodies gb
  JOIN jurisdictions j ON j.id = gb.jurisdiction_id
  LEFT JOIN state_names sn ON sn.fips_state = j.fips_state
  LEFT JOIN (
    SELECT governing_body_id, count(*)::int AS cnt
    FROM offices WHERE governing_body_id IS NOT NULL
    GROUP BY governing_body_id
  ) att ON att.governing_body_id = gb.id
  GROUP BY ${ROLLUP_KEY}, ${ROLLUP_FIPS}
`;

// Standalone offices grouped per rollup bucket.
const ROLLUP_STANDALONE_SQL = `
  WITH ${STATE_NAMES_CTE}
  SELECT
    ${ROLLUP_KEY}  AS state_name,
    ${ROLLUP_FIPS} AS fips,
    count(*)::int AS standalone_offices,
    count(*) FILTER (WHERE (o.meta->'research_extracted'->>'authoritative') = 'true')::int AS standalone_offices_verified,
    count(*) FILTER (WHERE j.type IN ('state','nation','territory'))::int AS state_standalone,
    count(*) FILTER (WHERE j.type IN ('state','nation','territory') AND (o.meta->'research_extracted'->>'authoritative') = 'true')::int AS state_standalone_verified,
    count(*) FILTER (WHERE j.type NOT IN ('state','nation','territory'))::int AS local_standalone,
    count(*) FILTER (WHERE j.type NOT IN ('state','nation','territory') AND (o.meta->'research_extracted'->>'authoritative') = 'true')::int AS local_standalone_verified
  FROM offices o
  JOIN jurisdictions j ON j.id = o.jurisdiction_id
  LEFT JOIN state_names sn ON sn.fips_state = j.fips_state
  WHERE o.governing_body_id IS NULL
  GROUP BY ${ROLLUP_KEY}, ${ROLLUP_FIPS}
`;

// Distinct entities (jurisdictions) per rollup bucket. Mirrors the JS path:
// entityIdsPerState collects jurisdiction_ids that own >=1 body OR >=1
// standalone office, then counts distinct per bucket.
const ROLLUP_ENTITIES_SQL = `
  WITH ${STATE_NAMES_CTE},
  jur_with_work AS (
    SELECT DISTINCT jurisdiction_id FROM governing_bodies
    UNION
    SELECT DISTINCT jurisdiction_id FROM offices WHERE governing_body_id IS NULL AND jurisdiction_id IS NOT NULL
  )
  SELECT
    ${ROLLUP_KEY}  AS state_name,
    ${ROLLUP_FIPS} AS fips,
    count(DISTINCT j.id)::int AS entities
  FROM jur_with_work jw
  JOIN jurisdictions j ON j.id = jw.jurisdiction_id
  LEFT JOIN state_names sn ON sn.fips_state = j.fips_state
  GROUP BY ${ROLLUP_KEY}, ${ROLLUP_FIPS}
`;

// Totals — straight aggregates.
const TOTALS_SQL = `
  SELECT
    (SELECT count(*) FROM governing_bodies)::int AS bodies,
    (SELECT count(*) FROM offices)::int AS offices_total,
    (SELECT count(*) FROM offices WHERE governing_body_id IS NOT NULL)::int AS offices_parented,
    (SELECT count(*) FROM offices WHERE governing_body_id IS NULL)::int AS offices_standalone,
    (SELECT count(*) FROM governing_bodies WHERE size_authoritative)::int AS bodies_authoritative,
    (SELECT count(*) FROM governing_bodies WHERE body_structure_verified)::int AS bodies_structure_verified,
    (SELECT count(*) FROM governing_bodies WHERE last_verified_at IS NOT NULL AND last_verified_at >= now() - interval '7 days')::int AS bodies_verified_run_7d,
    (SELECT count(*) FROM governing_bodies WHERE body_structure_verified IS NOT TRUE)::int AS bodies_compiled,
    (SELECT count(*) FROM governing_bodies gb
       WHERE gb.size_total <> COALESCE(
         (SELECT count(*) FROM offices o WHERE o.governing_body_id = gb.id), 0))::int AS bodies_mismatched,
    (SELECT count(*) FROM governing_bodies
       WHERE jsonb_typeof(citations) = 'array' AND jsonb_array_length(citations) > 0)::int AS citations_present,
    (SELECT count(*) FROM offices
       WHERE governing_body_id IS NULL
         AND (meta->'research_extracted'->>'authoritative') = 'true')::int AS standalone_research_verified,
    (SELECT count(*) FROM offices
       WHERE governing_body_id IS NULL
         AND (meta->'research_extracted'->>'last_verified_at') IS NOT NULL)::int AS standalone_research_started
`;

type RollupRow = OfficeReviewData["byStateRollup"][number];

function emptyRollupRow(state_name: string, fips: string | null): RollupRow {
  return {
    state_name, fips,
    bodies: 0, seats: 0, verified: 0, mismatched: 0,
    bodies_state_level: 0, bodies_local_level: 0,
    standalone_offices: 0, standalone_offices_verified: 0,
    entities: 0, mapped_bodies: 0,
    state_bodies: 0, state_bodies_verified: 0, state_bodies_seats: 0, state_bodies_seats_verified: 0,
    state_standalone: 0, state_standalone_verified: 0,
    local_bodies: 0, local_bodies_verified: 0, local_bodies_seats: 0, local_bodies_seats_verified: 0,
    local_standalone: 0, local_standalone_verified: 0,
  };
}

// Run a single SQL on its OWN dedicated pool client, then release it.
//
// Promise.all over pool.query() shares the pool's client set, and under
// connection contention two of the four parallel queries can land on the same
// client mid-flight — which trips pg's "client is already executing a query"
// DeprecationWarning (removed in pg@9). Acquiring an explicit client per query
// guarantees a 1:1 query-to-client mapping regardless of pool pressure, so the
// four queries stay parallel but never collide on a client. The release in
// `finally` returns the client even if the query throws.
async function queryOwnClient(pool: Pool, sql: string) {
  const client = await pool.connect();
  try {
    return await client.query(sql);
  } finally {
    client.release();
  }
}

export async function fetchMainViewData(pool: Pool): Promise<OfficeReviewData> {
  const [totalsRes, bodiesRes, standaloneRes, entitiesRes] = await Promise.all([
    queryOwnClient(pool, TOTALS_SQL),
    queryOwnClient(pool, ROLLUP_BODIES_SQL),
    queryOwnClient(pool, ROLLUP_STANDALONE_SQL),
    queryOwnClient(pool, ROLLUP_ENTITIES_SQL),
  ]);

  const t = totalsRes.rows[0] ?? {};
  const totals: OfficeReviewData["totals"] = {
    bodies: t.bodies ?? 0,
    offices_total: t.offices_total ?? 0,
    offices_parented: t.offices_parented ?? 0,
    offices_standalone: t.offices_standalone ?? 0,
    bodies_authoritative: t.bodies_authoritative ?? 0,
    bodies_structure_verified: t.bodies_structure_verified ?? 0,
    bodies_verified_run_7d: t.bodies_verified_run_7d ?? 0,
    bodies_compiled: t.bodies_compiled ?? 0,
    bodies_mismatched: t.bodies_mismatched ?? 0,
    citations_present: t.citations_present ?? 0,
    standalone_research_verified: t.standalone_research_verified ?? 0,
    standalone_research_started: t.standalone_research_started ?? 0,
  };

  // Merge the three per-bucket result sets by (state_name) — the JS path keys
  // the rollup map by state_name (key var), so we do the same.
  const rollup = new Map<string, RollupRow>();
  const get = (state_name: string, fips: string | null): RollupRow => {
    let r = rollup.get(state_name);
    if (!r) { r = emptyRollupRow(state_name, fips); rollup.set(state_name, r); }
    return r;
  };

  for (const row of bodiesRes.rows) {
    const r = get(row.state_name, row.fips ?? null);
    r.bodies += row.bodies;
    r.seats += row.seats;
    r.verified += row.verified;
    r.mismatched += row.mismatched;
    r.bodies_state_level += row.bodies_state_level;
    r.bodies_local_level += row.bodies_local_level;
    r.state_bodies += row.state_bodies;
    r.state_bodies_verified += row.state_bodies_verified;
    r.state_bodies_seats += row.state_bodies_seats;
    r.state_bodies_seats_verified += row.state_bodies_seats_verified;
    r.local_bodies += row.local_bodies;
    r.local_bodies_verified += row.local_bodies_verified;
    r.local_bodies_seats += row.local_bodies_seats;
    r.local_bodies_seats_verified += row.local_bodies_seats_verified;
    r.mapped_bodies = (r.mapped_bodies ?? 0) + row.mapped;
  }
  for (const row of standaloneRes.rows) {
    const r = get(row.state_name, row.fips ?? null);
    r.standalone_offices += row.standalone_offices;
    r.standalone_offices_verified += row.standalone_offices_verified;
    r.state_standalone += row.state_standalone;
    r.state_standalone_verified += row.state_standalone_verified;
    r.local_standalone += row.local_standalone;
    r.local_standalone_verified += row.local_standalone_verified;
  }
  for (const row of entitiesRes.rows) {
    const r = get(row.state_name, row.fips ?? null);
    r.entities = row.entities;
  }

  // Same sort as the JS path: Federal first, (unknown) last, else alphabetical.
  const byStateRollup: RollupRow[] = [...rollup.values()].sort((a, b) => {
    if (a.state_name === "Federal") return -1;
    if (b.state_name === "Federal") return 1;
    if (a.state_name === "(unknown)") return 1;
    if (b.state_name === "(unknown)") return -1;
    return a.state_name.localeCompare(b.state_name);
  });

  return {
    generatedAt: new Date().toISOString(),
    totals,
    byChamberType: new Map(),
    byState: new Map(),
    byStateRollup,
    entities: [],
    bodies: [],
    standalone: [],
    stateLegSanity: [],
  };
}

// ============================================================================
// MATRICES view (/admin/office-review/matrices) — sections 2-8.
//
// fetchOfficeReviewData() pages EVERY governing_body (~74K), EVERY office
// (~453K) and EVERY jurisdiction (~71K) over Supabase REST (~275K rows, 270+
// HTTP round-trips at ~150ms each) and aggregates in JS — a ~236s cold render.
// This module reproduces the SAME OfficeReviewData fields the matrices
// sections read (sections 2-7; section 8 is client-polled and untouched), but
// sources them from the live Postgres (PG_POOL) instead:
//
//   - totals          : reused TOTALS_SQL (same as the main-view fast path)
//   - byChamberType   : GROUP BY chamber_type (bodies / seats / size_authoritative)
//   - stateLegSanity  : per-state Senate/House catalogued vs expected size
//   - byChamberType + stateLegSanity are pure aggregates.
//   - bodies[]        : BodyRow[] for ALL bodies, built in ONE SQL join
//                       (attached-office counts via a grouped sub-select)
//                       instead of paging 74K bodies + 453K offices over REST.
//   - standalone[]    : StandaloneRow[] for ALL standalone offices in ONE SQL
//                       query (office_type slug + research_extracted fields
//                       parsed in SQL), replacing the REST page of 453K offices.
//   - entities[]      : per-jurisdiction rollup, computed in JS from the bodies
//                       + standalone arrays above (same logic the heavy path
//                       uses), so EntityRow fields match exactly.
//
// Why full arrays, not pre-capped: the renderer (renderOfficeReviewHTML) is
// LEFT UNTOUCHED. It already SSR-caps the embedded HTML itself (entities
// .slice(0,500), bodies .slice(0,1500)) and builds the sec-2/sec-5 filter
// dropdowns + the "N jurisdictions" / "N bodies" labels off the full arrays.
// Handing it the full arrays therefore yields byte-identical HTML to the heavy
// path while removing the REST round-trips entirely. Building + sorting ~74K
// small objects in-process over a local Unix/TCP socket is sub-second and
// preserves EXACT ordering parity (localeCompare tie-breaks happen in the
// renderer, identically). byState + byStateRollup are left empty: the matrices
// page CSS-hides section 1 (the per-state table), so the renderer maps over
// empty arrays there safely (same as fetchMainViewData leaves 2-8 empty).
//
// FOLLOW-UP (explicitly NOT built here): full server-side filtering across all
// rows for sec 2 / sec 5 (search/chamber/auth/state/mismatch executed in SQL
// with LIMIT/OFFSET) so the embedded set could be small AND complete. Today
// the client filter still operates over the embedded capped set only — the
// SAME behavior the heavy path already had.
// ============================================================================

const TYPE_TO_LEVEL: Record<string, string> = {
  nation: "federal",
  state: "state",
  federal_district: "federal",
  territory: "state",
  county: "county",
  municipality: "municipal",
  city: "municipal",
  town: "municipal",
  township: "municipal",
  village: "municipal",
  borough: "municipal",
  school_district: "school",
  special_district: "special",
  judicial_district: "judicial",
  state_agency: "state",
};

// State legislative chamber sizes — MUST stay byte-identical to STATE_LEG_SIZES
// in office-review.ts (the heavy path). Verified 2026-05-25.
const STATE_LEG_SIZES_MATRICES: Record<string, { senate: number; house: number | null }> = {
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
  Nebraska: { senate: 49, house: null },
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

// Full bodies as BodyRow[], computed in SQL. Mirrors fetchOfficeReviewData's
// BodyRow build exactly:
//   mismatch            = size_total <> attached_offices_count
//   has_description     = description IS NOT NULL AND length>0
//   has_powers_summary  = powers_summary IS NOT NULL AND length>0
//   citation_count      = jsonb_array_length(citations) when citations is array else 0
//   data_quality_tier   = meta->>'data_quality_tier'
const BODIES_SQL = `
  SELECT
    gb.id,
    gb.canonical_name,
    gb.short_name,
    gb.chamber_type,
    gb.jurisdiction_id,
    j.name  AS jurisdiction_name,
    j.type  AS jurisdiction_type,
    j.fips_state,
    COALESCE(gb.size_total,0)::int AS size_total,
    COALESCE(gb.size_authoritative,false) AS size_authoritative,
    COALESCE(gb.body_structure_verified,false) AS body_structure_verified,
    COALESCE(att.cnt,0)::int AS attached_offices_count,
    (gb.description IS NOT NULL AND length(gb.description) > 0) AS has_description,
    (gb.powers_summary IS NOT NULL AND length(gb.powers_summary) > 0) AS has_powers_summary,
    CASE WHEN jsonb_typeof(gb.citations) = 'array' THEN jsonb_array_length(gb.citations) ELSE 0 END::int AS citation_count,
    gb.last_verified_at,
    gb.verified_by,
    gb.meta->>'data_quality_tier' AS data_quality_tier
  FROM governing_bodies gb
  JOIN jurisdictions j ON j.id = gb.jurisdiction_id
  LEFT JOIN (
    SELECT governing_body_id, count(*)::int AS cnt
    FROM offices WHERE governing_body_id IS NOT NULL
    GROUP BY governing_body_id
  ) att ON att.governing_body_id = gb.id
  ORDER BY gb.id
`;

// All standalone offices (governing_body_id IS NULL) as StandaloneRow[].
//   research              = meta->'research_extracted' (object)
//   research_verified     = research->>'authoritative' = 'true'
//   research_citation_count = jsonb_array_length(research->'citations') when array else 0
//   research_last_verified_at = research->>'last_verified_at'
//   office_type_slug      = office_types.slug via office_type_id
const STANDALONE_SQL = `
  SELECT
    o.id,
    o.canonical_name,
    COALESCE(o.level,'(unknown)') AS level,
    COALESCE(j.name,'(unknown)') AS jurisdiction_name,
    j.fips_state,
    ot.slug AS office_type_slug,
    o.meta->>'data_quality_tier' AS data_quality_tier,
    ((o.meta->'research_extracted'->>'authoritative') = 'true') AS research_verified,
    CASE
      WHEN jsonb_typeof(o.meta->'research_extracted'->'citations') = 'array'
      THEN jsonb_array_length(o.meta->'research_extracted'->'citations')
      ELSE 0
    END::int AS research_citation_count,
    (o.meta->'research_extracted'->>'last_verified_at') AS research_last_verified_at,
    (o.meta->'research_extracted'->>'verified_by') AS research_verified_by,
    o.jurisdiction_id,
    j.type AS jurisdiction_type
  FROM offices o
  LEFT JOIN jurisdictions j ON j.id = o.jurisdiction_id
  LEFT JOIN office_types ot ON ot.id = o.office_type_id
  WHERE o.governing_body_id IS NULL
  ORDER BY o.id
`;

// chamber_type aggregate. auth = size_authoritative (NOT struct) — matches
// the heavy path's byChamberType.auth.
const BY_CHAMBER_SQL = `
  SELECT
    chamber_type,
    count(*)::int AS bodies,
    COALESCE(sum(size_total),0)::int AS seats,
    count(*) FILTER (WHERE size_authoritative)::int AS auth
  FROM governing_bodies
  GROUP BY chamber_type
`;

// State-legislature catalogued sizes. One row per (state name, chamber).
// No name collisions exist for legislative_upper/lower (verified), so a plain
// GROUP BY is unambiguous; we still MAX(size_total) defensively to collapse
// any future dup to a single deterministic value (the heavy path's .find()
// would pick the lowest-id match — identical when there's exactly one).
const STATE_LEG_CATALOG_SQL = `
  SELECT j.name AS state_name, gb.chamber_type,
         (array_agg(COALESCE(gb.size_total,0) ORDER BY gb.id))[1]::int AS catalogued
  FROM governing_bodies gb
  JOIN jurisdictions j ON j.id = gb.jurisdiction_id
  WHERE gb.chamber_type IN ('legislative_upper','legislative_lower')
  GROUP BY j.name, gb.chamber_type
`;

export async function fetchMatricesViewData(pool: Pool): Promise<OfficeReviewData> {
  const [totalsRes, bodiesRes, standaloneRes, chamberRes, legRes] = await Promise.all([
    queryOwnClient(pool, TOTALS_SQL),
    queryOwnClient(pool, BODIES_SQL),
    queryOwnClient(pool, STANDALONE_SQL),
    queryOwnClient(pool, BY_CHAMBER_SQL),
    queryOwnClient(pool, STATE_LEG_CATALOG_SQL),
  ]);

  const t = totalsRes.rows[0] ?? {};
  const totals: OfficeReviewData["totals"] = {
    bodies: t.bodies ?? 0,
    offices_total: t.offices_total ?? 0,
    offices_parented: t.offices_parented ?? 0,
    offices_standalone: t.offices_standalone ?? 0,
    bodies_authoritative: t.bodies_authoritative ?? 0,
    bodies_structure_verified: t.bodies_structure_verified ?? 0,
    bodies_verified_run_7d: t.bodies_verified_run_7d ?? 0,
    bodies_compiled: t.bodies_compiled ?? 0,
    bodies_mismatched: t.bodies_mismatched ?? 0,
    citations_present: t.citations_present ?? 0,
    standalone_research_verified: t.standalone_research_verified ?? 0,
    standalone_research_started: t.standalone_research_started ?? 0,
  };

  // ── BodyRow[] ──────────────────────────────────────────────────────────
  const bodies: BodyRow[] = bodiesRes.rows.map((b: any) => ({
    id: b.id,
    canonical_name: b.canonical_name,
    short_name: b.short_name ?? null,
    chamber_type: b.chamber_type as ChamberType,
    jurisdiction_id: b.jurisdiction_id,
    jurisdiction_name: b.jurisdiction_name ?? "(unknown)",
    jurisdiction_type: b.jurisdiction_type ?? "(unknown)",
    fips_state: b.fips_state ?? null,
    size_total: b.size_total ?? 0,
    size_authoritative: !!b.size_authoritative,
    body_structure_verified: !!b.body_structure_verified,
    attached_offices_count: b.attached_offices_count ?? 0,
    mismatch: (b.size_total ?? 0) !== (b.attached_offices_count ?? 0),
    has_description: !!b.has_description,
    has_powers_summary: !!b.has_powers_summary,
    citation_count: b.citation_count ?? 0,
    last_verified_at: b.last_verified_at
      ? new Date(b.last_verified_at).toISOString()
      : null,
    verified_by: b.verified_by ?? null,
    data_quality_tier: b.data_quality_tier ?? null,
  }));

  // ── StandaloneRow[] ────────────────────────────────────────────────────
  // Keep a parallel jurisdiction map for the entity rollup (matches the heavy
  // path, which looks up the originating office's jurisdiction).
  const standaloneJur = new Map<string, { jurisdiction_id: string | null; name: string; type: string; fips_state: string | null }>();
  const standalone: StandaloneRow[] = standaloneRes.rows.map((o: any) => {
    standaloneJur.set(o.id, {
      jurisdiction_id: o.jurisdiction_id ?? null,
      name: o.jurisdiction_name ?? "(unknown)",
      type: o.jurisdiction_type ?? "(unknown)",
      fips_state: o.fips_state ?? null,
    });
    return {
      id: o.id,
      canonical_name: o.canonical_name,
      level: o.level ?? "(unknown)",
      jurisdiction_name: o.jurisdiction_name ?? "(unknown)",
      fips_state: o.fips_state ?? null,
      office_type_slug: o.office_type_slug ?? null,
      data_quality_tier: o.data_quality_tier ?? null,
      research_verified: !!o.research_verified,
      research_citation_count: o.research_citation_count ?? 0,
      research_last_verified_at: o.research_last_verified_at ?? null,
      research_verified_by: o.research_verified_by ?? null,
    };
  });

  // ── byChamberType ──────────────────────────────────────────────────────
  const byChamberType = new Map<ChamberType, { bodies: number; seats: number; auth: number }>();
  for (const c of chamberRes.rows) {
    byChamberType.set(c.chamber_type as ChamberType, {
      bodies: c.bodies ?? 0,
      seats: c.seats ?? 0,
      auth: c.auth ?? 0,
    });
  }

  // ── stateLegSanity ─────────────────────────────────────────────────────
  // Mirror the heavy path: iterate STATE_LEG_SIZES entries in insertion order
  // (the heavy path does Object.entries(...).sort() — JS sorts [key,val] pairs
  // lexically by stringified pair, but since values stringify uniformly this
  // is effectively state-name order; replicate by sorting on state name).
  const legCatalog = new Map<string, number>();
  for (const r of legRes.rows) {
    legCatalog.set(`${r.state_name}|${r.chamber_type}`, r.catalogued ?? 0);
  }
  const stateLegSanity: OfficeReviewData["stateLegSanity"] = [];
  // Object.entries() preserves insertion order; the heavy path calls .sort()
  // on the [key,value] pairs with the default comparator. We reproduce that
  // exact ordering below in the verify script by sorting both the same way;
  // here we emit in the heavy path's iteration order (Object.entries + sort()).
  const legEntries = Object.entries(STATE_LEG_SIZES_MATRICES).sort();
  for (const [stateName, exp] of legEntries) {
    const senateCat = legCatalog.get(`${stateName}|legislative_upper`);
    if (senateCat !== undefined) {
      stateLegSanity.push({
        state: stateName, chamber: "Senate",
        catalogued: senateCat, expected: exp.senate, ok: senateCat === exp.senate,
      });
    } else {
      stateLegSanity.push({ state: stateName, chamber: "Senate", catalogued: 0, expected: exp.senate, ok: false });
    }
    if (exp.house !== null) {
      const houseCat = legCatalog.get(`${stateName}|legislative_lower`);
      if (houseCat !== undefined) {
        stateLegSanity.push({
          state: stateName, chamber: "House",
          catalogued: houseCat, expected: exp.house, ok: houseCat === exp.house,
        });
      } else {
        stateLegSanity.push({ state: stateName, chamber: "House", catalogued: 0, expected: exp.house, ok: false });
      }
    }
  }

  // ── Entity rollup ──────────────────────────────────────────────────────
  // One EntityRow per jurisdiction owning >=1 body or >=1 standalone office.
  // bodies_verified uses body_structure_verified (heavy path line 398);
  // standalone_offices_verified uses research_verified (line 411).
  const entityMap = new Map<string, EntityRow>();
  const jurInfo = new Map<string, { name: string; type: string; fips_state: string | null }>();
  for (const b of bodies) {
    jurInfo.set(b.jurisdiction_id, { name: b.jurisdiction_name, type: b.jurisdiction_type, fips_state: b.fips_state });
  }
  for (const [, j] of standaloneJur) {
    if (j.jurisdiction_id && !jurInfo.has(j.jurisdiction_id)) {
      jurInfo.set(j.jurisdiction_id, { name: j.name, type: j.type, fips_state: j.fips_state });
    }
  }
  const getEntity = (jid: string): EntityRow => {
    let e = entityMap.get(jid);
    if (!e) {
      const j = jurInfo.get(jid)!;
      e = {
        id: jid,
        name: j.name,
        short_name: null,
        type: j.type,
        fips_state: j.fips_state,
        level: TYPE_TO_LEVEL[j.type] ?? "other",
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
  };
  for (const b of bodies) {
    if (!jurInfo.has(b.jurisdiction_id)) continue;
    const e = getEntity(b.jurisdiction_id);
    e.bodies_count += 1;
    e.bodies_seats += b.size_total;
    if (b.body_structure_verified) e.bodies_verified += 1;
    if (b.mismatch) e.bodies_mismatched += 1;
  }
  for (const s of standalone) {
    const j = standaloneJur.get(s.id);
    if (!j || !j.jurisdiction_id || !jurInfo.has(j.jurisdiction_id)) continue;
    const e = getEntity(j.jurisdiction_id);
    e.standalone_offices_count += 1;
    if (s.research_verified) e.standalone_offices_verified += 1;
  }
  for (const e of entityMap.values()) {
    e.total_positions = e.bodies_seats + e.standalone_offices_count;
  }
  const entities: EntityRow[] = Array.from(entityMap.values());

  return {
    generatedAt: new Date().toISOString(),
    totals,
    byChamberType,
    byState: new Map(),
    byStateRollup: [],
    entities,
    bodies,
    standalone,
    stateLegSanity,
  };
}
