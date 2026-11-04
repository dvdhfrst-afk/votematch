'use client';

/**
 * Client-side guide scoring (work-order 1B item 2).
 *
 * The guide's SCORING inputs now come from the on-device VoterProfile, never
 * the server. This module:
 *   1. fetches the PUBLIC positions bundle (candidate/position DISPLAY data)
 *      from /api/positions-bundle on the client,
 *   2. reads the device profile via the shared useVoterProfile snapshot,
 *   3. computes, per race, the CANONICAL MatchResult[] (computeMatchesFromBundle
 *      — the parity-proven weighted-L1 matcher) for the headline chip + plan
 *      picks, and
 *   4. builds the guide's per-domain / per-issue MatchBreakdown structure from
 *      the same bundle+profile, with its headline overallScore PINNED to the
 *      canonical score so chips, drill-downs and the plan all show one number.
 *
 * HONEST DEGRADATION (invariant 5): when the device has no profile (quick-match
 * not done) we return hasProfile=false and NO scores. Every guide surface then
 * renders "No match yet - answer a few questions" instead of a fabricated
 * "Top match: X 0%". Insufficient overlap for a scored profile falls out of the
 * canonical matcher as a null score -> the designed insufficient-overlap state.
 *
 * PRIVACY (invariant 1): the ONLY network call here is a GET for the public
 * bundle. No answer/opinion bytes are ever sent. Scoring runs entirely in the
 * browser against IndexedDB state.
 */

import { useEffect, useMemo, useState } from 'react';
import type {
  Candidate as GuideCandidate,
  CandidateStance,
  Issue,
  IssueRelevance,
  MatchBreakdown,
  Race as GuideRace,
  VoterProfile as GuideVoterProfile,
} from '@/lib/guide/contract';
import { buildMatchBreakdown } from '@/lib/guide/scoring';
import type { MatchResult } from '@/types/database';
import { applicabilityAt, raceLevelToScope } from '@/lib/taxonomy/scope';
import type { RaceLevel, ScopeApplicabilityMode } from '@/types/database';
import { useVoterProfile } from './useVoterProfile';
import { computeMatchesFromBundle } from './match-client';
import { POSITIONS_BUNDLE_PATH } from '@/lib/pwa/routes';
import type {
  BundleRace,
  BundleSubDimension,
  PositionsBundle,
} from './bundle';
import type { VoterProfile as DeviceProfile } from './types';

// ---------------------------------------------------------------------------
// Bundle -> guide contract adapters (client-side, display shapes)
// ---------------------------------------------------------------------------

function toOfficeLevel(level: RaceLevel): GuideRace['officeLevel'] {
  if (level === 'school') return 'school_board';
  if (level === 'special') return 'special_district';
  return level as GuideRace['officeLevel'];
}

function toRelevance(mode: ScopeApplicabilityMode): IssueRelevance {
  if (mode === 'matching') return 'counts';
  if (mode === 'informational') return 'context_only';
  return 'not_applicable';
}

function subDimsToIssues(subDims: BundleSubDimension[]): Issue[] {
  return subDims.map((sd) => ({
    id: sd.id,
    name: sd.name,
    domain: sd.domain,
    spectrum: { low: sd.spectrum_low, high: sd.spectrum_high },
  }));
}

/**
 * Per-office relevance map for one office level, keyed by issue (sub_dimension)
 * id. Mirrors the live provider's scopeMapForLevel: strict opt-in default
 * (absent scope key => not_applicable) so an issue only counts where the
 * taxonomy says so. Office-scoped intersection (relevant_dimensions) is applied
 * inside the canonical matcher already; this map governs which issues are
 * VISIBLE + context vs counted in the guide drill-down.
 */
function scopeMapFor(
  subDims: BundleSubDimension[],
  officeLevel: GuideRace['officeLevel'],
): Record<string, IssueRelevance> {
  const level: RaceLevel =
    officeLevel === 'school_board'
      ? 'school'
      : officeLevel === 'special_district'
        ? 'special'
        : (officeLevel as RaceLevel);
  const scope = raceLevelToScope(level);
  const map: Record<string, IssueRelevance> = {};
  for (const sd of subDims) {
    map[sd.id] = toRelevance(
      applicabilityAt({ scope_applicability: sd.scope_applicability }, scope),
    );
  }
  return map;
}

/** Bundle candidate -> guide Candidate with stances (display only). */
function bundleCandidateToGuide(
  race: BundleRace,
  cand: BundleRace['candidates'][number],
): GuideCandidate {
  const stances: CandidateStance[] = cand.positions.map((p) => ({
    candidateId: cand.id,
    issueId: p.sub_dimension_id,
    score: p.score,
    confidence:
      p.confidence === 'high' || p.confidence === 'candidate_direct'
        ? 'high'
        : p.confidence === 'medium'
          ? 'medium'
          : p.confidence === 'low'
            ? 'low'
            : 'no_data',
    summary: null,
    sources: [],
  }));
  return {
    id: cand.id,
    name: cand.name,
    party: cand.party,
    photoUrl: null,
    bio: null,
    websiteUrl: null,
    coverageTier: cand.tier,
    stances,
  };
}

/** Build the device VoterProfile in the GUIDE contract shape for scoring. */
function toGuideVoterProfile(device: DeviceProfile): GuideVoterProfile {
  const stances = Object.values(device.answers).map((a) => ({
    issueId: a.subDimensionId,
    score: a.score,
    confidence: 'high' as const,
    summary: null,
    sources: [],
  }));
  return {
    id: device.localId,
    stances,
    domainWeights: device.emphasis?.domainWeights ?? {},
    source: 'manual',
    updatedAt: device.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Score assembly
// ---------------------------------------------------------------------------

export interface RaceScoreEntry {
  raceId: string;
  /** Guide breakdowns, ranked best-first, insufficient last. */
  breakdowns: MatchBreakdown[];
  /** Canonical top scorable pick for the plan (null candidateId = decide at booth). */
  topCandidateId: string | null;
  topScore: number | null;
}

export interface GuideScores {
  loading: boolean;
  /** True once the device profile has been read (answers present or not). */
  ready: boolean;
  /** True when the voter has answered enough to score (emphasis + >=1 answer). */
  hasProfile: boolean;
  /** Per-race score entry, keyed by raceId. */
  byRace: Map<string, RaceScoreEntry>;
  /** Convenience: ranked breakdowns for one race (empty when no profile). */
  matchesForRace: (raceId: string) => MatchBreakdown[];
  /** Convenience: the breakdown for one candidate in one race, or null. */
  breakdownFor: (raceId: string, candidateId: string) => MatchBreakdown | null;
}

/**
 * Compute all guide scores from a bundle + device profile. Pure; the hook wraps
 * it with fetch + device state. Returns an empty map when there is no scorable
 * profile so callers render the honest "answer questions" state.
 */
export function assembleGuideScores(
  bundle: PositionsBundle,
  device: DeviceProfile | null,
): { hasProfile: boolean; byRace: Map<string, RaceScoreEntry> } {
  const byRace = new Map<string, RaceScoreEntry>();

  const answered = device ? Object.keys(device.answers).length : 0;
  const hasEmphasis = !!device?.emphasis;
  const hasProfile = !!device && answered > 0 && hasEmphasis;
  if (!hasProfile || !device) {
    return { hasProfile: false, byRace };
  }

  // 1. Canonical scores (the number the chips + plan show). Parity-proven.
  const canonical: MatchResult[] = computeMatchesFromBundle(device, bundle);
  const canonScoreByRaceCand = new Map<string, Map<string, number | null>>();
  for (const r of canonical) {
    const m = new Map<string, number | null>();
    for (const c of r.candidates) m.set(c.candidate.id, c.score);
    canonScoreByRaceCand.set(r.race.id, m);
  }

  // 2. Guide-contract drill-down structure, headline PINNED to the canonical
  //    score so every depth shows one number.
  const issues = subDimsToIssues(bundle.subDimensions);
  const guideVoter = toGuideVoterProfile(device);

  for (const br of bundle.races) {
    const officeLevel = toOfficeLevel(br.level);
    const scopeMap = scopeMapFor(bundle.subDimensions, officeLevel);
    const guideRace: GuideRace = {
      id: br.id,
      name: br.name,
      officeLevel,
      district: br.district,
      electionDate: br.election_date,
      candidates: br.candidates.map((c) => bundleCandidateToGuide(br, c)),
    };
    const canonScores = canonScoreByRaceCand.get(br.id) ?? new Map();

    const breakdowns: MatchBreakdown[] = guideRace.candidates.map((gc) => {
      const raw = buildMatchBreakdown({
        voter: guideVoter,
        candidate: gc,
        race: guideRace,
        issues,
        scopeMap,
        raceCandidates: guideRace.candidates,
      });
      const canonScore = canonScores.get(gc.id);
      // Pin the headline to the canonical score. null canonical score =
      // insufficient overlap => force the honest no_data state so the UI shows
      // "not enough overlap yet", never a fabricated percentage.
      if (canonScore === null || canonScore === undefined) {
        return {
          ...raw,
          overallScore: 0,
          confidence: 'no_data',
          notes: [
            {
              type: 'low_candidate_coverage' as const,
              message:
                'Not enough overlapping positions to score this candidate yet. Answer more questions or check back as we gather positions.',
            },
            ...raw.notes.filter((n) => n.type !== 'low_candidate_coverage'),
          ],
        };
      }
      return { ...raw, overallScore: canonScore };
    });

    // Rank: scorable first (desc), insufficient (no_data) last.
    breakdowns.sort((a, b) => {
      const aNo = a.confidence === 'no_data';
      const bNo = b.confidence === 'no_data';
      if (aNo !== bNo) return aNo ? 1 : -1;
      return b.overallScore - a.overallScore;
    });

    const top = breakdowns.find((m) => m.confidence !== 'no_data') ?? null;
    byRace.set(br.id, {
      raceId: br.id,
      breakdowns,
      topCandidateId: top?.candidateId ?? null,
      topScore: top?.overallScore ?? null,
    });
  }

  return { hasProfile: true, byRace };
}

// ---------------------------------------------------------------------------
// Bundle fetch (module cache so multiple guide components share one GET)
// ---------------------------------------------------------------------------

let bundlePromise: Promise<PositionsBundle | null> | null = null;

export function fetchPositionsBundle(): Promise<PositionsBundle | null> {
  if (typeof window === 'undefined') return Promise.resolve(null);
  if (bundlePromise) return bundlePromise;
  bundlePromise = fetch(POSITIONS_BUNDLE_PATH, {
    // Public per-session ballot; the SW (1C) caches it. Same-origin, no body.
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  })
    .then((r) => (r.ok ? (r.json() as Promise<PositionsBundle>) : null))
    .catch(() => null);
  return bundlePromise;
}

/** Test/refresh seam: drop the cached bundle promise. */
export function resetBundleCache(): void {
  bundlePromise = null;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Subscribe a guide client component to device-derived scores. Fetches the
 * public bundle once (shared), reads the device profile, and recomputes
 * breakdowns whenever the profile changes (answer edits re-score live).
 */
export function useGuideScores(): GuideScores {
  const { profile, loading: profileLoading } = useVoterProfile();
  const [bundle, setBundle] = useState<PositionsBundle | null>(null);
  const [bundleLoading, setBundleLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetchPositionsBundle().then((b) => {
      if (cancelled) return;
      setBundle(b);
      setBundleLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const { hasProfile, byRace } = useMemo(() => {
    if (!bundle) return { hasProfile: false, byRace: new Map<string, RaceScoreEntry>() };
    return assembleGuideScores(bundle, profile);
  }, [bundle, profile]);

  const loading = profileLoading || bundleLoading;

  return useMemo<GuideScores>(
    () => ({
      loading,
      ready: !profileLoading,
      hasProfile,
      byRace,
      matchesForRace: (raceId: string) => byRace.get(raceId)?.breakdowns ?? [],
      breakdownFor: (raceId: string, candidateId: string) =>
        byRace.get(raceId)?.breakdowns.find((b) => b.candidateId === candidateId) ??
        null,
    }),
    [loading, profileLoading, hasProfile, byRace],
  );
}
