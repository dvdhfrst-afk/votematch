'use client';

/**
 * Client race detail (work-order 1B item 2).
 *
 * The server renders the ballot's race + candidate DISPLAY data and hands it
 * here. SCORING (ranking, match chips, breakdowns, the desktop rail's top
 * scores) is computed on the CLIENT from the on-device profile via
 * useGuideScores(). This is the client boundary for the race page.
 *
 * Honest states (invariant 5): no device profile -> a clear "answer questions"
 * banner and candidates listed UNRANKED with no score; insufficient overlap ->
 * the matcher's designed no_data state per candidate.
 */

import Link from 'next/link';
import MatchBreakdownView from './MatchBreakdownView';
import GuideRaceRail, { type RailRace } from './GuideRaceRail';
import { officeLevelLabel, formatElectionDate } from './format';
import { CandidateAvatar, CivicLinkButton, Eyebrow } from './primitives';
import { useGuideScores } from '@/lib/device/guide-scores';
import type { MatchBreakdown, Race } from '@/lib/guide/contract';

interface Props {
  race: Race;
  allRaces: Race[];
}

/** Empty breakdown so MatchBreakdownView can render a no-profile candidate row. */
function placeholderBreakdown(raceId: string, candidateId: string): MatchBreakdown {
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
          'No match yet. Answer a few questions and this race gets scored against your priorities, on your device.',
      },
    ],
  };
}

export default function GuideRaceDetail({ race, allRaces }: Props) {
  const scores = useGuideScores();

  // Ranked breakdowns for the active race (device-derived). When there is no
  // profile the matcher returns nothing; we fall back to display order with a
  // placeholder so the candidates are still visible + navigable.
  const deviceMatches = scores.matchesForRace(race.id);
  const ranked =
    scores.hasProfile && deviceMatches.length > 0
      ? deviceMatches
      : race.candidates.map((c) => placeholderBreakdown(race.id, c.id));

  // Rail: top match per race from device scores (null when no profile).
  const railRaces: RailRace[] = allRaces.map((r) => {
    const entry = scores.byRace.get(r.id);
    const top =
      scores.hasProfile && entry?.topCandidateId
        ? entry.breakdowns.find((b) => b.candidateId === entry.topCandidateId) ?? null
        : null;
    return { race: r, top };
  });

  const detail = (
    <div className="space-y-6 pb-24">
      <Link
        href="/guide"
        className="lg:hidden inline-flex items-center gap-1 text-sm font-medium min-h-[44px]"
        style={{ color: 'var(--civic-primary)' }}
      >
        ← All races
      </Link>

      <header>
        <Eyebrow>{officeLevelLabel(race.officeLevel)}</Eyebrow>
        <h1
          style={{
            fontFamily: 'var(--font-serif)',
            fontWeight: 700,
            fontSize: 'clamp(24px, 1.4rem + 0.8vw, 32px)',
            lineHeight: 1.15,
            color: 'var(--civic-text)',
            marginTop: 4,
          }}
        >
          {race.name}
        </h1>

        {race.electionDate && (
          <div
            className="mt-2 inline-flex items-center gap-2"
            style={{
              padding: '5px 11px',
              borderRadius: 'var(--r-pill)',
              background: 'var(--civic-primary-soft)',
              border: '1px solid transparent',
            }}
          >
            <span aria-hidden="true" style={{ fontSize: 12 }}>
              🗓
            </span>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--civic-primary)' }}>
              Election day: {formatElectionDate(race.electionDate)}
            </span>
          </div>
        )}

        {race.officeResponsibilities && (
          <div
            style={{
              marginTop: 14,
              padding: '14px 16px',
              borderRadius: 'var(--r-md)',
              background: 'var(--civic-surface-muted)',
              border: '1px solid var(--civic-border)',
            }}
          >
            <div
              className="civic-mono"
              style={{
                fontSize: 10,
                color: 'var(--civic-text-muted)',
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                fontWeight: 600,
                marginBottom: 4,
              }}
            >
              What this office actually does
            </div>
            <p style={{ fontSize: 14, color: 'var(--civic-text-secondary)', lineHeight: 1.55 }}>
              {race.officeResponsibilities}
            </p>
          </div>
        )}
      </header>

      {!scores.loading && !scores.hasProfile && (
        <div className="civic-card" style={{ background: 'var(--civic-primary-soft)' }}>
          <p style={{ fontSize: 14, color: 'var(--civic-text)', lineHeight: 1.5 }}>
            No match yet. Answer a few questions and every candidate here gets
            scored against your priorities, right on your device.
          </p>
          <div className="mt-3">
            <CivicLinkButton href="/quick-match" size="md">
              Answer a few questions
            </CivicLinkButton>
          </div>
        </div>
      )}

      <section className="space-y-5">
        {ranked.map((breakdown, idx) => {
          const candidate = race.candidates.find((c) => c.id === breakdown.candidateId);
          if (!candidate) return null;
          return (
            <div key={breakdown.candidateId}>
              <div className="flex items-center gap-3 mb-2 px-1">
                <span
                  className="civic-mono"
                  style={{
                    fontSize: 13,
                    fontWeight: 700,
                    color: 'var(--civic-text-muted)',
                    width: 24,
                    textAlign: 'center',
                  }}
                >
                  {scores.hasProfile ? idx + 1 : '·'}
                </span>
                <CandidateAvatar name={candidate.name} photoUrl={candidate.photoUrl} size={36} />
                <div className="flex-1 min-w-0">
                  <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--civic-text)' }}>
                    {candidate.name}
                  </div>
                  {candidate.party && (
                    <div style={{ fontSize: 11, color: 'var(--civic-text-muted)' }}>
                      {candidate.party}
                    </div>
                  )}
                </div>
                <Link
                  href={`/guide/candidate/${candidate.id}?race=${race.id}`}
                  className="text-xs font-medium min-h-[32px] inline-flex items-center"
                  style={{ color: 'var(--civic-primary)' }}
                >
                  Profile →
                </Link>
              </div>

              <MatchBreakdownView
                breakdown={breakdown}
                candidate={candidate}
                race={race}
                startOpen={idx === 0 && scores.hasProfile}
              />
            </div>
          );
        })}
      </section>

      <div className="sticky bottom-4 pt-2">
        <CivicLinkButton href="/guide/plan" size="lg" fullWidth>
          Add to my plan →
        </CivicLinkButton>
      </div>
    </div>
  );

  return (
    <div className="lg:grid lg:grid-cols-[minmax(240px,300px)_1fr] lg:gap-8 lg:items-start">
      <aside className="hidden lg:block lg:sticky" style={{ top: 72 }}>
        <GuideRaceRail races={railRaces} activeRaceId={race.id} />
      </aside>
      <div className="min-w-0">{detail}</div>
    </div>
  );
}
