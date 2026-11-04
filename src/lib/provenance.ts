/**
 * Provenance + visibility — the shared trust vocabulary for both portals.
 *
 * Trust model (locked): show ALL candidate positions, each clearly LABELED by
 * provenance tier + confidence, with source + quote when available. Never hide
 * or drop data. The voter gets a VISIBILITY-LEVEL control to narrow what THEY
 * see; the data is never gated, only collapsed behind a restorable disclosure.
 *
 * This module is the single source of truth for:
 *   - the human-facing label + plain-language explanation of each `source_tier`
 *   - the trust ranking that orders tiers strongest → weakest
 *   - the visibility levels and which tiers each one surfaces
 *
 * Both the voter UI (`SourceTierBadge`, results, guide) and the candidate
 * display components import from here so the two sides label provenance
 * identically. Colors use the neutral/civic token families only — never the
 * partisan red/blue or red→green ramps (see globals.css US color rules).
 */

import type { SourceTier, VisibilityLevel } from '@/types/database';

export interface TierMeta {
  /** Canonical key (matches the union value). */
  key: SourceTier | 'unlabeled';
  /** Badge label, e.g. "Candidate-stated". */
  label: string;
  /** Ultra-short label for tight chips, e.g. "Stated". */
  short: string;
  /** Plain-language explanation shown on hover / in the explainer. */
  explanation: string;
  /** Trust rank, higher = stronger/more direct provenance. */
  rank: number;
  /**
   * Tailwind utility classes for the badge surface. Neutral/desaturated only:
   * we deliberately avoid green=good / red=bad so the badge reads as "where
   * this came from", not "we endorse / distrust this".
   */
  badgeClass: string;
  /** Small leading glyph that reinforces the tier without relying on color. */
  glyph: string;
}

const UNLABELED: TierMeta = {
  key: 'unlabeled',
  label: 'Source not labeled',
  short: 'Unlabeled',
  explanation:
    'We have this position on file but have not yet attached a provenance label to it. Treat it cautiously and check the cited sources.',
  rank: 0,
  badgeClass: 'bg-[var(--n-100)] text-[var(--n-600)] border-[var(--n-300)]',
  glyph: '○',
};

/**
 * Tier metadata keyed by the live `positions.source_tier` value. Ranks:
 *   5 candidate_stated_current     — the candidate's own current words
 *   4 voting_record_authoritative  — official roll-call record
 *   3 media_paraphrase_high_quality— reputable coverage / direct quotes
 *   1 ml_inferred_from_corpus      — AI-inferred from the public record
 */
export const TIER_META: Record<SourceTier, TierMeta> = {
  candidate_stated_current: {
    key: 'candidate_stated_current',
    label: 'Candidate-stated',
    short: 'Stated',
    explanation:
      "The candidate's own current words, taken from their campaign materials, questionnaire answers, or official statements.",
    rank: 5,
    badgeClass: 'bg-[var(--conf-high-bg)] text-[var(--conf-high-fg)] border-[var(--state-success-bd)]',
    glyph: '✦',
  },
  voting_record_authoritative: {
    key: 'voting_record_authoritative',
    label: 'Voting record',
    short: 'Record',
    explanation:
      'Drawn from official roll-call voting records. This is what the candidate did in office, not what they said.',
    rank: 4,
    badgeClass: 'bg-[var(--score-high-bg)] text-[var(--score-high-fg)] border-[var(--score-high-bd)]',
    glyph: '▣',
  },
  media_paraphrase_high_quality: {
    key: 'media_paraphrase_high_quality',
    label: 'Media-reported',
    short: 'Media',
    explanation:
      "Paraphrased from reputable news coverage or interviews. Reported about the candidate, not their direct words — read the source to see the original context.",
    rank: 3,
    badgeClass: 'bg-[var(--state-info-bg)] text-[var(--state-info-fg)] border-[var(--state-info-bd)]',
    glyph: '◐',
  },
  ml_inferred_from_corpus: {
    key: 'ml_inferred_from_corpus',
    label: 'AI-inferred',
    short: 'Inferred',
    explanation:
      "Inferred by our AI model from the candidate's broader public record. This is our best read of where they likely stand, not a direct statement. Always shown labeled as inferred.",
    rank: 1,
    badgeClass: 'bg-[var(--state-warn-bg)] text-[var(--state-warn-fg)] border-[var(--state-warn-bd)]',
    glyph: '◇',
  },
};

/** Resolve any (possibly null / unrecognised) source_tier to its metadata. */
export function tierMeta(tier: SourceTier | string | null | undefined): TierMeta {
  if (tier && tier in TIER_META) return TIER_META[tier as SourceTier];
  return UNLABELED;
}

// ---------------------------------------------------------------------------
// Visibility levels
// ---------------------------------------------------------------------------

export interface VisibilityLevelMeta {
  key: VisibilityLevel;
  /** Segmented-control label, e.g. "Stated only". */
  label: string;
  /** One-line plain-English description of what this level shows. */
  description: string;
  /** Minimum tier rank surfaced at this level (tiers below are collapsed). */
  minRank: number;
}

/** Ordered most-restrictive → most-inclusive (left → right in the control). */
export const VISIBILITY_LEVELS: VisibilityLevelMeta[] = [
  {
    key: 'stated',
    label: 'Stated only',
    description:
      "Show only positions in the candidate's own words. Hides voting-record, media, and AI-inferred positions.",
    minRank: 5,
  },
  {
    key: 'verified',
    label: 'Stated + record',
    description:
      'Show their own words plus voting records and direct media quotes. Hides AI-inferred positions.',
    minRank: 3,
  },
  {
    key: 'all',
    label: 'Everything',
    description:
      'Show every position, including AI-inferred ones. Inferred positions stay clearly labeled.',
    minRank: 0,
  },
];

/** Default visibility — the trust model default is to show everything, labeled. */
export const DEFAULT_VISIBILITY: VisibilityLevel = 'all';

export function visibilityMeta(level: VisibilityLevel | null | undefined): VisibilityLevelMeta {
  const key = level ?? DEFAULT_VISIBILITY;
  return VISIBILITY_LEVELS.find((l) => l.key === key) ?? VISIBILITY_LEVELS[2];
}

/**
 * Whether a position of the given tier is surfaced at the chosen visibility
 * level. Tiers that fail this are NOT discarded — callers collapse them behind
 * a "hidden by your visibility setting" disclosure that the voter can reopen.
 */
export function tierVisibleAtLevel(
  tier: SourceTier | string | null | undefined,
  level: VisibilityLevel | null | undefined,
): boolean {
  return tierMeta(tier).rank >= visibilityMeta(level).minRank;
}

/**
 * Coarse provenance rank for a MatchView (used on /results, where we only know
 * which view the matcher used, not per-position tiers). Lets the results page
 * flag when a match leans on provenance weaker than the voter's chosen floor.
 */
export function matchViewRank(view: 'stated' | 'inferred' | 'both' | null | undefined): number {
  switch (view) {
    case 'stated':
      return 5; // candidate's own words
    case 'both':
      return 3; // blended
    case 'inferred':
    default:
      return 1; // record-based / inferred
  }
}

/** Pull the first non-empty quote from a position's citations, if any. */
export function firstQuote(
  citations: Array<{ quote?: string | null }> | null | undefined,
): string | null {
  if (!citations) return null;
  for (const c of citations) {
    const q = c?.quote?.trim();
    if (q) return q;
  }
  return null;
}
