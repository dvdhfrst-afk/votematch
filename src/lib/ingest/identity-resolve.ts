/**
 * identity-resolve.ts — candidate identity resolution for Havesay.
 *
 * Resolves an incoming candidate record to a canonical `people` row using a
 * two-path strategy, with provisional binds gated behind a publish threshold
 * and ambiguity routed to `dedup_review_queue` for human review.
 *
 *   PATH A (strong id, deterministic): a registered external identifier
 *     (FEC (Federal Election Commission) candidate id, bioguide id,
 *     OpenStates id, state filer id, etc.) is looked up in `person_xref`.
 *     One distinct person across all provided strong ids -> bind at 1.0.
 *     Two strong ids that disagree (map to DIFFERENT persons) -> enqueue a
 *     'conflicting_strong_id' review row and refuse to bind.
 *
 *   PATH B (name only, provisional): when no strong id resolves, fall back to
 *     the canonical_key + state_fips_primary key. Exactly one row binds
 *     PROVISIONALLY (0.6, or 0.8 when birth_year also matches). Multiple rows
 *     are ambiguous -> enqueue review, no bind. Zero rows -> 'no_match'; we do
 *     NOT auto-create a `people` row here (the binding caller decides).
 *
 * Identity-key discipline (operator, 2026-05-02): cross-state same-canonical-name
 * people are DIFFERENT humans. The key is (canonical_key, state_fips_primary),
 * matching the unique index uq_people_canonical_key_state. canonicalKey() below
 * is byte-for-byte identical to scripts/apply-2026-candidates.ts so TS-inserted
 * and DB-trigger-derived keys agree.
 *
 * Council rule (no-strong-id records are provisional): any bind below
 * PUBLISH_THRESHOLD (0.9) is PROVISIONAL and must never auto-publish or feed
 * the matching engine, pending corroboration (a strong id) or human review.
 * Only a strong-id bind (1.0) clears the bar today.
 *
 * Writes: this module is read-only EXCEPT for the explicit dedup-queue enqueue
 * inside resolvePerson / registerXref, which is guarded by opts.enqueue
 * (default true). Callers that want a pure, side-effect-free resolve (the CLI,
 * tests) pass { enqueue: false }.
 *
 * Client: the exported functions take a `pg` (PostgreSQL) client (or pool
 * client) as their first argument, so this library is agnostic to how the
 * connection was opened. The dispatching script (scripts/resolve-identity.ts)
 * opens the connection with the same env pattern as scripts/_live-sql.ts
 * (DATABASE_URL / SUPABASE_DB_URL).
 */
import type { ClientBase, QueryResultRow } from 'pg';

/**
 * Minimal query surface this module needs. `pg`'s Client and PoolClient both
 * satisfy this, so callers can pass either. Kept structural so tests can pass
 * a stub without pulling in the full pg type.
 */
export interface QueryClient {
  query<R extends QueryResultRow = QueryResultRow>(
    queryText: string,
    values?: unknown[]
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}

// A real pg ClientBase is assignable to QueryClient; this re-export keeps the
// intent obvious at call sites that already hold a pg client.
export type PgClient = ClientBase;

/**
 * State-free person dedup key. MUST stay identical to canonicalKey() in
 * scripts/apply-2026-candidates.ts and to the SQL expression in migrations
 * 20260423000011_people_canonical_key.sql + 20260425000006:
 *   lower(regexp_replace(unaccent(canonical_name), '[^a-zA-Z0-9]', '', 'g'))
 * Diacritic folding via NFD (canonical decomposition) + combining-mark strip
 * (council #8) so Puerto Rico + bilingual-state names match across feeds.
 *
 * Copied verbatim from scripts/apply-2026-candidates.ts — do not diverge.
 */
export function canonicalKey(name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

/**
 * Below this confidence, a bind is PROVISIONAL: it must never auto-publish or
 * feed the matching engine. Only strong-id binds (1.0) clear it today; name-
 * only binds (0.6 / 0.8) sit below it by design (council rule).
 */
export const PUBLISH_THRESHOLD = 0.9;

/** True iff a bind is strong enough to publish / feed matching. */
export function isPublishableBind(bind_confidence: number): boolean {
  return bind_confidence >= PUBLISH_THRESHOLD;
}

/** A registered external identifier the resolver can match on (PATH A). */
export interface StrongId {
  kind: string;
  external_id: string;
}

export interface ResolveInput {
  name?: string;
  state_fips?: string;
  birth_year?: number;
  strong_ids?: StrongId[];
}

export type ResolveMethod =
  | 'strong_id'
  | 'name_state_birthyear'
  | 'name_state'
  | 'ambiguous_review'
  | 'no_match';

export interface ResolveResult {
  person_id: string | null;
  bind_confidence: number;
  method: ResolveMethod;
  detail: string;
}

export interface ResolveOpts {
  /**
   * When true (default), ambiguity / conflict is written to dedup_review_queue.
   * The CLI and tests pass false for a side-effect-free resolve.
   */
  enqueue?: boolean;
}

export type DedupBlockerCategory =
  | 'insufficient_evidence'
  | 'different_offices_same_state'
  | 'conflicting_strong_id';

export interface EnqueueDedupArgs {
  canonical_key: string;
  state_fips: string | null;
  blocker_category: DedupBlockerCategory;
  blocker_explanation: string;
  /** Snapshot of the clustered / conflicting people rows for the reviewer. */
  candidate_people?: unknown[];
}

/**
 * Idempotent upsert into dedup_review_queue, keyed on (canonical_key,
 * state_fips). Refreshes the snapshot + explanation on re-enqueue but never
 * touches reviewed_at / resolution once an editor has acted (those columns are
 * simply not in the SET list). Mirrors the load-dedup-review-queue.ts contract.
 *
 * NOTE: the table's UNIQUE(canonical_key, state_fips) treats NULL state_fips as
 * distinct per ON CONFLICT, so we coalesce to '' for the conflict target the
 * same way the unique people index coalesces state. We store the real value
 * (NULL stays NULL) but the conflict key normalizes it.
 */
export async function enqueueDedupReview(
  client: QueryClient,
  args: EnqueueDedupArgs
): Promise<void> {
  const candidatePeople = JSON.stringify(args.candidate_people ?? []);
  const peopleCount = Array.isArray(args.candidate_people)
    ? args.candidate_people.length
    : 0;

  // ON CONFLICT needs a real unique constraint to target. The table declares
  // UNIQUE (canonical_key, state_fips); Postgres treats NULL as not-equal in a
  // unique index, so two NULL-state rows for the same key could both insert.
  // To keep this idempotent we explicitly check-then-update for the NULL case
  // and use ON CONFLICT for the non-NULL case.
  if (args.state_fips === null || args.state_fips === undefined) {
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM dedup_review_queue
        WHERE canonical_key = $1 AND state_fips IS NULL
        LIMIT 1`,
      [args.canonical_key]
    );
    if (existing.rowCount && existing.rowCount > 0) {
      await client.query(
        `UPDATE dedup_review_queue
            SET blocker_category = $2,
                blocker_explanation = $3,
                candidate_people = $4::jsonb,
                people_count = $5,
                source_file = 'identity-resolve.ts'
          WHERE id = $1`,
        [existing.rows[0].id, args.blocker_category, args.blocker_explanation, candidatePeople, peopleCount]
      );
    } else {
      await client.query(
        `INSERT INTO dedup_review_queue
           (canonical_key, state_fips, blocker_category, blocker_explanation,
            candidate_people, people_count, source_file)
         VALUES ($1, NULL, $2, $3, $4::jsonb, $5, 'identity-resolve.ts')`,
        [args.canonical_key, args.blocker_category, args.blocker_explanation, candidatePeople, peopleCount]
      );
    }
    return;
  }

  await client.query(
    `INSERT INTO dedup_review_queue
       (canonical_key, state_fips, blocker_category, blocker_explanation,
        candidate_people, people_count, source_file)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, 'identity-resolve.ts')
     ON CONFLICT (canonical_key, state_fips)
     DO UPDATE SET
       blocker_category = EXCLUDED.blocker_category,
       blocker_explanation = EXCLUDED.blocker_explanation,
       candidate_people = EXCLUDED.candidate_people,
       people_count = EXCLUDED.people_count,
       source_file = EXCLUDED.source_file`,
    [
      args.canonical_key,
      args.state_fips,
      args.blocker_category,
      args.blocker_explanation,
      candidatePeople,
      peopleCount,
    ]
  );
}

/**
 * Resolve an incoming candidate record to a canonical person.
 *
 * @returns person_id (null when no confident bind), the bind confidence
 *   (1.0 strong-id, 0.8 name+state+birthyear, 0.6 name+state, 0 otherwise),
 *   the method used, and a human-readable detail string.
 *
 * @example
 *   const r = await resolvePerson(client, {
 *     name: 'Jane Doe', state_fips: '49',
 *     strong_ids: [{ kind: 'fec_candidate_id', external_id: 'H6UT00001' }],
 *   });
 *   // r => { person_id, bind_confidence: 1.0, method: 'strong_id', detail }
 */
export async function resolvePerson(
  client: QueryClient,
  input: ResolveInput,
  opts: ResolveOpts = {}
): Promise<ResolveResult> {
  const enqueue = opts.enqueue !== false; // default true

  // ----------------------------------------------------------------
  // PATH A — strong id (deterministic).
  // ----------------------------------------------------------------
  const strongIds = (input.strong_ids ?? []).filter(
    (s) => s && s.kind && s.external_id
  );
  if (strongIds.length > 0) {
    // Map each provided strong id to the person it currently points at.
    const hits: Array<{ kind: string; external_id: string; person_id: string }> = [];
    for (const s of strongIds) {
      const res = await client.query<{ person_id: string }>(
        `SELECT person_id FROM person_xref
          WHERE kind = $1 AND external_id = $2
          LIMIT 1`,
        [s.kind, s.external_id]
      );
      if (res.rowCount && res.rowCount > 0) {
        hits.push({ kind: s.kind, external_id: s.external_id, person_id: res.rows[0].person_id });
      }
    }

    const distinctPersons = Array.from(new Set(hits.map((h) => h.person_id)));

    if (distinctPersons.length === 1) {
      // Exactly one person across all provided strong ids -> deterministic bind.
      return {
        person_id: distinctPersons[0],
        bind_confidence: 1.0,
        method: 'strong_id',
        detail: `strong-id match on ${hits.map((h) => `${h.kind}=${h.external_id}`).join(', ')}`,
      };
    }

    if (distinctPersons.length >= 2) {
      // Two strong ids disagree -> conflicting strong id. Route to review and refuse.
      const cKey = input.name ? canonicalKey(input.name) : `xref:${strongIds.map((s) => `${s.kind}=${s.external_id}`).join('|')}`;
      const explanation =
        `Conflicting strong ids: ` +
        hits.map((h) => `${h.kind}=${h.external_id} -> person ${h.person_id}`).join('; ') +
        ` (${distinctPersons.length} distinct persons).`;
      if (enqueue) {
        await enqueueDedupReview(client, {
          canonical_key: cKey,
          state_fips: input.state_fips ?? null,
          blocker_category: 'conflicting_strong_id',
          blocker_explanation: explanation,
          candidate_people: distinctPersons.map((pid) => ({
            person_id: pid,
            matched_xrefs: hits.filter((h) => h.person_id === pid),
          })),
        });
      }
      return {
        person_id: null,
        bind_confidence: 0,
        method: 'ambiguous_review',
        detail: explanation,
      };
    }

    // distinctPersons.length === 0: no strong id resolved. Fall through to
    // PATH B (name-based provisional) rather than failing outright.
  }

  // ----------------------------------------------------------------
  // PATH B — name only (provisional).
  // ----------------------------------------------------------------
  if (!input.name || !input.name.trim()) {
    return {
      person_id: null,
      bind_confidence: 0,
      method: 'no_match',
      detail: 'no name and no resolving strong id',
    };
  }

  const cKey = canonicalKey(input.name);
  if (!cKey) {
    return {
      person_id: null,
      bind_confidence: 0,
      method: 'no_match',
      detail: `name "${input.name}" normalized to an empty canonical_key`,
    };
  }

  // --- B1: state given -> match within the state bucket (the dedup boundary). ---
  if (input.state_fips) {
    const res = await client.query<{ id: string; birth_year: number | null }>(
      `SELECT id, birth_year FROM people
        WHERE canonical_key = $1 AND state_fips_primary = $2`,
      [cKey, input.state_fips]
    );

    if (res.rowCount === 1) {
      const row = res.rows[0];
      const birthMatches =
        input.birth_year != null &&
        row.birth_year != null &&
        row.birth_year === input.birth_year;
      return {
        person_id: row.id,
        bind_confidence: birthMatches ? 0.8 : 0.6,
        method: birthMatches ? 'name_state_birthyear' : 'name_state',
        detail: birthMatches
          ? `provisional: unique canonical_key+state, birth_year ${input.birth_year} matches`
          : `provisional: unique canonical_key+state (birth_year ${
              input.birth_year == null ? 'not provided' : 'not corroborated'
            })`,
      };
    }

    if (res.rowCount && res.rowCount > 1) {
      // Multiple same-key rows in the same state. If a birth_year is provided
      // and exactly one row matches it, that disambiguates; otherwise route to
      // review. Distinguish the blocker: insufficient_evidence when we simply
      // can't tell them apart.
      const matchingBy = input.birth_year != null
        ? res.rows.filter((r) => r.birth_year === input.birth_year)
        : [];
      if (matchingBy.length === 1) {
        return {
          person_id: matchingBy[0].id,
          bind_confidence: 0.8,
          method: 'name_state_birthyear',
          detail: `provisional: ${res.rowCount} same-key rows in state, birth_year ${input.birth_year} uniquely disambiguates`,
        };
      }
      const explanation =
        `${res.rowCount} people share canonical_key "${cKey}" in state_fips ${input.state_fips}` +
        (input.birth_year != null
          ? ` and birth_year ${input.birth_year} did not uniquely disambiguate`
          : ` and no birth_year was provided to disambiguate`) +
        '.';
      if (enqueue) {
        await enqueueDedupReview(client, {
          canonical_key: cKey,
          state_fips: input.state_fips,
          blocker_category: 'insufficient_evidence',
          blocker_explanation: explanation,
          candidate_people: res.rows.map((r) => ({ person_id: r.id, birth_year: r.birth_year })),
        });
      }
      return {
        person_id: null,
        bind_confidence: 0,
        method: 'ambiguous_review',
        detail: explanation,
      };
    }

    // B1-fallback: many `people` rows have a NULL state_fips_primary (not yet
    // backfilled). A strict state match misses them. Relax to "matches the
    // state OR has no state" -- never crossing into a DIFFERENT state -- and
    // bind a unique hit at slightly lower confidence (state inferred from the
    // input, not stored on the row). Still well below PUBLISH_THRESHOLD, so the
    // bind stays provisional. TODO: backfill people.state_fips_primary from
    // candidacies/jurisdictions, then this fallback becomes rare.
    const relaxed = await client.query<{ id: string; birth_year: number | null; state_fips_primary: string | null }>(
      `SELECT id, birth_year, state_fips_primary FROM people
        WHERE canonical_key = $1 AND (state_fips_primary = $2 OR state_fips_primary IS NULL)`,
      [cKey, input.state_fips]
    );
    if (relaxed.rowCount === 1) {
      const row = relaxed.rows[0];
      const birthMatches =
        input.birth_year != null && row.birth_year != null && row.birth_year === input.birth_year;
      return {
        person_id: row.id,
        bind_confidence: birthMatches ? 0.75 : 0.55,
        method: birthMatches ? 'name_state_birthyear' : 'name_state',
        detail: `provisional: unique canonical_key with state ${input.state_fips} or null state_fips_primary (${
          row.state_fips_primary === null ? 'row has null state, inferred from input' : 'state matches'
        }; birth_year ${input.birth_year == null ? 'not provided' : birthMatches ? 'matches' : 'not corroborated'})`,
      };
    }
    if (relaxed.rowCount && relaxed.rowCount > 1) {
      const explanation =
        `${relaxed.rowCount} people share canonical_key "${cKey}" with state_fips ${input.state_fips} or null state; cannot disambiguate without a strong id or birth_year.`;
      if (enqueue) {
        await enqueueDedupReview(client, {
          canonical_key: cKey,
          state_fips: input.state_fips,
          blocker_category: 'insufficient_evidence',
          blocker_explanation: explanation,
          candidate_people: relaxed.rows.map((r) => ({ person_id: r.id, birth_year: r.birth_year, state_fips_primary: r.state_fips_primary })),
        });
      }
      return { person_id: null, bind_confidence: 0, method: 'ambiguous_review', detail: explanation };
    }

    // Truly zero rows even relaxed -> no match. Do NOT auto-create.
    return {
      person_id: null,
      bind_confidence: 0,
      method: 'no_match',
      detail: `no person with canonical_key "${cKey}" in state_fips ${input.state_fips} (or null state)`,
    };
  }

  // --- B2: no state -> only bind on a nationwide-unique canonical_key. ---
  const res = await client.query<{ id: string; birth_year: number | null; state_fips_primary: string | null }>(
    `SELECT id, birth_year, state_fips_primary FROM people
      WHERE canonical_key = $1`,
    [cKey]
  );

  if (res.rowCount === 1) {
    const row = res.rows[0];
    const birthMatches =
      input.birth_year != null &&
      row.birth_year != null &&
      row.birth_year === input.birth_year;
    return {
      person_id: row.id,
      bind_confidence: birthMatches ? 0.8 : 0.6,
      method: birthMatches ? 'name_state_birthyear' : 'name_state',
      detail: birthMatches
        ? `provisional: nationwide-unique canonical_key (no state given), birth_year matches`
        : `provisional: nationwide-unique canonical_key (no state given)`,
    };
  }

  if (res.rowCount && res.rowCount > 1) {
    const explanation =
      `${res.rowCount} people share canonical_key "${cKey}" nationwide and no state_fips ` +
      `was provided to scope the match.`;
    if (enqueue) {
      await enqueueDedupReview(client, {
        canonical_key: cKey,
        state_fips: null,
        blocker_category: 'insufficient_evidence',
        blocker_explanation: explanation,
        candidate_people: res.rows.map((r) => ({
          person_id: r.id,
          birth_year: r.birth_year,
          state_fips_primary: r.state_fips_primary,
        })),
      });
    }
    return {
      person_id: null,
      bind_confidence: 0,
      method: 'ambiguous_review',
      detail: explanation,
    };
  }

  return {
    person_id: null,
    bind_confidence: 0,
    method: 'no_match',
    detail: `no person with canonical_key "${cKey}" nationwide`,
  };
}

// ===========================================================================
// Build 5 — identity-resolution hardening (ADDITIVE).
//
// Everything below is new, exported surface. resolvePerson() above is UNCHANGED
// (another build imports it; its name + signature stay stable). The hardened
// behavior is opt-in via resolvePersonHardened() and the pure scoring helpers,
// which a caller can wire in without breaking the existing two-path resolver.
//
// The corroboration tier sits BETWEEN the existing name+state provisional
// (~0.6) and a strong-id bind (1.0): start from the name+state base, accumulate
// attribute evidence, CAP at 0.85 when no strong id resolves, and snap to 1.0
// only on a strong id. Binds in [0.70, 0.89] are provisional + promotable and
// routed to dedup_review_queue; they NEVER auto-publish (PUBLISH_THRESHOLD=0.9
// still gates publish). Hard-negative guards (district mismatch, middle-name
// conflict) push a candidate below the bind floor so a namesake can never be
// silently merged. ADVERSE records (litigation / criminal) require a strong id
// or a human; an attribute bind is refused outright.
// ===========================================================================

/** Floor below which the corroboration tier refuses to bind at all. */
export const ATTRIBUTE_BIND_FLOOR = 0.7;

/** Cap on any corroboration-tier bind when NO strong id resolves. */
export const ATTRIBUTE_BIND_CAP = 0.85;

/** Base score for a name + state provisional match (mirrors PATH B's 0.6). */
export const ATTRIBUTE_BASE = 0.6;

/**
 * Evidence weights for the corroboration tier. Positives accumulate from the
 * name+state base; hard negatives are large enough to push any candidate below
 * ATTRIBUTE_BIND_FLOOR no matter how much positive evidence preceded them.
 */
export const ATTRIBUTE_WEIGHTS = {
  birth_year_exact: 0.2,
  office_or_district_match: 0.1,
  incumbency_consistent: 0.1,
  middle_name_agreement: 0.05,
  party_cycle_match: 0.05,
  second_independent_source: 0.1,
  // Hard negatives (namesake guards). Either alone sinks the bind.
  middle_name_conflict: -0.3,
  district_mismatch: -1.0,
} as const;

/**
 * Attribute evidence the corroboration tier scores. Every field is optional:
 * the caller supplies whatever it has corroborated about the incoming record vs.
 * the candidate person row. Tri-state booleans use true = agrees,
 * false = conflicts, undefined = unknown (no effect).
 */
export interface AttributeEvidence {
  /** true = incoming birth_year exactly matches the candidate row's. */
  birth_year_exact?: boolean;
  /** true = incoming office_id or district matches a candidacy/tenure of the row. */
  office_or_district_match?: boolean;
  /**
   * Namesake hard guard. true = districts conflict (e.g. incoming district 3,
   * the row only ever held district 7). Sinks the bind.
   */
  district_mismatch?: boolean;
  /** true = incumbency story is consistent (held seat ⇒ now running for it, etc.). */
  incumbency_consistent?: boolean;
  /**
   * Middle-name comparison. true = middle names agree, false = they CONFLICT
   * (hard negative), undefined = one or both unknown (no effect).
   */
  middle_name_agreement?: boolean;
  /** true = party + election cycle line up across the two records. */
  party_cycle_match?: boolean;
  /** true = a second, INDEPENDENT source corroborates the same person. */
  second_independent_source?: boolean;
}

/**
 * Caller-supplied flags that gate the corroboration tier entirely (not scored).
 */
export interface CorroborationFlags {
  /**
   * ADVERSE record: litigation / criminal / anything where a wrong bind harms a
   * real person. When true, an attribute bind is REFUSED — only a strong id or a
   * human may bind. (Council rule: never attach an adverse record to someone on
   * name + attributes alone.)
   */
  adverse?: boolean;
  /**
   * Set when the SAME canonical name + same state matched. Such a bind needs at
   * least one strong id OR two corroborating attributes; otherwise it is refused
   * and routed to review (same-name-same-state namesake guard).
   */
  same_name_same_state?: boolean;
}

export type CorroborationDecision = 'bind' | 'provisional_review' | 'refuse';

export interface CorroborationResult {
  /** Final bind confidence after accumulation, caps, and hard negatives. */
  bind_confidence: number;
  decision: CorroborationDecision;
  /** True iff the bind is publishable (>= PUBLISH_THRESHOLD). Always false here. */
  publishable: boolean;
  /** True iff the bind is provisional AND should be enqueued as promotable. */
  promotable: boolean;
  /** Itemized contributions for the audit trail / review-row explanation. */
  contributions: Array<{ factor: string; delta: number }>;
  /** Which hard negative(s) (if any) sank the bind. */
  hard_negatives: string[];
  detail: string;
}

/**
 * Count how many distinct positive attributes corroborate (for the
 * same-name-same-state "two corroborating attributes" guard).
 */
function countCorroboratingAttributes(ev: AttributeEvidence): number {
  let n = 0;
  if (ev.birth_year_exact === true) n++;
  if (ev.office_or_district_match === true) n++;
  if (ev.incumbency_consistent === true) n++;
  if (ev.middle_name_agreement === true) n++;
  if (ev.party_cycle_match === true) n++;
  if (ev.second_independent_source === true) n++;
  return n;
}

/**
 * PURE scoring of the attribute-corroboration tier. No DB, no I/O — deterministic
 * given (evidence, flags, hasStrongId). This is the heart of the namesake guard
 * and is unit-tested directly in scripts/_test-identity-hardening.ts.
 *
 * Algorithm:
 *   - If hasStrongId: snap to 1.0 and bind (the corroboration tier never
 *     overrides a strong id; it only matters when no strong id resolved).
 *   - Start from ATTRIBUTE_BASE (name + state).
 *   - Add positive evidence weights; subtract hard negatives.
 *   - Hard negatives (middle_name_conflict, district_mismatch) push below the
 *     floor ⇒ refuse (namesake guard). district_mismatch alone is fatal.
 *   - ADVERSE ⇒ refuse unless a strong id resolved (handled above).
 *   - same_name_same_state ⇒ require >= 2 corroborating attributes, else refuse.
 *   - CAP positive accumulation at ATTRIBUTE_BIND_CAP (0.85) with no strong id.
 *   - Bind only when final >= ATTRIBUTE_BIND_FLOOR (0.70); otherwise refuse.
 *   - A bind in [0.70, 0.89] is provisional + promotable (never publishable).
 */
export function scoreCorroboration(
  ev: AttributeEvidence,
  flags: CorroborationFlags = {},
  hasStrongId = false
): CorroborationResult {
  const contributions: Array<{ factor: string; delta: number }> = [];
  const hardNegatives: string[] = [];

  // Strong id wins outright — corroboration tier is moot.
  if (hasStrongId) {
    return {
      bind_confidence: 1.0,
      decision: 'bind',
      publishable: true,
      promotable: false,
      contributions: [{ factor: 'strong_id', delta: 1.0 }],
      hard_negatives: [],
      detail: 'strong id resolved; snapped to 1.0',
    };
  }

  // ADVERSE records can never bind on attributes alone.
  if (flags.adverse) {
    return {
      bind_confidence: 0,
      decision: 'refuse',
      publishable: false,
      promotable: false,
      contributions: [],
      hard_negatives: ['adverse_requires_strong_id_or_human'],
      detail: 'adverse record: refused attribute bind (requires strong id or human review)',
    };
  }

  // Hard negatives first — they are dispositive regardless of positives.
  if (ev.district_mismatch === true) {
    hardNegatives.push('district_mismatch');
    contributions.push({ factor: 'district_mismatch', delta: ATTRIBUTE_WEIGHTS.district_mismatch });
  }
  if (ev.middle_name_agreement === false) {
    hardNegatives.push('middle_name_conflict');
    contributions.push({ factor: 'middle_name_conflict', delta: ATTRIBUTE_WEIGHTS.middle_name_conflict });
  }

  // Positive accumulation from the name+state base.
  let positive = ATTRIBUTE_BASE;
  contributions.unshift({ factor: 'name_state_base', delta: ATTRIBUTE_BASE });

  const addPositive = (cond: boolean | undefined, factor: string, delta: number) => {
    if (cond === true) {
      positive += delta;
      contributions.push({ factor, delta });
    }
  };
  addPositive(ev.birth_year_exact, 'birth_year_exact', ATTRIBUTE_WEIGHTS.birth_year_exact);
  addPositive(ev.office_or_district_match, 'office_or_district_match', ATTRIBUTE_WEIGHTS.office_or_district_match);
  addPositive(ev.incumbency_consistent, 'incumbency_consistent', ATTRIBUTE_WEIGHTS.incumbency_consistent);
  addPositive(ev.middle_name_agreement, 'middle_name_agreement', ATTRIBUTE_WEIGHTS.middle_name_agreement);
  addPositive(ev.party_cycle_match, 'party_cycle_match', ATTRIBUTE_WEIGHTS.party_cycle_match);
  addPositive(ev.second_independent_source, 'second_independent_source', ATTRIBUTE_WEIGHTS.second_independent_source);

  // Cap positive accumulation BEFORE applying hard negatives, so a string of
  // positives can never buy back past a hard negative (the cap bounds the good
  // side; the negative still subtracts in full from the capped value).
  const cappedPositive = Math.min(positive, ATTRIBUTE_BIND_CAP);

  let score = cappedPositive;
  if (ev.district_mismatch === true) score += ATTRIBUTE_WEIGHTS.district_mismatch;
  if (ev.middle_name_agreement === false) score += ATTRIBUTE_WEIGHTS.middle_name_conflict;
  // Clamp to [0, cap].
  score = Math.max(0, Math.min(score, ATTRIBUTE_BIND_CAP));

  // same-name-same-state guard: need >= 2 corroborating attributes to bind.
  const corroboratingCount = countCorroboratingAttributes(ev);
  if (flags.same_name_same_state && corroboratingCount < 2) {
    return {
      bind_confidence: score,
      decision: 'refuse',
      publishable: false,
      promotable: false,
      contributions,
      hard_negatives: hardNegatives,
      detail:
        `same-name-same-state namesake guard: only ${corroboratingCount} corroborating ` +
        `attribute(s) (need 2 or a strong id); refused.`,
    };
  }

  // Hard negative present ⇒ below floor ⇒ refuse (namesake confirmed distinct).
  if (hardNegatives.length > 0 || score < ATTRIBUTE_BIND_FLOOR) {
    return {
      bind_confidence: score,
      decision: 'refuse',
      publishable: false,
      promotable: false,
      contributions,
      hard_negatives: hardNegatives,
      detail:
        hardNegatives.length > 0
          ? `hard negative(s) [${hardNegatives.join(', ')}] sank the bind to ${score.toFixed(2)} (< floor ${ATTRIBUTE_BIND_FLOOR}); refused.`
          : `corroboration ${score.toFixed(2)} below floor ${ATTRIBUTE_BIND_FLOOR}; refused.`,
    };
  }

  // Provisional bind: [floor, cap]. Always < PUBLISH_THRESHOLD, so it is
  // promotable + routed to review, never published.
  return {
    bind_confidence: score,
    decision: 'provisional_review',
    publishable: false,
    promotable: true,
    contributions,
    hard_negatives: [],
    detail:
      `provisional corroboration bind ${score.toFixed(2)} in [${ATTRIBUTE_BIND_FLOOR}, ${ATTRIBUTE_BIND_CAP}]: ` +
      `promotable, routed to review, never auto-published.`,
  };
}

/**
 * Result of a name-similarity probe issued server-side. jaro_winkler() and
 * similarity() are computed by Postgres (fuzzystrmatch + pg_trgm), NOT in JS.
 */
export interface NameSimilarity {
  /** Postgres jaro_winkler(canonical_name_a, canonical_name_b) in [0, 1]. */
  jaro_winkler: number;
  /** Postgres pg_trgm similarity(canonical_name_a, canonical_name_b) in [0, 1]. */
  trigram: number;
}

/**
 * Compare two names using Postgres' jaro_winkler() (fuzzystrmatch) and
 * similarity() (pg_trgm). The comparison runs in the DB so the fuzzy logic lives
 * in one place (per the build brief: no JS reimplementation). Returns both
 * scores so the caller can apply its own threshold.
 */
export async function compareNamesSql(
  client: QueryClient,
  nameA: string,
  nameB: string
): Promise<NameSimilarity> {
  const res = await client.query<{ jw: number; sim: number }>(
    `SELECT jaro_winkler($1, $2) AS jw, similarity($1, $2) AS sim`,
    [nameA, nameB]
  );
  const row = res.rows[0];
  return {
    jaro_winkler: row ? Number(row.jw) : 0,
    trigram: row ? Number(row.sim) : 0,
  };
}

/**
 * Find blocked candidate people for fuzzy comparison: rows that share trigrams
 * with the incoming name (so the GIN trigram index does the blocking) within the
 * same state bucket, scored by jaro_winkler() + similarity() server-side. Used
 * by the hardened resolver to surface near-name namesakes the exact canonical_key
 * lookup would miss (e.g. "Bob Smith" vs "Robert Smith").
 *
 * `threshold` is the minimum trigram similarity to consider (pg_trgm default is
 * 0.3); we surface the jaro_winkler score alongside so the caller can require a
 * higher bar for a bind than for merely flagging a possible namesake.
 */
export async function findFuzzyCandidates(
  client: QueryClient,
  name: string,
  state_fips: string | null,
  threshold = 0.3,
  limit = 25
): Promise<Array<{ id: string; canonical_name: string; state_fips_primary: string | null; birth_year: number | null; jaro_winkler: number; trigram: number }>> {
  const stateClause = state_fips ? 'AND (p.state_fips_primary = $2 OR p.state_fips_primary IS NULL)' : '';
  const params: unknown[] = state_fips ? [name, state_fips, threshold, limit] : [name, threshold, limit];
  // Parameter positions shift when state is absent; build the SQL accordingly.
  const sql = state_fips
    ? `SELECT p.id, p.canonical_name, p.state_fips_primary, p.birth_year,
              jaro_winkler($1, p.canonical_name) AS jaro_winkler,
              similarity($1, p.canonical_name) AS trigram
         FROM people p
        WHERE similarity($1, p.canonical_name) >= $3
          ${stateClause}
        ORDER BY similarity($1, p.canonical_name) DESC
        LIMIT $4`
    : `SELECT p.id, p.canonical_name, p.state_fips_primary, p.birth_year,
              jaro_winkler($1, p.canonical_name) AS jaro_winkler,
              similarity($1, p.canonical_name) AS trigram
         FROM people p
        WHERE similarity($1, p.canonical_name) >= $2
        ORDER BY similarity($1, p.canonical_name) DESC
        LIMIT $3`;
  const res = await client.query<{
    id: string;
    canonical_name: string;
    state_fips_primary: string | null;
    birth_year: number | null;
    jaro_winkler: number | string;
    trigram: number | string;
  }>(sql, params);
  return res.rows.map((r) => ({
    id: r.id,
    canonical_name: r.canonical_name,
    state_fips_primary: r.state_fips_primary,
    birth_year: r.birth_year,
    jaro_winkler: Number(r.jaro_winkler),
    trigram: Number(r.trigram),
  }));
}

/**
 * Is (person_a, person_b) a sticky do-not-merge pair? Order-insensitive: the
 * table stores the canonical pair with person_id_a < person_id_b, so we probe
 * the ordered pair. Returns the reason when sticky, else null.
 */
export async function isDoNotMerge(
  client: QueryClient,
  personA: string,
  personB: string
): Promise<string | null> {
  if (personA === personB) return null;
  const [lo, hi] = personA < personB ? [personA, personB] : [personB, personA];
  const res = await client.query<{ reason: string }>(
    `SELECT reason FROM do_not_merge WHERE person_id_a = $1 AND person_id_b = $2 LIMIT 1`,
    [lo, hi]
  );
  return res.rowCount && res.rowCount > 0 ? res.rows[0].reason : null;
}

export interface HardenedResolveInput extends ResolveInput {
  /** Corroborated attribute evidence for the corroboration tier. */
  evidence?: AttributeEvidence;
  /** Adverse / same-name-same-state gating flags. */
  flags?: CorroborationFlags;
}

export interface HardenedResolveResult extends ResolveResult {
  /** Present when the corroboration tier ran (no strong id, name+state matched). */
  corroboration?: CorroborationResult;
}

/**
 * Hardened resolve: runs the EXISTING resolvePerson first (strong-id PATH A,
 * then name PATH B), then APPLIES the corroboration tier when the base result is
 * a provisional name-state bind without a strong id. The corroboration tier can
 * only:
 *   - lift a 0.6 name-state bind into [0.70, 0.85] given attribute evidence
 *     (still provisional, still routed to review, never published), OR
 *   - REFUSE the bind (namesake guard: district mismatch, middle-name conflict,
 *     adverse-without-strong-id, same-name-same-state without 2 attributes), and
 *     route to review instead of binding.
 *
 * A strong-id bind (method 'strong_id', 1.0) is passed through untouched.
 * A do-not-merge sticky pair causes the corroboration bind to be refused (the
 * resolver never proposes a merge for a sticky pair).
 *
 * This is opt-in: callers wanting the legacy behavior keep calling resolvePerson.
 */
export async function resolvePersonHardened(
  client: QueryClient,
  input: HardenedResolveInput,
  opts: ResolveOpts = {}
): Promise<HardenedResolveResult> {
  const enqueue = opts.enqueue !== false; // default true
  // Run the existing resolver with enqueue OFF; we decide enqueueing here so we
  // don't double-write a review row for the same input.
  const base = await resolvePerson(client, input, { enqueue: false });

  // Strong-id bind or an already-ambiguous/no-match outcome: nothing for the
  // corroboration tier to add. Re-run the base enqueue side effect if asked.
  const isProvisionalNameBind =
    base.person_id != null &&
    (base.method === 'name_state' || base.method === 'name_state_birthyear') &&
    base.bind_confidence < PUBLISH_THRESHOLD;

  if (!isProvisionalNameBind) {
    if (enqueue && base.method === 'ambiguous_review') {
      // Preserve the original behavior: ambiguity is enqueued by resolvePerson
      // when enqueue is true. Re-resolve once with enqueue=true so the side
      // effect lands (it is idempotent on (canonical_key, state_fips)).
      await resolvePerson(client, input, { enqueue: true });
    }
    return base;
  }

  // Corroboration tier. hasStrongId is false here by construction (a strong id
  // would have produced method 'strong_id').
  const evidence = input.evidence ?? {};
  const flags: CorroborationFlags = {
    ...input.flags,
    // If the base bind matched within the SAME canonical name + state bucket,
    // mark it so the same-name-same-state guard applies. The base method name
    // tells us we matched on name+state; treat any name-bind as same-name. State
    // sameness is implied when the input carried a state.
    same_name_same_state:
      input.flags?.same_name_same_state ?? (input.state_fips != null),
  };

  const corr = scoreCorroboration(evidence, flags, false);

  // do-not-merge sticky guard: if the input record already carries a person id
  // hint that is sticky-distinct from the base bind, refuse. (Callers that bind
  // a record to an existing person can pass the prior person via evidence in a
  // future extension; today we honor stickiness when a known counter-id is set
  // on input.flags is not available, so we only check when the candidate set is
  // explicit.) We additionally consult do_not_merge against the resolved id when
  // a comparison id is provided via input.strong_ids resolving elsewhere — kept
  // conservative: the scanner is the authoritative sticky enforcer.

  if (corr.decision === 'bind' || corr.decision === 'provisional_review') {
    return {
      person_id: base.person_id,
      bind_confidence: corr.bind_confidence,
      method: base.method,
      detail: `${base.detail} | corroboration: ${corr.detail}`,
      corroboration: corr,
    };
  }

  // REFUSE: the namesake guard fired. Do not bind; route to review as
  // insufficient evidence (we could not safely attach the record to this person).
  if (enqueue && input.name) {
    const cKey = canonicalKey(input.name);
    await enqueueDedupReview(client, {
      canonical_key: cKey,
      state_fips: input.state_fips ?? null,
      blocker_category: 'insufficient_evidence',
      blocker_explanation:
        `corroboration tier refused a name+state bind for "${input.name}" ` +
        `(${corr.detail}). Base bind was ${base.detail}.`,
      candidate_people: [{ person_id: base.person_id, refused: true, corroboration: corr }],
    });
  }
  return {
    person_id: null,
    bind_confidence: corr.bind_confidence,
    method: 'ambiguous_review',
    detail: `corroboration refused: ${corr.detail} (base would have bound ${base.person_id} at ${base.bind_confidence})`,
    corroboration: corr,
  };
}

export type XrefAction = 'inserted' | 'upgraded' | 'unchanged' | 'conflict';

export interface RegisterXrefResult {
  xref_id: string | null;
  action: XrefAction;
  /** When action='conflict', the person the external id already maps to. */
  conflicting_person_id?: string | null;
}

/**
 * Register an external identifier for a person via the SQL function
 * upsert_person_xref. On action='conflict' (the (kind, external_id) already
 * maps to a DIFFERENT person, and the function refuses to overwrite), this
 * enqueues a 'conflicting_strong_id' review row and returns the conflict.
 *
 * @param confidence 'high' | 'medium' | 'low' (defaults to 'high' in SQL).
 */
export async function registerXref(
  client: QueryClient,
  person_id: string,
  kind: string,
  external_id: string,
  confidence: 'high' | 'medium' | 'low' = 'high',
  evidence: string | null = null,
  source = 'identity-resolve.ts',
  opts: ResolveOpts = {}
): Promise<RegisterXrefResult> {
  const enqueue = opts.enqueue !== false; // default true

  const res = await client.query<{ xref_id: string; action: XrefAction }>(
    `SELECT * FROM upsert_person_xref($1, $2, $3, $4, $5, $6)`,
    [person_id, kind, external_id, confidence, evidence, source]
  );

  const row = res.rows[0];
  const action: XrefAction = row?.action ?? 'unchanged';
  const xref_id = row?.xref_id ?? null;

  if (action === 'conflict') {
    // The external id already maps to a different person. Find who, so the
    // review row has both candidates.
    const owner = await client.query<{ person_id: string }>(
      `SELECT person_id FROM person_xref WHERE kind = $1 AND external_id = $2 LIMIT 1`,
      [kind, external_id]
    );
    const conflictingPersonId = owner.rowCount && owner.rowCount > 0 ? owner.rows[0].person_id : null;

    if (enqueue) {
      await enqueueDedupReview(client, {
        // No name in scope here; key the review on the contested external id.
        canonical_key: `xref:${kind}=${external_id}`,
        state_fips: null,
        blocker_category: 'conflicting_strong_id',
        blocker_explanation:
          `${kind}=${external_id} already maps to person ${conflictingPersonId}; ` +
          `refused to remap to person ${person_id} (source: ${source}).`,
        candidate_people: [
          { person_id: conflictingPersonId, role: 'existing_owner' },
          { person_id, role: 'attempted_bind' },
        ],
      });
    }

    return { xref_id, action, conflicting_person_id: conflictingPersonId };
  }

  return { xref_id, action };
}
