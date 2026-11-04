/**
 * Name -> candidacy + person resolution for state SoS adapters.
 *
 * Called by base.ts once per reported row BEFORE writing election_results.
 * If resolution is ambiguous (>1 candidate answers) or missing, the base
 * adapter logs to ingestion_errors and writes the row with NULL candidacy_id
 * / person_id — election_results still records the vote totals so we can
 * surface unofficial counts even when we haven't matched a filed candidate.
 *
 * Resolution strategy
 * -------------------
 * 1. Normalize reported_name via canonicalKey() — same transform as the
 *    people.canonical_key DB trigger (lower + strip non-alphanumeric).
 * 2. Query people WHERE canonical_key = $1.
 * 3. For each candidate person, check for an active candidacy in an
 *    election this year against the resolved office (resolveOfficeElection).
 * 4. Narrow to exactly one → return. 0 or >1 → return null.
 *
 * Office resolution is intentionally lenient: the SoS reports the office as
 * "U.S. HOUSE OF REPRESENTATIVES, DISTRICT 1" while we store it as
 * "United States Representative, District 1, UT" or as a seat_designation
 * on the office row. We apply a light normalization (expand abbreviations +
 * strip punctuation) and match on office_types.slug or canonical_name
 * tokens combined with the district identifier.
 *
 * Cross-state collision protection (council 2026-04-25 finding DE#3)
 * ------------------------------------------------------------------
 * The `people` table has no state_fips column — a person can run in
 * multiple states or move. canonical_key alone is therefore NOT a
 * unique key: two unrelated "John Smith"s in CA and OH both produce
 * canonical_key='johnsmith'. The 457 cross-state dupes the data-quality
 * watcher found are because per-state candidacy adapters were doing
 * `SELECT id FROM people WHERE canonical_key = $1 LIMIT 1` and accepting
 * whichever row happened to come back first.
 *
 * The fix: lookups MUST disambiguate by state_fips via joins to either
 * candidacies (current cycle) or office_tenures (historical incumbency).
 * Use {@link findOrCreatePerson} for any code path that creates people
 * rows. resolveCandidacy() already inherits the disambiguation through
 * its election_id filter (each election is bound to exactly one office,
 * which is bound to exactly one jurisdiction → state).
 */

import type { Pool } from 'pg';

// ---------------------------------------------------------------------------
// Name normalization — must match people.canonical_key trigger
// ---------------------------------------------------------------------------

export function canonicalKey(name: string): string {
  // NFD-normalize and strip combining marks before lowercasing so accented
  // characters fold to their ASCII equivalents (council finding #8).
  // "Vázquez" → "vazquez", "Núñez" → "nunez", "Müller" → "muller".
  // Required for Puerto Rico + every bilingual state where SoS reports
  // sometimes carry diacritics, sometimes don't, for the same person.
  // SQL-side equivalent ships in migration 20260425000006_territory_office_types.sql
  // (unaccent extension + trigger update).
  return name
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

// ---------------------------------------------------------------------------
// Office normalization
// ---------------------------------------------------------------------------

/**
 * Map the source's free-form office string to our slug/canonical form.
 * Kept intentionally conservative — return lowercase, punctuation-stripped,
 * abbreviation-expanded. Callers do fuzzy / substring matching on the
 * result, not exact equality.
 */
export function normalizeOfficeName(raw: string): string {
  // Order matters: compound patterns BEFORE their component abbreviations
  // so "Lt. Gov." expands to "lieutenant governor" not "lt governor".
  const expansions: Array<[RegExp, string]> = [
    // Compounds first
    [/\blt\.?\s*gov\.?(?:ernor)?\b/gi, 'lieutenant governor'],
    [/\batty?\.?\s*gen\.?(?:eral)?\b/gi, 'attorney general'],
    [/\bv\.?p\.?\b/gi, 'vice president'],
    [/\bdistrict\s+attorney\b/gi, 'district attorney'],
    // Scalar abbreviations
    [/\bu\.?s\.?\b/gi, 'united states'],
    [/\bus\b/gi, 'united states'],
    [/\brep\.?\b/gi, 'representative'],
    [/\bsen\.?\b/gi, 'senator'],
    [/\bgov\.?\b/gi, 'governor'],
    [/\bag\b/gi, 'attorney general'],
    [/\btreas\.?\b/gi, 'treasurer'],
    [/\baud\.?\b/gi, 'auditor'],
    [/\bdist\.?\b/gi, 'district'],
    [/\bda\b/gi, 'district attorney'],
    [/\bpres\.?\b/gi, 'president'],
    [/\bassy\.?\b/gi, 'assembly'],
    [/\bleg\.?\b/gi, 'legislative'],
    [/\bsch\.?\b/gi, 'school'],
    [/\bbd\.?\b/gi, 'board'],
  ];
  let out = raw.toLowerCase().trim();
  for (const [re, rep] of expansions) out = out.replace(re, rep);
  // Replace any punctuation / whitespace cluster with a single space.
  out = out.replace(/[^a-z0-9]+/g, ' ').trim();
  return out;
}

// ---------------------------------------------------------------------------
// Office → election resolution
// ---------------------------------------------------------------------------

export type ResolveOfficeElectionInput = {
  state_fips: string;
  office_name: string;
  district_identifier: string | null | undefined;
  election_year: number;
};

export type ResolveOfficeElectionResult = {
  office_id: string;
  election_id: string;
};

/**
 * Given a state + free-form office name + optional district, return the
 * most-plausible (office_id, election_id) pair for the given year. Returns
 * null when no office matches or when >1 equally-plausible matches exist.
 *
 * Query strategy:
 *   - Offices live in `offices` keyed on office_type_id + jurisdiction_id.
 *   - The jurisdictions table holds fips_state for every state jurisdiction.
 *   - We normalize the input and search canonical_name AND seat_designation
 *     for any of the normalized tokens, tied to a jurisdiction in the
 *     state.
 *   - Then join elections ON office_id and filter by election_year.
 *   - If district_identifier is provided, prefer rows where
 *     seat_designation contains it or canonical_name contains it; otherwise
 *     accept the top candidate.
 */
export async function resolveOfficeElection(
  pg: Pool,
  input: ResolveOfficeElectionInput,
): Promise<ResolveOfficeElectionResult | null> {
  const norm = normalizeOfficeName(input.office_name);
  const districtNeedle = (input.district_identifier ?? '').trim();

  // Extract tokens; we use the two most distinctive ones as substring
  // filters against canonical_name. Short common words stripped.
  const stop = new Set([
    'of', 'the', 'and', 'for', 'in', 'on', 'at', 'a', 'an', 'to', 'from',
  ]);
  const tokens = norm
    .split(/\s+/)
    .filter((t) => t.length > 2 && !stop.has(t));

  if (tokens.length === 0) return null;

  // Build an AND-of-ILIKEs on canonical_name. Postgres pg_trgm GIN index
  // on offices.canonical_name keeps this fast.
  const likeClauses: string[] = [];
  const likeParams: string[] = [];
  for (const t of tokens.slice(0, 4)) {
    likeParams.push(`%${t}%`);
    likeClauses.push(`lower(o.canonical_name) LIKE $${likeParams.length + 2}`);
  }

  // $1 = state_fips, $2 = election_year, $3..n = token likes, final = districtNeedle
  const params: Array<string | number> = [
    input.state_fips,
    input.election_year,
    ...likeParams,
  ];

  // District-aware scoring: prefer rows whose seat_designation or
  // canonical_name contains the district_identifier.
  const districtClause = districtNeedle
    ? `CASE WHEN o.seat_designation ILIKE $${params.length + 1}
             OR lower(o.canonical_name) LIKE $${params.length + 1}
           THEN 1 ELSE 0 END`
    : '0';
  if (districtNeedle) params.push(`%${districtNeedle}%`);

  const sql = `
    SELECT o.id AS office_id,
           e.id AS election_id,
           ${districtClause} AS district_score
    FROM offices o
    JOIN jurisdictions j ON j.id = o.jurisdiction_id
    JOIN elections e ON e.office_id = o.id
    WHERE j.fips_state = $1
      AND EXTRACT(YEAR FROM e.election_date)::int = $2
      ${likeClauses.length > 0 ? 'AND ' + likeClauses.join(' AND ') : ''}
    ORDER BY district_score DESC, e.election_date ASC
    LIMIT 5
  `;

  const res = await pg.query<{
    office_id: string;
    election_id: string;
    district_score: number;
  }>(sql, params);

  if (res.rows.length === 0) return null;

  // If district specified: require a positive district_score for the top
  // hit. Otherwise return the top match.
  const top = res.rows[0];
  if (districtNeedle && top.district_score === 0) return null;

  // Ambiguity check: if the top-2 rows tie on district_score AND we have
  // no way to distinguish, bail out.
  if (res.rows.length > 1) {
    const second = res.rows[1];
    if (
      second.district_score === top.district_score &&
      top.office_id !== second.office_id
    ) {
      // Multiple offices match equally; resolution is ambiguous.
      return null;
    }
  }

  return { office_id: top.office_id, election_id: top.election_id };
}

// ---------------------------------------------------------------------------
// Candidacy resolution
// ---------------------------------------------------------------------------

export type ResolveCandidacyInput = {
  reported_name: string;
  state_fips: string;
  office_name: string;
  district_identifier?: string | null;
  election_year: number;
};

export type ResolveCandidacyResult = {
  candidacy_id: string;
  person_id: string;
};

/**
 * Resolve reported_name + office + state + year to a single candidacy row.
 *
 * Returns null for any ambiguous or missing match so the caller can log to
 * ingestion_errors and continue. This is intentional: partial matches are
 * dangerous (attach vote totals to the wrong person), absence is safe.
 */
export async function resolveCandidacy(
  pg: Pool,
  input: ResolveCandidacyInput,
): Promise<ResolveCandidacyResult | null> {
  const key = canonicalKey(input.reported_name);
  if (!key) return null;

  // Step 1: resolve the office/election context first. Without this,
  // any two people named "John Smith" in the same year collide.
  const officeInfo = await resolveOfficeElection(pg, {
    state_fips: input.state_fips,
    office_name: input.office_name,
    district_identifier: input.district_identifier,
    election_year: input.election_year,
  });
  if (!officeInfo) return null;

  // Step 2: find candidacies IN THIS ELECTION whose person has the
  // canonical_key we derived from the reported name. The election_id
  // filter implicitly scopes to this state (an election belongs to
  // exactly one office, which belongs to exactly one jurisdiction); we
  // also assert state_fips on the offices→jurisdictions chain
  // explicitly so any future schema drift fails loudly rather than
  // silently re-introducing cross-state collisions (council 2026-04-25
  // finding DE#3).
  const sql = `
    SELECT c.id AS candidacy_id,
           c.person_id AS person_id
    FROM candidacies c
    JOIN people p ON p.id = c.person_id
    JOIN elections el ON el.id = c.election_id
    JOIN offices o ON o.id = el.office_id
    JOIN jurisdictions j ON j.id = o.jurisdiction_id
    WHERE c.election_id = $1
      AND p.canonical_key = $2
      AND j.fips_state = $3
      AND c.status NOT IN ('withdrew','disqualified')
    LIMIT 3
  `;
  const res = await pg.query<{
    candidacy_id: string;
    person_id: string;
  }>(sql, [officeInfo.election_id, key, input.state_fips]);

  if (res.rows.length !== 1) return null;
  return res.rows[0];
}

// ---------------------------------------------------------------------------
// Person find-or-create — ALWAYS state-disambiguated
// ---------------------------------------------------------------------------

export type FindOrCreatePersonInput = {
  /** Free-form reported name; the same string written verbatim into
   * people.canonical_name when a new row is created. */
  name: string;
  /** Two-character state FIPS, e.g. '49' for Utah. Required — a lookup
   * without state_fips collides on canonical_key across states. */
  state_fips: string;
  /** Optional election year used to break ties when multiple matching
   * people exist (most-recent activity wins). */
  electionYear?: number;
  /** Optional source tag stored on people.meta when a new row is
   * created. Helps audit which adapter created the person. */
  source?: string;
  /** Optional data_source_id stored on people.meta. */
  dataSourceId?: string;
};

/**
 * Find an existing person row tied to the given state, or create a new
 * one. Lookup logic:
 *
 *   1. Compute canonical_key (lower + strip-nonalnum).
 *   2. SELECT every people row with that canonical_key.
 *   3. For each candidate, check whether they have ANY candidacy in
 *      `state_fips` OR an office_tenure for an office located in
 *      `state_fips`. People rows that fail BOTH tests are not us.
 *   4. If exactly one candidate passes: return that person_id.
 *   5. If multiple pass: prefer the one with most-recent activity in
 *      this state (max(filed_on) on candidacies + max(started_on) on
 *      tenures). If electionYear is provided, prefer the candidate
 *      whose latest activity is closest to (year, year-1, year-2) etc.
 *   6. If zero pass: insert a new people row. The dupe is intentional —
 *      two real people with the same name in different states.
 *
 * Idempotent under concurrent writers (re-reads after INSERT-on-conflict).
 *
 * IMPORTANT: This does NOT merge existing duplicates. The 457 known
 * dupes from before this fix shipped need a separate cleanup pass.
 * Going forward this function makes sure no NEW cross-state dupes are
 * created.
 */
export async function findOrCreatePerson(
  pg: Pool,
  input: FindOrCreatePersonInput,
): Promise<string> {
  const reportedName = input.name.trim();
  const key = canonicalKey(reportedName);
  if (!key) {
    throw new Error(
      `findOrCreatePerson: empty canonical_key for input "${input.name}"`,
    );
  }
  if (!input.state_fips || !/^\d{2}$/.test(input.state_fips)) {
    throw new Error(
      `findOrCreatePerson: state_fips must be a 2-digit FIPS string, got "${input.state_fips}"`,
    );
  }

  // ---- Lookup phase --------------------------------------------------
  // Pull every person row with the matching canonical_key, plus a
  // single-row aggregate over their state-scoped activity. We score
  // each candidate by:
  //   - has_candidacy_in_state: 1 if any candidacy in this state, else 0
  //   - has_tenure_in_state:    1 if any office_tenure in this state, else 0
  //   - latest_activity:         most recent of (filed_on, started_on,
  //                              election_date) in this state
  // and discard candidates that score 0/0.
  const lookupSql = `
    SELECT
      p.id,
      p.created_at,
      EXISTS (
        SELECT 1
        FROM candidacies c
        JOIN elections el ON el.id = c.election_id
        JOIN offices o ON o.id = el.office_id
        JOIN jurisdictions j ON j.id = o.jurisdiction_id
        WHERE c.person_id = p.id AND j.fips_state = $2
      ) AS has_candidacy_in_state,
      EXISTS (
        SELECT 1
        FROM office_tenures t
        JOIN offices o ON o.id = t.office_id
        JOIN jurisdictions j ON j.id = o.jurisdiction_id
        WHERE t.person_id = p.id AND j.fips_state = $2
      ) AS has_tenure_in_state,
      (
        SELECT max(GREATEST(
          COALESCE(c.filed_on, '1900-01-01'::date),
          COALESCE(el.election_date, '1900-01-01'::date)
        ))
        FROM candidacies c
        JOIN elections el ON el.id = c.election_id
        JOIN offices o ON o.id = el.office_id
        JOIN jurisdictions j ON j.id = o.jurisdiction_id
        WHERE c.person_id = p.id AND j.fips_state = $2
      ) AS latest_candidacy_in_state,
      (
        SELECT max(COALESCE(t.ended_on, t.started_on))
        FROM office_tenures t
        JOIN offices o ON o.id = t.office_id
        JOIN jurisdictions j ON j.id = o.jurisdiction_id
        WHERE t.person_id = p.id AND j.fips_state = $2
      ) AS latest_tenure_in_state
    FROM people p
    WHERE p.canonical_key = $1
  `;
  type LookupRow = {
    id: string;
    created_at: Date;
    has_candidacy_in_state: boolean;
    has_tenure_in_state: boolean;
    latest_candidacy_in_state: Date | null;
    latest_tenure_in_state: Date | null;
  };
  const found = await pg.query<LookupRow>(lookupSql, [key, input.state_fips]);

  // Filter: keep rows that have at least one in-state activity. These
  // are the only rows that can plausibly be "the same person" as the
  // one we're about to ingest in this state. Out-of-state rows with
  // the same canonical_key are presumed unrelated.
  const inStateMatches = found.rows.filter(
    (r) => r.has_candidacy_in_state || r.has_tenure_in_state,
  );

  if (inStateMatches.length === 1) {
    return inStateMatches[0]!.id;
  }

  if (inStateMatches.length > 1) {
    // Prefer the most recently active in-state row. If electionYear is
    // provided, the closest year wins; otherwise the most recent date.
    const target = input.electionYear ?? new Date().getUTCFullYear();
    const scored = inStateMatches.map((r) => {
      const latest = mostRecent(
        r.latest_candidacy_in_state,
        r.latest_tenure_in_state,
      );
      const yearDelta = latest
        ? Math.abs(latest.getUTCFullYear() - target)
        : Number.POSITIVE_INFINITY;
      return { row: r, latest, yearDelta };
    });
    scored.sort((a, b) => {
      // Lower yearDelta wins. Tiebreak: more recent absolute date wins.
      if (a.yearDelta !== b.yearDelta) return a.yearDelta - b.yearDelta;
      const aMs = a.latest ? a.latest.getTime() : 0;
      const bMs = b.latest ? b.latest.getTime() : 0;
      return bMs - aMs;
    });
    return scored[0]!.row.id;
  }

  // ---- Insert phase --------------------------------------------------
  // No in-state row exists. Out-of-state rows with the same
  // canonical_key are intentionally left alone — different person.
  const meta: Record<string, unknown> = {};
  if (input.source) meta.source = input.source;
  if (input.dataSourceId) meta.data_source_id = input.dataSourceId;
  meta.created_for_state_fips = input.state_fips;

  const ins = await pg.query<{ id: string }>(
    `INSERT INTO people
       (canonical_name, full_legal_name, canonical_key, meta)
     VALUES ($1, $1, $2, $3::jsonb)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [reportedName, key, JSON.stringify(meta)],
  );
  if (ins.rows[0]) return ins.rows[0].id;

  // Race recovery: another writer inserted between our lookup and
  // insert. Re-read with the same state filter so we still pick up
  // an in-state row when one exists; otherwise fall through to a
  // canonical_key-only re-read (a concurrent writer for the SAME
  // state may have just landed a row whose candidacies/tenures haven't
  // been written yet — accept that since dropping it would create the
  // very dupe we're trying to prevent).
  const recheck = await pg.query<LookupRow>(lookupSql, [key, input.state_fips]);
  const recheckInState = recheck.rows.filter(
    (r) => r.has_candidacy_in_state || r.has_tenure_in_state,
  );
  if (recheckInState.length > 0) return recheckInState[0]!.id;

  // Last resort: someone else just inserted a person row with the
  // same canonical_key but no candidacies/tenures yet. Pick the one
  // tagged with our state_fips in meta.created_for_state_fips, else
  // the newest.
  const fallback = await pg.query<{ id: string; meta: Record<string, unknown> | null }>(
    `SELECT id, meta
       FROM people
      WHERE canonical_key = $1
      ORDER BY (meta->>'created_for_state_fips' = $2)::int DESC,
               created_at DESC
      LIMIT 1`,
    [key, input.state_fips],
  );
  if (fallback.rows[0]) return fallback.rows[0].id;

  throw new Error(
    `findOrCreatePerson: could not locate or create person for "${reportedName}" (key=${key}, state=${input.state_fips})`,
  );
}

function mostRecent(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a.getTime() >= b.getTime() ? a : b;
}
