/**
 * Shared types for the candidate source-gathering pipeline.
 *
 * Every source type has a connector that implements `SourceConnector`. The
 * orchestrator iterates over applicable connectors for each candidate,
 * collects source rows, deduplicates, and bulk-upserts into candidate_sources.
 *
 * Integration with retention engine: each fetched source may create an
 * extraction_audit row (when AI is involved in extracting the payload), and
 * the row's id gets stored on candidate_sources.extraction_audit_id for
 * per-source provenance.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  AuthenticityTier,
  CandidateSourceType,
  OutletIdeology,
} from '@/types/database';

export interface CandidateContext {
  /**
   * Primary id used for writing to `candidate_sources.candidate_id`. In the
   * legacy path this is the `candidates.id`. In the new path (candidacies +
   * people + elections + offices) this is still the legacy id — we write to
   * candidate_sources using the legacy candidate_id column until a follow-up
   * migration moves candidate_sources onto the candidacies graph.
   */
  id: string;
  /** New-world candidacies.id when resolved from the office-centric graph. */
  candidacy_id?: string;
  /** New-world people.id when resolved from the office-centric graph. */
  person_id?: string;
  /** New-world offices.id when resolved from the office-centric graph. */
  office_id?: string;
  /** New-world elections.id when resolved from the office-centric graph. */
  election_id?: string;
  /** Canonical name: prefers people.canonical_name, falls back to candidates.name. */
  name: string;
  party: string | null;
  website_url: string | null;
  /**
   * Race level — from offices.level when resolved via candidacies, falling
   * back to races.level for legacy rows. Expanded to include the additional
   * office-graph levels ('school' | 'special' | 'judicial') that exist in the
   * office_types.level vocabulary.
   */
  race_level?: 'federal' | 'state' | 'county' | 'municipal' | 'school' | 'special' | 'judicial';
  /**
   * Race / office display name. Prefers offices.canonical_name; falls back
   * to races.name for legacy rows.
   */
  race_name?: string;
  /** Race id — used for district-scoped queries + cross-candidate dedup. */
  race_id?: string;
  /**
   * 2-char FIPS state code (e.g. '49' for UT). Resolved via:
   *   offices.jurisdiction_id → jurisdictions.fips_state (new path)
   *   races.name → state-name regex (legacy fallback)
   * REQUIRED for state-gated connectors (utah_outlets, eventually other
   * state-specific outlet registries).
   */
  stateFips?: string;
  /**
   * Names of all OTHER candidates in the same race. Used by connectors that
   * do relevance scoring (e.g., google_news) to detect when an article is
   * generic race coverage that mentions many candidates rather than being
   * specific to the target candidate. Excludes the target candidate itself.
   */
  other_race_candidates?: string[];
  /** For federal incumbents: Congress.gov bioguide_id if we've matched them */
  bioguide_id?: string | null;
  /** For state legislators: OpenStates id if matched */
  openstates_id?: string | null;
}

/**
 * Result of `SourceConnector.applicable()`. Two-valued: either the connector
 * will run (true) or it will be skipped with a human-readable reason.
 *
 * Skip reasons are logged to `ingestion_runs` (status='skipped') so the gap
 * is visible as data rather than being a silent connector-doesn't-fire. See
 * council F17 (2026-04-23): state-gating utah_outlets against an NJ
 * candidate used to return empty rows; now it returns a structured skip.
 */
export type ApplicableResult =
  | { applicable: true }
  | { applicable: false; reason: string };

export interface SourceRow {
  source_type: CandidateSourceType;
  /** Optional granular sub-type (see migration 20260420000004). Omit when the parent type is self-describing. */
  source_subtype?: string | null;
  authenticity_tier: AuthenticityTier;
  outlet_ideology?: OutletIdeology | null;
  url: string | null;
  title: string | null;
  raw_data: string;
  published_at?: string | null;
  extraction_audit_id?: string | null;
  /**
   * Connector-computed relevance score in [0, 1]: fraction of named-candidate
   * mentions in the article that were the target candidate. 1.0 = the article
   * only mentions this candidate; 0.5 = mentions this candidate as half of
   * named candidates; 0.1 = article is mostly about other candidates.
   * Undefined = connector didn't compute relevance (not applicable).
   */
  relevance_score?: number;
}

export interface SourceConnector {
  /** Stable identifier used for logging + dedup by connector origin. */
  name: string;

  /**
   * Is this connector applicable to this candidate?
   *
   * Returns an `ApplicableResult` rather than a bare boolean so state-gated
   * connectors (e.g., `utah_outlets` which only fires for stateFips='49')
   * can supply a reason that the orchestrator logs to `ingestion_runs`.
   *
   * Returning `{ applicable: true }` means: run the connector.
   * Returning `{ applicable: false, reason: ... }` means: skip and log why.
   */
  applicable(candidate: CandidateContext): ApplicableResult;

  /**
   * Fetch fresh source rows. Must NOT mutate the DB — that's the orchestrator's
   * job. May use the Supabase client for auxiliary lookups (e.g., extracting
   * published_at from existing cached rows).
   *
   * Should honor rate limits and robots.txt politely. On recoverable failures,
   * return [] rather than throwing (the orchestrator will log + move on).
   */
  fetch(candidate: CandidateContext, s: SupabaseClient): Promise<SourceRow[]>;
}

/**
 * Default authenticity tier for each source_type in the 11-value taxonomy.
 *
 * Mirrors the backfill mapping in 20260418000003_two_view_positions.sql
 * lines 74-83, extended for the new types introduced in 20260420000004:
 *
 *   tier 1 (primary, candidate's own words):
 *     website, op_ed, press_release, speech, interview, social, questionnaire
 *   tier 2 (reported with direct quote):
 *     news
 *   tier 3 (paraphrased / secondary / observation-of-action):
 *     scorecard, filing, voting_record
 *
 * Note the 20260418000003 precedent: `voting_record` is primary data but
 * classified as tier 3 because a vote is an action, not a stated position.
 * The stated-view classifier excludes tier > 1; the inferred-view classifier
 * weights tier-3 votes specially via the prompt (see plan 007 §3).
 *
 * Connectors should treat this as a DEFAULT only — they may pass a stricter
 * tier explicitly (e.g., google-news.ts downgrades tier-2 to tier-3 when
 * relevance is low).
 */
export function tierFor(sourceType: CandidateSourceType): AuthenticityTier {
  switch (sourceType) {
    case 'website':
    case 'op_ed':
    case 'press_release':
    case 'speech':
    case 'interview':
    case 'social':
    case 'questionnaire':
      return 1;
    case 'news':
      return 2;
    case 'scorecard':
    case 'filing':
    case 'voting_record':
      return 3;
  }
}

export interface ConnectorRunResult {
  connector: string;
  candidate_name: string;
  rows_returned: number;
  rows_inserted: number; // post-dedup
  errors: string[];
  duration_ms: number;
}
