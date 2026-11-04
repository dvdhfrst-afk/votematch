'use client';

/**
 * Client domain drill-down (work-order 1B item 2).
 *
 * The server supplies the race + candidate DISPLAY data. The per-domain /
 * per-issue MATCH breakdown is computed on the CLIENT from the on-device profile
 * (useGuideScores). No opinion is read server-side.
 *
 * Honest state (invariant 5): no device profile -> an "answer questions" banner
 * and the domain issues shown WITHOUT scored diffs (voter side null), never a
 * fabricated alignment number.
 */

import Link from 'next/link';
import { useMemo } from 'react';
import { domainLabel, officeLevelLabel } from './format';
import {
  ScoreBar,
  ConfidenceBadge,
  CandidateAvatar,
  CivicLinkButton,
  Eyebrow,
} from './primitives';
import GuideRaceRail, { type RailRace } from './GuideRaceRail';
import DomainIssueList from '@/app/guide/race/[raceId]/domain/[domainKey]/DomainIssueList';
import { useGuideScores } from '@/lib/device/guide-scores';
import type { Candidate, Race } from '@/lib/guide/contract';
import type { VisibilityLevel } from '@/types/database';

interface Props {
  race: Race;
  allRaces: Race[];
  domainKey: string;
  /** The candidate to drill into (from ?candidate=, else the top match). */
  candidateId?: string;
  visibilityLevel: VisibilityLevel;
}

export default function GuideDomainClient({
  race,
  allRaces,
  domainKey,
  candidateId,
  visibilityLevel,
}: Props) {
  const scores = useGuideScores();

  const matches = scores.matchesForRace(race.id);
  const match = candidateId
    ? matches.find((m) => m.candidateId === candidateId)
    : matches[0];

  const candidate: Candidate | undefined = match
    ? race.candidates.find((c) => c.id === match.candidateId)
    : candidateId
      ? race.candidates.find((c) => c.id === candidateId)
      : race.candidates[0];

  const railRaces: RailRace[] = allRaces.map((r) => {
    const entry = scores.byRace.get(r.id);
    const top =
      scores.hasProfile && entry?.topCandidateId
        ? entry.breakdowns.find((b) => b.candidateId === entry.topCandidateId) ?? null
        : null;
    return { race: r, top };
  });

  const domainRow = match?.byDomain.find((d) => d.domain === domainKey) ?? null;

  const domainIssues = useMemo(() => {
    if (!match) return [];
    return match.byIssue
      .filter((i) => i.domain === domainKey)
      .sort((a, b) => {
        if (a.includedInScore !== b.includedInScore) {
          return a.includedInScore ? -1 : 1;
        }
        return (b.delta ?? -1) - (a.delta ?? -1);
      });
  }, [match, domainKey]);

  const otherCandidates = candidate
    ? race.candidates.filter((c) => c.id !== candidate.id)
    : race.candidates;

  const domainOrder = match?.byDomain.map((d) => d.domain) ?? [];
  const idx = domainOrder.indexOf(domainKey);
  const prev = idx > 0 ? domainOrder[idx - 1] : null;
  const next = idx >= 0 && idx < domainOrder.length - 1 ? domainOrder[idx + 1] : null;

  const detail = (
    <div className="space-y-6">
      <Link
        href={`/guide/race/${race.id}`}
        className="inline-flex items-center gap-1 text-sm font-medium min-h-[44px]"
        style={{ color: 'var(--civic-primary)' }}
      >
        ← {race.name}
      </Link>

      <header className="civic-card">
        <Eyebrow>{officeLevelLabel(race.officeLevel)}</Eyebrow>
        <h1
          className="civic-serif"
          style={{
            fontFamily: 'var(--font-serif)',
            fontWeight: 700,
            fontSize: 'clamp(24px, 1.4rem + 0.8vw, 32px)',
            lineHeight: 1.15,
            color: 'var(--civic-text)',
            marginTop: 4,
          }}
        >
          {domainLabel(domainKey)}
        </h1>

        {candidate && (
          <div className="mt-4 flex items-center gap-3">
            <CandidateAvatar name={candidate.name} photoUrl={candidate.photoUrl} size={48} />
            <div className="min-w-0 flex-1">
              <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--civic-text)' }}>
                {candidate.name}
              </div>
              {candidate.party && (
                <div style={{ fontSize: 12, color: 'var(--civic-text-muted)' }}>
                  {candidate.party}
                </div>
              )}
            </div>
          </div>
        )}

        {!scores.loading && !scores.hasProfile ? (
          <div className="mt-5">
            <p style={{ fontSize: 14, color: 'var(--civic-text-secondary)', lineHeight: 1.5 }}>
              No match yet. Answer a few questions to see how this domain scores.
            </p>
            <div className="mt-3">
              <CivicLinkButton href="/quick-match" size="md">
                Answer a few questions
              </CivicLinkButton>
            </div>
          </div>
        ) : domainRow ? (
          <>
            <div className="mt-5">
              <ScoreBar pct={domainRow.alignment} label="Domain match" />
            </div>
            <div className="mt-4 flex items-center gap-2 flex-wrap">
              {match && <ConfidenceBadge level={match.confidence} />}
              <span
                className="civic-mono"
                style={{
                  fontSize: 11,
                  color: 'var(--civic-text-muted)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                }}
              >
                {domainRow.countedIssues} of {domainRow.totalIssues} issues counted
              </span>
              {domainRow.contribution !== 0 && (
                <span
                  className="civic-mono"
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    color:
                      domainRow.contribution > 0
                        ? 'var(--state-success-fg)'
                        : 'var(--state-warn-fg)',
                  }}
                >
                  {domainRow.contribution > 0 ? '+' : ''}
                  {domainRow.contribution} pts to headline
                </span>
              )}
            </div>
          </>
        ) : (
          <p className="mt-5" style={{ fontSize: 14, color: 'var(--civic-text-muted)' }}>
            Not enough overlap yet to score this domain.
          </p>
        )}
      </header>

      <section>
        <Eyebrow>Issues — tap any to expand</Eyebrow>
        <div className="mt-3">
          <DomainIssueList
            issues={domainIssues}
            candidateName={candidate?.name ?? 'this candidate'}
            visibilityLevel={visibilityLevel}
          />
        </div>
      </section>

      {otherCandidates.length > 0 && (
        <section className="civic-card">
          <Eyebrow>Same domain, other candidates</Eyebrow>
          <ul className="mt-3 space-y-2">
            {otherCandidates.map((c) => (
              <li key={c.id}>
                <Link
                  href={`/guide/race/${race.id}/domain/${domainKey}?candidate=${c.id}`}
                  prefetch={false}
                  className="flex items-center gap-3 civic-card-interactive"
                  style={{
                    padding: '10px 12px',
                    border: '1px solid var(--civic-border)',
                    borderRadius: 'var(--r-md)',
                    minHeight: 56,
                    textDecoration: 'none',
                    color: 'inherit',
                  }}
                >
                  <CandidateAvatar name={c.name} photoUrl={c.photoUrl} size={36} />
                  <div className="flex-1 min-w-0">
                    <div style={{ fontSize: 14, fontWeight: 600 }}>{c.name}</div>
                    {c.party && (
                      <div style={{ fontSize: 11, color: 'var(--civic-text-muted)' }}>
                        {c.party}
                      </div>
                    )}
                  </div>
                  <span aria-hidden="true" style={{ fontSize: 18, color: 'var(--civic-text-muted)' }}>
                    ›
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {(prev || next) && candidate && (
        <nav
          className="flex items-center justify-between"
          style={{ fontSize: 13, color: 'var(--civic-text-muted)' }}
        >
          {prev ? (
            <Link
              href={`/guide/race/${race.id}/domain/${prev}?candidate=${candidate.id}`}
              prefetch={false}
              className="min-h-[44px] inline-flex items-center"
              style={{ color: 'var(--civic-primary)' }}
            >
              ← {domainLabel(prev)}
            </Link>
          ) : (
            <span />
          )}
          {next ? (
            <Link
              href={`/guide/race/${race.id}/domain/${next}?candidate=${candidate.id}`}
              prefetch={false}
              className="min-h-[44px] inline-flex items-center"
              style={{ color: 'var(--civic-primary)' }}
            >
              {domainLabel(next)} →
            </Link>
          ) : (
            <span />
          )}
        </nav>
      )}
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
