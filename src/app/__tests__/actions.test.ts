/**
 * Server-action tests for src/app/actions.ts.
 *
 * The actions touch a lot of infra (Supabase client, geocoder, sessions,
 * Inngest, next/navigation redirect). We mock all of those so the test
 * exercises the action's *control flow* — not the dependencies.
 *
 * Specific blast-radius checks:
 *   - SPI consent gate must reject quick-match + feedback writes when the
 *     user has not opted in (Legal Lens #4).
 *   - The lookupBallotAction catch block must not swallow Next's redirect()
 *     pseudo-throw (NEXT_REDIRECT).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { User } from '@/types/database';

// ---------------------------------------------------------------------------
// Mocks — declared BEFORE the SUT import so vi.mock() hoists them properly.
// ---------------------------------------------------------------------------

// next/navigation.redirect throws a special error tagged NEXT_REDIRECT. We
// reproduce that contract so we can assert the action attempted a redirect.
class MockRedirectError extends Error {
  digest = 'NEXT_REDIRECT;replace;/ballot;307;';
  constructor(public readonly path: string) {
    super(`NEXT_REDIRECT: ${path}`);
  }
}

vi.mock('next/navigation', () => ({
  redirect: vi.fn((path: string) => {
    throw new MockRedirectError(path);
  }),
}));

// Geocoder
const mockGeocodeAddress = vi.fn();
const mockLookupPrecinct = vi.fn();
vi.mock('@/lib/ballot-lookup', () => ({
  geocodeAddress: (addr: string) => mockGeocodeAddress(addr),
  lookupPrecinct: (lat: number, lng: number, sb: unknown) =>
    mockLookupPrecinct(lat, lng, sb),
}));

// District-based fallback (state-generic path). Default: no coverage.
const mockResolveDistrictBallot = vi.fn().mockResolvedValue({
  electionIds: [],
  stateFips: null,
  districts: [],
});
vi.mock('@/lib/ballot-lookup/district-lookup', () => ({
  resolveDistrictBallotElectionIds: (
    lat: number,
    lng: number,
    sb: unknown,
  ) => mockResolveDistrictBallot(lat, lng, sb),
}));

// Ballot loader — the session→race-id resolver + the session→ballot loader.
// lookupBallotAction uses resolveSessionRaceIds to derive the precinct-path
// race set, then hasUpcomingRace(...) checks the upcoming subset (the
// silent-empty-guide fix under test). Default here: resolve a race id so the
// happy-path tests reach the redirect; the v_voter_races mock below supplies the
// upcoming row. No-coverage tests override to [].
const mockResolveSessionRaceIds = vi.fn().mockResolvedValue(['race-1']);
const mockLoadBallotForSession = vi.fn().mockResolvedValue(null);
vi.mock('@/lib/ballot-lookup/ballot-loader', () => ({
  resolveSessionRaceIds: (user: unknown) => mockResolveSessionRaceIds(user),
  loadBallotForSession: (user: unknown) => mockLoadBallotForSession(user),
}));

// Shared candidate/position resolver. Mocked so the action's control flow is
// exercised without a live DB. Default: an empty ballot.
const mockResolveMatchCandidates = vi.fn().mockResolvedValue({
  candidates: [],
  raceToElectionId: new Map(),
  officeDimsByRace: new Map(),
  legacyRaceIds: [],
  legacyCandidateIds: [],
});
vi.mock('@/lib/matching/resolve-match-candidates', () => ({
  resolveMatchCandidates: (sb: unknown, ids: string[]) =>
    mockResolveMatchCandidates(sb, ids),
}));

// Snapshot writer — no-op in tests.
const mockSaveMatchSnapshot = vi.fn().mockResolvedValue(undefined);
vi.mock('@/app/api/match/snapshot', () => ({
  saveMatchSnapshot: (...args: unknown[]) => mockSaveMatchSnapshot(...args),
}));

// Session helpers
const mockGetOrCreateSession = vi.fn();
const mockGetSessionUser = vi.fn();
const mockSetSessionCookie = vi.fn();
vi.mock('@/lib/session', () => ({
  getOrCreateSession: () => mockGetOrCreateSession(),
  getSessionUser: () => mockGetSessionUser(),
  setSessionCookie: (token: string) => mockSetSessionCookie(token),
}));

// Inngest
const mockInngestSend = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/inngest/client', () => ({
  inngest: { send: (...args: unknown[]) => mockInngestSend(...args) },
}));

// Supabase server client — return a chainable mock builder.
type ChainStep = { table: string; method: string; args: unknown[] };
const supabaseChainCalls: ChainStep[] = [];

// hasUpcomingRace() queries v_voter_races via the SERVICE client. Default: one
// upcoming row (happy path). The precinct-with-no-upcoming test overrides this
// to [] to exercise the new coverage gate.
let voterRacesResult: { data: unknown; error: unknown } = {
  data: [{ id: 'race-1' }],
  error: null,
};

function makeSupabaseMock() {
  function makeBuilder(table: string): unknown {
    const builder: Record<string, unknown> = {};
    const chainable = [
      'select', 'eq', 'in', 'is', 'update', 'insert', 'delete', 'upsert',
      'gte', 'lte', 'order', 'limit',
    ];
    for (const m of chainable) {
      builder[m] = (...args: unknown[]) => {
        supabaseChainCalls.push({ table, method: m, args });
        return builder;
      };
    }
    builder.single = vi.fn().mockResolvedValue({
      data: { race_ids: ['race-1'] },
      error: null,
    });
    // Make the builder thenable so `await supabase.from('x').update(...).eq(...)`
    // resolves cleanly. sub_dimensions needs a non-null array; v_voter_races
    // returns the controllable coverage result; everything else resolves benign.
    (builder as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
      resolve(
        table === 'sub_dimensions'
          ? { data: [], error: null }
          : table === 'v_voter_races'
            ? voterRacesResult
            : { data: null, error: null },
      );
    return builder;
  }

  return {
    from: vi.fn((table: string) => makeBuilder(table)),
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  };
}

let supabaseMock: ReturnType<typeof makeSupabaseMock>;

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(supabaseMock),
  createServiceClient: () => Promise.resolve(supabaseMock),
}));

// Matching algorithm — keep the real one (it's pure), but guarantee we have
// no race-coupling surprises by returning a minimal valid shape on no input.
// The real module is fine to keep imported; nothing to mock here.

// ---------------------------------------------------------------------------
// SUT import (after mocks)
// ---------------------------------------------------------------------------

let actions: typeof import('../actions');

beforeEach(async () => {
  vi.clearAllMocks();
  supabaseChainCalls.length = 0;
  supabaseMock = makeSupabaseMock();
  // Reset coverage default (one upcoming race) + resolver default (one id).
  voterRacesResult = { data: [{ id: 'race-1' }], error: null };
  mockResolveSessionRaceIds.mockResolvedValue(['race-1']);
  vi.resetModules();
  actions = await import('../actions');
});

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'u-1',
    session_token: 't-1',
    address_text: null,
    precinct_id: null,
    quick_match_answers: null,
    weights: null,
    email: null,
    spi_consent_at: null,
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeFormData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

// ===========================================================================
// lookupBallotAction
// ===========================================================================

describe('lookupBallotAction', () => {
  it('returns {error} when address is blank', async () => {
    const r = await actions.lookupBallotAction(makeFormData({ address: '   ' }));
    expect(r).toEqual({ error: 'Please enter your address.' });
    expect(mockGeocodeAddress).not.toHaveBeenCalled();
  });

  it('returns {error} when address is missing entirely', async () => {
    const r = await actions.lookupBallotAction(new FormData());
    expect(r).toEqual({ error: 'Please enter your address.' });
  });

  it('returns {error} when geocoder returns null', async () => {
    mockGeocodeAddress.mockResolvedValueOnce(null);
    const r = await actions.lookupBallotAction(makeFormData({ address: '123 Main' }));
    expect(r).toMatchObject({ error: expect.stringContaining('Could not find that address') });
  });

  it('returns territory error structure when geocoder reports territory', async () => {
    mockGeocodeAddress.mockResolvedValueOnce({
      error: 'territory_address_unsupported',
      state_fips: '72',
      abbr: 'PR',
    });
    const r = await actions.lookupBallotAction(
      makeFormData({ address: 'Calle 1, San Juan PR 00901' }),
    );
    expect(r).toMatchObject({ territory: 'PR', state_fips: '72' });
    expect((r as { error: string }).error).toContain('Territory');
  });

  it('returns honest no_coverage when neither precinct nor district coverage exists', async () => {
    mockGeocodeAddress.mockResolvedValueOnce({ lat: 41, lng: -111 });
    mockLookupPrecinct.mockResolvedValueOnce(null);
    // district fallback default mock: no coverage
    const r = await actions.lookupBallotAction(
      makeFormData({ address: '123 Main, Salt Lake City, UT' }),
    );
    expect(r).toMatchObject({
      error: expect.stringContaining("don't have"),
      no_coverage: true,
    });
  });

  it('returns no_coverage when a precinct exists but has NO upcoming races', async () => {
    // The silent-empty-guide bug: a precinct resolves, but every one of its
    // races is in the past (v_voter_races election_date < today), so the guide
    // would render empty. The action must catch this and surface no_coverage
    // instead of redirecting. resolveSessionRaceIds returns ids, but the
    // v_voter_races upcoming check returns NO rows.
    mockGeocodeAddress.mockResolvedValueOnce({ lat: 41.18, lng: -112.0 });
    mockLookupPrecinct.mockResolvedValueOnce({
      id: 'p-utah',
      race_ids: ['race-1'],
      district_info: {},
    });
    mockResolveSessionRaceIds.mockResolvedValueOnce(['race-1', 'race-2']);
    voterRacesResult = { data: [], error: null }; // none upcoming

    const r = await actions.lookupBallotAction(
      makeFormData({ address: '123 Example St, Sampleton, UT 84000' }),
    );
    expect(r).toMatchObject({
      error: expect.stringContaining('upcoming races'),
      no_coverage: true,
    });
  });

  it('does NOT write address_text on the happy path (privacy)', async () => {
    mockGeocodeAddress.mockResolvedValueOnce({ lat: 41, lng: -111 });
    mockLookupPrecinct.mockResolvedValueOnce({
      id: 'p-1',
      race_ids: ['race-1'],
      district_info: {},
    });
    mockGetOrCreateSession.mockResolvedValueOnce({
      user: makeUser(),
      token: 't-1',
      isNew: false,
    });

    await expect(
      actions.lookupBallotAction(makeFormData({ address: '123 Main' })),
    ).rejects.toThrow(/NEXT_REDIRECT/);

    // No users.update call may carry address_text.
    const wroteAddress = supabaseChainCalls.some(
      (c) =>
        c.table === 'users' &&
        c.method === 'update' &&
        typeof c.args[0] === 'object' &&
        c.args[0] !== null &&
        'address_text' in (c.args[0] as Record<string, unknown>),
    );
    expect(wroteAddress).toBe(false);
  });

  it('happy path: lets Next redirect propagate (NEXT_REDIRECT not swallowed)', async () => {
    mockGeocodeAddress.mockResolvedValueOnce({ lat: 41, lng: -111 });
    mockLookupPrecinct.mockResolvedValueOnce({
      id: 'p-1',
      race_ids: [],
      district_info: {},
    });
    mockGetOrCreateSession.mockResolvedValueOnce({
      user: makeUser(),
      token: 't-1',
      isNew: true,
    });

    // Action should THROW the NEXT_REDIRECT error (not return an error).
    // If the catch block swallows it, this test fails — exactly the
    // regression we want to lock in.
    await expect(
      actions.lookupBallotAction(makeFormData({ address: '123 Main' })),
    ).rejects.toThrow(/NEXT_REDIRECT/);
  });

  it('happy path with existing session does not call setSessionCookie', async () => {
    mockGeocodeAddress.mockResolvedValueOnce({ lat: 41, lng: -111 });
    mockLookupPrecinct.mockResolvedValueOnce({
      id: 'p-1',
      race_ids: [],
      district_info: {},
    });
    mockGetOrCreateSession.mockResolvedValueOnce({
      user: makeUser(),
      token: 't-1',
      isNew: false, // existing session
    });

    await expect(
      actions.lookupBallotAction(makeFormData({ address: '123 Main' })),
    ).rejects.toThrow(/NEXT_REDIRECT/);
    expect(mockSetSessionCookie).not.toHaveBeenCalled();
  });

  // A1 canonical swap: the success redirect target depends on whether the live
  // guide provider is ready. isGuideProviderReady() reads
  // NEXT_PUBLIC_GUIDE_PROVIDER at call time; the beforeEach resetModules +
  // re-import means each test sees the env as set here. The MockRedirectError
  // captures the path so we can assert the exact target (not just NEXT_REDIRECT).
  it('redirects to /ballot when the guide provider is NOT live (default)', async () => {
    const prev = process.env.NEXT_PUBLIC_GUIDE_PROVIDER;
    delete process.env.NEXT_PUBLIC_GUIDE_PROVIDER;
    vi.resetModules();
    actions = await import('../actions');

    mockGeocodeAddress.mockResolvedValueOnce({ lat: 41, lng: -111 });
    mockLookupPrecinct.mockResolvedValueOnce({ id: 'p-1', race_ids: [], district_info: {} });
    mockGetOrCreateSession.mockResolvedValueOnce({ user: makeUser(), token: 't-1', isNew: false });

    await expect(
      actions.lookupBallotAction(makeFormData({ address: '123 Main' })),
    ).rejects.toMatchObject({ path: '/ballot' });

    if (prev === undefined) delete process.env.NEXT_PUBLIC_GUIDE_PROVIDER;
    else process.env.NEXT_PUBLIC_GUIDE_PROVIDER = prev;
  });

  it('redirects to /guide when the guide provider IS live (canonical path)', async () => {
    const prev = process.env.NEXT_PUBLIC_GUIDE_PROVIDER;
    process.env.NEXT_PUBLIC_GUIDE_PROVIDER = 'live';
    vi.resetModules();
    actions = await import('../actions');

    mockGeocodeAddress.mockResolvedValueOnce({ lat: 41, lng: -111 });
    mockLookupPrecinct.mockResolvedValueOnce({ id: 'p-1', race_ids: [], district_info: {} });
    mockGetOrCreateSession.mockResolvedValueOnce({ user: makeUser(), token: 't-1', isNew: false });

    await expect(
      actions.lookupBallotAction(makeFormData({ address: '123 Main' })),
    ).rejects.toMatchObject({ path: '/guide' });

    if (prev === undefined) delete process.env.NEXT_PUBLIC_GUIDE_PROVIDER;
    else process.env.NEXT_PUBLIC_GUIDE_PROVIDER = prev;
  });
});

// ===========================================================================
// submitQuickMatchAction
// ===========================================================================

describe('submitQuickMatchAction', () => {
  // WORK-ORDER 1B: submitQuickMatchAction no longer persists opinions or
  // computes matches server-side. Opinions live only on the device now; the
  // client writes to IndexedDB and scores via /api/positions-bundle. This action
  // is retained ONLY so any server-action caller does not break: it guards the
  // session + the SPI-consent legal gate, then returns { success: true } WITHOUT
  // touching the DB, the resolvers, or the snapshot table. These tests were
  // rewritten from the old server-persistence assertions to lock the new no-op
  // behavior (no users.update({quick_match_answers}), no resolveMatchCandidates,
  // no saveMatchSnapshot).
  const baseAnswers = {
    domains: ['economy', 'social', 'healthcare'] as const,
    positions: [{ sub_dimension_id: 's1', score: 0.5 }],
  };

  it('returns {error} when no session', async () => {
    mockGetSessionUser.mockResolvedValueOnce(null);
    const r = await actions.submitQuickMatchAction({ ...baseAnswers, domains: [...baseAnswers.domains] });
    expect(r).toMatchObject({ error: expect.stringContaining('No active session') });
  });

  it('returns spi_consent_required when user has not opted in', async () => {
    mockGetSessionUser.mockResolvedValueOnce(makeUser({ spi_consent_at: null }));
    const r = await actions.submitQuickMatchAction({ ...baseAnswers, domains: [...baseAnswers.domains] });
    expect(r).toEqual({ error: 'spi_consent_required' });
  });

  it('is a no-op that succeeds without persisting opinions or computing matches', async () => {
    mockGetSessionUser.mockResolvedValueOnce(
      makeUser({ spi_consent_at: '2026-01-01T00:00:00Z', precinct_id: null }),
    );

    const r = await actions.submitQuickMatchAction({
      ...baseAnswers,
      domains: [...baseAnswers.domains],
    });

    // Succeeds as a thin no-op.
    expect(r).toEqual({ success: true });

    // No server-side opinion write path is exercised.
    expect(mockResolveSessionRaceIds).not.toHaveBeenCalled();
    expect(mockResolveMatchCandidates).not.toHaveBeenCalled();
    expect(mockSaveMatchSnapshot).not.toHaveBeenCalled();
    const wroteAnswers = supabaseChainCalls.some(
      (c) =>
        c.table === 'users' &&
        c.method === 'update' &&
        typeof c.args[0] === 'object' &&
        c.args[0] !== null &&
        'quick_match_answers' in (c.args[0] as Record<string, unknown>),
    );
    expect(wroteAnswers).toBe(false);
  });
});

// ===========================================================================
// submitFeedbackAction
// ===========================================================================

describe('submitFeedbackAction', () => {
  it('returns {error} when no session', async () => {
    mockGetSessionUser.mockResolvedValueOnce(null);
    const r = await actions.submitFeedbackAction({
      did_vote: true,
      changed_vote: 'yes',
    });
    expect(r).toEqual({ error: 'No active session.' });
  });

  it('returns spi_consent_required when did_vote provided without consent', async () => {
    mockGetSessionUser.mockResolvedValueOnce(makeUser({ spi_consent_at: null }));
    const r = await actions.submitFeedbackAction({
      did_vote: true,
      changed_vote: 'yes',
      races_changed: 2,
    });
    expect(r).toEqual({ error: 'spi_consent_required' });
  });

  it('returns spi_consent_required even when did_vote is false (consent still required)', async () => {
    mockGetSessionUser.mockResolvedValueOnce(makeUser({ spi_consent_at: null }));
    const r = await actions.submitFeedbackAction({
      did_vote: false,
      changed_vote: 'no',
    });
    expect(r).toEqual({ error: 'spi_consent_required' });
  });
});

// ===========================================================================
// submitCorrectionAction
// ===========================================================================

describe('submitCorrectionAction', () => {
  it('rejects missing required fields', async () => {
    const r = await actions.submitCorrectionAction({
      candidate_id: '',
      position_id: 'p',
      submitted_by: 'me',
    });
    expect(r).toMatchObject({ error: expect.stringContaining('Missing required fields') });
  });

  it('rejects when position_id missing', async () => {
    const r = await actions.submitCorrectionAction({
      candidate_id: 'c',
      position_id: '',
      submitted_by: 'me',
    });
    expect(r).toMatchObject({ error: expect.stringContaining('Missing required fields') });
  });
});

// ===========================================================================
// submitEmailOptinAction
// ===========================================================================

describe('submitEmailOptinAction', () => {
  it('rejects malformed email', async () => {
    const r = await actions.submitEmailOptinAction('not-an-email');
    expect(r).toMatchObject({ error: expect.stringContaining('valid email') });
  });

  it('rejects empty email', async () => {
    const r = await actions.submitEmailOptinAction('');
    expect(r).toMatchObject({ error: expect.stringContaining('valid email') });
  });
});
