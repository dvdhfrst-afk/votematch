/**
 * Pure-function advancement-rule library.
 *
 * Given a slice of `election_results` rows from a primary (+ whatever the
 * effective `primary_advance_rule` is), decide who advances to the next
 * election — the general, the primary runoff, or in LA's case nobody
 * (majority-wins-outright).
 *
 * These functions are pure: no DB calls, no time lookups, no side effects.
 * That lets `__tests__/rules.test.ts` hammer them with synthetic fixtures
 * and lets the CLI script (`scripts/advance-winners.ts`) drive them with
 * rows pulled from `v_advancement_candidates`.
 *
 * Rule surface matches the `primary_advance_rule` CHECK constraint in
 * supabase/migrations/20260423000001_office_election_rules.sql.
 */

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

/** Value set matches `elections.primary_advance_rule` CHECK constraint. */
export type PrimaryAdvanceRule =
  | 'top_vote_getter_per_party'
  | 'plurality_threshold_or_runoff'
  | 'top_two_overall'
  | 'top_four_overall'
  | 'majority_or_advance_to_general'
  | 'convention_supermajority_or_primary'
  | 'instant_runoff'
  | 'no_primary';

/**
 * Minimum shape an advancement rule needs from an election_results row.
 *
 * `candidacy_id` is required: the rules never invent lineage for write-ins
 * or unmatched rows — those have candidacy_id NULL and the CLI filters
 * them out before calling a rule.
 *
 * `party_id` is optional because top-two / top-four / jungle don't care
 * about party; top-vote-getter-per-party requires it (rows without a
 * resolvable party are skipped from that rule's per-party bucket).
 *
 * `nomination_method` is optional and only consulted by
 * convention_supermajority_or_primary, which needs to exclude the
 * convention-path rows that were already nominated pre-primary.
 */
export interface RuleResultRow {
  candidacy_id: string;
  party_id: string | null;
  vote_count: number | null;
  vote_percentage: number | null;
  /** Only needed for the UT SB54 rule. */
  nomination_method?: string | null;
}

export interface RuleDecision {
  /** Candidacies that advance to the target general election. */
  winner_candidacy_ids: string[];
  /** Candidacies that advance to a primary-runoff (not general). */
  runoff_advancer_candidacy_ids: string[];
}

/** Anything outside our enum — the CLI treats this as a data problem. */
export class UnknownAdvancementRuleError extends Error {
  constructor(rule: string) {
    super(`Unknown advancement_rule: ${rule}`);
    this.name = 'UnknownAdvancementRuleError';
  }
}

// ---------------------------------------------------------------------------
// Small internal helpers
// ---------------------------------------------------------------------------

/** Sort descending by vote_count (NULLs trail); stable secondary by candidacy_id
 *  so fixtures and DB ordering produce identical results run-to-run. */
function sortByVotesDesc<T extends RuleResultRow>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const av = a.vote_count ?? -1;
    const bv = b.vote_count ?? -1;
    if (bv !== av) return bv - av;
    return a.candidacy_id.localeCompare(b.candidacy_id);
  });
}

function emptyDecision(): RuleDecision {
  return { winner_candidacy_ids: [], runoff_advancer_candidacy_ids: [] };
}

// ---------------------------------------------------------------------------
// Rule implementations
// ---------------------------------------------------------------------------

/**
 * Standard partisan primary: top vote-getter per distinct party_id advances.
 * Rows without a party_id are ignored (they cannot produce a partisan winner).
 * Used by: most states' partisan primaries.
 */
export function topVoteGetterPerParty(rows: RuleResultRow[]): RuleDecision {
  const byParty = new Map<string, RuleResultRow[]>();
  for (const r of rows) {
    if (!r.party_id) continue;
    const bucket = byParty.get(r.party_id) ?? [];
    bucket.push(r);
    byParty.set(r.party_id, bucket);
  }
  const winners: string[] = [];
  for (const [, bucket] of byParty) {
    const sorted = sortByVotesDesc(bucket);
    if (sorted.length > 0) winners.push(sorted[0].candidacy_id);
  }
  return { winner_candidacy_ids: winners, runoff_advancer_candidacy_ids: [] };
}

/**
 * Plurality + majority runoff: GA / AL / MS / TX primary rule.
 * Per-party bucket. If top vote-getter's percentage > 50%, they win. Otherwise
 * top two go to the primary_runoff (not general).
 */
export function pluralityThresholdOrRunoff(rows: RuleResultRow[]): RuleDecision {
  const byParty = new Map<string, RuleResultRow[]>();
  for (const r of rows) {
    if (!r.party_id) continue;
    const bucket = byParty.get(r.party_id) ?? [];
    bucket.push(r);
    byParty.set(r.party_id, bucket);
  }
  const decision = emptyDecision();
  for (const [, bucket] of byParty) {
    const sorted = sortByVotesDesc(bucket);
    if (sorted.length === 0) continue;
    const top = sorted[0];
    const topPct = top.vote_percentage ?? 0;
    if (topPct > 50) {
      decision.winner_candidacy_ids.push(top.candidacy_id);
    } else {
      // No majority: top two go to the runoff. If there's only one candidate
      // they win outright — there's nobody to run off against.
      if (sorted.length === 1) {
        decision.winner_candidacy_ids.push(top.candidacy_id);
      } else {
        decision.runoff_advancer_candidacy_ids.push(
          sorted[0].candidacy_id,
          sorted[1].candidacy_id,
        );
      }
    }
  }
  return decision;
}

/** CA / WA top-two: top 2 overall advance to general regardless of party. */
export function topTwoOverall(rows: RuleResultRow[]): RuleDecision {
  const sorted = sortByVotesDesc(rows);
  return {
    winner_candidacy_ids: sorted.slice(0, 2).map((r) => r.candidacy_id),
    runoff_advancer_candidacy_ids: [],
  };
}

/** AK top-four: top 4 overall advance to a RCV general. */
export function topFourOverall(rows: RuleResultRow[]): RuleDecision {
  const sorted = sortByVotesDesc(rows);
  return {
    winner_candidacy_ids: sorted.slice(0, 4).map((r) => r.candidacy_id),
    runoff_advancer_candidacy_ids: [],
  };
}

/**
 * LA jungle. If the top vote-getter exceeds 50% they win outright and the race
 * is finalized — nobody advances anywhere. Otherwise top 2 go to a runoff-
 * general (materialized as the "to" election; the runoff link is represented
 * as a general advancement with the two advancers, per schema).
 */
export function majorityOrAdvanceToGeneral(rows: RuleResultRow[]): RuleDecision {
  const sorted = sortByVotesDesc(rows);
  if (sorted.length === 0) return emptyDecision();
  const top = sorted[0];
  const topPct = top.vote_percentage ?? 0;
  if (topPct > 50) {
    // Outright win — no advancement, race finalized at the jungle stage.
    return emptyDecision();
  }
  return {
    winner_candidacy_ids: sorted.slice(0, 2).map((r) => r.candidacy_id),
    runoff_advancer_candidacy_ids: [],
  };
}

/**
 * UT SB54. Convention-path rows were already nominated pre-primary — they
 * are NOT subject to advancement from the primary results (they became
 * general-ballot candidates via the convention, not the primary-winner path).
 * Filter those out and run the standard per-party rule on the remainder.
 */
export function conventionSupermajorityOrPrimary(
  rows: RuleResultRow[],
): RuleDecision {
  const primaryOnly = rows.filter((r) => r.nomination_method !== 'convention');
  return topVoteGetterPerParty(primaryOnly);
}

/**
 * RCV in the primary. Round-by-round tabulation already set is_winner=TRUE on
 * exactly one row per party (the CLI filtered to (is_winner OR is_runoff_
 * advancer) upstream). Treat identically to top_vote_getter_per_party: the
 * winner is the party's top vote-getter post-RCV.
 */
export function instantRunoff(rows: RuleResultRow[]): RuleDecision {
  return topVoteGetterPerParty(rows);
}

/** Offices with no primary at all. Always a no-op. */
export function noPrimary(): RuleDecision {
  return emptyDecision();
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/** Dispatches to the right pure function. Throws on unknown rule values. */
export function applyAdvancementRule(
  rule: PrimaryAdvanceRule,
  rows: RuleResultRow[],
): RuleDecision {
  switch (rule) {
    case 'top_vote_getter_per_party':
      return topVoteGetterPerParty(rows);
    case 'plurality_threshold_or_runoff':
      return pluralityThresholdOrRunoff(rows);
    case 'top_two_overall':
      return topTwoOverall(rows);
    case 'top_four_overall':
      return topFourOverall(rows);
    case 'majority_or_advance_to_general':
      return majorityOrAdvanceToGeneral(rows);
    case 'convention_supermajority_or_primary':
      return conventionSupermajorityOrPrimary(rows);
    case 'instant_runoff':
      return instantRunoff(rows);
    case 'no_primary':
      return noPrimary();
    default: {
      // Exhaustiveness check; unreachable under strict types.
      const _exhaustive: never = rule;
      throw new UnknownAdvancementRuleError(String(_exhaustive));
    }
  }
}
