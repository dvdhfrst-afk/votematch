'use client';

/**
 * Client race list for the guide index (work-order 1B item 2).
 *
 * The server renders the ballot's race + candidate DISPLAY data (public) and
 * hands it here as `races`. SCORING is computed on the CLIENT from the on-device
 * profile via useGuideScores(). This is the client boundary that hydrates match
 * chips into the server-rendered shell.
 *
 * Honest states (invariant 5):
 *   - no on-device profile  -> "No match yet - answer a few questions" (never a
 *     fabricated "Top match: X 0%")
 *   - profile present, race has a scorable top match -> chip + name
 *   - profile present, race has only insufficient-overlap candidates -> the
 *     designed "not enough overlap yet" state, no percentage
 */

import Link from 'next/link';
import type { Race } from '@/lib/guide/contract';
import { officeLevelLabel } from './format';
import { ScoreChip, Eyebrow } from './primitives';
import { useGuideScores } from '@/lib/device/guide-scores';

export default function GuideRaceList({ races }: { races: Race[] }) {
  const scores = useGuideScores();

  return (
    <ul className="space-y-3">
      {races.map((race) => {
        const entry = scores.byRace.get(race.id);
        const top =
          entry && entry.topCandidateId
            ? entry.breakdowns.find((b) => b.candidateId === entry.topCandidateId) ?? null
            : null;
        const topName = top
          ? race.candidates.find((c) => c.id === top.candidateId)?.name ?? null
          : null;

        return (
          <li key={race.id}>
            <Link
              href={`/guide/race/${race.id}`}
              className="block civic-card civic-card-interactive"
              style={{ minHeight: 80, textDecoration: 'none', color: 'inherit' }}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <Eyebrow>{officeLevelLabel(race.officeLevel)}</Eyebrow>
                  <h3
                    style={{
                      fontFamily: 'var(--font-serif)',
                      fontWeight: 700,
                      fontSize: 18,
                      lineHeight: 1.25,
                      color: 'var(--civic-text)',
                      marginTop: 4,
                    }}
                  >
                    {race.name}
                  </h3>

                  {/* Match line — device-derived, honest per state. */}
                  {scores.loading ? (
                    <p style={{ fontSize: 13, color: 'var(--civic-text-muted)', marginTop: 6 }}>
                      Scoring on your device...
                    </p>
                  ) : !scores.hasProfile ? (
                    <p style={{ fontSize: 13, color: 'var(--civic-text-muted)', marginTop: 6 }}>
                      No match yet, answer a few questions
                    </p>
                  ) : topName ? (
                    <p style={{ fontSize: 13, color: 'var(--civic-text-secondary)', marginTop: 6 }}>
                      Top match:{' '}
                      <span style={{ fontWeight: 600, color: 'var(--civic-text)' }}>
                        {topName}
                      </span>
                    </p>
                  ) : (
                    <p style={{ fontSize: 13, color: 'var(--civic-text-muted)', marginTop: 6 }}>
                      Not enough overlap yet to rank this race
                    </p>
                  )}
                </div>
                {scores.hasProfile && top && (
                  <div className="text-right shrink-0">
                    <ScoreChip pct={top.overallScore} showTier={false} />
                  </div>
                )}
              </div>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
