/**
 * Party-string -> parties.id resolution.
 *
 * Every state SoS reports party differently: 'DEM', 'Democratic', 'D',
 * 'DFL' (MN), 'NPL' (ND), 'DTS' (CA no-preference). The parties schema
 * normalizes this via:
 *
 *   - Abbreviation (state-scoped via (state_fips, abbreviation))
 *   - normalized_name (state-scoped)
 *   - aliases[] (GIN-indexed array of known string variants)
 *
 * State-scoped rows take precedence over national rows so DFL-in-Minnesota
 * resolves to the MN DFL row rather than the national Democratic row.
 *
 * When nothing matches, we return null — the base adapter lets the row
 * through with NULL party_id. A separate periodic audit (see unknown party
 * query below) surfaces recurring unknowns for human review so we only
 * seed new parties after observing real usage.
 */

import type { Pool } from 'pg';

// ---------------------------------------------------------------------------
// Primary lookup
// ---------------------------------------------------------------------------

/**
 * Resolve a free-form party string to parties.id.
 *
 * Preference order (higher -> lower):
 *   1. state-scoped row whose abbreviation / normalized_name / aliases match
 *   2. national row (state_fips IS NULL) with same match
 *
 * Match rules:
 *   - abbreviation = $normalized (case-insensitive)
 *   - normalized_name = $normalized (case-insensitive)
 *   - $normalized = ANY(aliases) — stored as-entered; we check both the
 *     raw input and the uppercase form.
 */
export async function resolvePartyId(
  pg: Pool,
  party_string: string | null | undefined,
  state_fips: string,
): Promise<string | null> {
  if (party_string === null || party_string === undefined) return null;
  const raw = party_string.trim();
  if (!raw) return null;

  // A handful of common "non-party" sentinels the adapter layer emits.
  // Normalize write-in variants up-front so '(W-I)', 'W/I', 'write-in'
  // all resolve to the national write_in row.
  const writeInRe = /^(w[-/]?i|write[-\s]*in)$/i;
  if (writeInRe.test(raw)) {
    const r = await pg.query<{ id: string }>(
      `SELECT id FROM parties
         WHERE state_fips IS NULL AND party_family = 'write_in'
         LIMIT 1`,
    );
    return r.rows[0]?.id ?? null;
  }

  const upper = raw.toUpperCase();

  // Single query. Rank: state-scoped match (rank=0) beats national (rank=1);
  // within each scope, abbreviation-match beats name-match beats alias-match.
  const sql = `
    SELECT id,
           CASE WHEN state_fips = $2 THEN 0 ELSE 1 END AS scope_rank,
           CASE
             WHEN upper(abbreviation) = $1 THEN 0
             WHEN upper(normalized_name) = $1 THEN 1
             WHEN $3 = ANY(aliases) OR $1 = ANY(aliases) THEN 2
             ELSE 3
           END AS match_rank
    FROM parties
    WHERE (state_fips = $2 OR state_fips IS NULL)
      AND (
        upper(abbreviation) = $1
        OR upper(normalized_name) = $1
        OR $3 = ANY(aliases)
        OR $1 = ANY(aliases)
      )
    ORDER BY scope_rank ASC, match_rank ASC
    LIMIT 1
  `;
  const res = await pg.query<{ id: string }>(sql, [upper, state_fips, raw]);
  return res.rows[0]?.id ?? null;
}

// ---------------------------------------------------------------------------
// Find-or-create helper (use sparingly)
// ---------------------------------------------------------------------------

/**
 * Find a state-scoped row; create a minimal stub if none exists. Returns
 * the id either way.
 *
 * Guidance: DO NOT call this from a production adapter. Preferred flow is
 * resolvePartyId() -> null -> log to ingestion_errors and let a human
 * review the unknown before we seed a new party row. This helper exists
 * for seed scripts and one-off backfills where human review happens up
 * front.
 */
export async function findOrCreateStateParty(
  pg: Pool,
  input: {
    state_fips: string;
    abbreviation: string;
    normalized_name: string;
    display_name?: string;
    aliases?: string[];
  },
): Promise<string> {
  // Try lookup first (by abbreviation within state).
  const lookup = await pg.query<{ id: string }>(
    `SELECT id FROM parties
       WHERE state_fips = $1 AND upper(abbreviation) = upper($2)
       LIMIT 1`,
    [input.state_fips, input.abbreviation],
  );
  if (lookup.rows[0]) return lookup.rows[0].id;

  // Insert stub. party_family = 'other' by default — caller should update
  // later once categorized.
  const ins = await pg.query<{ id: string }>(
    `INSERT INTO parties
       (state_fips, abbreviation, normalized_name, display_name, party_family, aliases, is_major_in_state)
     VALUES ($1, $2, $3, $4, 'other', $5, FALSE)
     ON CONFLICT (state_fips, abbreviation) DO UPDATE
       SET normalized_name = EXCLUDED.normalized_name
     RETURNING id`,
    [
      input.state_fips,
      input.abbreviation,
      input.normalized_name,
      input.display_name ?? input.normalized_name,
      input.aliases ?? [],
    ],
  );
  return ins.rows[0].id;
}

/**
 * Audit query — find party strings observed in election_results meta that
 * did not resolve. Intended for operator use, not in-run decision making.
 *
 * Usage (psql):
 *   SELECT * FROM unknown_party_audit('49') LIMIT 50;
 */
export async function listUnknownPartyObservations(
  pg: Pool,
  state_fips: string,
  limit = 50,
): Promise<Array<{ party_abbreviation: string; observations: number }>> {
  const sql = `
    SELECT er.party_abbreviation,
           count(*) AS observations
    FROM election_results er
    JOIN elections el ON el.id = er.election_id
    JOIN offices o ON o.id = el.office_id
    JOIN jurisdictions j ON j.id = o.jurisdiction_id
    WHERE er.party_id IS NULL
      AND er.party_abbreviation IS NOT NULL
      AND j.fips_state = $1
    GROUP BY er.party_abbreviation
    ORDER BY observations DESC
    LIMIT $2
  `;
  const res = await pg.query<{
    party_abbreviation: string;
    observations: number;
  }>(sql, [state_fips, limit]);
  return res.rows;
}
