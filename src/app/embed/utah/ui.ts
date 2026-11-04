/**
 * ui.ts - small shared display helpers for the Utah embed. Pure, no JSX.
 * No em-dashes or en-dashes anywhere per the project formatting rule.
 */

import type { Domain, RaceLevel } from '@/types/database';

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

/**
 * Humanize a sub_dimension name for display. Some names are stored as slugs
 * (e.g. "economic_system"); turn underscores into spaces and capitalize the
 * first letter, while leaving already-proper names (e.g. "Great Salt Lake")
 * untouched.
 */
export function humanizeIssueName(name: string): string {
  const spaced = name.replace(/_/g, ' ').trim();
  if (!spaced) return name;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function domainLabel(domain: Domain | string): string {
  return DOMAIN_LABELS[domain] ?? String(domain).replace(/_/g, ' ');
}

export const LEVEL_LABELS: Record<RaceLevel, string> = {
  federal: 'Federal',
  state: 'State',
  county: 'County',
  municipal: 'City & town',
  school: 'School board',
  special: 'Special district',
  judicial: 'Judicial',
};

export function levelLabel(level: RaceLevel | string): string {
  return LEVEL_LABELS[level as RaceLevel] ?? String(level);
}

/** Score band -> design-system score tint tokens (single-hue, non-partisan). */
export function scoreTone(score: number | null): {
  bg: string;
  fg: string;
  bd: string;
  bar: string;
} {
  if (score === null) {
    return { bg: 'var(--score-low-bg)', fg: 'var(--score-low-fg)', bd: 'var(--score-low-bd)', bar: 'var(--score-low-bar)' };
  }
  if (score >= 70) {
    return { bg: 'var(--score-high-bg)', fg: 'var(--score-high-fg)', bd: 'var(--score-high-bd)', bar: 'var(--score-high-bar)' };
  }
  if (score >= 45) {
    return { bg: 'var(--score-mid-bg)', fg: 'var(--score-mid-fg)', bd: 'var(--score-mid-bd)', bar: 'var(--score-mid-bar)' };
  }
  return { bg: 'var(--score-low-bg)', fg: 'var(--score-low-fg)', bd: 'var(--score-low-bd)', bar: 'var(--score-low-bar)' };
}

/** Format an ISO YYYY-MM-DD as a local calendar date, avoiding UTC off-by-one. */
export function formatBallotDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(`${iso.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

/** Compact party label. */
export function partyLabel(party: string | null): string | null {
  if (!party) return null;
  const p = party.trim();
  if (!p) return null;
  return p;
}
