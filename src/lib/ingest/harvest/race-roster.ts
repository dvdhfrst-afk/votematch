/**
 * race-roster.ts -- the SAFE in-document candidate resolver for source-centric
 * harvest (Phase 0).
 *
 * THE SAFETY CONSTRAINT (see 12-positioning-engine/13-harvest-buildout-plan.md):
 *   A source-centric document (a forum video, a voter guide, an endorsement page)
 *   names several people. The hard, shared problem is binding each NAME MENTION to
 *   the correct person WITHOUT ever attaching it to a namesake. The thing that
 *   makes this safe is the RACE ROSTER from the office graph: a source has a
 *   jurisdiction + cycle + office scope, so a "Smith" in a Davis County Commission
 *   forum only has to resolve against the 2 to 4 people actually in THAT race, not
 *   all the Smiths nationally. We NEVER match outside the roster.
 *
 * What this module provides:
 *   - loadRosterForSource(client, harvestSource): build the in-scope roster from a
 *     registered harvest_sources row (its jurisdiction_id / FIPS + office_hint +
 *     election_cycle).
 *   - loadRosterForRace(client, scope): build the roster directly from a
 *     {fips_state, fips_county, fips_place, office_hint, cycle} scope.
 *   - resolveMentionInRoster(mentionName, roster): match ONE name string against
 *     the small roster and return exactly one person, or 'ambiguous' / 'none'.
 *     Never a guess; never a match outside the roster.
 *
 * canonicalKey() is REUSED from identity-resolve.ts (do NOT duplicate it). The
 * roster join walks candidacies -> elections -> offices -> jurisdictions and
 * joins people, exactly the verified office-graph schema.
 *
 * The pg (PostgreSQL) client is passed in as a structural QueryClient (the same
 * interface identity-resolve uses), so callers can pass a real pg Client or a
 * stub. No I/O beyond the queries this issues.
 */
import { canonicalKey, type QueryClient } from '../identity-resolve';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The fields of a harvest_sources row this resolver needs to scope the roster.
 * A full row has more columns; we accept just the scope-bearing subset so a
 * caller can pass either the whole row or a trimmed object.
 */
export interface HarvestSourceScope {
  id?: string;
  jurisdiction_id?: string | null;
  fips_state?: string | null;
  fips_county?: string | null;
  fips_place?: string | null;
  office_hint?: string | null;
  election_cycle?: string | null;
}

/** Direct race scope (no harvest_sources row needed). */
export interface RaceScope {
  fips_state?: string | null;
  fips_county?: string | null;
  fips_place?: string | null;
  jurisdiction_id?: string | null;
  office_hint?: string | null;
  /** Election cycle string (matched against elections.election_cycle_id / a year). */
  cycle?: string | null;
}

/** One candidacy in scope, flattened with the person + office it belongs to. */
export interface RosterEntry {
  candidacy_id: string;
  election_id: string;
  office_id: string;
  office_canonical_name: string | null;
  jurisdiction_id: string | null;
  person_id: string;
  canonical_name: string;
  canonical_key: string;
  /** people.name_variants (alternate spellings / nicknames), may be empty. */
  name_variants: string[];
  party: string | null;
  ballot_designation: string | null;
  status: string | null;
}

/** The loaded roster plus the scope it was built from (for provenance / logs). */
export interface Roster {
  entries: RosterEntry[];
  scope: RaceScope;
  /** Human-readable note on how the scope was applied (which filters fired). */
  note: string;
}

/** Outcome of resolving one name mention against a roster. */
export type MentionResolution =
  | {
      status: 'resolved';
      entry: RosterEntry;
      /** How the bind was made (exact key, variant, or safe fuzzy). */
      method: 'canonical_key' | 'name_variant' | 'safe_fuzzy';
      /** Roster-scoped confidence in [0, 1]. */
      confidence: number;
      detail: string;
    }
  | {
      status: 'ambiguous';
      /** The >1 roster entries the mention matched -- a human must decide. */
      candidates: RosterEntry[];
      detail: string;
    }
  | {
      status: 'none';
      detail: string;
    };

// ---------------------------------------------------------------------------
// Roster loading
// ---------------------------------------------------------------------------

/**
 * Normalize a name to comparable tokens (lowercased alphanumeric words) for the
 * SAFE fuzzy tier. Reuses the same diacritic / case folding philosophy as
 * canonicalKey but keeps word boundaries (canonicalKey strips them entirely).
 */
function nameTokens(name: string): string[] {
  return name
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

/**
 * Build the roster SQL + params for a race scope. The join is:
 *   candidacies -> elections -> offices -> jurisdictions, + people.
 * Filters applied (each optional, AND-ed):
 *   - jurisdiction_id: office.jurisdiction_id OR office.district_jurisdiction_id
 *   - fips_state / fips_county / fips_place: matched on the office's jurisdiction
 *   - office_hint: case-insensitive substring on office.canonical_name
 *   - cycle: matched on elections.election_cycle_id::text OR the election year
 * Withdrawn candidacies are EXCLUDED from the roster (a name that has dropped out
 * should not capture a mention). status is still returned for the survivors.
 */
function buildRosterQuery(scope: RaceScope): { sql: string; params: unknown[]; filters: string[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  const filters: string[] = [];
  const p = (v: unknown): string => {
    params.push(v);
    return `$${params.length}`;
  };

  // Exclude withdrawn candidacies from the roster (a dropped-out name must not
  // capture a mention). NULL / other statuses stay in.
  where.push(`(c.status IS NULL OR c.status <> 'withdrawn')`);
  where.push(`c.withdrew_on IS NULL`);

  if (scope.jurisdiction_id) {
    where.push(
      `(o.jurisdiction_id = ${p(scope.jurisdiction_id)} OR o.district_jurisdiction_id = ${p(scope.jurisdiction_id)})`,
    );
    filters.push('jurisdiction_id');
  }
  if (scope.fips_state) {
    where.push(`j.fips_state = ${p(scope.fips_state)}`);
    filters.push('fips_state');
  }
  if (scope.fips_county) {
    where.push(`j.fips_county = ${p(scope.fips_county)}`);
    filters.push('fips_county');
  }
  if (scope.fips_place) {
    where.push(`j.fips_place = ${p(scope.fips_place)}`);
    filters.push('fips_place');
  }
  if (scope.office_hint && scope.office_hint.trim()) {
    where.push(`o.canonical_name ILIKE ${p('%' + scope.office_hint.trim() + '%')}`);
    filters.push('office_hint');
  }
  if (scope.cycle && scope.cycle.trim()) {
    // The cycle may be an election_cycle_id (a uuid / text key) OR a plain year.
    // Match either the cycle id cast to text OR the year of election_date.
    const cy = scope.cycle.trim();
    where.push(
      `(e.election_cycle_id::text = ${p(cy)} OR to_char(e.election_date, 'YYYY') = ${p(cy)})`,
    );
    filters.push('cycle');
  }

  const sql = `
    SELECT
      c.id            AS candidacy_id,
      e.id            AS election_id,
      o.id            AS office_id,
      o.canonical_name AS office_canonical_name,
      o.jurisdiction_id AS jurisdiction_id,
      p.id            AS person_id,
      p.canonical_name AS canonical_name,
      p.canonical_key  AS canonical_key,
      p.name_variants  AS name_variants,
      c.party          AS party,
      c.ballot_designation AS ballot_designation,
      c.status         AS status
    FROM candidacies c
    JOIN elections e ON e.id = c.election_id
    JOIN offices   o ON o.id = e.office_id
    JOIN people    p ON p.id = c.person_id
    LEFT JOIN jurisdictions j ON j.id = o.jurisdiction_id
    WHERE ${where.join('\n      AND ')}
    ORDER BY o.canonical_name, p.canonical_name`;

  return { sql, params, filters };
}

/** Coerce a possibly-null people.name_variants column into a string[]. */
function asVariants(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  return [];
}

/**
 * loadRosterForRace -- build the in-scope roster from a direct race scope.
 *
 * Returns every (non-withdrawn) candidacy that matches the scope, flattened with
 * its person + office. The caller then resolves name mentions against this small
 * set with resolveMentionInRoster. An empty roster is a valid result (the scope
 * matched no live candidacies) and the caller should hold mentions unattributed.
 */
export async function loadRosterForRace(client: QueryClient, scope: RaceScope): Promise<Roster> {
  const { sql, params, filters } = buildRosterQuery(scope);
  const res = await client.query<{
    candidacy_id: string;
    election_id: string;
    office_id: string;
    office_canonical_name: string | null;
    jurisdiction_id: string | null;
    person_id: string;
    canonical_name: string;
    canonical_key: string | null;
    name_variants: unknown;
    party: string | null;
    ballot_designation: string | null;
    status: string | null;
  }>(sql, params);

  const entries: RosterEntry[] = res.rows.map((r) => ({
    candidacy_id: r.candidacy_id,
    election_id: r.election_id,
    office_id: r.office_id,
    office_canonical_name: r.office_canonical_name,
    jurisdiction_id: r.jurisdiction_id,
    person_id: r.person_id,
    canonical_name: r.canonical_name,
    // Fall back to recomputing the key if the column is null (older rows).
    canonical_key: r.canonical_key ?? canonicalKey(r.canonical_name ?? ''),
    name_variants: asVariants(r.name_variants),
    party: r.party,
    ballot_designation: r.ballot_designation,
    status: r.status,
  }));

  return {
    entries,
    scope,
    note: `roster loaded with filters [${filters.join(', ') || 'none'}]: ${entries.length} in-scope candidac${entries.length === 1 ? 'y' : 'ies'}`,
  };
}

/**
 * loadRosterForSource -- build the roster from a registered harvest_sources row.
 * Maps the source's scope columns onto a RaceScope and delegates to
 * loadRosterForRace.
 */
export async function loadRosterForSource(
  client: QueryClient,
  harvestSource: HarvestSourceScope,
): Promise<Roster> {
  const scope: RaceScope = {
    fips_state: harvestSource.fips_state ?? null,
    fips_county: harvestSource.fips_county ?? null,
    fips_place: harvestSource.fips_place ?? null,
    jurisdiction_id: harvestSource.jurisdiction_id ?? null,
    office_hint: harvestSource.office_hint ?? null,
    cycle: harvestSource.election_cycle ?? null,
  };
  return loadRosterForRace(client, scope);
}

// ---------------------------------------------------------------------------
// Mention resolution -- the SAFE bind. NEVER matches outside the roster.
// ---------------------------------------------------------------------------

/**
 * The minimum SAFE-fuzzy strength required to bind a mention. Inside the tiny
 * roster (2 to 4 people) this is forgiving enough to catch "Bob" for "Robert
 * Smith" via the surname while still refusing a generic partial that matches two
 * roster members.
 */
const SAFE_FUZZY_MIN = 0.5;

/**
 * Token-overlap similarity between a mention and a roster name, in [0, 1]. This
 * is a deliberately small, deterministic heuristic (NO database fuzzy functions
 * here -- the roster is tiny and in-memory): the fraction of the mention's tokens
 * that appear in the candidate's name tokens. A surname-only mention ("Smith")
 * scores 1.0 against any roster name containing "smith"; a full match scores 1.0;
 * a mismatch scores 0. Because we then require a UNIQUE roster hit, a surname
 * shared by two roster members yields 'ambiguous', never a guess.
 */
function tokenOverlap(mentionTokens: string[], nameTokens_: string[]): number {
  if (mentionTokens.length === 0 || nameTokens_.length === 0) return 0;
  const nameSet = new Set(nameTokens_);
  let hit = 0;
  for (const t of mentionTokens) if (nameSet.has(t)) hit++;
  return hit / mentionTokens.length;
}

/**
 * resolveMentionInRoster -- bind ONE name string to exactly one roster person,
 * or return 'ambiguous' / 'none'. The resolution is roster-CONSTRAINED: a name
 * can ONLY ever bind to someone already in the roster, so a namesake outside the
 * race is structurally impossible to hit.
 *
 * Tiers (each requires a UNIQUE roster hit to bind; >1 hit at any tier is
 * 'ambiguous' and the caller must hold the mention unattributed):
 *   1. EXACT canonical_key. canonicalKey(mention) === entry.canonical_key.
 *   2. NAME VARIANT. canonicalKey(mention) matches canonicalKey of any of the
 *      entry's people.name_variants (nicknames / alternate spellings).
 *   3. SAFE FUZZY (token overlap >= SAFE_FUZZY_MIN within the small roster). This
 *      is the surname-match tier; it is safe ONLY because it is confined to the
 *      roster and still demands uniqueness.
 *
 * A blank / empty-key mention resolves to 'none'. An empty roster resolves to
 * 'none'. Ambiguity at the FIRST tier that produces any hit wins (we do not fall
 * through to a looser tier after an exact-key collision).
 */
export function resolveMentionInRoster(mentionName: string, roster: Roster | RosterEntry[]): MentionResolution {
  const entries = Array.isArray(roster) ? roster : roster.entries;
  const mention = (mentionName ?? '').trim();
  if (!mention) {
    return { status: 'none', detail: 'empty mention' };
  }
  if (entries.length === 0) {
    return { status: 'none', detail: 'empty roster (scope matched no in-scope candidacies)' };
  }

  const mKey = canonicalKey(mention);
  if (!mKey) {
    return { status: 'none', detail: `mention "${mention}" normalized to an empty canonical_key` };
  }

  // ---- Tier 1: exact canonical_key ----
  const exact = entries.filter((e) => e.canonical_key === mKey);
  if (exact.length === 1) {
    return {
      status: 'resolved',
      entry: exact[0],
      method: 'canonical_key',
      confidence: 1.0,
      detail: `exact canonical_key match within roster (${entries.length} in scope)`,
    };
  }
  if (exact.length > 1) {
    return {
      status: 'ambiguous',
      candidates: exact,
      detail: `${exact.length} roster members share canonical_key "${mKey}"; cannot disambiguate -- held unattributed`,
    };
  }

  // ---- Tier 2: name variant ----
  const variantHits = entries.filter((e) => e.name_variants.some((v) => canonicalKey(v) === mKey));
  if (variantHits.length === 1) {
    return {
      status: 'resolved',
      entry: variantHits[0],
      method: 'name_variant',
      confidence: 0.95,
      detail: `matched a registered name_variant of "${variantHits[0].canonical_name}" within roster`,
    };
  }
  if (variantHits.length > 1) {
    return {
      status: 'ambiguous',
      candidates: variantHits,
      detail: `${variantHits.length} roster members carry a name_variant matching "${mention}"; held unattributed`,
    };
  }

  // ---- Tier 3: SAFE fuzzy (token overlap), roster-confined, unique-only ----
  const mTokens = nameTokens(mention);
  const scored = entries
    .map((e) => ({
      entry: e,
      score: Math.max(
        tokenOverlap(mTokens, nameTokens(e.canonical_name)),
        // Also consider variants so "Liz" -> a "Liz" variant of "Elizabeth" wins.
        ...e.name_variants.map((v) => tokenOverlap(mTokens, nameTokens(v))),
        0,
      ),
    }))
    .filter((s) => s.score >= SAFE_FUZZY_MIN)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    return {
      status: 'none',
      detail: `no roster member matched "${mention}" at any tier (roster of ${entries.length}); held unattributed`,
    };
  }

  // Unique strongest hit? Bind. A tie at the top (two roster members equally
  // matched by, e.g., a shared surname) is AMBIGUOUS -- never guess a namesake.
  const top = scored[0];
  const tiedAtTop = scored.filter((s) => s.score === top.score);
  if (tiedAtTop.length === 1) {
    return {
      status: 'resolved',
      entry: top.entry,
      method: 'safe_fuzzy',
      confidence: Math.min(0.9, 0.6 + top.score * 0.3),
      detail: `safe roster-confined fuzzy match (overlap ${top.score.toFixed(2)}) to "${top.entry.canonical_name}"; unique within roster`,
    };
  }
  return {
    status: 'ambiguous',
    candidates: tiedAtTop.map((s) => s.entry),
    detail: `${tiedAtTop.length} roster members tie at fuzzy overlap ${top.score.toFixed(2)} for "${mention}"; held unattributed (never a namesake guess)`,
  };
}
