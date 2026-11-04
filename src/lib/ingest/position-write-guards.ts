/**
 * position-write-guards.ts -- two pure guards every position WRITE path must run
 * before it emits a scored voter-visible row. Extracted here so the local
 * promotion path (promote-signals-to-positions.ts) and the agent-swarm research
 * path (scripts/research-write.ts) enforce the SAME two rules, and so both are
 * unit-testable with no DB and no model call.
 *
 * The 2026-07-01 position-quality audit found two voter-visible failure classes
 * that these guards close:
 *
 *  (a) ABSENCE GUARD. The extractor (or research agent) wrote a scored, medium/
 *      high-confidence position whose own nuance/notes say it found NO position
 *      ("the candidate's position on X is not explicitly detailed", "no explicit
 *      mention", "difficult to ascertain"). Silence is not a position. When the
 *      notes carry governing-absence language, the row must NOT publish at
 *      medium/high -- it is forced to low (the pipeline's existing no-data
 *      convention) or dropped by the caller. NOTE: the honest deterministic
 *      no-data row that the two-view / promotion path writes at LOW is fine --
 *      the bug is a SCORED row at medium+ that contradicts its own notes.
 *
 *  (b) EXTREME-VALUE CORROBORATION GUARD. A score at an extreme of the axis
 *      (<= 0.1 or >= 0.9) is a maximal claim about a candidate ("would abolish
 *      X", "would ban Y"). A maximal claim resting on a SINGLE quote is exactly
 *      the kind of high-stakes attribution that must be corroborated. Require
 *      >= 2 DISTINCT corroborating quotes for an extreme score; otherwise clamp
 *      the confidence to 'low'. (This mirrors gateSignal's cross-source
 *      corroboration stage in extract-signals.ts, which promote-signals never
 *      called.)
 *
 * Pure, deterministic, no I/O, no em-dashes / en-dashes.
 */

// ===========================================================================
// (a) ABSENCE-LANGUAGE GUARD
// ===========================================================================

/**
 * Governing-absence phrasings, derived from the live positions.nuance_notes of
 * the flagged rows (2026-07-01 audit probe over ~9K notes). These are the
 * phrasings a model uses when it is SAYING IT HAS NO POSITION for the axis, as
 * distinct from a real hedge that qualifies a stated position (e.g. "supports X;
 * no detail on funding"). We deliberately keep this list to the phrasings that
 * are the model's PRIMARY finding of absence and exclude bare "no"/"not" tokens
 * that appear inside real positions -- over-matching would demote genuine
 * medium/high rows.
 *
 * Case-insensitive substring match (see hasAbsenceLanguage). Each entry is a
 * lowercase phrase; matching lowercases the notes first.
 */
export const ABSENCE_LANGUAGE_PATTERNS: readonly string[] = [
  // "no <X>" family
  'no explicit mention',
  'no explicit position',
  'no explicit statement',
  'no specific evidence',
  'no specific mention',
  'no public statement',
  'no public position',
  'no direct statement',
  'no direct evidence',
  'no direct mention',
  'no clear position',
  'no stated position',
  'no evidence',
  'without specific evidence',
  // "does not / not explicitly" family
  'does not address',
  'does not mention',
  'does not explicitly',
  'not explicitly detail',
  'not explicitly address',
  'not explicitly stated',
  'not explicitly mention',
  'not directly mention',
  'not directly address',
  // "insufficient / could not find" family
  'insufficient evidence',
  'insufficient information',
  'could not find',
  // "difficult to ..." family (the model's polite way of saying "I have nothing")
  'difficult to ascertain',
  'difficult to accurately',
  'difficult to determine',
  // "lack(s) of ..." family
  'lack of direct evidence',
  'lack of explicit',
  'lacks explicit',
  // "not detailed / not provided in the source(s)" family
  'not detailed in',
  'not provided in',
];

/**
 * hasAbsenceLanguage(notes): true when the notes carry any governing-absence
 * phrasing from ABSENCE_LANGUAGE_PATTERNS. Empty / null notes are NOT absence
 * (the guard only fires on an explicit statement of absence, never on silence).
 */
export function hasAbsenceLanguage(notes: string | null | undefined): boolean {
  if (!notes) return false;
  const hay = notes.toLowerCase();
  for (const p of ABSENCE_LANGUAGE_PATTERNS) {
    if (hay.includes(p)) return true;
  }
  return false;
}

/** The coarse confidence enum the positions table stores. */
export type PositionConfidence = 'high' | 'medium' | 'low' | 'no_data';

/**
 * absenceGuardConfidence(confidence, notes): the confidence a scored row may
 * publish at once the absence guard has run. A row whose notes state absence is
 * never allowed to publish medium/high: it is forced down to 'low'. A row that
 * is already low / no_data, or whose notes make no absence claim, passes through
 * unchanged. This does NOT drop the row (the caller decides drop-vs-demote); it
 * only ensures a self-contradicting scored row cannot claim medium+ confidence.
 */
export function absenceGuardConfidence(
  confidence: PositionConfidence,
  notes: string | null | undefined,
): PositionConfidence {
  if ((confidence === 'medium' || confidence === 'high') && hasAbsenceLanguage(notes)) {
    return 'low';
  }
  return confidence;
}

// ===========================================================================
// (b) EXTREME-VALUE CORROBORATION GUARD
// ===========================================================================

/** A score at or below this is an extreme (toward the 0.0 pole). */
export const EXTREME_LOW_MAX = 0.1;
/** A score at or above this is an extreme (toward the 1.0 pole). */
export const EXTREME_HIGH_MIN = 0.9;
/** Distinct corroborating quotes an extreme score needs to keep medium/high. */
export const MIN_DISTINCT_QUOTES_FOR_EXTREME = 2;

/** True when the score sits at either extreme of the 0..1 axis. */
export function isExtremeScore(score: number | null | undefined): boolean {
  if (typeof score !== 'number' || Number.isNaN(score)) return false;
  return score <= EXTREME_LOW_MAX || score >= EXTREME_HIGH_MIN;
}

/**
 * countDistinctQuotes(quotes): the number of DISTINCT non-empty corroborating
 * quotes, normalized (whitespace collapsed, lowercased) so two citations of the
 * same sentence with cosmetic whitespace differences count as ONE, not two.
 * A maximal claim needs genuinely independent corroboration, not the same quote
 * copied across citations.
 */
export function countDistinctQuotes(
  quotes: ReadonlyArray<string | null | undefined>,
): number {
  const seen = new Set<string>();
  for (const q of quotes) {
    if (!q) continue;
    const norm = q.replace(/\s+/g, ' ').trim().toLowerCase();
    if (norm) seen.add(norm);
  }
  return seen.size;
}

/**
 * extremeValueGuardConfidence(score, confidence, quotes): clamp a medium/high
 * confidence to 'low' when the score is an extreme (<=0.1 or >=0.9) but fewer
 * than MIN_DISTINCT_QUOTES_FOR_EXTREME distinct corroborating quotes back it. A
 * non-extreme score, or an extreme score with >= 2 distinct quotes, passes
 * through unchanged. Already-low / no_data rows pass through unchanged.
 */
export function extremeValueGuardConfidence(
  score: number | null | undefined,
  confidence: PositionConfidence,
  quotes: ReadonlyArray<string | null | undefined>,
): PositionConfidence {
  if (confidence !== 'medium' && confidence !== 'high') return confidence;
  if (!isExtremeScore(score)) return confidence;
  if (countDistinctQuotes(quotes) >= MIN_DISTINCT_QUOTES_FOR_EXTREME) return confidence;
  return 'low';
}

// ===========================================================================
// Combined convenience: run BOTH guards, low-water-mark the confidence.
// ===========================================================================

/**
 * applyWriteGuards({score, confidence, notes, quotes}): run the absence guard
 * and the extreme-value corroboration guard and return the LOWEST confidence
 * either guard permits. Order is irrelevant (both only ever lower confidence),
 * so this is just min(absence, extreme). Callers that want to DROP rather than
 * demote can compare the returned confidence to the input.
 */
export function applyWriteGuards(args: {
  score: number | null | undefined;
  confidence: PositionConfidence;
  notes: string | null | undefined;
  quotes: ReadonlyArray<string | null | undefined>;
}): PositionConfidence {
  const afterAbsence = absenceGuardConfidence(args.confidence, args.notes);
  const afterExtreme = extremeValueGuardConfidence(args.score, afterAbsence, args.quotes);
  return afterExtreme;
}
