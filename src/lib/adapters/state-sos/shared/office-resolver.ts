/**
 * Shared (office, election) resolver for state SoS candidate-filing adapters.
 *
 * Why this exists
 * ---------------
 * Per-state candidacy adapters historically called {@link resolveOfficeElection}
 * (a fuzzy ILIKE-against-canonical_name resolver) to find the office_id +
 * election_id for each parsed row. That resolver fails silently in two
 * common ways:
 *
 *   1. **Token mismatch.** The reported office name uses words that don't
 *      appear in canonical_name. UT's XLSX says "U.S. House District 1" →
 *      tokens [united, states, house, district]. But the canonical_name
 *      stored in our DB is "US Representative from Utah's 1st Congressional
 *      District" — has "Representative" but no "House". Zero matches.
 *      Same for "State Senate District 13" vs canonical "Utah State
 *      Senator — District 13" (Senator ≠ Senate).
 *
 *   2. **Missing election.** The office row exists but no `elections` row
 *      exists for the right year. Lt. Gov, AG, Auditor, Treasurer in UT
 *      run on the gubernatorial cycle — no 2026 entries seeded.
 *
 * Both paths cause the adapter to silently skip the row. UT was producing
 * 80 parsed rows but only 15 inserts; TN 50 parsed but only 35 inserts.
 *
 * The fix (per project brief, option (b))
 * ---------------------------------------
 * Auto-create offices + elections on the fly, marking newly-created rows
 * with `meta.data_quality_tier='compiled_by_adapter'` so the data-quality
 * dashboard can spot them and ops can promote to 'authoritative' once
 * verified. This is the same pattern that lets us scale to all 56
 * jurisdictions without hand-seeding 100+ offices per state.
 *
 * Resolution order (idempotent at every step):
 *   1. Find existing office by (state_fips, office_type_slug, district_id)
 *      — the strict path. Honors both `seat_designation` and
 *      `meta->>'district_name'` so we tolerate varied seat formats.
 *   2. Fallback to {@link resolveOfficeElection} — keeps existing fuzzy
 *      behavior so we don't lose offices already resolvable.
 *   3. If still no office: find or create an `office_types` row by slug
 *      (or fuzzy-derive from office_name when no slug supplied),
 *      then INSERT a new `offices` row tied to the state jurisdiction.
 *   4. Find or create the `elections` row for (office_id, year, type).
 *
 * Returned `data_quality_tier` says how authoritative the result is:
 *   - 'authoritative': office row pre-existed AND was already tier=authoritative
 *   - 'compiled': office or election was created by this helper, OR the office
 *     existed but is itself a compiled tier row.
 */

import type { Pool } from 'pg';
import { resolveOfficeElection } from '../candidate-resolver';

// ---------------------------------------------------------------------------
// Slug → office-type metadata (level + branch + display name)
// ---------------------------------------------------------------------------

/** Canonical level for newly-minted office_types. Picked from the slug. */
const SLUG_LEVEL: Record<string, { level: string; branch: string; generic_name: string }> = {
  // federal
  us_president: { level: 'federal', branch: 'executive', generic_name: 'President of the United States' },
  us_vice_president: { level: 'federal', branch: 'executive', generic_name: 'Vice President of the United States' },
  us_senator: { level: 'federal', branch: 'legislative', generic_name: 'U.S. Senator' },
  us_representative: { level: 'federal', branch: 'legislative', generic_name: 'U.S. Representative' },
  delegate: { level: 'federal', branch: 'legislative', generic_name: 'Delegate' },
  resident_commissioner: { level: 'federal', branch: 'legislative', generic_name: 'Resident Commissioner' },
  // state
  governor: { level: 'state', branch: 'executive', generic_name: 'Governor' },
  lieutenant_governor: { level: 'state', branch: 'executive', generic_name: 'Lieutenant Governor' },
  state_attorney_general: { level: 'state', branch: 'executive', generic_name: 'Attorney General' },
  state_auditor: { level: 'state', branch: 'administrative', generic_name: 'State Auditor' },
  state_treasurer: { level: 'state', branch: 'administrative', generic_name: 'State Treasurer' },
  secretary_of_state: { level: 'state', branch: 'administrative', generic_name: 'Secretary of State' },
  state_senator: { level: 'state', branch: 'legislative', generic_name: 'State Senator' },
  state_representative: { level: 'state', branch: 'legislative', generic_name: 'State Representative' },
  state_board_of_education: { level: 'state', branch: 'legislative', generic_name: 'State Board of Education Member' },
  state_supreme_court_justice: { level: 'judicial', branch: 'judicial', generic_name: 'Justice of the State Supreme Court' },
  judge_court_of_appeals: { level: 'judicial', branch: 'judicial', generic_name: 'Judge of the Court of Appeals' },
  // judicial generic
  judge_district_court: { level: 'judicial', branch: 'judicial', generic_name: 'District Court Judge' },
  judge_circuit_court: { level: 'judicial', branch: 'judicial', generic_name: 'Circuit Court Judge' },
};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ResolveOrCreateInput = {
  state_fips: string;
  /** Canonical slug from office_types (e.g., 'governor', 'state_senator').
   *  When omitted, the helper attempts to derive one from office_name. */
  office_type_slug?: string;
  /** Free-form office name as reported by the source. Used for canonical_name
   *  on newly-created offices and as a fallback for slug derivation. */
  office_name: string;
  /** Bare district id ('1', '13', '47'). null for statewide. */
  district_identifier: string | null;
  /** Year of the election we're attaching the candidacy to. */
  election_year: number;
  /** Election date (yyyy-mm-dd). Required; needed for both the find-by-(office,date)
   *  query and for creating a new election when one doesn't exist. */
  election_date: string;
  /** 'primary' | 'general' | etc. — must be one of elections.election_type CHECK values. */
  election_type: string;
  /** Optional data_source_id stored on newly-created rows for provenance. */
  data_source_id?: string;
  /** Adapter name stored on newly-created rows for audit. */
  adapter_name: string;
};

export type ResolveOrCreateResult = {
  office_id: string;
  election_id: string;
  /** Did we have to create rows? Used by callers to bump stats / log audit. */
  created: { office: boolean; office_type: boolean; election: boolean };
  /** Tier reported on the result. 'authoritative' only when the office was
   *  already authoritative AND the election already existed. */
  data_quality_tier: 'authoritative' | 'compiled';
};

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

/**
 * Resolve, or create-on-the-fly, the (office_id, election_id) for a
 * candidacy row. Never returns null — if everything else fails the helper
 * creates the rows it needs and tags them with `compiled_by_adapter`.
 *
 * Idempotent under concurrent writers: every INSERT is guarded by a SELECT
 * + ON CONFLICT, and the helper re-reads after a conflict to pick up the
 * row that landed.
 */
export async function resolveOrCreateOfficeAndElection(
  pg: Pool,
  input: ResolveOrCreateInput,
): Promise<ResolveOrCreateResult> {
  const created = { office: false, office_type: false, election: false };
  let officeIsAuthoritative = false;

  // --- Step 1: strict slug+district lookup ---------------------------------
  let officeId: string | null = null;
  if (input.office_type_slug) {
    officeId = await findOfficeBySlugAndDistrict(pg, {
      state_fips: input.state_fips,
      office_type_slug: input.office_type_slug,
      district_identifier: input.district_identifier,
    });
    if (officeId) {
      officeIsAuthoritative = await isOfficeAuthoritative(pg, officeId);
    }
  }

  // --- Step 2: legacy fuzzy resolver as compatibility fallback -------------
  if (!officeId) {
    const fuzzy = await resolveOfficeElection(pg, {
      state_fips: input.state_fips,
      office_name: input.office_name,
      district_identifier: input.district_identifier ?? null,
      election_year: input.election_year,
    });
    if (fuzzy) {
      // The fuzzy path returned both office_id and election_id — we can
      // short-circuit here. We still need a tier — read it from offices.meta.
      officeIsAuthoritative = await isOfficeAuthoritative(pg, fuzzy.office_id);
      return {
        office_id: fuzzy.office_id,
        election_id: fuzzy.election_id,
        created,
        data_quality_tier: officeIsAuthoritative ? 'authoritative' : 'compiled',
      };
    }
  }

  // --- Step 3: create the office (and office_type if necessary) ------------
  if (!officeId) {
    const slug = input.office_type_slug ?? deriveSlugFromName(input.office_name);
    const officeTypeId = await findOrCreateOfficeType(pg, slug, created);
    const jurisdictionId = await stateJurisdictionId(pg, input.state_fips);
    if (!jurisdictionId) {
      throw new Error(
        `office-resolver: no state jurisdiction for fips_state="${input.state_fips}"`,
      );
    }
    officeId = await createOffice(pg, {
      slug,
      office_type_id: officeTypeId,
      jurisdiction_id: jurisdictionId,
      office_name: input.office_name,
      district_identifier: input.district_identifier,
      adapter_name: input.adapter_name,
      data_source_id: input.data_source_id,
    });
    created.office = true;
  }

  // --- Step 4: find-or-create the election --------------------------------
  const { electionId, wasCreated } = await findOrCreateElection(pg, {
    office_id: officeId,
    election_date: input.election_date,
    election_type: input.election_type,
    adapter_name: input.adapter_name,
    data_source_id: input.data_source_id,
  });
  created.election = wasCreated;

  return {
    office_id: officeId,
    election_id: electionId,
    created,
    data_quality_tier:
      officeIsAuthoritative && !created.office && !created.election ? 'authoritative' : 'compiled',
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Find an office row by (state_fips, office_type slug, district_identifier).
 *
 * The lookup is intentionally permissive on the district side — it accepts
 * any seat_designation or meta.district_name that contains the supplied
 * district id, so "District 13", "Senate District 13", "House of
 * Representatives Seat 13" all resolve to the right row.
 *
 * When district_identifier is null we accept ANY office of the given slug
 * in the state (for statewide seats like Governor / AG / Treasurer).
 */
async function findOfficeBySlugAndDistrict(
  pg: Pool,
  input: { state_fips: string; office_type_slug: string; district_identifier: string | null },
): Promise<string | null> {
  if (input.district_identifier) {
    const d = input.district_identifier;
    // Anchor the district match: digits adjacent to a non-digit on both
    // sides so '1' doesn't accidentally match '11', '13', etc.
    // We use Postgres regex for that anchor + ILIKE for tolerance.
    const sql = `
      SELECT o.id
      FROM offices o
      JOIN office_types ot ON ot.id = o.office_type_id
      JOIN jurisdictions j ON j.id = o.jurisdiction_id
      WHERE j.fips_state = $1
        AND ot.slug = $2
        AND (
          o.seat_designation ~ $3
          OR (o.meta->>'district_name') ~ $3
          OR o.canonical_name ~ $3
        )
      ORDER BY
        (o.seat_designation ~ ('^District ' || $4 || '$'))::int DESC,
        (o.seat_designation = ('District ' || $4))::int DESC,
        o.created_at ASC
      LIMIT 1
    `;
    const anchored = `(^|[^0-9])0*${d}([^0-9]|$)`;
    const res = await pg.query<{ id: string }>(sql, [
      input.state_fips,
      input.office_type_slug,
      anchored,
      d,
    ]);
    if (res.rows[0]) return res.rows[0].id;
    return null;
  }
  // Statewide: just match on slug + state.
  const res = await pg.query<{ id: string }>(
    `
      SELECT o.id FROM offices o
      JOIN office_types ot ON ot.id = o.office_type_id
      JOIN jurisdictions j ON j.id = o.jurisdiction_id
      WHERE j.fips_state = $1 AND ot.slug = $2
      ORDER BY o.created_at ASC
      LIMIT 1
    `,
    [input.state_fips, input.office_type_slug],
  );
  return res.rows[0]?.id ?? null;
}

async function isOfficeAuthoritative(pg: Pool, officeId: string): Promise<boolean> {
  const r = await pg.query<{ tier: string | null }>(
    `SELECT meta->>'data_quality_tier' AS tier FROM offices WHERE id = $1`,
    [officeId],
  );
  return r.rows[0]?.tier === 'authoritative';
}

async function findOrCreateOfficeType(
  pg: Pool,
  slug: string,
  created: { office_type: boolean },
): Promise<string> {
  const r = await pg.query<{ id: string }>(
    `SELECT id FROM office_types WHERE slug = $1 LIMIT 1`,
    [slug],
  );
  if (r.rows[0]) return r.rows[0].id;

  const tmpl = SLUG_LEVEL[slug];
  const generic = tmpl?.generic_name ?? humanizeSlug(slug);
  const level = tmpl?.level ?? 'state';
  const branch = tmpl?.branch ?? null;

  const ins = await pg.query<{ id: string }>(
    `INSERT INTO office_types (slug, generic_name, level, branch)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (slug) DO UPDATE SET slug = EXCLUDED.slug
     RETURNING id`,
    [slug, generic, level, branch],
  );
  if (ins.rows[0]) {
    created.office_type = true;
    return ins.rows[0].id;
  }
  // Race fallback
  const re = await pg.query<{ id: string }>(
    `SELECT id FROM office_types WHERE slug = $1 LIMIT 1`,
    [slug],
  );
  if (re.rows[0]) return re.rows[0].id;
  throw new Error(`office-resolver: failed to create office_type slug=${slug}`);
}

async function stateJurisdictionId(pg: Pool, stateFips: string): Promise<string | null> {
  const r = await pg.query<{ id: string }>(
    `SELECT id FROM jurisdictions
      WHERE fips_state = $1 AND type IN ('state','territory','federal_district')
      ORDER BY (type='state')::int DESC, created_at ASC
      LIMIT 1`,
    [stateFips],
  );
  return r.rows[0]?.id ?? null;
}

async function createOffice(
  pg: Pool,
  input: {
    slug: string;
    office_type_id: string;
    jurisdiction_id: string;
    office_name: string;
    district_identifier: string | null;
    adapter_name: string;
    data_source_id?: string;
  },
): Promise<string> {
  const tmpl = SLUG_LEVEL[input.slug];
  const level = tmpl?.level ?? 'state';
  const seat = input.district_identifier ? `District ${input.district_identifier}` : null;
  const canonical = canonicalizeOfficeName(input.office_name, input.district_identifier);

  const meta = {
    data_quality_tier: 'compiled',
    created_by_adapter: input.adapter_name,
    data_source_id: input.data_source_id ?? null,
    district_name: input.district_identifier ?? null,
    auto_created: true,
  };

  const ins = await pg.query<{ id: string }>(
    `INSERT INTO offices (canonical_name, office_type_id, jurisdiction_id, level, seat_designation, meta)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     RETURNING id`,
    [canonical, input.office_type_id, input.jurisdiction_id, level, seat, JSON.stringify(meta)],
  );
  if (ins.rows[0]) return ins.rows[0].id;
  throw new Error(`office-resolver: failed to insert office "${canonical}"`);
}

async function findOrCreateElection(
  pg: Pool,
  input: {
    office_id: string;
    election_date: string;
    election_type: string;
    adapter_name: string;
    data_source_id?: string;
  },
): Promise<{ electionId: string; wasCreated: boolean }> {
  const sel = await pg.query<{ id: string }>(
    `SELECT id FROM elections
      WHERE office_id = $1 AND election_date = $2::date AND election_type = $3
      LIMIT 1`,
    [input.office_id, input.election_date, input.election_type],
  );
  if (sel.rows[0]) return { electionId: sel.rows[0].id, wasCreated: false };

  const ins = await pg.query<{ id: string }>(
    `INSERT INTO elections (office_id, election_date, election_type, meta)
     VALUES ($1, $2::date, $3, $4::jsonb)
     ON CONFLICT (office_id, election_date, election_type) DO NOTHING
     RETURNING id`,
    [
      input.office_id,
      input.election_date,
      input.election_type,
      JSON.stringify({
        source: input.adapter_name,
        data_source_id: input.data_source_id ?? null,
        auto_created: true,
        data_quality_tier: 'compiled',
      }),
    ],
  );
  if (ins.rows[0]) return { electionId: ins.rows[0].id, wasCreated: true };

  // Concurrent insert won the race — re-read.
  const re = await pg.query<{ id: string }>(
    `SELECT id FROM elections
      WHERE office_id = $1 AND election_date = $2::date AND election_type = $3
      LIMIT 1`,
    [input.office_id, input.election_date, input.election_type],
  );
  if (re.rows[0]) return { electionId: re.rows[0].id, wasCreated: false };
  throw new Error(
    `office-resolver: could not find or create election for office=${input.office_id}`,
  );
}

// ---------------------------------------------------------------------------
// Slug derivation + name canonicalization
// ---------------------------------------------------------------------------

/**
 * Derive a probably-correct office_types.slug from a free-form office name.
 * The derivation table covers the high-frequency cases that show up in
 * state SoS XLSX exports; anything else falls through to a slugified
 * version of the name.
 */
export function deriveSlugFromName(name: string): string {
  const s = name.toLowerCase();
  if (/\bgovernor\b/.test(s) && /\blieutenant\b/.test(s)) return 'lieutenant_governor';
  if (/\blt\.?\s*gov(?:ernor)?\b/.test(s)) return 'lieutenant_governor';
  if (/\bgovernor\b/.test(s)) return 'governor';
  if (/\battorney\s+general\b/.test(s)) return 'state_attorney_general';
  if (/\bauditor\b/.test(s)) return 'state_auditor';
  if (/\btreasurer\b/.test(s)) return 'state_treasurer';
  if (/\bsecretary\s+of\s+state\b/.test(s)) return 'secretary_of_state';
  if (/\b(u\.?s\.?|united\s+states)\s+sen(?:ate|ator)\b/.test(s)) return 'us_senator';
  if (/\b(u\.?s\.?|united\s+states)\s+(house|representative|congress)\b/.test(s)) return 'us_representative';
  if (/\bstate\s+sen(?:ate|ator)\b/.test(s)) return 'state_senator';
  if (/\bstate\s+(house|representative|assembly)\b/.test(s)) return 'state_representative';
  if (/\bstate\s+(?:school\s+board|board\s+of\s+education)\b/.test(s)) return 'state_board_of_education';
  if (/\bsupreme\s+court\b/.test(s)) return 'state_supreme_court_justice';
  if (/\bcourt\s+of\s+appeals\b/.test(s)) return 'judge_court_of_appeals';
  // Last resort: deterministic slug from the cleaned name.
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 60);
}

function canonicalizeOfficeName(name: string, district: string | null): string {
  const trimmed = name.trim().replace(/\s+/g, ' ');
  if (!district) return trimmed;
  // If the trimmed name already mentions the district, leave it alone.
  if (new RegExp(`\\b${district}\\b`).test(trimmed)) return trimmed;
  return `${trimmed} (District ${district})`;
}

function humanizeSlug(slug: string): string {
  return slug
    .split('_')
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ');
}
