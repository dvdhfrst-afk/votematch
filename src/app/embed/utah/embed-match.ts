/**
 * embed-match.ts - turn the widget's swipe answers into an ephemeral on-device
 * VoterProfile and score it with the SAME canonical matcher the main app uses.
 *
 * ON-DEVICE INVARIANT (memory: voter_data_architecture_ondevice): the profile
 * built here lives only in the widget's React state for the duration of the
 * session. It is NEVER written to the server and never persisted to the shared
 * app IndexedDB (the embed keeps its own ephemeral copy so a third-party iframe
 * never touches the main profile). Matching runs in the browser via
 * computeMatchesFromBundle -> computeMatchesForUser (pure TS). No opinion leaves
 * the device.
 *
 * No em-dashes or en-dashes anywhere per the project formatting rule.
 */

import type { Domain, MatchResult, QuickMatchAnswers } from '@/types/database';
import type { PositionsBundle } from '@/lib/device/bundle';
import type { VoterProfile } from '@/lib/device/types';
import { computeMatchesFromBundle } from '@/lib/device/match-client';
import { deriveWeights } from '@/lib/matching/weights';

export type SwipeChoice = 'agree' | 'disagree' | 'skip';

export interface SwipeAnswer {
  issueId: string;
  domain: Domain;
  choice: SwipeChoice;
  /** The importance flag double-weights the domain (Wahl-O-Mat's mechanism). */
  important: boolean;
}

// Agree/disagree map to the 0..1 axis toward the high/low spectrum pole. We keep
// a small margin off the extremes so a single binary tap does not read as
// absolute certainty (the acquiescence-bias guard from V2 pillar 5). Skip stores
// no answer at all: abstention is never coerced into a side.
const AGREE_SCORE = 0.85;
const DISAGREE_SCORE = 0.15;

export function buildEphemeralProfile(answers: SwipeAnswer[]): VoterProfile {
  const now = new Date().toISOString();

  const deviceAnswers: VoterProfile['answers'] = {};
  for (const a of answers) {
    if (a.choice === 'skip') continue;
    deviceAnswers[a.issueId] = {
      subDimensionId: a.issueId,
      score: a.choice === 'agree' ? AGREE_SCORE : DISAGREE_SCORE,
      answeredAt: now,
      source: 'quick-match',
    };
  }

  // Domain emphasis comes from the importance flags: the domains the voter
  // starred, ranked by how many issues they starred in each, top 3. With no
  // stars, chosenDomains is empty and deriveWeights returns an equal-weight
  // vector, so matching still works (every domain counts at baseline).
  const importantByDomain = new Map<Domain, number>();
  for (const a of answers) {
    if (a.important && a.choice !== 'skip') {
      importantByDomain.set(a.domain, (importantByDomain.get(a.domain) ?? 0) + 1);
    }
  }
  const chosenDomains = [...importantByDomain.entries()]
    .sort((x, y) => y[1] - x[1])
    .map(([d]) => d)
    .slice(0, 3);

  const qma: QuickMatchAnswers = { domains: chosenDomains, positions: [] };
  const domainWeights = deriveWeights(qma);

  return {
    schemaVersion: 2,
    localId: 'embed',
    answers: deviceAnswers,
    emphasis: { chosenDomains, domainWeights },
    // 'both' so the matcher uses every gate-visible position (stated preferred,
    // record/inferred as available), matching what the widget displays.
    matchView: 'both',
    picks: {},
    plan: { ready: false, updatedAt: now },
    promptHistory: {},
    updatedAt: now,
    createdAt: now,
  };
}

/** Score the whole ballot on-device from the swipe answers + the public bundle. */
export function computeEmbedMatches(
  answers: SwipeAnswer[],
  bundle: PositionsBundle,
): MatchResult[] {
  return computeMatchesFromBundle(buildEphemeralProfile(answers), bundle);
}

/** Count of non-skip answers, for the "answered N" progress readout. */
export function answeredCount(answers: SwipeAnswer[]): number {
  return answers.filter((a) => a.choice !== 'skip').length;
}
