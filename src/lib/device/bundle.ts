/**
 * PositionsBundle — the PUBLIC, per-ballot payload the device downloads on app
 * open and scores against locally (work-order 1A deliverable 3).
 *
 * INVARIANT (work-order invariants 2 + 3): this carries ONLY public
 * civic/candidate data (races, candidates, renderable position vectors, office
 * dims, sub-dimension metadata). It NEVER contains voter opinions, and the
 * client never sends opinions back to fetch it. The only voter-linked input is
 * the existing anonymous session cookie used purely to resolve WHICH races are
 * on this voter's ballot (their address), which is the same resolution `/ballot`
 * already performs.
 *
 * Lean by design: citation TEXT is excluded; each position carries only a
 * `citationCount` so the payload stays small (target < ~300KB for an 11-race
 * ballot). The device match engine (match-client.ts) needs only the vectors +
 * scope metadata to reproduce the server score exactly.
 *
 * The bundle intentionally mirrors the fields the pure matcher keys on
 * (sub_dimension_id, score, view_type, confidence) so match-client can feed it
 * straight into selectPositionsForView + weightedL1Score with no re-derivation.
 */

import type {
  Confidence,
  Domain,
  PositionViewType,
  RaceLevel,
  RaceType,
  ScopeApplicability,
} from '@/types/database';

/**
 * One renderable position vector for a candidate on one sub-dimension. This is
 * the lean projection of a DB `positions` row: enough to score + label, without
 * the citation prose, nuance notes, or audit ids.
 */
export interface BundlePosition {
  /** positions.id — kept so the client can dedup the two read paths. */
  id: string;
  sub_dimension_id: string;
  /** 0.0 .. 1.0 */
  score: number;
  view_type: PositionViewType;
  confidence: Confidence;
  /** positions.source_tier, needed by selectPositionsForView's STATED_OK guard. */
  source_tier: string | null;
  /** ISO created_at, needed by selectPositionsForView's most-recent-wins tiebreak. */
  created_at: string;
  /** Count of source citations (NOT the citation text). Drives "Based on N sources". */
  citationCount: number;
  /** True when at least one citation carries a non-empty URL (matcher's non-placeholder gate). */
  hasCitationUrl: boolean;
}

/** A candidate on the ballot, with their lean position vectors. */
export interface BundleCandidate {
  id: string;
  /** Already display-formatted (formatCandidateName + sanitizeDisplayName). */
  name: string;
  party: string | null;
  /** Coverage tier A/B/C from the ballot loader's well-documented signal. */
  tier: 'A' | 'B' | 'C';
  positions: BundlePosition[];
}

/** A race on the voter's ballot. */
export interface BundleRace {
  id: string;
  name: string;
  level: RaceLevel;
  district: string | null;
  election_date: string;
  type: RaceType;
  /**
   * Office-scoped relevant_dimensions (sub_dimension ids), resolved server-side
   * via loadRaceOfficeDimensions. Null/empty means "use the level-scope set"
   * (the client mirrors the server's dims_source fallback exactly).
   */
  relevant_dimensions: string[] | null;
  candidates: BundleCandidate[];
}

/** Lean sub-dimension metadata the client needs for scoping + labels. */
export interface BundleSubDimension {
  id: string;
  domain: Domain;
  name: string;
  spectrum_low: string;
  spectrum_high: string;
  display_order: number;
  scope_applicability: ScopeApplicability;
}

/**
 * Server-resolved matching feature flags, emitted so the CLIENT matcher scores
 * on the SAME code branch the production server does (work-order 1B item 3).
 *
 * The pure matcher (algorithm.ts) reads these flags from `process.env`, which is
 * undefined in the browser bundle and would otherwise silently fall back to the
 * production-OFF default. In production the server runs with office-dims ON, so
 * the client would under-score (whole-level dim set instead of the office-scoped
 * set) without this. The endpoint reads the real server env once and ships the
 * resolved booleans here; match-client applies them via the office-dims module's
 * documented override (NOT by mutating process.env, which is inert in the
 * browser). See src/lib/matching/office-dims.ts setOfficeDimsOverride().
 */
export interface MatchingFlags {
  /** MATCHING_RESPECT_OFFICE_DIMS resolved on the server (office-scoped dims). */
  respectOfficeDims: boolean;
  /** MATCHING_MULTIVARIABLE resolved on the server (axis scoring path). */
  multivariable: boolean;
}

/** The full per-ballot bundle. */
export interface PositionsBundle {
  /** Bundle schema version, for cache-busting the service-worker cache (Phase 1C). */
  version: number;
  /** ISO timestamp the bundle was generated (for staleness display). */
  generatedAt: string;
  races: BundleRace[];
  subDimensions: BundleSubDimension[];
  /**
   * Server-resolved matching flags. Optional so an older cached bundle (v1)
   * still parses; match-client treats an absent object as "server defaults"
   * and falls back to the matcher's own env read. Present on v2+.
   */
  matchingFlags?: MatchingFlags;
}

/**
 * Current bundle schema version.
 *
 * v2 (2026-07-04, work-order 1B): adds `matchingFlags` so the client matcher
 * runs the same office-dims / multivariable branch as the production server.
 * Bumping this busts the service-worker cache so returning devices refetch a
 * flag-bearing bundle rather than scoring on the stale flagless v1.
 */
export const POSITIONS_BUNDLE_VERSION = 2;
