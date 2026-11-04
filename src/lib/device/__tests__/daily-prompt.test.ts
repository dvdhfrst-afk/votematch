/**
 * Daily-prompt selection-logic tests (work-order Phase 2A).
 *
 * Covers the two halves of the server-blind split:
 *   - rankDailyPromptCandidates(): server-blind ranking (on-ballot weighting,
 *     day-seeded rotation, priority tiebreak, no profile input).
 *   - pickDailyPromptQuestion(): device-side choice (first unanswered, else
 *     oldest-answered refresh, else none).
 * Plus the frequency cap + streak + reminder-time helpers.
 */

import { describe, it, expect } from 'vitest';
import {
  rankDailyPromptCandidates,
  pickDailyPromptQuestion,
  hasAnsweredPromptToday,
  computeStreak,
  dailyPromptSeed,
  ballotKeyFromRaceIds,
  localDayKey,
  REFRESH_AGE_MS,
  DAILY_PROMPT_LIST_SIZE,
  type RankableQuestion,
} from '@/lib/device/daily-prompt';
import { emptyProfile } from '@/lib/device/store';
import type { VoterProfile } from '@/lib/device/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function q(id: string, sub: string, priority = 0): RankableQuestion {
  return { id, subDimensionId: sub, priority };
}

function profileWith(
  answers: Record<string, { score: number; answeredAt: string }>,
  promptHistory: VoterProfile['promptHistory'] = {},
): VoterProfile {
  const p = emptyProfile('2026-07-01T00:00:00.000Z');
  for (const [sub, a] of Object.entries(answers)) {
    p.answers[sub] = {
      subDimensionId: sub,
      score: a.score,
      answeredAt: a.answeredAt,
      source: 'daily-prompt',
    };
  }
  p.promptHistory = promptHistory;
  return p;
}

// ---------------------------------------------------------------------------
// Server-blind ranking
// ---------------------------------------------------------------------------

describe('rankDailyPromptCandidates (server-blind)', () => {
  const bank: RankableQuestion[] = [
    q('qa', 'sd-a', 10),
    q('qb', 'sd-b', 50),
    q('qc', 'sd-c', 20),
    q('qd', 'sd-d', 30),
    q('qe', 'sd-e', 40),
    q('qf', 'sd-f', 5),
  ];

  it('sorts on-ballot questions ahead of off-ballot ones', () => {
    const ranked = rankDailyPromptCandidates({
      questions: bank,
      ballotSubDimensionIds: new Set(['sd-c', 'sd-f']),
      seed: 0,
    });
    // First two must be the on-ballot ones (order among them by rotation/priority).
    const firstTwo = ranked.slice(0, 2).map((c) => c.subDimensionId).sort();
    expect(firstTwo).toEqual(['sd-c', 'sd-f']);
    expect(ranked[0].onBallot).toBe(true);
    expect(ranked[1].onBallot).toBe(true);
  });

  it('is deterministic for a fixed seed', () => {
    const a = rankDailyPromptCandidates({
      questions: bank,
      ballotSubDimensionIds: new Set(),
      seed: 12345,
    });
    const b = rankDailyPromptCandidates({
      questions: bank,
      ballotSubDimensionIds: new Set(),
      seed: 12345,
    });
    expect(a).toEqual(b);
  });

  it('rotates the lead question as the seed changes', () => {
    const leads = new Set<string>();
    for (let s = 0; s < bank.length; s++) {
      const ranked = rankDailyPromptCandidates({
        questions: bank,
        ballotSubDimensionIds: new Set(),
        seed: s,
      });
      leads.add(ranked[0].questionId);
    }
    // With no on-ballot weighting, the day rotation should surface more than one
    // distinct lead question across seeds.
    expect(leads.size).toBeGreaterThan(1);
  });

  it('caps the list at the requested limit', () => {
    const ranked = rankDailyPromptCandidates({
      questions: bank,
      ballotSubDimensionIds: new Set(),
      seed: 3,
    });
    expect(ranked.length).toBe(Math.min(DAILY_PROMPT_LIST_SIZE, bank.length));
  });

  it('returns [] for an empty bank', () => {
    expect(
      rankDailyPromptCandidates({
        questions: [],
        ballotSubDimensionIds: new Set(),
        seed: 1,
      }),
    ).toEqual([]);
  });

  it('does not consult any profile (pure of opinion)', () => {
    // Same inputs, no profile arg exists in the signature; identical output.
    const out = rankDailyPromptCandidates({
      questions: bank,
      ballotSubDimensionIds: new Set(['sd-b']),
      seed: 7,
    });
    expect(out[0].subDimensionId).toBe('sd-b');
    expect(out.every((c) => 'onBallot' in c)).toBe(true);
  });
});

describe('dailyPromptSeed / ballotKey', () => {
  it('is stable per (day, ballot)', () => {
    const key = ballotKeyFromRaceIds(['r2', 'r1', 'r3']);
    expect(key).toBe('r1,r2,r3'); // order-independent
    expect(dailyPromptSeed('2026-07-04', key)).toBe(
      dailyPromptSeed('2026-07-04', key),
    );
  });

  it('changes across days', () => {
    const key = ballotKeyFromRaceIds(['r1']);
    expect(dailyPromptSeed('2026-07-04', key)).not.toBe(
      dailyPromptSeed('2026-07-05', key),
    );
  });
});

// ---------------------------------------------------------------------------
// Device-side pick
// ---------------------------------------------------------------------------

describe('pickDailyPromptQuestion (device-side)', () => {
  const candidates = [
    { questionId: 'qa', subDimensionId: 'sd-a', onBallot: true },
    { questionId: 'qb', subDimensionId: 'sd-b', onBallot: true },
    { questionId: 'qc', subDimensionId: 'sd-c', onBallot: false },
  ];

  it('picks the first UNANSWERED sub_dimension in ranked order', () => {
    const profile = profileWith({
      'sd-a': { score: 0.5, answeredAt: '2026-07-01T00:00:00.000Z' },
    });
    const pick = pickDailyPromptQuestion(candidates, profile);
    expect(pick.reason).toBe('unanswered');
    expect(pick.candidate?.subDimensionId).toBe('sd-b');
  });

  it('falls back to the OLDEST-answered when all are answered and stale', () => {
    const now = Date.parse('2026-08-15T12:00:00.000Z');
    const profile = profileWith({
      'sd-a': { score: 0.5, answeredAt: '2026-07-01T00:00:00.000Z' }, // oldest
      'sd-b': { score: 0.5, answeredAt: '2026-07-10T00:00:00.000Z' },
      'sd-c': { score: 0.5, answeredAt: '2026-07-05T00:00:00.000Z' },
    });
    const pick = pickDailyPromptQuestion(candidates, profile, now);
    expect(pick.reason).toBe('refresh');
    expect(pick.candidate?.subDimensionId).toBe('sd-a');
  });

  it('returns none when all answered but nothing is stale enough', () => {
    const answeredAt = '2026-08-14T00:00:00.000Z';
    const now = Date.parse('2026-08-15T00:00:00.000Z'); // only 1 day old
    const profile = profileWith({
      'sd-a': { score: 0.5, answeredAt },
      'sd-b': { score: 0.5, answeredAt },
      'sd-c': { score: 0.5, answeredAt },
    });
    const pick = pickDailyPromptQuestion(candidates, profile, now);
    expect(pick.reason).toBe('none');
    expect(pick.candidate).toBeNull();
  });

  it('refresh triggers exactly at the horizon', () => {
    const answeredAt = '2026-07-01T00:00:00.000Z';
    const at = Date.parse(answeredAt) + REFRESH_AGE_MS;
    const profile = profileWith({
      'sd-a': { score: 0.5, answeredAt },
      'sd-b': { score: 0.5, answeredAt },
      'sd-c': { score: 0.5, answeredAt },
    });
    expect(pickDailyPromptQuestion(candidates, profile, at).reason).toBe('refresh');
    expect(pickDailyPromptQuestion(candidates, profile, at - 1).reason).toBe('none');
  });

  it('picks the first candidate when the profile is empty', () => {
    const pick = pickDailyPromptQuestion(candidates, null);
    expect(pick.reason).toBe('unanswered');
    expect(pick.candidate?.questionId).toBe('qa');
  });

  it('returns none for an empty candidate list', () => {
    expect(pickDailyPromptQuestion([], null).reason).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// Frequency cap + streak
// ---------------------------------------------------------------------------

describe('hasAnsweredPromptToday', () => {
  it('is true when an answered prompt was shown today', () => {
    const now = new Date('2026-07-04T20:00:00');
    const profile = profileWith(
      {},
      {
        qa: {
          questionId: 'qa',
          subDimensionId: 'sd-a',
          shownAt: new Date('2026-07-04T09:00:00').toISOString(),
          answered: true,
          score: 0.5,
        },
      },
    );
    expect(hasAnsweredPromptToday(profile, now)).toBe(true);
  });

  it('is false when today only has a shown-but-skipped prompt', () => {
    const now = new Date('2026-07-04T20:00:00');
    const profile = profileWith(
      {},
      {
        qa: {
          questionId: 'qa',
          subDimensionId: 'sd-a',
          shownAt: new Date('2026-07-04T09:00:00').toISOString(),
          answered: false,
        },
      },
    );
    expect(hasAnsweredPromptToday(profile, now)).toBe(false);
  });

  it('is false when the answered prompt was a prior day', () => {
    const now = new Date('2026-07-04T20:00:00');
    const profile = profileWith(
      {},
      {
        qa: {
          questionId: 'qa',
          subDimensionId: 'sd-a',
          shownAt: new Date('2026-07-03T09:00:00').toISOString(),
          answered: true,
          score: 0.5,
        },
      },
    );
    expect(hasAnsweredPromptToday(profile, now)).toBe(false);
  });
});

describe('computeStreak', () => {
  function hist(days: string[]): VoterProfile['promptHistory'] {
    const h: VoterProfile['promptHistory'] = {};
    days.forEach((d, i) => {
      h[`q${i}`] = {
        questionId: `q${i}`,
        subDimensionId: `sd-${i}`,
        shownAt: new Date(`${d}T10:00:00`).toISOString(),
        answered: true,
        score: 0.5,
      };
    });
    return h;
  }

  it('counts consecutive answered days ending today', () => {
    const now = new Date('2026-07-04T20:00:00');
    const profile = profileWith(
      {},
      hist(['2026-07-02', '2026-07-03', '2026-07-04']),
    );
    expect(computeStreak(profile, now)).toBe(3);
  });

  it('allows the streak to end yesterday when today is not answered yet', () => {
    const now = new Date('2026-07-04T09:00:00');
    const profile = profileWith({}, hist(['2026-07-02', '2026-07-03']));
    expect(computeStreak(profile, now)).toBe(2);
  });

  it('breaks the streak on a gap', () => {
    const now = new Date('2026-07-04T20:00:00');
    const profile = profileWith(
      {},
      hist(['2026-07-01', '2026-07-04']), // gap on the 2nd/3rd
    );
    expect(computeStreak(profile, now)).toBe(1);
  });

  it('is zero with no answered prompts', () => {
    expect(computeStreak(emptyProfile(), new Date())).toBe(0);
  });
});

describe('localDayKey', () => {
  it('formats a local YYYY-MM-DD', () => {
    expect(localDayKey(new Date('2026-07-04T23:30:00'))).toBe('2026-07-04');
  });
});
