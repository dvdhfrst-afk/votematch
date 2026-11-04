// ---------------------------------------------------------------------------
// Four-band ordinal label scale for the G1 golden set.
// (V2-VISION "Data-quality rule": clearly supports / partially / unrelated /
//  contradicts, judged as quote-in-CONTEXT vs the claimed stance.)
//
// Pure module, safe to import from both server and client components.
// ---------------------------------------------------------------------------

export type BandN = 1 | 2 | 3 | 4;

export interface BandDef {
  n: BandN;
  key: "clearly_supports" | "partially_supports" | "unrelated" | "contradicts";
  label: string;
  hint: string;
  tone: "success" | "warn" | "neutral" | "error";
}

export const BANDS: readonly BandDef[] = [
  {
    n: 1,
    key: "clearly_supports",
    label: "Clearly supports",
    hint: "The quote, read in its context, entails the claimed stance on the claimed sub-dimension.",
    tone: "success",
  },
  {
    n: 2,
    key: "partially_supports",
    label: "Partially / ambiguous",
    hint: "On-topic and plausible, but ambiguous, hedged, or readable more than one way.",
    tone: "warn",
  },
  {
    n: 3,
    key: "unrelated",
    label: "Unrelated",
    hint: "The quote is about something else. It does not speak to this claim at all.",
    tone: "neutral",
  },
  {
    n: 4,
    key: "contradicts",
    label: "Contradicts",
    hint: "The quote, in context, supports the OPPOSITE stance from the claim.",
    tone: "error",
  },
] as const;

export function bandByN(n: number): BandDef | undefined {
  return BANDS.find((b) => b.n === n);
}

export function isBandN(n: unknown): n is BandN {
  return n === 1 || n === 2 || n === 3 || n === 4;
}

// ---------------------------------------------------------------------------
// The fifth action: "cannot verify from source" (keyboard 5).
// NOT an ordinal band. Stored with band: null and a required skip_reason, and
// EXCLUDED from calibration (see entailment-calibration.isSkipLabel). Label
// hygiene: a reviewer should skip rather than guess when the source cannot be
// checked (dead link, unscrubable video, paywall, source mismatch).
// ---------------------------------------------------------------------------

/** The keyboard key that arms the skip action. */
export const SKIP_KEY = "5" as const;

/** Preset one-word-or-more skip reasons (free text also allowed). */
export const SKIP_REASONS = [
  "dead link",
  "video unscrubable",
  "paywall",
  "source mismatch",
] as const;

export type SkipReason = (typeof SKIP_REASONS)[number] | string;
