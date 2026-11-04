/**
 * Provider layer for the UX contract.
 *
 * Today: resolves to a mock provider so the UX can iterate end-to-end
 * without the live DB.
 *
 * Later: a live provider adapts DB types → UX contract types and this
 * module flips behind `NEXT_PUBLIC_GUIDE_PROVIDER=live`. The UI never
 * imports anything below the provider surface.
 */

import type {
  BallotPlan,
  Candidate,
  Issue,
  MatchBreakdown,
  Race,
  VoterProfile,
} from './contract';
import {
  MOCK_ISSUES,
  MOCK_RACES,
  MOCK_VOTER_PROFILE,
  SCOPE_BY_OFFICE,
} from './mock-data';
import { buildMatchBreakdown } from './scoring';

export interface GuideProvider {
  listRaces(): Promise<Race[]>;
  getRace(raceId: string): Promise<Race | null>;
  getCandidate(candidateId: string): Promise<Candidate | null>;
  getVoterProfile(): Promise<VoterProfile | null>;
  getMatch(raceId: string, candidateId: string): Promise<MatchBreakdown | null>;
  listMatchesForRace(raceId: string): Promise<MatchBreakdown[]>;
  getBallotPlan(): Promise<BallotPlan>;
}

// ---------------------------------------------------------------------------
// Mock provider
// ---------------------------------------------------------------------------

const mockProvider: GuideProvider = {
  async listRaces() {
    return MOCK_RACES;
  },

  async getRace(raceId) {
    return MOCK_RACES.find((r) => r.id === raceId) ?? null;
  },

  async getCandidate(candidateId) {
    for (const race of MOCK_RACES) {
      const hit = race.candidates.find((c) => c.id === candidateId);
      if (hit) return hit;
    }
    return null;
  },

  async getVoterProfile() {
    return MOCK_VOTER_PROFILE;
  },

  async getMatch(raceId, candidateId) {
    const race = MOCK_RACES.find((r) => r.id === raceId);
    if (!race) return null;
    const candidate = race.candidates.find((c) => c.id === candidateId);
    if (!candidate) return null;
    const scopeMap = SCOPE_BY_OFFICE[race.officeLevel] ?? {};
    return buildMatchBreakdown({
      voter: MOCK_VOTER_PROFILE,
      candidate,
      race,
      issues: MOCK_ISSUES,
      scopeMap,
      raceCandidates: race.candidates,
    });
  },

  async listMatchesForRace(raceId) {
    const race = MOCK_RACES.find((r) => r.id === raceId);
    if (!race) return [];
    const scopeMap = SCOPE_BY_OFFICE[race.officeLevel] ?? {};
    const breakdowns = race.candidates.map((candidate) =>
      buildMatchBreakdown({
        voter: MOCK_VOTER_PROFILE,
        candidate,
        race,
        issues: MOCK_ISSUES,
        scopeMap,
        raceCandidates: race.candidates,
      }),
    );
    breakdowns.sort((a, b) => b.overallScore - a.overallScore);
    return breakdowns;
  },

  async getBallotPlan() {
    // Default: voter's plan is "the top match in each race", shown as the
    // booth-ready default. Voters can override picks in the UI later.
    const picks = await Promise.all(
      MOCK_RACES.map(async (race) => {
        const matches = await mockProvider.listMatchesForRace(race.id);
        const top = matches[0];
        return {
          raceId: race.id,
          raceName: race.name,
          candidateId: top?.candidateId ?? null,
          candidateName:
            race.candidates.find((c) => c.id === top?.candidateId)?.name ?? null,
          matchScore: top?.overallScore ?? null,
        };
      }),
    );
    return {
      profileId: MOCK_VOTER_PROFILE.id,
      generatedAt: new Date().toISOString(),
      picks,
    };
  },
};

// ---------------------------------------------------------------------------
// Live provider
// ---------------------------------------------------------------------------
// The real DB-backed provider lives in ./live-provider (it imports server-only
// modules — Supabase service client, session, the ballot loader — so it is
// imported lazily inside getGuideProvider() only when mode === 'live', keeping
// those server deps out of any bundle that resolves 'mock' or 'disabled').

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/**
 * Guide provider mode.
 *
 *   - 'live' : the real DB-backed provider (currently a stub that throws).
 *   - 'mock' : invented races/candidates. CONTENT-INTEGRITY HAZARD — fabricated
 *              candidates must never be reachable by a normal user under real
 *              branding. It is gated behind an explicit dev opt-in below.
 *   - 'disabled' : the honest default. The guide feature is not wired to real
 *              data, so guide routes render an "in development" notice and any
 *              nav into /guide/* is hidden.
 *
 * The mock is only served when BOTH:
 *   - NODE_ENV === 'development', AND
 *   - NEXT_PUBLIC_GUIDE_PROVIDER === 'mock' (explicit opt-in)
 * In production, or with the env var unset, mode resolves to 'disabled' even if
 * someone sets NEXT_PUBLIC_GUIDE_PROVIDER=mock — so mock data can never ship.
 */
export type GuideMode = 'live' | 'mock' | 'disabled';

export function getGuideMode(): GuideMode {
  const env = process.env.NEXT_PUBLIC_GUIDE_PROVIDER;
  if (env === 'live') return 'live';
  if (env === 'mock' && process.env.NODE_ENV === 'development') return 'mock';
  return 'disabled';
}

/**
 * True when a provider will actually serve guide pages — i.e. mode is 'live'
 * OR 'mock' (dev opt-in). Guide ROUTES gate on this: when false ('disabled'),
 * they render the honest "in development" notice instead of calling the
 * provider. When true in the 'mock' case, the developer who set the dev flag
 * sees the mock (that's the point of the flag).
 */
export function isGuideRenderable(): boolean {
  return getGuideMode() !== 'disabled';
}

/**
 * True only when the guide is backed by REAL data ('live'). User-facing NAV
 * (the "View Full Ballot" CTA on /results, sticky CTA, etc.) gates on this so
 * a normal user is never routed into fabricated/mock content under real
 * branding. Mock mode is a developer-only surface and must not be linked to.
 */
export function isGuideProviderReady(): boolean {
  return getGuideMode() === 'live';
}

export function getGuideProvider(): GuideProvider {
  const mode = getGuideMode();
  if (mode === 'live') {
    // Lazy require so the live provider's server-only deps (Supabase service
    // client, session, the ballot loader) are only pulled in when live mode is
    // actually selected — never in a mock/disabled build. `require` keeps
    // getGuideProvider() synchronous (its callers are sync). Cast is safe: the
    // module's `liveProvider` satisfies GuideProvider by construction.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { liveProvider } = require('./live-provider') as {
      liveProvider: GuideProvider;
    };
    return liveProvider;
  }
  if (mode === 'mock') return mockProvider;
  // 'disabled' — no provider should be serving pages. Guide routes gate on
  // isGuideRenderable() before ever calling this, so reaching here is a
  // programming error. Throw rather than silently leak mock data.
  throw new Error(
    'Guide provider is disabled. Routes must check isGuideRenderable() ' +
      'before calling getGuideProvider().',
  );
}
