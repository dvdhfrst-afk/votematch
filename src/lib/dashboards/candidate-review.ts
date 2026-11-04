/**
 * Candidate-review dashboard &#x2014; shared module.
 *
 * Extension of office-review. While office-review tracks foundational
 * civic-architecture progress (do we even KNOW the bodies / offices that
 * exist?), candidate-review tracks the work that sits ON TOP of that
 * foundation: per-state, per-office, per-candidate position research.
 *
 * Three views, mirroring a drill-down:
 *
 *   1. State index            (/candidate-review)
 *      One row per state, sorted by % of upcoming candidates that have
 *      &#x2265;1 researched position. Click a row &#x2192; state page.
 *
 *   2. State page             (/candidate-review/:fips)
 *      Offices in this state with at least one upcoming election in the
 *      current cycle. Grouped by election date so primaries pop above
 *      generals. Per-row: candidate slate + researched fraction. Click
 *      an office &#x2192; office page.
 *
 *   3. Office page            (/candidate-review/office/:office_id)
 *      Position-matrix grid (sub_dimensions &#xD7; candidates) with the A+
 *      visual: score + confidence bar + source-tier dots + stated/
 *      inferred-conflict flag + qualified-position badge. Tracks task
 *      #33; this module exposes the fetch + render functions but the
 *      route wiring sits in dashboard-server.ts.
 *
 * All three views run sub-second via direct pg queries (PG_POOL). No
 * Supabase REST paging.
 *
 * Per-state researched-candidate definition (matches /api/state-progress
 * and the office-review "Researched candidates" column):
 *
 *   &#x2022; Denominator: candidacies in elections this calendar year (Jan 1 &#x2192;
 *     Dec 31), status &#x2208; {active, pending_verification}.
 *   &#x2022; Numerator:   subset whose person_id has &#x2265;1 row in positions.
 *
 * Federal bucketing follows the same asymmetric pattern as office-
 * review: federal offices live under state-type jurisdictions, so we
 * bucket on offices.level = 'federal' &#x2192; 'US', else jurisdictions.fips_state.
 */

import type { Pool } from 'pg';

// &#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;
// Types
// &#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;

export interface StateIndexRow {
  fips: string;
  state_name: string;
  offices_in_upcoming: number;
  candidates_in_upcoming: number;
  /** Candidates with any actionable contact info recorded — meta.contact_email,
   *  meta.campaign_website_url, meta.phone, people.website_url, or a legacy
   *  candidate_contacts row. This is the "can we even reach them?" gate for
   *  outreach and questionnaire campaigns. */
  candidates_with_contact: number;
  /** 0 positions &#x2014; research hasn't started */
  candidates_untouched: number;
  /** 1&#x2013;4 positions &#x2014; extraction has begun but below the matching-algorithm
   *  threshold (MIN_OVERLAP_FOR_SCORE = 5 in algorithm.ts). The candidate
   *  doesn't score yet &#x2014; too thin for the L1 distance to be reliable. */
  candidates_started: number;
  /** 5+ positions &#x2014; matchable per the algorithm. "Solid" research. */
  candidates_solid: number;
  /** Subset of candidates with at least one position from a stated view
   *  (view_type='stated': questionnaire / campaign site / voting record /
   *  verified social). Indicates direct evidence rather than purely inferred
   *  positions &#x2014; a quality signal independent of depth. */
  candidates_stated: number;
  /** Convenience for the depth bar: candidates_solid / candidates_in_upcoming. */
  solid_pct: number;
}

export interface OfficeSlateRow {
  office_id: string;
  office_name: string;
  level: string;
  seat_designation: string;
  state_abbr: string;
  election_date: string;
  election_type: string;
  candidates_total: number;
  candidates_with_research: number;
  /** Sum of positions rows across the slate (gives a "depth" signal). */
  positions_sum: number;
  /** Number of distinct candidates whose positions include any stated row. */
  candidates_with_stated: number;
  /** Number of distinct candidates whose positions include any inferred row. */
  candidates_with_inferred: number;
}

export interface StatePageData {
  fips: string;
  state_name: string;
  offices: OfficeSlateRow[];
  generated_at: string;
}

export interface StateIndexData {
  rows: StateIndexRow[];
  generated_at: string;
}

// &#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;
// Bucketing constants &#x2014; kept in sync with dashboard-server.ts so federal
// offices end up in the 'US' synthetic state bucket regardless of which
// state-type jurisdiction owns them.
// &#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;

const FIPS_KEY_OFFICES = "CASE WHEN o.level = 'federal' THEN 'US' ELSE j.fips_state END";

const NAMES_SQL = `
  SELECT DISTINCT ON (fips_state)
    fips_state, name
  FROM jurisdictions
  WHERE fips_state IS NOT NULL
    AND type IN ('state','federal_district','territory')
  ORDER BY fips_state,
    CASE type
      WHEN 'state' THEN 4
      WHEN 'federal_district' THEN 3
      WHEN 'territory' THEN 2
      ELSE 0
    END DESC,
    name
`;

// &#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;
// fetchStateIndex
// &#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;

export async function fetchStateIndex(pool: Pool): Promise<StateIndexData> {
  // Research-depth buckets:
  //   untouched = 0 positions (haven't started research)
  //   started   = 1&#x2013;4 positions (touched but below the matching-algorithm
  //               threshold MIN_OVERLAP_FOR_SCORE = 5 in algorithm.ts)
  //   solid     = 5+ positions (matchable)
  //
  // Independent quality axis:
  //   stated coverage = &#x2265;1 position with view_type='stated' (questionnaire,
  //                     campaign site, voting record, verified social).
  //                     A candidate can be "solid" but inferred-only &#x2014; that's
  //                     a quality risk worth surfacing separately.
  //
  // Aggregation pattern: pre-aggregate positions per person in a CTE so the
  // outer query can do filter-count aggregates without correlated subqueries
  // for every candidacy row.
  // Contact-info predicate (per probe 2026-05-27):
  // people.meta JSONB is where ops actually stores contact data. Check there
  // first; fall back to website_url column and the (currently empty) legacy
  // candidate_contacts table for forward-compat. National coverage with this
  // predicate is 12,776 / 17,144 (74.5%), Utah 348/371 (94%), CA 61/63 (97%),
  // Federal 3,885/5,536 (70%).
  const sql = `
    WITH person_pos AS (
      SELECT
        person_id,
        count(*)::int                       AS pos_count,
        bool_or(view_type = 'stated')       AS has_stated
      FROM positions
      WHERE person_id IS NOT NULL
      GROUP BY person_id
    ),
    up AS (
      SELECT
        ${FIPS_KEY_OFFICES}        AS fips,
        c.id                       AS candidacy_id,
        o.id                       AS office_id,
        coalesce(pp.pos_count, 0)  AS pos_count,
        coalesce(pp.has_stated, false) AS has_stated,
        (
          -- Real contact columns first (per DATA-MAP.md: people.contact_email
          -- + candidacies.campaign_email are where contact ingestion writes).
          coalesce(c.campaign_email, '') <> ''
          OR coalesce(c.website, '') <> ''
          OR coalesce(p.contact_email, '') <> ''
          OR coalesce(p.contact_phone, '') <> ''
          OR p.website_url IS NOT NULL
          OR p.meta ? 'campaign_website_url'
          OR p.meta ? 'contact_email'
          OR p.meta ? 'phone'
          OR EXISTS (
            SELECT 1 FROM candidate_contacts cc
            WHERE cc.candidate_id = ANY(p.legacy_candidate_ids)
          )
        ) AS has_contact
      FROM candidacies c
      JOIN elections e     ON e.id = c.election_id
      JOIN offices o       ON o.id = e.office_id
      JOIN jurisdictions j ON j.id = o.jurisdiction_id
      JOIN people p        ON p.id = c.person_id
      LEFT JOIN person_pos pp ON pp.person_id = c.person_id
      WHERE (j.fips_state IS NOT NULL OR j.type = 'nation' OR o.level = 'federal')
        AND c.status IN ('active','pending_verification')
        AND e.election_date >= date_trunc('year', now())
        AND e.election_date <  date_trunc('year', now()) + interval '1 year'
    )
    SELECT
      fips,
      count(DISTINCT office_id)::int                                      AS offices_in_upcoming,
      count(DISTINCT candidacy_id)::int                                   AS candidates_in_upcoming,
      count(DISTINCT candidacy_id) FILTER (WHERE has_contact)::int        AS candidates_with_contact,
      count(DISTINCT candidacy_id) FILTER (WHERE pos_count = 0)::int      AS candidates_untouched,
      count(DISTINCT candidacy_id) FILTER (WHERE pos_count BETWEEN 1 AND 4)::int AS candidates_started,
      count(DISTINCT candidacy_id) FILTER (WHERE pos_count >= 5)::int     AS candidates_solid,
      count(DISTINCT candidacy_id) FILTER (WHERE has_stated)::int         AS candidates_stated
    FROM up
    GROUP BY fips
  `;
  const client = await pool.connect();
  let nameRows: { fips_state: string; name: string }[];
  let dataRows: {
    fips: string;
    offices_in_upcoming: number;
    candidates_in_upcoming: number;
    candidates_with_contact: number;
    candidates_untouched: number;
    candidates_started: number;
    candidates_solid: number;
    candidates_stated: number;
  }[];
  try {
    const [n, d] = await Promise.all([client.query(NAMES_SQL), client.query(sql)]);
    nameRows = n.rows as any;
    dataRows = d.rows as any;
  } finally {
    client.release();
  }
  const nameByFips = new Map<string, string>();
  for (const r of nameRows) nameByFips.set(r.fips_state, r.name);
  nameByFips.set('US', 'Federal');

  const rows: StateIndexRow[] = dataRows.map((r) => ({
    fips: r.fips,
    state_name: nameByFips.get(r.fips) ?? `(fips ${r.fips})`,
    offices_in_upcoming: r.offices_in_upcoming,
    candidates_in_upcoming: r.candidates_in_upcoming,
    candidates_with_contact: r.candidates_with_contact,
    candidates_untouched: r.candidates_untouched,
    candidates_started: r.candidates_started,
    candidates_solid: r.candidates_solid,
    candidates_stated: r.candidates_stated,
    solid_pct:
      r.candidates_in_upcoming > 0 ? r.candidates_solid / r.candidates_in_upcoming : 0,
  }));

  // Federal first, then alphabetical &#x2014; mirrors office-review's ordering.
  rows.sort((a, b) => {
    if (a.fips === 'US') return -1;
    if (b.fips === 'US') return 1;
    return a.state_name.localeCompare(b.state_name);
  });

  return { rows, generated_at: new Date().toISOString() };
}

// &#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;
// fetchStatePage &#x2014; offices in state with upcoming elections + slate counts
// &#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;

export async function fetchStatePage(pool: Pool, fips: string): Promise<StatePageData> {
  // Predicate: federal bucket (US) selects federal offices regardless of
  // which state-type jurisdiction owns them; everything else selects on
  // the state's fips_state directly.
  const fipsPredicate =
    fips === 'US'
      ? "o.level = 'federal'"
      : "o.level <> 'federal' AND j.fips_state = $1";

  const params = fips === 'US' ? [] : [fips];

  // &#x2500;&#x2500; Per-office slate aggregation
  // Numerator/denominator mirrors the state-index definition. We also
  // surface positions_sum (raw count across all candidates) and the
  // stated/inferred-coverage flags so the office row can hint at depth +
  // view mix without needing the office detail page.
  const sql = `
    WITH up AS (
      SELECT
        o.id              AS office_id,
        o.canonical_name  AS office_name,
        o.level           AS level,
        o.seat_designation AS seat_designation,
        e.id              AS election_id,
        e.election_date   AS election_date,
        e.election_type   AS election_type,
        j.short_name      AS state_abbr,
        c.id              AS candidacy_id,
        c.person_id       AS person_id
      FROM offices o
      JOIN elections e     ON e.office_id = o.id
      JOIN jurisdictions j ON j.id = o.jurisdiction_id
      LEFT JOIN candidacies c
        ON c.election_id = e.id
       AND c.status IN ('active','pending_verification')
      WHERE ${fipsPredicate}
        AND e.election_date >= date_trunc('year', now())
        AND e.election_date <  date_trunc('year', now()) + interval '1 year'
    ),
    per_person AS (
      SELECT
        up.office_id, up.election_id, up.candidacy_id, up.person_id,
        coalesce((SELECT count(*)::int FROM positions p WHERE p.person_id = up.person_id), 0) AS pos_count,
        EXISTS (SELECT 1 FROM positions p WHERE p.person_id = up.person_id AND p.view_type = 'stated')   AS has_stated,
        EXISTS (SELECT 1 FROM positions p WHERE p.person_id = up.person_id AND p.view_type = 'inferred') AS has_inferred
      FROM up
    )
    SELECT
      up.office_id,
      max(up.office_name)                                                                   AS office_name,
      max(up.level)                                                                         AS level,
      max(up.seat_designation)                                                              AS seat_designation,
      max(up.state_abbr)                                                                    AS state_abbr,
      min(up.election_date)                                                                 AS election_date,
      max(up.election_type)                                                                 AS election_type,
      count(DISTINCT up.candidacy_id) FILTER (WHERE up.candidacy_id IS NOT NULL)::int       AS candidates_total,
      count(DISTINCT up.candidacy_id) FILTER (
        WHERE up.candidacy_id IS NOT NULL AND coalesce(pp.pos_count,0) > 0
      )::int                                                                                AS candidates_with_research,
      coalesce(sum(pp.pos_count), 0)::int                                                   AS positions_sum,
      count(DISTINCT up.candidacy_id) FILTER (
        WHERE up.candidacy_id IS NOT NULL AND pp.has_stated
      )::int                                                                                AS candidates_with_stated,
      count(DISTINCT up.candidacy_id) FILTER (
        WHERE up.candidacy_id IS NOT NULL AND pp.has_inferred
      )::int                                                                                AS candidates_with_inferred
    FROM up
    LEFT JOIN per_person pp ON pp.candidacy_id = up.candidacy_id
    GROUP BY up.office_id
    ORDER BY election_date ASC, office_name ASC
  `;

  const nameLookupSql = NAMES_SQL;
  const client = await pool.connect();
  let officeRows: any[];
  let nameRows: { fips_state: string; name: string }[];
  try {
    const [o, n] = await Promise.all([
      client.query(sql, params),
      client.query(nameLookupSql),
    ]);
    officeRows = o.rows;
    nameRows = n.rows as any;
  } finally {
    client.release();
  }
  const nameByFips = new Map<string, string>();
  for (const r of nameRows) nameByFips.set(r.fips_state, r.name);
  nameByFips.set('US', 'Federal');

  const offices: OfficeSlateRow[] = officeRows.map((r) => ({
    office_id: r.office_id,
    office_name: r.office_name ?? '&#x2014;',
    level: r.level ?? '',
    seat_designation: r.seat_designation ?? '',
    state_abbr: r.state_abbr ?? '',
    election_date: r.election_date ? new Date(r.election_date).toISOString().slice(0, 10) : '',
    election_type: r.election_type ?? '',
    candidates_total: r.candidates_total ?? 0,
    candidates_with_research: r.candidates_with_research ?? 0,
    positions_sum: r.positions_sum ?? 0,
    candidates_with_stated: r.candidates_with_stated ?? 0,
    candidates_with_inferred: r.candidates_with_inferred ?? 0,
  }));

  return {
    fips,
    state_name: nameByFips.get(fips) ?? `(fips ${fips})`,
    offices,
    generated_at: new Date().toISOString(),
  };
}

// &#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;
// Rendering helpers
// &#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

/** Color scale mirrors the office-review map: 0%=red &#x2192; 100%=green. */
function pctColor(p: number): string {
  if (p >= 0.999) return '#33cc66';
  if (p >= 0.75) return '#99cc55';
  if (p >= 0.5) return '#dddd33';
  if (p >= 0.25) return '#dd9933';
  return '#cc3333';
}

/** Shared CSS &#x2014; kept inline so the dashboard stays a single-file render. */
const SHARED_CSS = `
  .cr-root { font-family: var(--civic-font-sans, system-ui); color: var(--civic-text, #1a1917); padding: 24px 32px 64px; max-width: 88rem; margin: 0 auto; }
  .cr-root h1 { font-family: var(--civic-font-display, Georgia, serif); font-size: 32px; font-weight: 700; letter-spacing: -.02em; margin: 8px 0; }
  .cr-root h2 { font-family: var(--civic-font-display); font-size: 20px; font-weight: 600; margin: 1.6em 0 .4em; padding-bottom: .3em; border-bottom: 1px solid var(--civic-border, #d5d3cc); }
  .cr-root .kicker { font-family: var(--civic-font-mono, ui-monospace, monospace); font-size: 11px; letter-spacing: .12em; text-transform: uppercase; color: var(--civic-text-muted, #57544d); font-weight: 600; }
  .cr-root .lede { font-family: var(--civic-font-serif, Georgia, serif); font-size: 17px; line-height: 1.5; color: var(--civic-text); margin: .5em 0 1.2em; max-width: 60rem; }
  .cr-root a { color: var(--civic-primary, #1a2f5c); text-decoration: none; border-bottom: 1px dotted currentColor; }
  .cr-root a:hover { border-bottom-style: solid; }
  .cr-root .breadcrumbs { font-family: var(--civic-font-mono, ui-monospace, monospace); font-size: 12px; color: var(--civic-text-muted, #57544d); margin: 4px 0 12px; }
  .cr-root .breadcrumbs a { color: inherit; border-bottom: 1px dotted currentColor; }
  .cr-root .breadcrumbs .sep { margin: 0 .5em; color: var(--civic-border); }

  .cr-totals-strip {
    display: flex; flex-wrap: wrap; gap: 8px 18px; align-items: baseline;
    background: var(--civic-surface, #fff); border: 1px solid var(--civic-border, #d5d3cc);
    border-radius: 8px; padding: 12px 16px; margin: 14px 0 22px;
    font-family: var(--civic-font-mono, ui-monospace, monospace); font-size: 13px;
  }
  .cr-totals-strip .group { display: inline-flex; align-items: baseline; gap: 8px; }
  .cr-totals-strip .group + .group::before { content: "&#xB7;"; color: var(--civic-text-muted, #57544d); margin-right: 8px; }
  .cr-totals-strip .big {
    font-family: var(--civic-font-display, Georgia, serif); font-size: 20px; font-weight: 700;
    line-height: 1; letter-spacing: -.02em; color: var(--civic-text);
  }
  .cr-totals-strip .lbl { color: var(--civic-text-muted); text-transform: uppercase; font-size: 10px; letter-spacing: .06em; font-weight: 600; }
  .cr-totals-strip .detail { color: var(--civic-text-secondary, #3e3b36); font-size: 12px; }

  .cr-root table { font-size: 13px; border-collapse: collapse; width: 100%; background: var(--civic-surface, #fff); border: 1px solid var(--civic-border, #d5d3cc); border-radius: 8px; overflow: hidden; }
  .cr-root table th, .cr-root table td { border-bottom: 1px solid var(--civic-border, #d5d3cc); padding: 7px 11px; text-align: left; vertical-align: middle; }
  .cr-root table th { background: var(--civic-surface-sunken, #f4f4f2); color: var(--civic-primary, #1a2f5c); font-family: var(--civic-font-mono, ui-monospace, monospace); font-size: 10.5px; text-transform: uppercase; letter-spacing: .05em; font-weight: 600; cursor: pointer; user-select: none; }
  .cr-root table tbody tr:nth-child(even) td { background: var(--civic-surface-muted, #faf8f5); }
  .cr-root td.num { font-family: var(--civic-font-mono); font-variant-numeric: tabular-nums; text-align: right; }
  .cr-root tr.click-row { cursor: pointer; }
  .cr-root tr.click-row:hover td { background: #e1ebf3 !important; }

  /* Researched bar &#x2014; visual on the % cell. The bar fills proportionally
     to research_pct and its color follows the same red&#x2192;green scale as
     the office-review map so the two pages read consistently. */
  .cr-bar { display: inline-block; vertical-align: middle; width: 90px; height: 9px; background: var(--civic-surface-sunken, #f4f4f2); border-radius: 4px; overflow: hidden; margin-right: 8px; border: 1px solid var(--civic-border); }
  .cr-bar > span { display: block; height: 100%; }
  .cr-bar-label { font-family: var(--civic-font-mono); font-variant-numeric: tabular-nums; font-size: 12px; color: var(--civic-text-secondary, #3e3b36); }

  /* View-mix pill &#x2014; colored block showing fraction of slate with stated
     vs inferred coverage. Helps spot offices where we have ONLY inferred
     research (lower-confidence) and need to chase stated sources. */
  .cr-mix { display: inline-flex; align-items: center; gap: 4px; font-family: var(--civic-font-mono); font-size: 11px; }
  .cr-mix .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; vertical-align: middle; }
  .cr-mix .dot.stated { background: #2c6b3a; }
  .cr-mix .dot.inferred { background: #b66b0a; }
  .cr-mix .dot.empty { background: var(--civic-border, #d5d3cc); }

  /* Level pill &#x2014; the office row's level (federal/state/county/etc) */
  .cr-pill { font-family: var(--civic-font-mono); font-size: 10px; padding: 2px 7px; border-radius: 999px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; display: inline-block; border: 1px solid var(--civic-border); }
  .cr-pill.federal   { background: #efe1f1; color: #5b2a6d; border-color: #c6a3d2; }
  .cr-pill.state     { background: #e1ebf3; color: #2f4e6e; border-color: #a8c3d8; }
  .cr-pill.county    { background: #e4f2ea; color: #2c6b3a; border-color: #a6cfb6; }
  .cr-pill.municipal { background: #fbf0d9; color: #b66b0a; border-color: #e3c582; }
  .cr-pill.school    { background: #f0e4f2; color: #6e2f5e; border-color: #d2a8c6; }
  .cr-pill.special   { background: #e1e8f3; color: #2f4e6e; border-color: #a8b6d8; }
  .cr-pill.judicial  { background: #f5e1de; color: #8b2e2e; border-color: #d19a95; }

  .cr-empty { padding: 36px 22px; text-align: center; color: var(--civic-text-muted); font-style: italic; background: var(--civic-surface, #fff); border: 1px dashed var(--civic-border, #d5d3cc); border-radius: 8px; margin: 14px 0; }

  .filter-row { display: flex; gap: 10px 14px; margin: 10px 0; align-items: center; flex-wrap: wrap; padding: 12px 14px; background: var(--civic-surface, #fff); border: 1px solid var(--civic-border, #d5d3cc); border-radius: 8px; }
  .filter-row label { font-family: var(--civic-font-mono); font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: var(--civic-text-muted); font-weight: 600; display: inline-flex; gap: 6px; align-items: center; }
  .filter-row select, .filter-row input { font-family: var(--civic-font-sans, system-ui); font-size: 13px; padding: 6px 10px; border: 1px solid var(--civic-border); border-radius: 4px; background: var(--civic-surface); }
  .filter-row button { font-family: var(--civic-font-mono); font-size: 11px; color: var(--civic-primary); background: none; border: 1px solid var(--civic-border); border-radius: 4px; padding: 4px 9px; cursor: pointer; }
`;

// &#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;
// renderStateIndex
// &#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;

export function renderStateIndex(data: StateIndexData): string {
  const totalOffices = data.rows.reduce((a, r) => a + r.offices_in_upcoming, 0);
  const totalCandidates = data.rows.reduce((a, r) => a + r.candidates_in_upcoming, 0);
  const totalContact = data.rows.reduce((a, r) => a + r.candidates_with_contact, 0);
  const totalUntouched = data.rows.reduce((a, r) => a + r.candidates_untouched, 0);
  const totalStarted = data.rows.reduce((a, r) => a + r.candidates_started, 0);
  const totalSolid = data.rows.reduce((a, r) => a + r.candidates_solid, 0);
  const totalStated = data.rows.reduce((a, r) => a + r.candidates_stated, 0);
  const overallSolidPct = totalCandidates > 0 ? totalSolid / totalCandidates : 0;
  const overallStatedPct = totalCandidates > 0 ? totalStated / totalCandidates : 0;
  const generatedAtDisplay = data.generated_at.replace('T', ' ').slice(0, 16) + ' UTC';

  // Per-bucket cell renderer. Shows the count + % so the column reads as a
  // value heatmap rather than just a raw integer. Each bucket gets a
  // semantic color: untouched=red (bad), started=amber (in-progress),
  // solid=green (matchable), stated=blue (quality signal).
  function bucketCell(count: number, total: number, color: string, mutedColor: string): string {
    if (total === 0) return `<span style="color:var(--civic-text-muted)">&#x2014;</span>`;
    if (count === 0) return `<span style="color:var(--civic-text-muted)">0 <span style="font-size:10px">(0%)</span></span>`;
    const p = count / total;
    return `<span style="color:${color};font-weight:600">${fmt(count)}</span> <span style="color:${mutedColor};font-size:10px">(${pct(p)})</span>`;
  }

  let _fresh: Record<string, any> = {};
  try { _fresh = JSON.parse(require('node:fs').readFileSync(require('node:path').resolve(process.cwd(), 'data', 'state-freshness.json'), 'utf-8')); } catch { /* none yet */ }
  const tbodyRows = data.rows
    .map((r) => {
      const fipsHref = `/candidate-review/${esc(r.fips)}`;
      const _f = _fresh[r.fips];
      const _when = _f && _f.reconciled_at ? new Date(_f.reconciled_at).toISOString().slice(0, 10) : '';
      const freshCell = /^(\d{2}|US)$/.test(r.fips)
        ? `<div style="color:${_when ? '#3e3b36' : '#8b2e2e'};font-size:10px;margin-bottom:2px">${_when || 'never'}</div><button class="reconcile-btn" data-fips="${esc(r.fips)}" data-name="${esc(r.state_name)}" title="${_when ? 'Last reconciled ' + _when + ' — refresh roster + consolidation' : 'Never reconciled — run roster consolidation for this state. Do this BEFORE enriching.'}">${_when ? '↻ Refresh' : 'Reconcile'}</button>`
        : '';
      const total = r.candidates_in_upcoming;
      const solidPct = r.solid_pct;
      const solidBarWidth = Math.round(solidPct * 100);
      const solidColor = pctColor(solidPct);
      return `<tr class="click-row" data-fips="${esc(r.fips)}" data-href="${fipsHref}">
        <td><strong><a href="${fipsHref}" style="border:none">${esc(r.state_name)}</a></strong></td>
        <td class="num">${fmt(r.offices_in_upcoming)}</td>
        <td class="num">${fmt(total)}</td>
        <td class="num">${bucketCell(r.candidates_with_contact, total, '#2f4e6e', '#7090a8')}</td>
        <td class="num">${bucketCell(r.candidates_untouched, total, '#8b2e2e', '#b87474')}</td>
        <td class="num">${bucketCell(r.candidates_started, total, '#b66b0a', '#c9985a')}</td>
        <td class="num">${bucketCell(r.candidates_solid, total, '#2c6b3a', '#6fa07c')}</td>
        <td class="num">${bucketCell(r.candidates_stated, total, '#2f4e6e', '#7090a8')}</td>
        <td class="num">
          <span class="cr-bar" title="${pct(solidPct)} of slate has 5+ positions (matchable per the algorithm)"><span style="width:${solidBarWidth}%;background:${solidColor === '#dddd33' ? '#7e7517' : solidColor}"></span></span>
        </td>
        <td style="text-align:center;vertical-align:bottom">${freshCell}</td>
        <td style="text-align:center">${/^(\d{2}|US)$/.test(r.fips) ? `<button class="run-contacts-btn" data-fips="${esc(r.fips)}" data-name="${esc(r.state_name)}" title="Find campaign contact info for ${esc(r.state_name)}'s candidates (state filings + campaign sites)">▶ Run</button>` : ''}</td>
      </tr>`;
    })
    .join('\n');

  return `<style>${SHARED_CSS}
    /* ── Contact-ingestion engine bar (mirrors office-review's #bb-ingest-bar) ── */
    #cc-ingest-bar { position:sticky; top:0; z-index:60; display:flex; align-items:center; gap:11px; flex-wrap:wrap;
      background:var(--civic-surface,#fff); border:1px solid var(--civic-border,#d5d3cc); border-radius:8px;
      padding:9px 14px; margin:10px 0 16px; box-shadow:0 2px 10px rgba(0,0,0,.07); }
    #cc-ingest-bar .lbl { font-family:var(--civic-font-mono,ui-monospace,monospace); font-size:11px; letter-spacing:.06em; text-transform:uppercase; color:var(--civic-text-muted,#57544d); }
    #cc-ingest-bar button { font-family:var(--civic-font-mono,monospace); font-size:12px; font-weight:700; letter-spacing:.04em; text-transform:uppercase; color:#fff; border:none; border-radius:6px; padding:7px 14px; cursor:pointer; }
    #cc-ingest-dot { width:11px; height:11px; border-radius:50%; display:inline-block; background:#b5b5b5; flex:0 0 auto; }
    #cc-ingest-dot.on { background:#2c6b3a; animation:ccpulse 1.6s infinite; }
    @keyframes ccpulse { 0%{box-shadow:0 0 0 0 rgba(44,107,58,.5);} 70%{box-shadow:0 0 0 7px rgba(44,107,58,0);} 100%{box-shadow:0 0 0 0 rgba(44,107,58,0);} }
    .cr-root tr.cc-live > td { background:#fff4cc !important; }
    .run-contacts-btn { font-family:var(--civic-font-mono,ui-monospace,monospace); font-size:10px; font-weight:700; letter-spacing:.03em; background:var(--civic-primary,#1a2f5c); color:#fff; border:none; border-radius:4px; padding:3px 10px; cursor:pointer; }
    .run-contacts-btn:disabled { opacity:.7; }
  </style>
<div class="cr-root">
  <header>
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:1em;flex-wrap:wrap">
      <div>
        <div class="kicker">Candidate research progress &#xB7; regenerated ${esc(generatedAtDisplay)}</div>
        <h1>Candidate Review &#x2014; research depth across this cycle</h1>
      </div>
      <a href="/admin/office-review" target="_blank" rel="noopener"
         style="font-family:var(--civic-font-mono,ui-monospace,monospace);font-size:12px;letter-spacing:.06em;text-transform:uppercase;font-weight:600;background:var(--civic-primary,#1a2f5c);color:#fff;padding:9px 16px;border-radius:6px;text-decoration:none;white-space:nowrap;align-self:center;border:none;display:inline-block"
         title="Open the office-review dashboard in a new tab">
        &#x2190; Office review
      </a>
    </div>
  </header>

  <div id="cc-ingest-bar">
    <span class="lbl">Contact engine</span>
    <span id="cc-ingest-dot"></span>
    <span id="cc-ingest-state" style="font-family:var(--civic-font-mono,monospace);font-size:13px;font-weight:700">checking&#x2026;</span>
    <span id="cc-ingest-now" style="font-family:var(--civic-font-mono,monospace);font-size:12px;color:var(--civic-text-secondary,#3e3b36)"></span>
    <button id="cc-ingest-off" style="background:#8b2e2e">&#x25A0; Stop</button>
    <span class="cc-cap" style="margin-left:12px;font-size:11px;color:var(--civic-text-secondary,#3e3b36);font-family:var(--civic-font-mono,monospace)">Budget $<input id="cc-budget" type="number" min="1" step="5" value="25" style="width:62px;font-family:inherit;font-size:11px;padding:2px 4px;border:1px solid var(--civic-border,#ccc);border-radius:4px"></span>
    <span class="cc-cap" style="font-size:11px;color:var(--civic-text-secondary,#3e3b36);font-family:var(--civic-font-mono,monospace)">Hours <input id="cc-hours" type="number" min="0.1" step="0.5" value="4" style="width:48px;font-family:inherit;font-size:11px;padding:2px 4px;border:1px solid var(--civic-border,#ccc);border-radius:4px"></span>
    <span class="cc-cap" style="font-size:11px;color:var(--civic-text-secondary,#3e3b36);font-family:var(--civic-font-mono,monospace)">Parallel <input id="cc-parallel" type="number" min="1" max="24" step="1" value="6" style="width:42px;font-family:inherit;font-size:11px;padding:2px 4px;border:1px solid var(--civic-border,#ccc);border-radius:4px"></span>
    <span id="cc-ingest-run" style="font-family:var(--civic-font-mono,monospace);font-size:12px;font-weight:700;color:#2c6b3a;margin-left:6px"></span>
    <span id="cc-ingest-count" style="font-family:var(--civic-font-mono,ui-monospace,monospace);font-size:12px;font-weight:700;color:var(--civic-primary,#1a2f5c);margin-left:14px"></span>
    <span id="cc-ingest-ops" style="font-family:var(--civic-font-mono,ui-monospace,monospace);font-size:11px;color:var(--civic-text-secondary,#3e3b36);margin-left:auto"></span>
  </div>

  <div id="cc-conflicts-panel" style="display:none;background:var(--civic-surface,#fff);border:1px solid #d19a95;border-radius:8px;padding:10px 14px;margin:0 0 16px">
    <div style="font-family:var(--civic-font-mono,monospace);font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#8b2e2e;font-weight:700;margin-bottom:6px">Needs review &#x2014; contact conflicts</div>
    <div id="cc-conflicts-rows" style="font-size:13px"></div>
  </div>

  <p class="lede">
    For every state with an upcoming election this cycle, where are we on
    extracting each candidate's positions? The depth columns split the slate
    by how much we've extracted: <strong>no positions yet</strong> (0 extracted),
    <strong>started</strong> (1&#x2013;4 positions &#x2014; too thin for the matching algorithm),
    <strong>solid</strong> (5+ positions &#x2014; matchable per the L1 algorithm).
    <strong>Stated coverage</strong> is an independent quality axis: how many
    candidates do we have direct evidence on (questionnaire / campaign site /
    voting record / verified social) versus inferred-only. Click a state to
    drill into the offices on the ballot.
  </p>

  <div class="cr-totals-strip">
    <span class="group">
      <span class="big">${fmt(totalOffices)}</span>
      <span class="lbl">Offices up</span>
    </span>
    <span class="group">
      <span class="big">${fmt(totalCandidates)}</span>
      <span class="lbl">Candidates</span>
    </span>
    <span class="group">
      <span class="big" style="color:#2f4e6e">${fmt(totalContact)}</span>
      <span class="lbl">Contact info</span>
      <span class="detail">${pct(totalCandidates > 0 ? totalContact / totalCandidates : 0)} reachable</span>
    </span>
    <span class="group">
      <span class="big" style="color:#8b2e2e" title="0 policy positions extracted — the matching algorithm requires 5 positions per candidate to include them in results.">${fmt(totalUntouched)}</span>
      <span class="lbl" title="0 policy positions extracted — the matching algorithm requires 5 positions per candidate to include them in results.">No positions yet</span>
      <span class="detail">${pct(totalCandidates > 0 ? totalUntouched / totalCandidates : 0)} of slate</span>
    </span>
    <span class="group">
      <span class="big" style="color:#b66b0a">${fmt(totalStarted)}</span>
      <span class="lbl">Started</span>
      <span class="detail">${pct(totalCandidates > 0 ? totalStarted / totalCandidates : 0)} &#xB7; 1&#x2013;4 positions</span>
    </span>
    <span class="group">
      <span class="big" style="color:#2c6b3a">${fmt(totalSolid)}</span>
      <span class="lbl">Solid</span>
      <span class="detail">${pct(overallSolidPct)} &#xB7; 5+, matchable</span>
    </span>
    <span class="group">
      <span class="big" style="color:#2f4e6e">${fmt(totalStated)}</span>
      <span class="lbl">Stated coverage</span>
      <span class="detail">${pct(overallStatedPct)} &#xB7; direct evidence</span>
    </span>
    <span class="group" style="margin-left:auto">
      <a href="/admin/office-review" target="_blank" rel="noopener" style="font-size:11px;color:var(--civic-text-muted);border:none">&#x2197; office review</a>
    </span>
  </div>

  <h2>By state &#x2014; pick where to research next</h2>
  <p style="font-size:13px;color:var(--civic-text-muted);margin:.3em 0 .6em">
    Federal first, then alphabetical. Each row's bar tracks <strong>Solid %</strong> &#x2014;
    the share of the slate that's matchable today. Big numbers in
    No positions yet + Started = the most productive places to focus next.
    Big Solid but small Stated coverage = depth without direct evidence,
    a quality risk worth chasing. Click any row to drill into the offices on the ballot.
  </p>
  <table>
    <thead>
      <tr>
        <th>Jurisdiction</th>
        <th class="num" title="Offices with at least one upcoming candidacy this cycle">Offices up</th>
        <th class="num" title="Total candidacies (active or pending_verification) in upcoming elections">Candidates</th>
        <th class="num" title="Candidates with any actionable contact info recorded (meta.contact_email, meta.campaign_website_url, meta.phone, people.website_url, or a legacy candidate_contacts row). The 'can we reach them?' gate for outreach and questionnaire campaigns.">Contact info</th>
        <th class="num" title="0 policy positions extracted. The matching algorithm requires 5 positions per candidate (MIN_OVERLAP_FOR_SCORE) to include them in results — candidates in this column have no positions on file yet.">No positions yet</th>
        <th class="num" title="1&#x2013;4 positions extracted but below the matching-algorithm threshold (MIN_OVERLAP_FOR_SCORE = 5). Won't show up in match results yet &#x2014; needs more depth.">Started (1&#x2013;4)</th>
        <th class="num" title="5+ positions &#x2014; matchable per the algorithm. The 'done' bucket.">Solid (5+)</th>
        <th class="num" title="Candidates with &#x2265;1 position from a stated view (questionnaire / campaign site / voting record / verified social). Independent of depth: a candidate can be Solid but inferred-only.">Stated coverage</th>
        <th class="num" title="Visual: % of slate that's Solid. Red = mostly untouched, green = mostly matchable.">Solid %</th>
        <th style="vertical-align:bottom" title="When this state's roster was last reconciled/consolidated. Reconcile BEFORE enriching so you don't research dead or passed-primary candidates.">Last refreshed</th>
        <th style="vertical-align:bottom" title="Find campaign contact info for this jurisdiction's candidates (state/county filings + campaign sites)">Run</th>
      </tr>
    </thead>
    <tbody>
${tbodyRows}
    </tbody>
  </table>

  ${
    data.rows.length === 0
      ? `<div class="cr-empty">No upcoming elections this cycle. Either the cycle window has rolled or the elections table hasn't been populated yet.</div>`
      : ''
  }

  <p style="font-size:11px;color:var(--civic-text-muted);margin-top:24px;font-family:var(--civic-font-mono,ui-monospace,monospace);max-width:60rem">
    Definitions: <strong>Offices up</strong> = offices with &#x2265;1 active candidacy in an
    election dated this calendar year. <strong>Candidates</strong> = candidacies with
    status &#x2208; {active, pending_verification}. Depth buckets are mutually exclusive
    (Untouched + Started + Solid = Candidates). <strong>Stated coverage</strong>
    cross-cuts depth: a candidate is "stated" if &#x2265;1 of their positions has
    view_type='stated' regardless of total count. Federal candidates roll into
    the Federal row regardless of which state-type jurisdiction owns the
    congressional-district office.
  </p>
</div>
<script>
(function() {
  // Click handler for table rows &#x2014; anywhere on the row navigates.
  document.querySelectorAll('tr.click-row').forEach(function(tr) {
    tr.addEventListener('click', function(e) {
      // Don't double-fire when the user clicks the actual link.
      if (e.target.tagName === 'A') return;
      var href = tr.getAttribute('data-href');
      if (href) window.location.href = href;
    });
  });
})();
(function() {
  // ── Contact-engine live status + Run buttons (pattern copied from
  //    office-review's ingest bar; polls /api/contacts/status every 5s). ──
  var dot=document.getElementById('cc-ingest-dot'), stateEl=document.getElementById('cc-ingest-state');
  var nowEl=document.getElementById('cc-ingest-now'), countEl=document.getElementById('cc-ingest-count');
  var offBtn=document.getElementById('cc-ingest-off');
  var budgetEl=document.getElementById('cc-budget'), hoursEl=document.getElementById('cc-hours'), parallelEl=document.getElementById('cc-parallel'), runEl=document.getElementById('cc-ingest-run');
  if(!dot) return;
  function clearHi(){ var els=document.querySelectorAll('.cc-live'); for(var i=0;i<els.length;i++) els[i].classList.remove('cc-live'); }
  function refresh(){
    fetch('/api/contacts/status',{cache:'no-store'}).then(function(r){return r.json();}).then(function(s){
      var act=s.activity||{};
      var running = !!s.orchestrator;
      dot.className = running ? 'on' : '';
      stateEl.textContent = running ? '● RUNNING' : '○ stopped';
      stateEl.style.color = running ? '#2c6b3a' : '#8b2e2e';
      nowEl.textContent = (running && act.message && act.phase && act.phase!=='idle') ? ('— '+act.message) : (running ? '— starting…' : '');
      offBtn.disabled=!running; offBtn.style.opacity=running?'1':'0.45';
      // Lock budget/hours fields while a run is live; show elapsed + spend.
      if(budgetEl) budgetEl.disabled = running; if(hoursEl) hoursEl.disabled = running; if(parallelEl) parallelEl.disabled = running;
      if(runEl){
        if(running && act.spent_usd!=null){
          var eh=(act.elapsed_hours||0).toFixed(1), hc=(act.hours_cap||0);
          var sp=(act.spent_usd||0).toFixed(2), bc=(act.budget_cap||0);
          runEl.textContent = '⏱ '+eh+'/'+hc+'h  ·  $'+sp+'/'+bc + (act.found!=null ? '  ·  '+act.found+' found' : '');
          runEl.style.color = (act.spent_usd/Math.max(1,act.budget_cap) > 0.9) ? '#b66b0a' : '#2c6b3a';
        } else { runEl.textContent=''; }
      }
      // Two-track counters (plan v2.1 D2): Reachable + Sources, then ops signals
      // (exhausted-vs-untried, due-recheck, quarantine, suppressed — council E).
      if(countEl && s.persons_total!=null){
        var pr = s.persons_total>0 ? Math.round(100*(s.reachable||0)/s.persons_total) : 0;
        var ps = s.persons_total>0 ? Math.round(100*(s.sources_attempted||0)/s.persons_total) : 0;
        countEl.textContent = (s.reachable||0)+'/'+s.persons_total+' reachable ('+pr+'%)  ·  '+(s.sources_attempted||0)+'/'+s.persons_total+' sources attempted ('+ps+'%)';
      }
      var opsEl=document.getElementById('cc-ingest-ops');
      if(opsEl){
        var bits=[];
        if(s.exhausted_unreachable>0) bits.push(s.exhausted_unreachable+' exhausted-unreachable');
        if(s.due_recheck>0) bits.push(s.due_recheck+' due re-check');
        if(s.quarantined_emails>0) bits.push(s.quarantined_emails+' quarantined');
        if(s.suppressed_people>0) bits.push(s.suppressed_people+' suppressed');
        if(s.open_disputes>0) bits.push(s.open_disputes+' disputes');
        opsEl.textContent = bits.join('  ·  ');
      }
      renderConflicts(s.open_conflicts||0);
      // Per-row Run buttons: active scope shows running; row highlighted.
      clearHi();
      var scope=act.scope, rbs=document.querySelectorAll('.run-contacts-btn');
      for(var i=0;i<rbs.length;i++){ var rb=rbs[i], f=rb.getAttribute('data-fips');
        if(running && scope && f===scope){ rb.textContent='● running'; rb.disabled=true; }
        else { rb.textContent='▶ Run'; rb.disabled=false; }
      }
      if(running && scope && scope!=='national'){ var sr=document.querySelector('tr[data-fips="'+scope+'"]'); if(sr) sr.classList.add('cc-live'); }
    }).catch(function(){ stateEl.textContent='status unavailable'; });
  }
  // Conflicts panel — the resolution loop (Keep / Accept / Edit / Dismiss).
  var _lastConflictCount = -1;
  function renderConflicts(openCount){
    var panel=document.getElementById('cc-conflicts-panel'), rowsEl=document.getElementById('cc-conflicts-rows');
    if(!panel||!rowsEl) return;
    if(openCount===0){ panel.style.display='none'; _lastConflictCount=0; return; }
    panel.style.display='block';
    if(openCount===_lastConflictCount) return;  // avoid re-render churn while polling
    _lastConflictCount=openCount;
    fetch('/api/contacts/conflicts',{cache:'no-store'}).then(function(r){return r.json();}).then(function(j){
      var rows=(j.conflicts||[]).map(function(c){
        var what = c.existing_value ? ('on file: <code>'+c.existing_value+'</code> · found: <code>'+(c.found_value||'—')+'</code>') : ('found: <code>'+(c.found_value||'—')+'</code> · '+(c.detail||''));
        var src = c.found_source_url ? ' <a href="'+c.found_source_url+'" target="_blank" rel="noopener" style="font-size:11px">src</a>' : '';
        return '<div style="padding:5px 0;border-bottom:1px solid var(--civic-border,#eee)" data-cid="'+c.id+'">'
          + '<strong>'+c.canonical_name+'</strong> <span style="font-family:monospace;font-size:11px;color:#888">'+c.field_kind+'</span> — '+what+src
          + ' <span style="float:right;white-space:nowrap">'
          + '<button class="cc-cres" data-id="'+c.id+'" data-a="keep" style="font-size:10px;margin-left:4px">Keep</button>'
          + '<button class="cc-cres" data-id="'+c.id+'" data-a="accept" style="font-size:10px;margin-left:4px">Accept found</button>'
          + '<button class="cc-cres" data-id="'+c.id+'" data-a="edit" style="font-size:10px;margin-left:4px">Edit…</button>'
          + '<button class="cc-cres" data-id="'+c.id+'" data-a="dismiss" style="font-size:10px;margin-left:4px">Dismiss</button>'
          + '</span></div>';
      }).join('');
      rowsEl.innerHTML = rows || '<em>none</em>';
    }).catch(function(){});
  }
  document.addEventListener('click',function(ev){
    var b = ev.target && ev.target.closest && ev.target.closest('.cc-cres');
    if(!b) return;
    ev.preventDefault(); ev.stopPropagation();
    var id=b.getAttribute('data-id'), a=b.getAttribute('data-a'), v='';
    if(a==='edit'){ v=prompt('Correct value:')||''; if(!v) return; }
    b.disabled=true; b.textContent='…';
    fetch('/api/contacts/conflicts/resolve?id='+encodeURIComponent(id)+'&action='+encodeURIComponent(a)+(v?'&value='+encodeURIComponent(v):''),{cache:'no-store'})
      .then(function(){ _lastConflictCount=-1; refresh(); })
      .catch(function(){ b.disabled=false; b.textContent=a; });
  }, true);
  offBtn.addEventListener('click',function(){ if(confirm('Stop the contact engine?')) { stateEl.textContent='stopping…'; fetch('/api/contacts/off',{cache:'no-store'}).then(function(){ setTimeout(refresh,1500); }); } });
  // CAPTURE phase so the Run click fires before the row's navigate handler.
  document.addEventListener('click',function(ev){
    var b = ev.target && ev.target.closest && ev.target.closest('.run-contacts-btn');
    if(!b) return;
    ev.preventDefault(); ev.stopPropagation();
    var fips=b.getAttribute('data-fips'), name=b.getAttribute('data-name');
    var budget=(budgetEl&&budgetEl.value)||'25', hours=(hoursEl&&hoursEl.value)||'4', parallel=(parallelEl&&parallelEl.value)||'6';
    if(!confirm('Find contact info for '+name+' candidates now?\\nCeilings: $'+budget+' budget, '+hours+'h window.\\nSources: state/county filings + campaign sites. Uses Claude quota; stops at whichever ceiling hits first (or when '+name+' is drained).')) return;
    b.disabled=true; b.textContent='▶ starting…';
    fetch('/api/contacts/run-state?fips='+encodeURIComponent(fips)+'&budget='+encodeURIComponent(budget)+'&hours='+encodeURIComponent(hours)+'&parallel='+encodeURIComponent(parallel),{cache:'no-store'})
      .then(function(r){return r.json();})
      .then(function(j){ b.textContent = (j&&j.ok)?'● running':'✕ err'; setTimeout(refresh,1500); })
      .catch(function(){ b.textContent='✕ err'; b.disabled=false; });
  }, true);
  // Reconcile / Refresh: run roster consolidation for the state BEFORE enriching.
  document.addEventListener('click',function(ev){
    var b = ev.target && ev.target.closest && ev.target.closest('.reconcile-btn');
    if(!b) return;
    ev.preventDefault(); ev.stopPropagation();
    var fips=b.getAttribute('data-fips'), name=b.getAttribute('data-name');
    if(!confirm('Reconcile '+name+' now?\\nRuns roster consolidation (advance uncontested primary winners, restore Nov-3 generals) and stamps "last refreshed". Do this BEFORE enriching. Never deletes.')) return;
    b.disabled=true; b.textContent='⟳ …';
    fetch('/api/contacts/reconcile-state?fips='+encodeURIComponent(fips),{cache:'no-store'})
      .then(function(r){return r.json();})
      .then(function(j){ b.textContent=(j&&j.ok)?'✓ done':'✕ err'; setTimeout(function(){ location.reload(); },2500); })
      .catch(function(){ b.textContent='✕ err'; b.disabled=false; });
  }, true);
  refresh(); setInterval(refresh,5000);
})();
</script>`;
}

// &#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;
// renderStatePage
// &#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;

export function renderStatePage(data: StatePageData): string {
  const generatedAtDisplay = data.generated_at.replace('T', ' ').slice(0, 16) + ' UTC';

  const totalCandidates = data.offices.reduce((a, o) => a + o.candidates_total, 0);
  const totalResearched = data.offices.reduce((a, o) => a + o.candidates_with_research, 0);
  const totalPositions = data.offices.reduce((a, o) => a + o.positions_sum, 0);
  const overallPct = totalCandidates > 0 ? totalResearched / totalCandidates : 0;

  // Group offices by election date. Within a date, sort by level (federal &#x2192;
  // state &#x2192; county &#x2192; municipal &#x2192; school &#x2192; special &#x2192; judicial) then name.
  const LEVEL_ORDER: Record<string, number> = {
    federal: 0, state: 1, county: 2, municipal: 3, school: 4, special: 5, judicial: 6,
  };
  const byDate = new Map<string, OfficeSlateRow[]>();
  for (const o of data.offices) {
    const k = o.election_date || 'unknown';
    if (!byDate.has(k)) byDate.set(k, []);
    byDate.get(k)!.push(o);
  }
  for (const arr of byDate.values()) {
    arr.sort((a, b) => {
      const la = LEVEL_ORDER[a.level] ?? 99;
      const lb = LEVEL_ORDER[b.level] ?? 99;
      if (la !== lb) return la - lb;
      return a.office_name.localeCompare(b.office_name);
    });
  }
  const dateKeys = [...byDate.keys()].sort();

  const officeRowsHtml = dateKeys
    .map((dateKey) => {
      const offices = byDate.get(dateKey)!;
      const dateLabel =
        dateKey === 'unknown'
          ? 'Date unknown'
          : new Date(dateKey + 'T12:00:00Z').toLocaleDateString('en-US', {
              year: 'numeric',
              month: 'long',
              day: 'numeric',
              timeZone: 'UTC',
            });
      const rows = offices
        .map((o) => {
          const pctValue = o.candidates_total > 0 ? o.candidates_with_research / o.candidates_total : 0;
          const pctStr = o.candidates_total > 0 ? pct(pctValue) : '&#x2014;';
          const color = pctColor(pctValue);
          const barWidth = Math.round(pctValue * 100);
          const officeHref = `/candidate-review/office/${esc(o.office_id)}`;
          const candidatesCell =
            o.candidates_total > 0
              ? `<span style="color:${color === '#dddd33' ? '#7e7517' : color};font-weight:600">${fmt(o.candidates_with_research)}</span><span style="color:var(--civic-text-muted)">/${fmt(o.candidates_total)}</span>`
              : `<span style="color:var(--civic-text-muted)">no candidates yet</span>`;
          const stated = o.candidates_with_stated;
          const inferred = o.candidates_with_inferred;
          const mixCell =
            o.candidates_with_research === 0
              ? `<span class="cr-mix"><span class="dot empty"></span><span style="color:var(--civic-text-muted)">none</span></span>`
              : `<span class="cr-mix" title="${stated} candidate(s) with stated positions &#xB7; ${inferred} with inferred">
                  <span class="dot stated"></span>${stated}
                  <span class="dot inferred"></span>${inferred}
                </span>`;
          const officeFullName =
            o.office_name + (o.seat_designation ? ` (${o.seat_designation})` : '');
          return `<tr class="click-row" data-href="${officeHref}">
            <td><a href="${officeHref}" style="border:none">${esc(officeFullName)}</a></td>
            <td><span class="cr-pill ${esc(o.level || '')}">${esc(o.level || '&#x2014;')}</span></td>
            <td style="font-family:var(--civic-font-mono);font-size:11px;color:var(--civic-text-muted);text-transform:uppercase">${esc(o.election_type)}</td>
            <td class="num">${candidatesCell}</td>
            <td>${mixCell}</td>
            <td class="num">${fmt(o.positions_sum)}</td>
            <td class="num">
              <span class="cr-bar"><span style="width:${barWidth}%;background:${color}"></span></span>
              <span class="cr-bar-label">${pctStr}</span>
            </td>
          </tr>`;
        })
        .join('\n');
      return `<h2 style="margin-top:1.4em">${esc(dateLabel)} <span style="font-size:12px;color:var(--civic-text-muted);font-weight:normal;letter-spacing:0;text-transform:none;margin-left:8px">${fmt(offices.length)} office${offices.length === 1 ? '' : 's'}</span></h2>
        <table>
          <thead>
            <tr>
              <th>Office</th>
              <th>Level</th>
              <th>Election type</th>
              <th class="num">Candidates (researched / total)</th>
              <th>View mix</th>
              <th class="num">Positions sum</th>
              <th class="num">Research depth</th>
            </tr>
          </thead>
          <tbody>
${rows}
          </tbody>
        </table>`;
    })
    .join('\n');

  return `<style>${SHARED_CSS}</style>
<div class="cr-root">
  <header>
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:1em;flex-wrap:wrap">
      <div>
        <div class="kicker">Candidate research &#xB7; ${esc(data.state_name)} &#xB7; regenerated ${esc(generatedAtDisplay)}</div>
        <div class="breadcrumbs">
          <a href="/admin/candidate-review">Candidate review</a>
          <span class="sep">&#x203A;</span>
          <span>${esc(data.state_name)}</span>
        </div>
        <h1>${esc(data.state_name)} &#x2014; offices on the ballot this cycle</h1>
      </div>
      <a href="/admin/office-review" target="_blank" rel="noopener"
         style="font-family:var(--civic-font-mono,ui-monospace,monospace);font-size:12px;letter-spacing:.06em;text-transform:uppercase;font-weight:600;background:var(--civic-primary,#1a2f5c);color:#fff;padding:9px 16px;border-radius:6px;text-decoration:none;white-space:nowrap;align-self:center;border:none;display:inline-block"
         title="Open the office-review dashboard in a new tab">
        &#x2197; Office review
      </a>
    </div>
  </header>
  <p class="lede">
    Every office in ${esc(data.state_name)} with at least one upcoming election
    in the current calendar year. Grouped by election date so primaries appear
    above generals. Click an office to drill into the candidate slate and the
    research depth on each position.
  </p>

  <div class="cr-totals-strip">
    <span class="group">
      <span class="big">${fmt(data.offices.length)}</span>
      <span class="lbl">Offices up</span>
    </span>
    <span class="group">
      <span class="big">${fmt(totalCandidates)}</span>
      <span class="lbl">Candidates</span>
    </span>
    <span class="group">
      <span class="big">${fmt(totalResearched)}</span>
      <span class="lbl">Researched</span>
      <span class="detail">${pct(overallPct)} of slate</span>
    </span>
    <span class="group">
      <span class="big">${fmt(totalPositions)}</span>
      <span class="lbl">Position rows</span>
      <span class="detail">summed across slate</span>
    </span>
    <span class="group" style="margin-left:auto">
      <a href="/admin/candidate-review" style="font-size:11px;color:var(--civic-text-muted);border:none">&#x2190; back to state index</a>
    </span>
  </div>

  ${
    data.offices.length === 0
      ? `<div class="cr-empty">No offices in ${esc(data.state_name)} have an upcoming election in this calendar year. Either no elections this cycle, or the elections table hasn't been populated yet.</div>`
      : officeRowsHtml
  }

  <p style="font-size:11px;color:var(--civic-text-muted);margin-top:24px;font-family:var(--civic-font-mono,ui-monospace,monospace)">
    "View mix" splits the slate by how positions were captured &#x2014;
    <span class="cr-mix" style="display:inline"><span class="dot stated"></span>stated</span>
    means the candidate's own statement (questionnaire, campaign site, on-record);
    <span class="cr-mix" style="display:inline"><span class="dot inferred"></span>inferred</span>
    means we derived the position from voting records, affiliations, or paraphrased media coverage.
    Office page (next click) shows the per-position source-tier breakdown.
  </p>
</div>
<script>
(function() {
  document.querySelectorAll('tr.click-row').forEach(function(tr) {
    tr.addEventListener('click', function(e) {
      if (e.target.tagName === 'A') return;
      var href = tr.getAttribute('data-href');
      if (href) window.location.href = href;
    });
  });
})();
</script>`;
}

// &#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;
// renderOfficePagePlaceholder &#x2014; task #33 placeholder until the A+ position
// grid lands. Keeps the click-through working so the user can validate the
// state-index &#x2192; state-page &#x2192; office-page navigation today.
// &#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;

export function renderOfficePagePlaceholder(office_id: string): string {
  return `<style>${SHARED_CSS}</style>
<div class="cr-root">
  <div class="breadcrumbs">
    <a href="/admin/candidate-review">Candidate review</a>
    <span class="sep">&#x203A;</span>
    <span>Office</span>
  </div>
  <h1>Office detail (coming soon)</h1>
  <div class="cr-empty">
    <p>The per-office candidate slate + position matrix (A+ visual: score + confidence bar + source-tier dots + stated/inferred-conflict flag) lands next.</p>
    <p style="margin-top:12px;font-family:var(--civic-font-mono,ui-monospace,monospace);font-size:11px">office_id: ${esc(office_id)}</p>
    <p style="margin-top:12px"><a href="javascript:history.back()">&#x2190; back</a></p>
  </div>
</div>`;
}
