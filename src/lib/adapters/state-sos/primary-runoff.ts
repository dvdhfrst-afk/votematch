/**
 * Shared primary-runoff outcome logic for Southern states (AL, MS, TN, KY).
 *
 * Rules (common to all four):
 *   - Partisan primary: candidates are segregated by party. Within a party
 *     contest, if one candidate clears 50% they win the nomination. If not,
 *     the top-2 in that party advance to a runoff held on a later date.
 *   - Per-state nuance (2026-04-23 verification):
 *       AL: runoff date 2026-07-14 (6 weeks after primary).
 *       MS: runoff date 2026-04-07 (4 weeks after primary).
 *       TN: NO runoff for state/federal primaries (plurality). Runoff only
 *            exists for some municipal offices. Default to plurality unless
 *            caller opts in via `enableRunoffs: true`.
 *       KY: Traditionally no statutory primary runoff for state/federal
 *            (plurality nominee) — same default as TN.
 *
 * is_winner / is_runoff_advancer
 * ------------------------------
 * - Leader with vote_percentage > 50 → is_winner = true.
 * - Otherwise, if enableRunoffs: top-2 within the party → is_runoff_advancer = true.
 * - Otherwise (plurality-only states): leader wins by plurality → is_winner = true.
 *
 * Grouping key: (office_name, district_identifier, party_abbreviation).
 * party_abbreviation=null rows (non-partisan / jungle-style) are grouped
 * together and treated with plurality semantics — they shouldn't appear in a
 * partisan-primary feed but we handle them defensively.
 */

import type { StateResultRow } from './base';

export type PrimaryOutcomeOpts = {
  enableRunoffs: boolean;
};

export function applyPrimaryRunoffOutcome(
  rows: StateResultRow[],
  opts: PrimaryOutcomeOpts,
): void {
  const groups = new Map<string, StateResultRow[]>();
  for (const r of rows) {
    const key = `${r.office_name}::${r.district_identifier ?? ''}::${r.party_abbreviation ?? ''}`;
    const arr = groups.get(key);
    if (arr) arr.push(r);
    else groups.set(key, [r]);
  }

  for (const group of groups.values()) {
    for (const r of group) {
      r.is_winner = false;
      r.is_runoff_advancer = false;
    }
    const ranked = [...group].sort((a, b) => {
      const av = a.vote_count ?? -1;
      const bv = b.vote_count ?? -1;
      if (bv !== av) return bv - av;
      return a.reported_name.localeCompare(b.reported_name);
    });
    const leader = ranked[0];
    if (!leader) continue;
    const leaderPct = leader.vote_percentage;

    // > 50% always wins outright (covers the plurality + runoff-state case).
    if (leaderPct !== null && leaderPct > 50) {
      leader.is_winner = true;
      continue;
    }

    if (!opts.enableRunoffs) {
      // Plurality nominee — top vote-getter wins.
      leader.is_winner = true;
      continue;
    }

    // Top-2 advance (ties at rank-2 included).
    const second = ranked[1];
    if (!second) {
      // Only one candidate — they advance / win by default.
      leader.is_winner = true;
      continue;
    }
    const secondVotes = second.vote_count ?? -1;
    for (const r of ranked) {
      const v = r.vote_count ?? -1;
      if (r === leader) r.is_runoff_advancer = true;
      else if (v >= secondVotes && v >= 0) r.is_runoff_advancer = true;
    }
  }
}
