/**
 * Unit tests for the pure-function advancement rules.
 *
 * No DB, no Supabase, no network — just synthetic RuleResultRow[] fixtures.
 *
 * Run: npx tsx --test src/lib/advancement/__tests__/rules.test.ts
 * (or): node --import tsx --test src/lib/advancement/__tests__/rules.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyAdvancementRule,
  conventionSupermajorityOrPrimary,
  instantRunoff,
  majorityOrAdvanceToGeneral,
  noPrimary,
  pluralityThresholdOrRunoff,
  topFourOverall,
  topTwoOverall,
  topVoteGetterPerParty,
  type RuleResultRow,
} from '../rules';

// Convenient party UUIDs — value doesn't matter, only distinctness.
const P_REP = '00000000-0000-0000-0000-000000000001';
const P_DEM = '00000000-0000-0000-0000-000000000002';

// Candidacy UUID builder — keeps fixtures readable.
const c = (n: number): string =>
  `cccccccc-0000-0000-0000-${String(n).padStart(12, '0')}`;

function row(
  candidacyIdx: number,
  party: string | null,
  votes: number,
  pct: number,
  extra: Partial<RuleResultRow> = {},
): RuleResultRow {
  return {
    candidacy_id: c(candidacyIdx),
    party_id: party,
    vote_count: votes,
    vote_percentage: pct,
    ...extra,
  };
}

// -------------------------------------------------------------------------
// top_vote_getter_per_party
// -------------------------------------------------------------------------
describe('topVoteGetterPerParty', () => {
  it('returns top per party across 2R + 2D', () => {
    const rows: RuleResultRow[] = [
      row(1, P_REP, 10_000, 55), // R winner
      row(2, P_REP,  8_000, 45),
      row(3, P_DEM, 12_000, 60), // D winner
      row(4, P_DEM,  8_000, 40),
    ];
    const d = topVoteGetterPerParty(rows);
    assert.equal(d.winner_candidacy_ids.length, 2);
    assert.ok(d.winner_candidacy_ids.includes(c(1)));
    assert.ok(d.winner_candidacy_ids.includes(c(3)));
    assert.equal(d.runoff_advancer_candidacy_ids.length, 0);
  });

  it('skips rows with no party_id', () => {
    const rows: RuleResultRow[] = [
      row(1, null, 10_000, 100), // write-in / unmatched
      row(2, P_REP, 500, 100),
    ];
    const d = topVoteGetterPerParty(rows);
    assert.deepEqual(d.winner_candidacy_ids, [c(2)]);
  });

  it('handles single-candidate bucket', () => {
    const rows: RuleResultRow[] = [row(1, P_REP, 500, 100)];
    const d = topVoteGetterPerParty(rows);
    assert.deepEqual(d.winner_candidacy_ids, [c(1)]);
  });
});

// -------------------------------------------------------------------------
// plurality_threshold_or_runoff
// -------------------------------------------------------------------------
describe('pluralityThresholdOrRunoff', () => {
  it('52% winner wins outright; no runoff', () => {
    const rows: RuleResultRow[] = [
      row(1, P_REP, 5200, 52),
      row(2, P_REP, 3000, 30),
      row(3, P_REP, 1800, 18),
    ];
    const d = pluralityThresholdOrRunoff(rows);
    assert.deepEqual(d.winner_candidacy_ids, [c(1)]);
    assert.deepEqual(d.runoff_advancer_candidacy_ids, []);
  });

  it('38% top-two sends both to runoff', () => {
    const rows: RuleResultRow[] = [
      row(1, P_REP, 3800, 38),
      row(2, P_REP, 3200, 32),
      row(3, P_REP, 3000, 30),
    ];
    const d = pluralityThresholdOrRunoff(rows);
    assert.deepEqual(d.winner_candidacy_ids, []);
    assert.equal(d.runoff_advancer_candidacy_ids.length, 2);
    assert.ok(d.runoff_advancer_candidacy_ids.includes(c(1)));
    assert.ok(d.runoff_advancer_candidacy_ids.includes(c(2)));
    assert.ok(!d.runoff_advancer_candidacy_ids.includes(c(3)));
  });

  it('sole candidate below 50% still wins (nobody to run off)', () => {
    const rows: RuleResultRow[] = [row(1, P_REP, 100, 0)];
    const d = pluralityThresholdOrRunoff(rows);
    assert.deepEqual(d.winner_candidacy_ids, [c(1)]);
  });

  it('applies per-party: R majority + D runoff in same primary', () => {
    const rows: RuleResultRow[] = [
      row(1, P_REP, 6000, 60), // R winner
      row(2, P_REP, 4000, 40),
      row(3, P_DEM, 4500, 45), // no D majority
      row(4, P_DEM, 3500, 35),
      row(5, P_DEM, 2000, 20),
    ];
    const d = pluralityThresholdOrRunoff(rows);
    assert.deepEqual(d.winner_candidacy_ids, [c(1)]);
    assert.equal(d.runoff_advancer_candidacy_ids.length, 2);
    assert.ok(d.runoff_advancer_candidacy_ids.includes(c(3)));
    assert.ok(d.runoff_advancer_candidacy_ids.includes(c(4)));
  });
});

// -------------------------------------------------------------------------
// top_two_overall
// -------------------------------------------------------------------------
describe('topTwoOverall', () => {
  it('picks top 2 regardless of party', () => {
    const rows: RuleResultRow[] = [
      row(1, P_REP, 3000, 30),
      row(2, P_DEM, 4000, 40),
      row(3, P_DEM, 2000, 20),
      row(4, P_REP, 1000, 10),
    ];
    const d = topTwoOverall(rows);
    assert.deepEqual(d.winner_candidacy_ids, [c(2), c(1)]);
    assert.equal(d.runoff_advancer_candidacy_ids.length, 0);
  });

  it('handles <2 candidates gracefully', () => {
    const rows: RuleResultRow[] = [row(1, P_REP, 5, 100)];
    const d = topTwoOverall(rows);
    assert.deepEqual(d.winner_candidacy_ids, [c(1)]);
  });
});

// -------------------------------------------------------------------------
// top_four_overall
// -------------------------------------------------------------------------
describe('topFourOverall', () => {
  it('picks top 4 regardless of party', () => {
    const rows: RuleResultRow[] = [
      row(1, P_REP, 5000, 25),
      row(2, P_DEM, 4000, 20),
      row(3, P_DEM, 3500, 17),
      row(4, P_REP, 3000, 15),
      row(5, null,  1500,  8),
      row(6, null,  1000,  5),
    ];
    const d = topFourOverall(rows);
    assert.deepEqual(d.winner_candidacy_ids, [c(1), c(2), c(3), c(4)]);
  });
});

// -------------------------------------------------------------------------
// majority_or_advance_to_general (LA jungle)
// -------------------------------------------------------------------------
describe('majorityOrAdvanceToGeneral', () => {
  it('51% winner finalizes race — no advancement', () => {
    const rows: RuleResultRow[] = [
      row(1, P_REP, 5100, 51),
      row(2, P_DEM, 3000, 30),
      row(3, P_REP, 1900, 19),
    ];
    const d = majorityOrAdvanceToGeneral(rows);
    assert.deepEqual(d.winner_candidacy_ids, []);
    assert.deepEqual(d.runoff_advancer_candidacy_ids, []);
  });

  it('40% plurality sends top-2 to runoff-general', () => {
    const rows: RuleResultRow[] = [
      row(1, P_REP, 4000, 40),
      row(2, P_DEM, 3500, 35),
      row(3, P_REP, 2500, 25),
    ];
    const d = majorityOrAdvanceToGeneral(rows);
    assert.deepEqual(d.winner_candidacy_ids, [c(1), c(2)]);
    assert.deepEqual(d.runoff_advancer_candidacy_ids, []);
  });

  it('empty input is empty output', () => {
    const d = majorityOrAdvanceToGeneral([]);
    assert.deepEqual(d.winner_candidacy_ids, []);
    assert.deepEqual(d.runoff_advancer_candidacy_ids, []);
  });
});

// -------------------------------------------------------------------------
// convention_supermajority_or_primary (UT SB54)
// -------------------------------------------------------------------------
describe('conventionSupermajorityOrPrimary', () => {
  it('filters convention rows then applies top-per-party', () => {
    const rows: RuleResultRow[] = [
      row(1, P_REP, 6000, 60, { nomination_method: 'convention' }), // pre-nominated, skip
      row(2, P_REP, 5500, 55, { nomination_method: 'primary' }), // R winner
      row(3, P_REP, 4500, 45, { nomination_method: 'primary' }),
      row(4, P_DEM, 3000, 50, { nomination_method: 'primary' }), // D winner
      row(5, P_DEM, 2000, 40, { nomination_method: 'convention' }), // pre-nominated, skip
    ];
    const d = conventionSupermajorityOrPrimary(rows);
    assert.equal(d.winner_candidacy_ids.length, 2);
    assert.ok(d.winner_candidacy_ids.includes(c(2)));
    assert.ok(d.winner_candidacy_ids.includes(c(4)));
    assert.ok(!d.winner_candidacy_ids.includes(c(1)));
    assert.ok(!d.winner_candidacy_ids.includes(c(5)));
  });

  it('all convention rows -> empty advancement', () => {
    const rows: RuleResultRow[] = [
      row(1, P_REP, 1000, 100, { nomination_method: 'convention' }),
      row(2, P_DEM, 1000, 100, { nomination_method: 'convention' }),
    ];
    const d = conventionSupermajorityOrPrimary(rows);
    assert.deepEqual(d.winner_candidacy_ids, []);
  });
});

// -------------------------------------------------------------------------
// instant_runoff (behaves as top_vote_getter_per_party post-RCV tabulation)
// -------------------------------------------------------------------------
describe('instantRunoff', () => {
  it('returns top per party (RCV winner pre-flagged by tabulation)', () => {
    const rows: RuleResultRow[] = [
      row(1, P_REP, 5500, 55),
      row(2, P_REP, 4500, 45),
      row(3, P_DEM, 6000, 60),
    ];
    const d = instantRunoff(rows);
    assert.equal(d.winner_candidacy_ids.length, 2);
    assert.ok(d.winner_candidacy_ids.includes(c(1)));
    assert.ok(d.winner_candidacy_ids.includes(c(3)));
  });
});

// -------------------------------------------------------------------------
// no_primary
// -------------------------------------------------------------------------
describe('noPrimary', () => {
  it('is always an empty advancement', () => {
    const d = noPrimary();
    assert.deepEqual(d.winner_candidacy_ids, []);
    assert.deepEqual(d.runoff_advancer_candidacy_ids, []);
  });
});

// -------------------------------------------------------------------------
// applyAdvancementRule dispatcher
// -------------------------------------------------------------------------
describe('applyAdvancementRule', () => {
  it('dispatches top_vote_getter_per_party', () => {
    const d = applyAdvancementRule('top_vote_getter_per_party', [
      row(1, P_REP, 10, 100),
    ]);
    assert.deepEqual(d.winner_candidacy_ids, [c(1)]);
  });

  it('dispatches no_primary as empty', () => {
    const d = applyAdvancementRule('no_primary', [row(1, P_REP, 10, 100)]);
    assert.deepEqual(d.winner_candidacy_ids, []);
    assert.deepEqual(d.runoff_advancer_candidacy_ids, []);
  });
});
