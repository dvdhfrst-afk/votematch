/**
 * Daily-prompt (question-of-the-day) wire types (work-order Phase 2A).
 *
 * Shared by the server endpoint (src/app/api/daily-prompt/route.ts) and the
 * client card (src/components/device/DailyPromptCard.tsx). Kept in `types/` so
 * both a server route and a client component can import it without dragging in
 * either side's server-only or browser-only code.
 *
 * PRIVACY: this is a PUBLIC payload. It carries question text + options +
 * sub_dimension labels (all public bank data) and a per-day ranking. It carries
 * NO voter opinion, and the request that fetches it carries none either - the
 * only voter-linked input is the existing anonymous session cookie, used purely
 * to resolve WHICH races are on the ballot (the same input /api/positions-bundle
 * already uses). No em-dashes or en-dashes per the project formatting rule.
 */

/** One answer option for a prompt question (mirrors questions.options rows). */
export interface DailyPromptOption {
  label: string;
  description: string;
  /** 0.0 .. 1.0 stance score this option maps to. */
  score: number;
}

/** A ranked candidate question the device may choose to surface. */
export interface DailyPromptCandidate {
  /** questions.id */
  questionId: string;
  /** sub_dimensions.id the question targets (the device's answer key). */
  subDimensionId: string;
  /** True when this question's sub_dimension is relevant to the ballot's races. */
  onBallot: boolean;
}

/** A candidate enriched with the renderable question content (endpoint output). */
export interface DailyPromptQuestion extends DailyPromptCandidate {
  prompt: string;
  /** Human label for the sub_dimension (for the card's "on X" framing). */
  subDimensionName: string | null;
  domain: string | null;
  options: DailyPromptOption[];
}

/** The full GET /api/daily-prompt response. */
export interface DailyPromptResponse {
  /** Local-independent day the list was computed for (server UTC date). */
  day: string;
  /** Ranked candidate questions; the DEVICE picks which to show. */
  questions: DailyPromptQuestion[];
  /** True when the session has no resolvable ballot (honest empty state). */
  noBallot: boolean;
}
