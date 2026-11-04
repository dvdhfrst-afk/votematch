/**
 * Small shared formatters for the guide UX. Server-safe. Paired with the
 * display primitives in `./primitives.tsx` — most callers should prefer
 * the primitives (ScoreChip, ConfidenceBadge, CoverageTier, MatchChip) over
 * the raw tint helpers here, but the helpers stay for legacy call sites.
 */

import type { Confidence } from '@/lib/guide/contract';

const DOMAIN_LABELS: Record<string, string> = {
  economy: 'Economy',
  social: 'Social',
  healthcare: 'Healthcare',
  education: 'Education',
  environment: 'Environment',
  governance: 'Governance',
  public_safety: 'Public safety',
  infrastructure: 'Infrastructure',
};

export function domainLabel(d: string): string {
  return DOMAIN_LABELS[d] ?? d.replace(/_/g, ' ');
}

export function confidenceLabel(c: Confidence): string {
  switch (c) {
    case 'high':
      return 'High confidence';
    case 'medium':
      return 'Medium confidence';
    case 'low':
      return 'Low confidence';
    case 'no_data':
      return 'No data';
  }
}

/** Single-hue slate-indigo tint — partisan-free, CVD-safe. */
export function scoreTint(score: number): string {
  if (score >= 75) return 'text-[color:var(--score-high-fg)]';
  if (score >= 50) return 'text-[color:var(--score-mid-fg)]';
  return 'text-[color:var(--score-low-fg)]';
}

/** Confidence tint for inline chip text. Uses state-color family (distinct from score). */
export function confidenceTint(c: Confidence): string {
  switch (c) {
    case 'high':
      return 'bg-[color:var(--conf-high-bg)] text-[color:var(--conf-high-fg)]';
    case 'medium':
      return 'bg-[color:var(--conf-med-bg)] text-[color:var(--conf-med-fg)]';
    case 'low':
      return 'bg-[color:var(--conf-low-bg)] text-[color:var(--conf-low-fg)]';
    case 'no_data':
      return 'bg-[color:var(--civic-surface-muted)] text-[color:var(--civic-text-muted)]';
  }
}

/** A small, legible pct label — avoids the "99.7%" pseudo-precision trap. */
export function formatPct(n: number): string {
  return `${Math.round(n)}%`;
}

export function officeLevelLabel(level: string): string {
  switch (level) {
    case 'federal':
      return 'Federal office';
    case 'state':
      return 'State office';
    case 'county':
      return 'County office';
    case 'municipal':
      return 'Municipal office';
    case 'judicial':
      return 'Judicial office';
    case 'school_board':
      return 'School board';
    case 'special_district':
      return 'Special district';
    default:
      return level;
  }
}

/**
 * Format an ISO election date (YYYY-MM-DD) as a human calendar date, e.g.
 * "July 21, 2026". We parse the Y/M/D parts directly rather than
 * `new Date(iso)` because that would interpret the string as UTC midnight,
 * which renders as the PREVIOUS day in every US timezone (a July-21 primary
 * would display as July 20). Same pattern as the /ballot electionDayLocal
 * guard and RaceCard.formatHumanDate.
 */
export function formatElectionDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map((n) => parseInt(n, 10));
  if (!y || !m || !d) return iso;
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

export function officeNoun(level: string): string {
  switch (level) {
    case 'federal':
      return 'federal official';
    case 'state':
      return 'state official';
    case 'county':
      return 'county official';
    case 'municipal':
      return 'city official';
    case 'judicial':
      return 'judge';
    case 'school_board':
      return 'school board member';
    case 'special_district':
      return 'district board member';
    default:
      return 'this office';
  }
}
