// Database types matching Supabase schema
// Source: blueprint-v5.md Section 9, data-model.md

export type Confidence =
  | 'high'
  | 'medium'
  | 'low'
  | 'candidate_direct'
  | 'no_data'
  /**
   * Council #29: emitted when answered_both_count < MIN_OVERLAP_FOR_SCORE
   * (5 dims). Score is null in that case — the matching engine refuses to
   * produce a number off a 1-2 dim coincidence.
   */
  | 'insufficient_overlap';
export type QuestionnaireStatus = 'not_invited' | 'invited' | 'responded';
export type RaceLevel =
  | 'federal'
  | 'state'
  | 'county'
  | 'municipal'
  | 'judicial'
  | 'school'
  | 'special';
export type RaceType = 'primary' | 'general';
export type CorrectionStatus = 'submitted' | 'accepted' | 'rejected';

/**
 * Scopes at which a sub-dimension may be scored. Extends race levels with
 * additional political contexts (judicial appointments, school boards, etc.)
 * that don't fit cleanly into federal/state/county.
 */
export type RaceScope =
  | 'federal'
  | 'state'
  | 'county'
  | 'municipal'
  | 'judicial'
  | 'school_board'
  | 'special_district';

/**
 * How a sub-dimension applies at a given scope:
 *   - 'matching'       — counts toward the user-candidate match score
 *   - 'informational'  — shown on the candidate profile for voter investigation,
 *                        but excluded from the match calculation
 *   - 'not_applicable' — hidden entirely for candidates at this scope
 */
export type ScopeApplicabilityMode = 'matching' | 'informational' | 'not_applicable';

export type ScopeApplicability = Partial<Record<RaceScope, ScopeApplicabilityMode>>;

export type SubDimensionRevisionType =
  | 'initial'
  | 'minor_edit'
  | 'deprecation'
  | 'restoration';

export type TaxonomyProposalType =
  | 'new_dim'
  | 'retire_dim'
  | 'restore_dim'
  | 'reword_spectrum'
  | 'change_scope'
  | 'change_regions'
  | 'change_salience'
  | 'rename_dim'
  | 'change_domain';

export type TaxonomyProposalStatus =
  | 'draft'
  | 'under_review'
  | 'approved'
  | 'applied'
  | 'rejected'
  | 'withdrawn';

export interface TaxonomyProposal {
  id: string;
  proposer_name: string;
  proposal_type: TaxonomyProposalType;
  target_sub_dimension_id: string | null;
  payload: Record<string, unknown>;
  rationale: string;
  status: TaxonomyProposalStatus;
  decision_reason: string | null;
  submitted_at: string | null;
  approved_at: string | null;
  applied_at: string | null;
  decision_at: string | null;
  decision_by: string | null;
  created_at: string;
  updated_at: string;
}

export type Domain =
  | 'economy'
  | 'social'
  | 'healthcare'
  | 'education'
  | 'environment'
  | 'governance'
  | 'public_safety'
  | 'infrastructure';

export interface SubDimension {
  id: string;
  domain: Domain;
  name: string;
  spectrum_low: string;
  spectrum_high: string;
  display_order: number;
  active?: boolean;
  /** Per-scope matching policy. Absent key defaults to 'not_applicable' at read time. */
  scope_applicability?: ScopeApplicability;
  /**
   * ISO 3166 country codes and sub-national codes where this dim applies.
   * Empty array = universal. US-only: ["US"]. Utah-specific extension: ["US-UT"].
   */
  applicable_regions?: string[];
  /** Editorial emphasis 0–1; 0.5 is neutral. Requires salience_rationale when != 0.5. */
  editorial_salience?: number;
  salience_rationale?: string | null;
  created_at?: string;
  deprecated_at?: string | null;
}

/**
 * One entry in the sub_dimension_versions audit log. Returned from admin queries;
 * not used in user-facing code paths.
 */
export interface SubDimensionVersion {
  id: string;
  sub_dimension_id: string;
  domain: Domain;
  name: string;
  spectrum_low: string;
  spectrum_high: string;
  scope_applicability: ScopeApplicability;
  applicable_regions: string[];
  editorial_salience: number;
  salience_rationale: string | null;
  active: boolean;
  change_reason: string | null;
  changed_by_role: string | null;
  revision_type: SubDimensionRevisionType;
  effective_from: string;
}

export interface Race {
  id: string;
  name: string;
  level: RaceLevel;
  district: string | null;
  election_date: string;
  type: RaceType;
  /** Per-office relevant_dimensions for this race's office.
   *  When set + MATCHING_RESPECT_OFFICE_DIMS feature flag is on, matching
   *  intersects this with the level-scope filter. Falls back to the level-
   *  scope filter alone when null/empty (default).
   *  Populated by loadRaceOfficeDimensions(); see lib/matching/queries.ts. */
  relevant_dimensions?: string[] | null;
}

export interface Candidate {
  id: string;
  name: string;
  party: string | null;
  race_id: string;
  bio: string | null;
  photo_url: string | null;
  website_url: string | null;
  questionnaire_status: QuestionnaireStatus;
  published: boolean;
  created_at: string;
  updated_at: string;
}

export type PositionViewType = 'stated' | 'inferred';

/**
 * Per-user preference for which position view the matching algorithm should
 * use. Lives inside `users.quick_match_answers` JSONB (decision 007 §4).
 *
 *   - 'stated'   — prefer candidate's own words; fall back to inferred if missing
 *   - 'inferred' — use behavioral/synthesized view (current default behavior)
 *   - 'both'     — average stated + inferred when both exist; else whichever exists
 *
 * `null`/absent ≡ 'inferred' (default).
 */
export type MatchView = 'stated' | 'inferred' | 'both';

/**
 * Per-voter "how much do I want to see" trust control (Brief B). Unlike
 * `match_view` (which view the MATCHER uses), this governs which position
 * provenance tiers are SURFACED to the voter. The trust model is "show
 * everything labeled, never hide" — this control only lets the voter narrow
 * their own view; nothing is dropped, only collapsed behind a restorable
 * disclosure. Stored in `users.quick_match_answers.visibility_level`.
 *
 *   - 'stated'   — only the candidate's own current words
 *                  (source_tier = candidate_stated_current)
 *   - 'verified' — stated + voting record + direct media quotes; excludes
 *                  AI-inferred positions
 *   - 'all'      — everything, including AI-inferred (clearly labeled)
 *
 * `null`/absent ≡ 'all' (the default — show everything, labeled). Tier→level
 * mapping + plain-language copy live in `@/lib/provenance`.
 */
export type VisibilityLevel = 'stated' | 'verified' | 'all';

/**
 * Provenance tier of a position, stored in `positions.source_tier` (live DB).
 * This is the trust label voters see — it says WHERE the position came from,
 * orthogonal to `confidence` (how sure we are) and `view_type` (stated vs
 * inferred). The four live values, strongest → weakest provenance:
 *
 *   - 'candidate_stated_current'     — the candidate's own current words
 *   - 'voting_record_authoritative'  — official roll-call voting record
 *   - 'media_paraphrase_high_quality'— paraphrased from reputable coverage
 *   - 'ml_inferred_from_corpus'      — AI-inferred from the public record
 *
 * Display metadata + ordering live in `@/lib/provenance`. Kept as a widened
 * union (| string) so an unrecognised tier from the DB degrades to an
 * "unlabeled" badge instead of breaking the type.
 */
export type SourceTier =
  | 'candidate_stated_current'
  | 'voting_record_authoritative'
  | 'media_paraphrase_high_quality'
  | 'ml_inferred_from_corpus';

export interface Position {
  id: string;
  candidate_id: string;
  sub_dimension_id: string;
  /**
   * stated = built from candidate's own official materials only
   *          (website, questionnaire, op-eds — authenticity_tier=1)
   * inferred = built from all sources, weighted by authenticity_tier
   */
  view_type: PositionViewType;
  score: number; // 0.0-1.0
  confidence: Confidence;
  source_citations: SourceCitation[];
  nuance_notes: string | null;
  ai_summary: string | null;
  extraction_audit_id: string | null;
  created_at: string;
  /**
   * Provenance tier (live DB column `positions.source_tier`). Drives the
   * per-position trust label in the voter UI. Nullable: legacy rows written
   * before the column existed have no tier. `string` widening tolerates any
   * future tier value without a type break — see SourceTier above.
   */
  source_tier?: SourceTier | string | null;
  /**
   * 1=primary (candidate's own words), 2=reported with direct quote,
   * 3=paraphrased. Mirrors `candidate_sources.authenticity_tier`. Most
   * position rows carry provenance via `source_tier`; this field is populated
   * when a single authenticity tier can be attributed to the position.
   */
  authenticity_tier?: AuthenticityTier | null;
}

/** Side-by-side stated + inferred rows for one (candidate, sub_dim) pair. */
export interface PositionGap {
  candidate_id: string;
  sub_dimension_id: string;
  stated_score: number | null;
  stated_confidence: Confidence | null;
  inferred_score: number | null;
  inferred_confidence: Confidence | null;
  /** |stated_score - inferred_score|; null if either view is missing */
  gap: number | null;
  /** true if gap <= 0.15, false if gap > 0.15, null if either view is missing */
  views_align: boolean | null;
  as_of: string;
}

export interface SourceCitation {
  url: string;
  title?: string;
  date?: string;
  /**
   * Direct quote backing this citation, when we captured one (e.g. the phi4
   * extraction path writes `{ url, model, quote, audit_id, extracted_at }`).
   * The voter UI surfaces this verbatim under the position so a reader can
   * judge the source in the candidate's own words. Absent for citations that
   * are link-only (Congress.gov profile, news index, "No signal" placeholder).
   */
  quote?: string | null;
  /**
   * Per-citation provenance tier, when a citation carries its own tier
   * distinct from the position's overall `source_tier`. Optional/forward-
   * compatible — most citations inherit the position tier.
   */
  source_tier?: SourceTier | string | null;
  /** 1=primary, 2=reported w/ direct quote, 3=paraphrased. See AuthenticityTier. */
  authenticity_tier?: AuthenticityTier | null;
  /** Extraction provenance carried by ML-extracted citations. */
  model?: string | null;
  audit_id?: string | null;
  extracted_at?: string | null;
}

export interface QuestionnaireResponse {
  id: string;
  candidate_id: string;
  race_id: string;
  response_data: Record<string, unknown>;
  attestation: string;
  submitted_at: string;
  updated_at: string | null;
}

export interface User {
  id: string;
  session_token: string;
  /**
   * DEPRECATED and no longer written. The server does not persist the voter's
   * plaintext address (privacy: "Your address is not stored on our servers" +
   * the on-device architecture). Lookup now resolves address -> geography ONCE
   * and stores only the resolved identifiers below (precinct_id for Utah,
   * state + congressional_district + resolved_election_ids elsewhere). This
   * field stays on the type only so code can tolerate rows that still hold old
   * values until the null-out migration runs; nothing reads it as a primary
   * source anymore. See scripts/_draft-null-address-text.sql.
   */
  address_text: string | null;
  precinct_id: string | null;
  /**
   * The resolved upcoming-election id set for this voter's ballot, computed
   * once at lookup time from their geocoded point (district path) so we never
   * have to re-geocode a stored plaintext address. NULL/absent for precinct
   * (Utah) sessions, which resolve from precinct_id instead, and until the
   * migration that adds the column runs. See migration
   * _draft-null-address-text.sql.
   */
  resolved_election_ids?: string[] | null;
  quick_match_answers: QuickMatchAnswers | null;
  weights: Record<string, number> | null;
  email: string | null;
  /**
   * Timestamp of explicit opt-in to process political preferences as SPI.
   * When null, quick-match answers MUST NOT be persisted. See migration
   * 20260420000000_user_spi_consent.sql.
   */
  spi_consent_at: string | null;
  /**
   * Per-user matching-view preference (decision 007 §4). Stored inside
   * `quick_match_answers.match_view` JSONB — this field is a convenience
   * shortcut populated from that path at read time. `null` ≡ default
   * (currently 'inferred').
   */
  match_view?: MatchView | null;
  /**
   * State + congressional-district snapshots populated when a ballot is
   * looked up. Used by participation-rank queries (migration
   * 20260502000002_voter_invites.sql) so we don't have to join through
   * precincts → political_districts on every render. Both nullable; if
   * the ballot lookup couldn't determine them they stay null and the
   * district-level rank just isn't shown.
   */
  state?: string | null;
  congressional_district?: string | null;
  /**
   * Set ONCE when the user completes their first quick-match. Drives the
   * participation-rank query. Updated by the `attributeInviteCompletion`
   * Inngest function with a fallback in `submitQuickMatchAction`.
   */
  first_match_completed_at?: string | null;
  created_at: string;
}

export interface QuickMatchAnswers {
  domains: Domain[]; // top 3
  positions: {
    sub_dimension_id: string;
    score: number;
  }[];
  /**
   * Optional: user's preference for which position view the matcher should
   * use. Defaults to 'inferred' when null/absent. See MatchView above.
   * Added per decision 007 §4 (two-view matching preference).
   */
  match_view?: MatchView | null;
  /**
   * Optional: voter's position-visibility trust level (Brief B). Defaults to
   * 'all' when null/absent. Governs which provenance tiers are surfaced (never
   * which are stored). See VisibilityLevel above.
   */
  visibility_level?: VisibilityLevel | null;
}

export interface Match {
  id: string;
  user_id: string;
  candidate_id: string;
  race_id: string;
  /**
   * 0-100, or null when answered_both_count < 5 (council #29). UI must
   * render the null branch as "insufficient overlap" rather than 0%.
   */
  score: number | null;
  /** 1-indexed rank within race; 1 = top match */
  rank: number;
  /** Is this candidate within the tied-threshold of the top-scoring one? */
  tied_with_top: boolean;
  /** Count of sub-dimensions where both user and candidate answered */
  answered_both_count: number;
  /** Total applicable sub-dimensions for the user-candidate pair */
  applicable_count: number;
  explanation: MatchExplanation;
  created_at: string;
}

export interface MatchExplanation {
  agreements: MatchPoint[];
  disagreements: MatchPoint[];
  confidence: Confidence;
  /** Per-domain alignment breakdown for top-domain presentation */
  per_domain: DomainAlignment[];
  /** Sub-dimensions where |user − candidate| > 0.5 despite being domain-aligned */
  disagreement_hotspots: MatchPoint[];
  /**
   * Which view the matcher used for this candidate (decision 007 §4).
   * Stored here so it survives the matches-table round-trip without a new
   * column (persisted inside the `explanation` JSONB). Optional to preserve
   * compatibility with matches rows written before this field existed.
   */
  match_view_used?: MatchView;
}

export interface DomainAlignment {
  domain: Domain;
  /** 0–100: higher = more aligned in this domain */
  alignment: number;
  /** How many sub-dimensions in the domain both sides answered */
  answered_both_count: number;
  /** Total sub-dimensions in this domain */
  total_count: number;
}

export interface MatchPoint {
  sub_dimension_id: string;
  sub_dimension_name: string;
  domain: Domain;
  summary: string;
}

export interface Precinct {
  id: string;
  geom: unknown; // PostGIS geometry
  race_ids: string[];
  district_info: DistrictInfo;
}

export interface DistrictInfo {
  congressional: string;
  state_senate: string;
  state_house: string;
  county: string;
}

export interface Correction {
  id: string;
  candidate_id: string;
  position_id: string;
  submitted_by: string;
  evidence: string | null;
  status: CorrectionStatus;
  resolution_notes: string | null;
  created_at: string;
  resolved_at: string | null;
}

/**
 * 11-value source-type taxonomy per council decision 007 §1 (migration
 * 20260420000004_source_type_taxonomy_expansion.sql). The older 7-value enum
 * was compressed: campaign_website + state_profile → 'website' (with
 * source_subtype), news_article + extracted_positions → 'news', fec_financials
 * → 'filing'. questionnaire and voting_record are preserved.
 *
 * New connectors for Milestone 2 (op_ed, press_release, speech, interview,
 * social, scorecard) ship empty — the pluggable-connector architecture adds
 * fetchers without further schema churn.
 */
export type CandidateSourceType =
  | 'website'
  | 'op_ed'
  | 'press_release'
  | 'speech'
  | 'interview'
  | 'social'
  | 'news'
  | 'scorecard'
  | 'filing'
  | 'questionnaire'
  | 'voting_record';

/** 1=primary, 2=reported w/ direct quote, 3=paraphrased. Stated view uses 1 only. */
export type AuthenticityTier = 1 | 2 | 3;

export type OutletIdeology =
  | 'left'
  | 'center-left'
  | 'center'
  | 'center-right'
  | 'right'
  | 'primary';

export interface CandidateSource {
  id: string;
  candidate_id: string;
  source_type: CandidateSourceType;
  /** Optional granular sub-type (e.g., 'campaign_site' vs 'state_profile' when source_type='website'). See migration 20260420000004. */
  source_subtype: string | null;
  raw_data: string;
  url: string | null;
  title: string | null;
  fetched_at: string;
  authenticity_tier: AuthenticityTier;
  outlet_ideology: OutletIdeology | null;
  published_at: string | null;
  extraction_audit_id: string | null;
}

export interface CandidateContact {
  id: string;
  candidate_id: string;
  email: string;
  created_at: string;
}

// Joined types for API responses
export interface CandidateWithPositions extends Candidate {
  positions: Position[];
  race: Race;
}

export interface RaceWithCandidates extends Race {
  candidates: Candidate[];
}

export interface BallotResult {
  precinct_id: string;
  races: RaceWithCandidates[];
  district_info: DistrictInfo;
}

/**
 * Which dimension set a race was scored on, for UI/log transparency.
 *   - 'office_scoped'  : the office's own relevant_dimensions were resolved and
 *                        intersected with the level-scope filter. The score
 *                        reflects only the issues relevant to THAT office.
 *   - 'level_fallback' : relevance was unknown (office_types.relevant_dimensions
 *                        NULL/empty, or the flag is off), so scoring fell back to
 *                        the full level-scope set. Broader than intended for
 *                        single-purpose offices; treat as a data-quality gap.
 * Only meaningful when MATCHING_RESPECT_OFFICE_DIMS is on; off-flag every race
 * is 'level_fallback' by construction (office scoping is not consulted).
 */
export type RaceDimsSource = 'office_scoped' | 'level_fallback';

export interface MatchResult {
  race: Race;
  /**
   * How this race's scoring dimension set was resolved. See RaceDimsSource.
   * 'level_fallback' with the flag on flags a race whose office has no
   * relevant_dimensions set: its score used the whole level's dim set, which
   * over-scores single-purpose offices. Surfaced so the UI/logs can distinguish
   * "scored on office-scoped dims" from "scored on the level fallback".
   * Optional so additive telemetry never breaks existing MatchResult builders;
   * an absent value reads the same as 'level_fallback' (relevance not applied).
   */
  dims_source?: RaceDimsSource;
  candidates: {
    candidate: Candidate;
    /**
     * 0-100 match score, OR null when overlap < 5 dims (council #29).
     * Null-score candidates sort to the bottom and the UI renders an
     * "insufficient overlap" message instead of a percentage.
     */
    score: number | null;
    /** 1-indexed rank within race */
    rank: number;
    /** True when this candidate is within the tied-threshold of the top match */
    tied_with_top: boolean;
    /** Sub-dimensions where both user and candidate answered */
    answered_both_count: number;
    /** Applicable sub-dimensions for this user-candidate pair */
    applicable_count: number;
    explanation: MatchExplanation;
    confidence: Confidence;
    /**
     * Which view the matcher actually used for this candidate (decision 007 §4).
     * Reflects the effective view after fallbacks:
     *   - 'stated'   when the user asked for stated and the candidate has any stated rows
     *   - 'inferred' default, or stated-preference fallback when no stated rows exist
     *   - 'both'     when user asked for both AND at least one sub_dim had both views
     * Card UI labels each candidate accordingly.
     */
    match_view_used: MatchView;
  }[];
}

/**
 * When a candidate's top rank is within this many percentage points of the #1
 * candidate's score, they're flagged as "roughly tied." Based on Rosema &
 * Louwerse (2016): small design changes flip the top match more often than
 * they flip the ranking, so a ~5pt band captures statistically indistinguishable
 * candidates without over-claiming ties.
 */
export const TIED_THRESHOLD_POINTS = 5;
