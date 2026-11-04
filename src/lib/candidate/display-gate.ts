/**
 * display-gate.ts -- the candidate/[id] page's decision about WHEN to render
 * position cards vs. the "we are still gathering verified sources" empty state.
 *
 * BACKGROUND (2026-07 fix)
 * ----------------------------------------------------------------------------
 * The candidate page had a Tier-C source-coverage floor (council decision 002):
 * when candidate_tier_view puts a candidate below Tier B (< 10 sources / < 2
 * source types), the page refused to render ANY position cards and showed a
 * "still gathering sources" stub instead. The floor exists to withhold thin
 * INFERRED guesses on candidates we have barely researched.
 *
 * That floor was tuned for a different pipeline. It suppressed real, well-cited
 * positions produced by the research + entailment pipeline: e.g. Arizona
 * candidates whose positions carry high/medium confidence (already gated by the
 * entailment check + write guards + extreme-value corroboration UPSTREAM) but
 * whose candidate_tier_view source_count is small. Rendering "0 total sources /
 * still gathering" on a candidate who actually has cited, entailment-passed
 * positions is both wrong and a trust regression.
 *
 * The two-view stated/inferred distinction, the per-position confidence badges,
 * the inferred labeling, and the "source coverage is thin" warning all keep
 * working. This module ONLY decides the binary "show the gathering stub" vs.
 * "render the positions section" — it does not change how any single position
 * is labeled.
 *
 * NEW THRESHOLDS (documented; this is the one place the gate is decided)
 * ----------------------------------------------------------------------------
 * A candidate's positions render when they have at least one RENDERABLE
 * position. A position is renderable when:
 *
 *   1. it is self-stated (view_type='stated' AND confidence='candidate_direct')
 *      -- the candidate's own affirmed words, highest authenticity, ALWAYS
 *      shown (the pre-existing self-stated carve-out); OR
 *   2. its confidence is 'high' or 'medium'. High/medium is the trust signal
 *      the upstream pipeline already earned: the entailment gate clamps a
 *      position that does not entail its cited quote down to 'low', the write
 *      guards clamp absence-language and single-quote extreme scores down to
 *      'low', and low-confidence rows are ALREADY hidden by the page's per-view
 *      confidence filter. So a surviving high/medium row is one we are willing
 *      to show WITH its confidence badge and (for inferred) its inferred label.
 *
 * We do NOT gate on raw citation count here. Citation count is a weak proxy the
 * confidence enum already folds in: a single-citation high-confidence row that
 * cleared entailment is more trustworthy than a five-citation low-confidence
 * row. Keeping SOME floor matters, so:
 *   - 'low' confidence positions remain hidden (they fall through to the
 *     per-view "no visible position" placeholder bucket, unchanged);
 *   - a candidate with ONLY low-confidence positions still shows an honest
 *     empty/low-confidence state (handled by the page, not promoted here);
 *   - a 1-weak-citation position surfaces as low confidence, i.e. it is NOT
 *     promoted to a rendered card by this gate. It shows the single-source
 *     warning path, not a confident card.
 *
 * So the floor moves from "coverage source_count >= 10" (which suppressed good
 * data) to "at least one position the upstream trust pipeline rated high/medium
 * OR the candidate's own affirmed words" -- honesty over coverage, without
 * publishing thin guesses.
 */

/** The minimal position shape the gate reads. Matches `positions` columns. */
export interface GatePosition {
  view_type: 'stated' | 'inferred' | string;
  confidence: string;
}

/**
 * A position is self-stated when it is the candidate's own affirmed words,
 * recorded via the candidate portal as a tier-1 primary source
 * (view_type='stated', confidence='candidate_direct'). These ALWAYS render;
 * the source-coverage floor never governs a candidate's own attestation.
 */
export function isSelfStated(p: GatePosition): boolean {
  return p.view_type === 'stated' && p.confidence === 'candidate_direct';
}

/**
 * A position is renderable when it is self-stated OR its confidence is high or
 * medium (see NEW THRESHOLDS above). Low / no_data / insufficient_overlap /
 * anything else is NOT renderable by this gate (those rows are handled by the
 * page's existing per-view low-confidence hide + placeholder bucket).
 */
export function isRenderablePosition(p: GatePosition): boolean {
  if (isSelfStated(p)) return true;
  return p.confidence === 'high' || p.confidence === 'medium';
}

/**
 * shouldShowGatheringState(tier, positions): TRUE when the page should render
 * the "we are still gathering verified sources" stub INSTEAD of the positions
 * section.
 *
 * We only show the gathering stub when BOTH:
 *   - the candidate is below the coverage floor (Tier C), AND
 *   - there is not a single renderable position (no self-stated words and no
 *     high/medium-confidence position).
 *
 * If a Tier-C candidate DOES have a renderable position (e.g. a well-cited,
 * entailment-passed inferred position), we fall through to the positions
 * section and render it with its normal badges. The "source coverage is thin"
 * warning still shows above, so the voter still sees the honest caveat.
 *
 * A non-Tier-C candidate never shows the gathering stub (unchanged).
 */
export function shouldShowGatheringState(
  tier: 'A' | 'B' | 'C',
  positions: GatePosition[],
): boolean {
  if (tier !== 'C') return false;
  const hasRenderable = positions.some(isRenderablePosition);
  return !hasRenderable;
}
