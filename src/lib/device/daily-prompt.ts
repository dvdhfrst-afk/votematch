/**
 * Daily-prompt (question-of-the-day) selection logic (work-order Phase 2A).
 *
 * THE SERVER-BLIND DESIGN, in two sentences: the endpoint returns a small
 * deterministic-per-day RANKED LIST of candidate questions (weighted toward the
 * sub_dimensions that matter for THIS ballot's races, using only the
 * address-derived ballot and never any opinion), and the DEVICE alone decides
 * which one to surface (first unanswered, else the oldest-answered for a
 * refresh). Because the client sends the server nothing about the profile, the
 * server can never learn what the voter has or has not answered - it only knows
 * the public ballot, exactly like /api/positions-bundle.
 *
 * This module holds the PURE, unit-testable halves of that split:
 *   - rankDailyPromptCandidates(): the server's blind ranking (ballot-weighted,
 *     day-seeded rotation). No profile input.
 *   - pickDailyPromptQuestion(): the device's choice among the returned
 *     candidates, using the on-device promptHistory + answers. Never leaves the
 *     device.
 *
 * PRIVACY (invariant 1): nothing here reads or writes the operational DB, and
 * the device half takes the profile as an argument - it is only ever called in
 * the browser. No em-dashes or en-dashes per the project formatting rule.
 */

import type { DailyPromptCandidate } from '@/types/daily-prompt';
import type { VoterProfile } from './types';

// ---------------------------------------------------------------------------
// Server-blind ranking
// ---------------------------------------------------------------------------

/** How many candidate questions the endpoint returns. Small on purpose: enough
 * for the device to find an unanswered one without shipping the whole bank. */
export const DAILY_PROMPT_LIST_SIZE = 5;

/**
 * A stable per-(day, ballot) integer seed. Deterministic so the same device
 * hitting the endpoint twice in one day gets the same list (cacheable), and so
 * two devices on the same ballot rotate through the bank in lockstep - which is
 * fine, because the DEVICE still personalizes the final pick from local
 * history. `ballotKey` is a cheap hash of the sorted race-id set (public data).
 */
export function dailyPromptSeed(dayIso: string, ballotKey: string): number {
  const s = `${dayIso}|${ballotKey}`;
  let h = 2166136261 >>> 0; // FNV-1a
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** Cheap order-independent key for a ballot's race-id set (public). */
export function ballotKeyFromRaceIds(raceIds: string[]): string {
  return [...raceIds].sort().join(',');
}

/** One question in the bank, as the ranker needs it (public metadata only). */
export interface RankableQuestion {
  id: string;
  subDimensionId: string;
  /** Higher = the seeded question authors want it asked more. */
  priority: number;
}

/**
 * Rank the question bank for one day + one ballot, server-blind.
 *
 * Weighting, highest first:
 *   1. Questions whose sub_dimension is in the ballot's relevant set (they
 *      sharpen THIS voter's race scoring) sort ahead of off-ballot ones.
 *   2. Within a tier, a day-seeded rotation offset spreads which question leads
 *      so a returning voter is not shown the same lead question every day.
 *   3. Author `priority` breaks remaining ties (higher first), then id for a
 *      fully stable order.
 *
 * Returns at most `limit` candidates. No profile is consulted - the device
 * applies its own history on top of this list.
 */
export function rankDailyPromptCandidates(args: {
  questions: RankableQuestion[];
  /** sub_dimension ids relevant to the ballot's races (public). */
  ballotSubDimensionIds: Set<string>;
  seed: number;
  limit?: number;
}): DailyPromptCandidate[] {
  const { questions, ballotSubDimensionIds, seed } = args;
  const limit = args.limit ?? DAILY_PROMPT_LIST_SIZE;
  if (questions.length === 0) return [];

  // Day-seeded rotation offset over the full bank so the leading question
  // changes each day even when priorities are flat.
  const offset = seed % questions.length;

  const scored = questions.map((q, i) => {
    const onBallot = ballotSubDimensionIds.has(q.subDimensionId) ? 1 : 0;
    // rotationRank: distance from today's offset, wrapping. Lower = earlier.
    const rotationRank = (i - offset + questions.length) % questions.length;
    return { q, onBallot, rotationRank };
  });

  scored.sort((a, b) => {
    // 1. on-ballot first
    if (a.onBallot !== b.onBallot) return b.onBallot - a.onBallot;
    // 2. day rotation
    if (a.rotationRank !== b.rotationRank) return a.rotationRank - b.rotationRank;
    // 3. author priority (higher first)
    if (a.q.priority !== b.q.priority) return b.q.priority - a.q.priority;
    // 4. stable by id
    return a.q.id < b.q.id ? -1 : a.q.id > b.q.id ? 1 : 0;
  });

  return scored.slice(0, limit).map(({ q, onBallot }) => ({
    questionId: q.id,
    subDimensionId: q.subDimensionId,
    onBallot: onBallot === 1,
  }));
}

// ---------------------------------------------------------------------------
// Device-side pick (browser-only; profile is an argument, never sent anywhere)
// ---------------------------------------------------------------------------

export type DailyPromptPickReason = 'unanswered' | 'refresh' | 'none';

export interface DailyPromptPick {
  /** The chosen candidate, or null when the list is empty. */
  candidate: DailyPromptCandidate | null;
  /** Why it was chosen - drives the card's framing ("Today's question" vs
   * "Still you? Refresh an older answer"). */
  reason: DailyPromptPickReason;
}

/**
 * Milliseconds after which a previously-answered stance is eligible for a
 * refresh prompt. 30 days: a stance "survives the latest news" by being
 * re-confirmed roughly monthly. Exported so the UI copy and tests agree.
 */
export const REFRESH_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The DEVICE's choice among the server's candidate list. Order of preference:
 *   1. The first candidate whose sub_dimension the voter has NOT answered yet
 *      (fills a gap that sharpens the ballot).
 *   2. Otherwise (fully answered across the list) the candidate whose existing
 *      answer is OLDEST, so a returning voter gets a "still you?" refresh of a
 *      stale stance rather than nothing.
 *   3. `none` when the list is empty.
 *
 * `now` is injectable for tests. Reads `profile.answers` (keyed by
 * sub_dimension) and `profile.promptHistory`; both are device-only.
 */
export function pickDailyPromptQuestion(
  candidates: DailyPromptCandidate[],
  profile: VoterProfile | null,
  now: number = Date.now(),
): DailyPromptPick {
  if (candidates.length === 0) return { candidate: null, reason: 'none' };

  const answers = profile?.answers ?? {};

  // 1. First unanswered sub_dimension in the ranked order.
  const unanswered = candidates.find((c) => !(c.subDimensionId in answers));
  if (unanswered) return { candidate: unanswered, reason: 'unanswered' };

  // 2. All answered -> pick the one whose answer is oldest AND older than the
  //    refresh horizon. If none is stale enough, there is nothing worth asking
  //    today; return none so the card can hide rather than nag.
  let oldest: DailyPromptCandidate | null = null;
  let oldestAt = Infinity;
  for (const c of candidates) {
    const a = answers[c.subDimensionId];
    if (!a) continue;
    const t = Date.parse(a.answeredAt);
    if (Number.isNaN(t)) continue;
    if (t < oldestAt) {
      oldestAt = t;
      oldest = c;
    }
  }

  if (oldest && now - oldestAt >= REFRESH_AGE_MS) {
    return { candidate: oldest, reason: 'refresh' };
  }

  return { candidate: null, reason: 'none' };
}

// ---------------------------------------------------------------------------
// Frequency cap (device-tracked, one prompt per calendar day)
// ---------------------------------------------------------------------------

/** Local calendar day key (YYYY-MM-DD in the device's timezone). */
export function localDayKey(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Has the device already ANSWERED a daily prompt today? Derived purely from
 * promptHistory: an entry that was answered whose shownAt lands on today's
 * local day means the once-per-day answer cap is spent. (Merely seeing the card
 * does not spend the cap; only answering does, so a dismiss-and-return still
 * shows the card.)
 */
export function hasAnsweredPromptToday(
  profile: VoterProfile | null,
  now: Date = new Date(),
): boolean {
  const today = localDayKey(now);
  const hist = profile?.promptHistory ?? {};
  for (const entry of Object.values(hist)) {
    if (!entry.answered) continue;
    const shown = new Date(entry.shownAt);
    if (!Number.isNaN(shown.getTime()) && localDayKey(shown) === today) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Streak (device-only, from promptHistory)
// ---------------------------------------------------------------------------

/**
 * Count the current daily-answer streak: consecutive local days (ending today
 * or yesterday) on which the voter answered at least one prompt. A gentle
 * indicator only - never gated, never sent anywhere.
 */
export function computeStreak(
  profile: VoterProfile | null,
  now: Date = new Date(),
): number {
  const hist = profile?.promptHistory ?? {};
  const answeredDays = new Set<string>();
  for (const entry of Object.values(hist)) {
    if (!entry.answered) continue;
    const d = new Date(entry.shownAt);
    if (!Number.isNaN(d.getTime())) answeredDays.add(localDayKey(d));
  }
  if (answeredDays.size === 0) return 0;

  // Start from today; if today is not answered, allow the streak to end
  // yesterday (so a not-yet-answered today does not zero a real streak).
  let cursor = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (!answeredDays.has(localDayKey(cursor))) {
    cursor = new Date(cursor.getTime() - 24 * 60 * 60 * 1000);
    if (!answeredDays.has(localDayKey(cursor))) return 0;
  }

  let streak = 0;
  while (answeredDays.has(localDayKey(cursor))) {
    streak++;
    cursor = new Date(cursor.getTime() - 24 * 60 * 60 * 1000);
  }
  return streak;
}
