'use client';

/**
 * Client candidate profile match (work-order 1B item 2).
 *
 * The server renders the candidate hero + provenance (display). The match
 * BREAKDOWN is computed on the CLIENT from the on-device profile (useGuideScores)
 * and shown via MatchBreakdownView. No opinion is read server-side.
 *
 * Honest state (invariant 5): no device profile -> "answer questions" banner in
 * place of a fabricated score; insufficient overlap -> the matcher's no_data
 * state carried through the breakdown.
 */

import Link from 'next/link';
import MatchBreakdownView from './MatchBreakdownView';
import { CivicLinkButton } from './primitives';
import { useGuideScores } from '@/lib/device/guide-scores';
import type { Candidate, MatchBreakdown, Race } from '@/lib/guide/contract';

interface Props {
  race: Race;
  candidate: Candidate;
}

function placeholder(raceId: string, candidateId: string): MatchBreakdown {
  return {
    raceId,
    candidateId,
    overallScore: 0,
    countedIssuesCount: 0,
    totalCountableIssuesCount: 0,
    contextIssuesCount: 0,
    excludedByOfficeCount: 0,
    confidence: 'no_data',
    tiedWith: [],
    byDomain: [],
    byIssue: [],
    notes: [
      {
        type: 'profile_incomplete',
        message:
          'No match yet. Answer a few questions to see how this candidate lines up with your priorities.',
      },
    ],
  };
}

export default function GuideCandidateClient({ race, candidate }: Props) {
  const scores = useGuideScores();
  const breakdown =
    (scores.hasProfile && scores.breakdownFor(race.id, candidate.id)) ||
    placeholder(race.id, candidate.id);

  return (
    <>
      {!scores.loading && !scores.hasProfile && (
        <div className="civic-card civic-print-hide" style={{ background: 'var(--civic-primary-soft)' }}>
          <p style={{ fontSize: 14, color: 'var(--civic-text)', lineHeight: 1.5 }}>
            No match yet. Answer a few questions and this profile shows how{' '}
            {candidate.name.split(' ')[0]} lines up with your priorities, scored
            on your device.
          </p>
          <div className="mt-3">
            <CivicLinkButton href="/quick-match" size="md">
              Answer a few questions
            </CivicLinkButton>
          </div>
        </div>
      )}

      <MatchBreakdownView
        breakdown={breakdown}
        candidate={candidate}
        race={race}
        startOpen={scores.hasProfile}
      />

      <div className="civic-print-hide">
        <Link
          href={`/guide/race/${race.id}`}
          className="inline-flex items-center gap-1 text-sm font-medium min-h-[44px]"
          style={{ color: 'var(--civic-primary)' }}
        >
          ← Back to {race.name}
        </Link>
      </div>
    </>
  );
}
