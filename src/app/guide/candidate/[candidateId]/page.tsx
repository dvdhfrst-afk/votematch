import Link from 'next/link';
import { notFound } from 'next/navigation';
import GuideCandidateClient from '@/components/guide/GuideCandidateClient';
import { getGuideProvider, isGuideRenderable } from '@/lib/guide/provider';
import { officeLevelLabel } from '@/components/guide/format';
import {
  CandidateAvatar,
  CoverageTier,
  BetaChip,
  FreshnessChip,
  Caveat,
  Eyebrow,
} from '@/components/guide/primitives';
import type { Candidate } from '@/lib/guide/contract';

/**
 * Provenance summary derived from the candidate's stances (candidate-frames.jsx:
 * "N sources · self-stated" + inferred/Beta treatment). Honest degradation: when
 * nothing is stated we say so rather than inventing a freshness signal.
 */
function candidateProvenance(candidate: Candidate): {
  hasInferred: boolean;
  statedCount: number;
  sourceCount: number;
  /** Age in months of the most-recent dated source, or null if none carry a date. */
  freshnessMonths: number | null;
} {
  let hasInferred = false;
  let statedCount = 0;
  let sourceCount = 0;
  let newestMs: number | null = null;
  const now = Date.now();

  for (const s of candidate.stances) {
    if (s.confidence === 'low' || s.confidence === 'medium') hasInferred = true;
    else if (s.confidence === 'high') statedCount += 1;
    for (const src of s.sources) {
      sourceCount += 1;
      if (src.date) {
        const t = Date.parse(src.date);
        if (!Number.isNaN(t) && (newestMs === null || t > newestMs)) newestMs = t;
      }
    }
  }

  const freshnessMonths =
    newestMs === null
      ? null
      : Math.max(0, Math.round((now - newestMs) / (1000 * 60 * 60 * 24 * 30.44)));

  return { hasInferred, statedCount, sourceCount, freshnessMonths };
}

/**
 * Candidate profile. Opens with the match breakdown expanded by default
 * (startOpen) because the reader navigated here deliberately to see one
 * person. Race context comes via the ?race= search param.
 */
export default async function GuideCandidatePage({
  params,
  searchParams,
}: {
  params: Promise<{ candidateId: string }>;
  searchParams: Promise<{ race?: string }>;
}) {
  if (!isGuideRenderable()) return null;
  const { candidateId } = await params;
  const { race: raceParam } = await searchParams;
  const provider = getGuideProvider();

  const candidate = await provider.getCandidate(candidateId);
  if (!candidate) notFound();

  let raceId = raceParam;
  if (!raceId) {
    const races = await provider.listRaces();
    raceId = races.find((r) => r.candidates.some((c) => c.id === candidateId))?.id;
  }
  if (!raceId) notFound();

  const race = await provider.getRace(raceId);
  if (!race) notFound();

  const prov = candidateProvenance(candidate);
  const lowCoverage = candidate.coverageTier === 'C' || candidate.stances.length === 0;

  return (
    <div className="max-w-3xl mx-auto px-4 py-6 space-y-6">
      <Link
        href={`/guide/race/${race.id}`}
        className="inline-flex items-center gap-1 text-sm font-medium min-h-[44px]"
        style={{ color: 'var(--civic-primary)' }}
      >
        ← Back to {race.name}
      </Link>

      {/* Candidate hero card */}
      <header className="civic-card">
        <div className="flex items-start gap-4">
          <CandidateAvatar name={candidate.name} photoUrl={candidate.photoUrl} size={72} />

          <div className="min-w-0 flex-1">
            <Eyebrow>{officeLevelLabel(race.officeLevel)}</Eyebrow>
            <h1
              style={{
                fontFamily: 'var(--font-serif)',
                fontWeight: 700,
                fontSize: 'clamp(22px, 1.3rem + 0.6vw, 28px)',
                lineHeight: 1.15,
                color: 'var(--civic-text)',
                marginTop: 4,
              }}
            >
              {candidate.name}
            </h1>

            <div className="mt-2 flex items-center gap-2 flex-wrap">
              {candidate.party && (
                <span
                  style={{
                    fontSize: 13,
                    fontWeight: 500,
                    color: 'var(--civic-text-secondary)',
                  }}
                >
                  {candidate.party}
                </span>
              )}
              <CoverageTier tier={candidate.coverageTier} />
              {/* Freshness signal — only when the provider actually supplied a
                  dated source (honest-degrade: no chip when we can't date it). */}
              {prov.freshnessMonths !== null && (
                <FreshnessChip months={prov.freshnessMonths} small />
              )}
              {/* Beta · AI marker — shown only when this candidate carries at
                  least one AI-inferred stance (candidate-frames: inferred block). */}
              {prov.hasInferred && <BetaChip small />}
            </div>

            {candidate.websiteUrl && (
              <a
                href={candidate.websiteUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center text-sm min-h-[44px] mt-2"
                style={{
                  color: 'var(--civic-primary)',
                  textDecoration: 'underline',
                  textUnderlineOffset: 2,
                }}
              >
                Campaign website ↗
              </a>
            )}
          </div>
        </div>

        {candidate.bio && (
          <p
            style={{
              marginTop: 16,
              paddingTop: 16,
              borderTop: '1px solid var(--civic-border)',
              fontSize: 14,
              lineHeight: 1.6,
              color: 'var(--civic-text-secondary)',
            }}
          >
            {candidate.bio}
          </p>
        )}

        {/* Provenance strip — "N sources · M self-stated" (candidate-frames
            "4 sources · self-stated"). Only shown when we have positions; the
            low-coverage empty state below handles the thin case honestly. */}
        {candidate.stances.length > 0 && (
          <div
            className="civic-mono"
            style={{
              marginTop: 14,
              paddingTop: 14,
              borderTop: '1px solid var(--civic-border)',
              fontSize: 11,
              color: 'var(--civic-text-muted)',
              display: 'flex',
              gap: 12,
              flexWrap: 'wrap',
            }}
          >
            <span>
              {prov.sourceCount} source{prov.sourceCount === 1 ? '' : 's'}
            </span>
            {prov.statedCount > 0 && <span>· {prov.statedCount} self-stated</span>}
            {prov.hasInferred && <span>· some positions inferred</span>}
          </div>
        )}
      </header>

      {/* Honest low-coverage state (candidate-frames VoterLowCoverage): when we
          have too little on this candidate, say what we DO have and never fake
          a score. Preserved from the display-gate's Tier-C signal. */}
      {lowCoverage && (
        <Caveat kind="info">
          We&rsquo;re still gathering {candidate.name.split(' ')[0]}&rsquo;s
          positions. What&rsquo;s shown below is everything we can verify so far —
          we don&rsquo;t guess to fill the gaps. Check back as coverage improves.
        </Caveat>
      )}

      {/* Match breakdown — computed on the client from the on-device profile. */}
      <GuideCandidateClient race={race} candidate={candidate} />
    </div>
  );
}
