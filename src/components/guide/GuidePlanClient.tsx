'use client';

/**
 * Client booth plan (work-order 1B item 2).
 *
 * The server supplies the ballot's races (display). The PLAN — each race's top
 * pick + score, decided/undecided counts — is computed on the CLIENT from the
 * on-device profile (useGuideScores) plus any explicit per-race picks the voter
 * saved to the device. Nothing about who the voter chose ever touches the server.
 *
 * Honest states (invariant 5): no device profile -> "answer questions to build
 * your plan"; a race with only insufficient-overlap candidates -> "decide at the
 * booth", never a fabricated recommendation.
 */

import Link from 'next/link';
import { ScoreChip, Caveat, Eyebrow, CivicLinkButton } from './primitives';
import { formatElectionDate } from './format';
import PrintPlanButton from '@/app/guide/plan/PrintPlanButton';
import { useGuideScores } from '@/lib/device/guide-scores';
import { useVoterProfile } from '@/lib/device/useVoterProfile';
import type { Race } from '@/lib/guide/contract';

interface PlanPick {
  raceId: string;
  raceName: string;
  candidateId: string | null;
  candidateName: string | null;
  matchScore: number | null;
}

export default function GuidePlanClient({ races }: { races: Race[] }) {
  const scores = useGuideScores();
  const { profile } = useVoterProfile();

  const nextElectionDate = races
    .map((r) => r.electionDate)
    .filter((d): d is string => Boolean(d))
    .sort()[0];

  // Build picks: an explicit device pick wins; otherwise the client-computed top
  // match. candidateId null = decide at the booth (undecided / insufficient).
  const picks: PlanPick[] = races.map((race) => {
    const entry = scores.byRace.get(race.id);
    const devicePick = profile?.picks[race.id];
    let candidateId: string | null = null;
    let matchScore: number | null = null;

    if (devicePick && devicePick.candidateId) {
      candidateId = devicePick.candidateId;
      const bd = entry?.breakdowns.find((b) => b.candidateId === candidateId);
      matchScore = bd && bd.confidence !== 'no_data' ? bd.overallScore : null;
    } else if (scores.hasProfile && entry?.topCandidateId) {
      candidateId = entry.topCandidateId;
      matchScore = entry.topScore;
    }

    const candidateName = candidateId
      ? race.candidates.find((c) => c.id === candidateId)?.name ?? null
      : null;

    return {
      raceId: race.id,
      raceName: race.name,
      candidateId,
      candidateName,
      matchScore,
    };
  });

  const filled = picks.filter((p) => p.candidateId !== null);
  const unfilled = picks.filter((p) => p.candidateId === null);
  const generatedAt = new Date();

  return (
    <div className="max-w-2xl mx-auto px-4 py-6 space-y-6" style={{ paddingBottom: 80 }}>
      <div className="civic-print-hide">
        <Link
          href="/guide"
          className="inline-flex items-center gap-1 text-sm font-medium min-h-[44px]"
          style={{ color: 'var(--civic-primary)' }}
        >
          ← Back to ballot
        </Link>
      </div>

      <header>
        <Eyebrow>My booth plan</Eyebrow>
        <h1
          style={{
            fontFamily: 'var(--font-serif)',
            fontWeight: 700,
            fontSize: 'clamp(26px, 1.5rem + 1.0vw, 36px)',
            lineHeight: 1.1,
            color: 'var(--civic-text)',
            marginTop: 4,
          }}
        >
          My ballot plan
        </h1>
        <p style={{ marginTop: 6, fontSize: 13, color: 'var(--civic-text-muted)' }}>
          Generated{' '}
          {generatedAt.toLocaleString(undefined, {
            dateStyle: 'medium',
            timeStyle: 'short',
          })}{' '}
          · {filled.length} of {picks.length} races decided
        </p>
        {nextElectionDate && (
          <div
            className="mt-3 inline-flex items-center gap-2"
            style={{
              padding: '6px 12px',
              borderRadius: 'var(--r-pill)',
              background: 'var(--civic-primary-soft)',
              border: '1px solid var(--civic-border)',
            }}
          >
            <span aria-hidden="true" style={{ fontSize: 13 }}>
              🗓
            </span>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--civic-primary)' }}>
              Election day: {formatElectionDate(nextElectionDate)}
            </span>
          </div>
        )}
      </header>

      {!scores.loading && !scores.hasProfile && (
        <div className="civic-card text-center civic-print-hide">
          <p style={{ fontSize: 14, color: 'var(--civic-text-secondary)', lineHeight: 1.5 }}>
            Answer a few questions to build your plan. Your picks live only on
            this device.
          </p>
          <Link href="/quick-match" className="civic-btn civic-btn-primary mt-4 inline-flex">
            Answer a few questions
          </Link>
        </div>
      )}

      {scores.hasProfile && filled.length === 0 && (
        <div className="civic-card text-center">
          <p style={{ fontSize: 14, color: 'var(--civic-text-muted)' }}>
            No picks yet. Open a race to see your matches.
          </p>
          <Link href="/guide" className="civic-btn civic-btn-primary mt-4 inline-flex">
            See my races
          </Link>
        </div>
      )}

      <section className="space-y-3">
        {picks.map((pick) => (
          <div key={pick.raceId} className="civic-card" style={{ pageBreakInside: 'avoid' }}>
            <Eyebrow>{pick.raceName}</Eyebrow>

            {pick.candidateId ? (
              <div className="mt-1 flex items-baseline justify-between gap-2 flex-wrap">
                <span
                  style={{
                    fontFamily: 'var(--font-serif)',
                    fontSize: 20,
                    fontWeight: 700,
                    color: 'var(--civic-text)',
                    lineHeight: 1.2,
                  }}
                >
                  {pick.candidateName}
                </span>
                {pick.matchScore !== null && (
                  <ScoreChip pct={pick.matchScore} showTier={false} />
                )}
              </div>
            ) : (
              <p
                className="civic-print-unfilled"
                style={{
                  marginTop: 6,
                  fontSize: 14,
                  fontStyle: 'italic',
                  color: 'var(--state-warn-fg)',
                }}
              >
                {scores.hasProfile
                  ? 'No pick yet, decide at the booth'
                  : 'Answer questions to see a match'}
              </p>
            )}

            <div className="mt-3 civic-print-hide">
              <Link
                href={`/guide/race/${pick.raceId}`}
                className="text-xs font-medium min-h-[32px] inline-flex items-center"
                style={{ color: 'var(--civic-primary)' }}
              >
                Review this race →
              </Link>
            </div>
          </div>
        ))}
      </section>

      {unfilled.length > 0 && scores.hasProfile && (
        <div className="civic-print-hide">
          <Caveat kind="warn">
            {unfilled.length} race{unfilled.length === 1 ? '' : 's'} not yet chosen.
            You can still take it into the booth; those show as &ldquo;decide at the
            booth.&rdquo;
          </Caveat>
        </div>
      )}

      {/* V2 pillar 5b: the destination is the phone in the booth. Booth Mode is
          the primary affordance; print survives only as a small accessibility
          link below it. */}
      <div className="civic-print-hide flex flex-col gap-3">
        <CivicLinkButton href="/booth" size="lg" fullWidth>
          Take it into the booth &rarr;
        </CivicLinkButton>
        <div className="text-center">
          <PrintPlanButton />
        </div>
      </div>

      <p style={{ marginTop: 24, fontSize: 12, color: 'var(--civic-text-muted)' }}>
        This plan is your own. Havesay never stores who you chose.
      </p>
    </div>
  );
}
