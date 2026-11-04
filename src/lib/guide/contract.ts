/**
 * Decoupled UX contract for the voter guide.
 *
 * The `/guide` surface is intentionally separated from the live DB schema so
 * the UX can evolve while the ingestion + classification side of the product
 * is being restructured. Every component and page under `src/components/guide/`
 * and `src/app/guide/` reads only from these types via the provider in
 * `./provider.ts`. When the DB stabilises, add a live adapter that satisfies
 * `GuideProvider` and flip `NEXT_PUBLIC_GUIDE_PROVIDER=live`.
 *
 * Design principles encoded here:
 *   1. One headline score, math-defensible, drillable all the way to
 *      issue-level diffs (total → domain → issue).
 *   2. Office-scope is explicit: issues that don't apply to the office are
 *      hidden from the score by default but available for deeper reading.
 *   3. No impute — if a candidate has no stated position, the diff is null,
 *      not a guess.
 *   4. The profile layer accepts manual answers today and is shaped to accept
 *      on-device social-inference output tomorrow without breaking the UI.
 */

export type OfficeLevel =
  | 'federal'
  | 'state'
  | 'county'
  | 'municipal'
  | 'judicial'
  | 'school_board'
  | 'special_district';

export type IssueRelevance =
  /** counts toward the match score at this office level */
  | 'counts'
  /** visible for context, excluded from the score */
  | 'context_only'
  /** not shown at all */
  | 'not_applicable';

export type Confidence = 'high' | 'medium' | 'low' | 'no_data';

export type CoverageTier = 'A' | 'B' | 'C';

export interface Issue {
  id: string;
  /** Human-readable short name — e.g., "Public lands" */
  name: string;
  /** Broad category — shared across multiple issues */
  domain: string;
  spectrum: {
    low: string;
    high: string;
  };
  /** One-line plain-English description of what this issue means */
  description?: string;
}

export interface Source {
  url: string;
  title: string;
  date?: string;
  /**
   * primary   — candidate's own material (site, questionnaire, op-ed)
   * reported  — direct quote in a reputable outlet
   * paraphrase — secondhand characterization
   */
  tier?: 'primary' | 'reported' | 'paraphrase';
}

/** A stance on an issue — shared shape between voter and candidate. */
export interface Stance {
  issueId: string;
  /** 0 = full spectrum low, 1 = full spectrum high */
  score: number;
  confidence: Confidence;
  /** AI-generated prose or voter-entered note */
  summary: string | null;
  sources: Source[];
  /** Optional nuance — why this score, what caveats */
  reasoning?: string;
}

export interface CandidateStance extends Stance {
  candidateId: string;
}

/**
 * A voter's profile. Designed so `source: 'manual'` works today and
 * `source: 'device_inferred'` works tomorrow without breaking the UI.
 *
 * On-device inference (future): a phone-resident model reads social
 * activity, builds `stances` + `domainWeights`, never transmits. The
 * UX reads the same shape either way.
 */
export interface VoterProfile {
  /** Anonymous, local identifier. Not a user account id. */
  id: string;
  stances: Stance[];
  /** 0–1 per domain. Higher = higher priority. */
  domainWeights: Record<string, number>;
  source: 'manual' | 'device_inferred' | 'hybrid';
  /** Last update — useful to nudge "is this still you?" */
  updatedAt: string;
}

export interface Candidate {
  id: string;
  name: string;
  party: string | null;
  photoUrl: string | null;
  bio: string | null;
  websiteUrl: string | null;
  coverageTier: CoverageTier;
  /** Every stance we have for this candidate, regardless of office. */
  stances: CandidateStance[];
}

export interface Race {
  id: string;
  name: string;
  officeLevel: OfficeLevel;
  district: string | null;
  electionDate: string;
  /** Short plain-English description of what this office actually does. */
  officeResponsibilities?: string;
  candidates: Candidate[];
}

/** The drill-down bundle. Same data, surfaced at three depths. */
export interface MatchBreakdown {
  raceId: string;
  candidateId: string;
  /** 0–100, rounded */
  overallScore: number;
  /** Issues that actually factored into the score (both answered + counts at this office) */
  countedIssuesCount: number;
  /** Total applicable issues we could have scored on */
  totalCountableIssuesCount: number;
  /** Context-only issues visible but not counted */
  contextIssuesCount: number;
  /** Office-scope has trimmed issues from scoring */
  excludedByOfficeCount: number;
  confidence: Confidence;
  /** If there are other candidates within the tie band, list their names. */
  tiedWith: string[];
  /** Tier 2: per-domain breakdown */
  byDomain: DomainBreakdown[];
  /** Tier 3: per-issue diffs — includes counts/context/excluded, filter client-side */
  byIssue: IssueDiff[];
  /** Disclosures surfaced in the UI */
  notes: MatchCaveat[];
}

export interface DomainBreakdown {
  domain: string;
  /** 0–100 */
  alignment: number;
  /**
   * How much this domain contributed to moving the overall score.
   * Sign indicates direction: positive pulls the score up, negative drags it down.
   * Useful for showing "why is my score what it is".
   */
  contribution: number;
  /** Voter's weight on this domain (0–1) */
  weight: number;
  countedIssues: number;
  totalIssues: number;
}

export interface IssueDiff {
  issueId: string;
  issueName: string;
  domain: string;
  voterScore: number | null;
  candidateScore: number | null;
  /** |voter − candidate|, or null if either side is missing */
  delta: number | null;
  relevance: IssueRelevance;
  /** True if this diff actually counted toward the overall score */
  includedInScore: boolean;
  candidateConfidence: Confidence;
  spectrum: { low: string; high: string };
  candidateSummary: string | null;
  candidateSources: Source[];
  /** Why the candidate was scored this way — nuance note */
  candidateReasoning?: string;
}

export type MatchCaveatType =
  | 'low_candidate_coverage'
  | 'office_scope_limited'
  | 'single_view_only'
  | 'tied_with_another'
  | 'context_excluded'
  | 'profile_incomplete';

export interface MatchCaveat {
  type: MatchCaveatType;
  message: string;
}

/** A voter's final booth-ready plan. Built from their per-race picks. */
export interface BallotPlan {
  profileId: string;
  generatedAt: string;
  picks: Array<{
    raceId: string;
    raceName: string;
    candidateId: string | null;
    candidateName: string | null;
    matchScore: number | null;
    note?: string;
  }>;
}
