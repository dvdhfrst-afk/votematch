/**
 * Unit tests for the LIVE guide provider (src/lib/guide/live-provider.ts).
 *
 * We mock the SUPABASE CLIENT + ballot loader + session (not the DB), so the
 * test exercises the ADAPTER: how DB rows (ballot races, sub_dimensions,
 * positions) become the guide contract (Race / Candidate / MatchBreakdown /
 * BallotPlan), and the honest-degrade behavior the DEFINITION-OF-WORKING
 * demands (no fabrication, insufficient-overlap surfaces as a non-trustworthy
 * state, thin candidates get the low-coverage tier, no voter profile falls back
 * to empty states).
 *
 * Mocks are declared BEFORE the SUT import so vi.mock() hoists correctly.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SubDimension, Position, User } from '@/types/database';
import type { BallotRace, BallotCandidate } from '@/lib/ballot-lookup/ballot-loader';

// --- next/cache: pass-through so unstable_cache doesn't fight the test ---
vi.mock('next/cache', () => ({
  unstable_cache: (fn: (...a: unknown[]) => unknown) => fn,
}));

// --- server-only: no-op in the test runtime ---
vi.mock('server-only', () => ({}));

// --- session ---
const mockGetSessionUser = vi.fn();
vi.mock('@/lib/session', () => ({
  getSessionUser: () => mockGetSessionUser(),
}));

// --- ballot loader (address→BallotRace[]). We drive races per test. ---
const mockLoadBallotForSession = vi.fn();
vi.mock('@/lib/ballot-lookup/ballot-loader', async (orig) => {
  // Keep the real type exports; only stub the loader function.
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    loadBallotForSession: (...a: unknown[]) => mockLoadBallotForSession(...a),
  };
});

// --- supabase service client. .from(table) returns rows we control. ---
const dbTables: Record<string, unknown[]> = {
  sub_dimensions: [],
  positions: [],
};

function makeQuery(table: string) {
  // A minimal thenable query builder: select().in()/.eq() all return `this`,
  // and awaiting resolves to { data }. We ignore the filters — the test
  // controls the row sets directly per table.
  const rows = () => dbTables[table] ?? [];
  const q: Record<string, unknown> = {
    select: () => q,
    in: () => q,
    eq: () => q,
    then: (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
      resolve({ data: rows(), error: null }),
  };
  return q;
}

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: async () => ({
    from: (table: string) => makeQuery(table),
  }),
}));

// SUT imported AFTER mocks.
import { liveProvider } from '@/lib/guide/live-provider';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SUB_DIMS: SubDimension[] = [
  mkDim('sd_tax', 'Tax policy', 'economy'),
  mkDim('sd_wage', 'Minimum wage', 'economy'),
  mkDim('sd_health', 'Healthcare access', 'healthcare'),
  mkDim('sd_climate', 'Climate action', 'environment'),
  mkDim('sd_lands', 'Public lands', 'environment'),
  mkDim('sd_immig', 'Immigration', 'social'),
];

function mkDim(id: string, name: string, domain: SubDimension['domain']): SubDimension {
  return {
    id,
    name,
    domain,
    spectrum_low: `${name} low`,
    spectrum_high: `${name} high`,
    display_order: 0,
    // Everything counts at federal so the scope map is exercised.
    scope_applicability: {
      federal: 'matching',
      state: 'matching',
      county: 'informational',
    },
  };
}

function mkPosition(overrides: Partial<Position> & { candidate_id: string; sub_dimension_id: string }): Position {
  return {
    id: `pos_${Math.random().toString(36).slice(2)}`,
    view_type: 'inferred',
    score: 0.5,
    confidence: 'high',
    source_citations: [{ url: 'https://example.org/s', title: 'Src' }],
    nuance_notes: null,
    ai_summary: 'A summary.',
    extraction_audit_id: null,
    created_at: '2026-06-01T00:00:00Z',
    ...overrides,
  } as Position;
}

function mkBallotCandidate(over: Partial<BallotCandidate> & { id: string; name: string }): BallotCandidate {
  return {
    id: over.id,
    name: over.name,
    party: over.party ?? 'Independent',
    race_id: over.race_id ?? 'race_1',
    bio: over.bio ?? null,
    photo_url: over.photo_url ?? null,
    website_url: over.website_url ?? null,
    questionnaire_status: 'not_invited',
    published: true,
    created_at: '',
    updated_at: '',
    selfAttested: over.selfAttested ?? false,
    wellDocumented: over.wellDocumented ?? false,
    positionLookupId: over.positionLookupId ?? over.id,
    personId: over.personId ?? null,
  };
}

function mkBallotRace(over: Partial<BallotRace> & { id: string; candidates: BallotCandidate[] }): BallotRace {
  return {
    id: over.id,
    name: over.name ?? 'US Senate',
    level: over.level ?? 'federal',
    district: over.district ?? null,
    election_date: over.election_date ?? '2026-11-03',
    type: 'general',
    candidates: over.candidates,
    daysUntilElection: 120,
    election_type: 'general',
    state_fips: '04',
  };
}

const VOTER_USER: User = {
  id: 'u1',
  session_token: 'tok-1',
  address_text: '123 Main St, Gilbert AZ 85296',
  precinct_id: null,
  quick_match_answers: {
    domains: ['environment', 'healthcare', 'economy'],
    positions: [
      { sub_dimension_id: 'sd_tax', score: 0.6 },
      { sub_dimension_id: 'sd_wage', score: 0.7 },
      { sub_dimension_id: 'sd_health', score: 0.8 },
      { sub_dimension_id: 'sd_climate', score: 0.9 },
      { sub_dimension_id: 'sd_lands', score: 0.85 },
      { sub_dimension_id: 'sd_immig', score: 0.55 },
    ],
    match_view: 'inferred',
  },
  weights: null,
  email: null,
  spi_consent_at: '2026-06-01T00:00:00Z',
  created_at: '2026-06-01T00:00:00Z',
};

// A candidate who agrees with the voter across all six issues (renderable,
// high confidence) → a real, high match.
const AGREER = mkBallotCandidate({ id: 'c_agree', name: 'Alex Rivera', wellDocumented: true });
const AGREER_POS: Position[] = SUB_DIMS.map((sd) =>
  mkPosition({
    candidate_id: 'c_agree',
    sub_dimension_id: sd.id,
    score: 0.85,
    confidence: 'high',
    view_type: 'inferred',
  }),
);

// A candidate with only ONE renderable position → below MIN_OVERLAP_FOR_SCORE.
const THIN = mkBallotCandidate({ id: 'c_thin', name: 'Sam Thin' });
const THIN_POS: Position[] = [
  mkPosition({ candidate_id: 'c_thin', sub_dimension_id: 'sd_tax', score: 0.5, confidence: 'high' }),
];

// A candidate with ZERO positions → empty-state / gathering.
const EMPTY = mkBallotCandidate({ id: 'c_empty', name: 'Pat Empty' });

// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  dbTables.sub_dimensions = SUB_DIMS;
  dbTables.positions = [];
  mockGetSessionUser.mockResolvedValue(VOTER_USER);
  mockLoadBallotForSession.mockResolvedValue({
    races: [],
    quality: new Map(),
    bridgeStats: { legacy: 0, newGraph: 0 },
  });
});

describe('live guide provider — race + candidate adaptation', () => {
  it('adapts ballot races into contract races with formatted candidates', async () => {
    mockLoadBallotForSession.mockResolvedValue({
      races: [mkBallotRace({ id: 'race_1', name: 'US Senate', candidates: [AGREER] })],
      quality: new Map(),
      bridgeStats: { legacy: 0, newGraph: 1 },
    });
    dbTables.positions = AGREER_POS;

    const races = await liveProvider.listRaces();
    expect(races).toHaveLength(1);
    expect(races[0].id).toBe('race_1');
    expect(races[0].officeLevel).toBe('federal');
    expect(races[0].candidates[0].id).toBe('c_agree');
    // Six renderable high-confidence positions → coverage tier A (wellDocumented).
    expect(races[0].candidates[0].coverageTier).toBe('A');
    expect(races[0].candidates[0].stances).toHaveLength(6);
  });

  it('maps office-graph school/special levels to guide school_board/special_district', async () => {
    mockLoadBallotForSession.mockResolvedValue({
      races: [
        mkBallotRace({ id: 'r_school', name: 'School Board', level: 'school', candidates: [EMPTY] }),
      ],
      quality: new Map(),
      bridgeStats: { legacy: 0, newGraph: 1 },
    });
    const races = await liveProvider.listRaces();
    expect(races[0].officeLevel).toBe('school_board');
  });
});

describe('live guide provider — scoring on real overlap', () => {
  beforeEach(() => {
    mockLoadBallotForSession.mockResolvedValue({
      races: [mkBallotRace({ id: 'race_1', candidates: [AGREER] })],
      quality: new Map(),
      bridgeStats: { legacy: 0, newGraph: 1 },
    });
    dbTables.positions = AGREER_POS;
  });

  it('produces a real high match for an aligned, well-covered candidate', async () => {
    const match = await liveProvider.getMatch('race_1', 'c_agree');
    expect(match).not.toBeNull();
    expect(match!.overallScore).toBeGreaterThan(70);
    expect(match!.countedIssuesCount).toBeGreaterThanOrEqual(MIN_OVERLAP);
    expect(match!.confidence).not.toBe('no_data');
    // Drill-down populated.
    expect(match!.byDomain.length).toBeGreaterThan(0);
    expect(match!.byIssue.length).toBeGreaterThan(0);
  });

  it('never imputes: an issue with no candidate position has a null candidateScore', async () => {
    // Drop one issue's position so it becomes a gap.
    dbTables.positions = AGREER_POS.filter((p) => p.sub_dimension_id !== 'sd_immig');
    const match = await liveProvider.getMatch('race_1', 'c_agree');
    const immig = match!.byIssue.find((i) => i.issueId === 'sd_immig');
    expect(immig).toBeDefined();
    expect(immig!.candidateScore).toBeNull();
    expect(immig!.delta).toBeNull();
  });
});

describe('live guide provider — honest degradation', () => {
  it('surfaces a below-floor candidate as insufficient (no_data), not a trustworthy number', async () => {
    mockLoadBallotForSession.mockResolvedValue({
      races: [mkBallotRace({ id: 'race_1', candidates: [THIN] })],
      quality: new Map(),
      bridgeStats: { legacy: 0, newGraph: 1 },
    });
    dbTables.positions = THIN_POS;

    const match = await liveProvider.getMatch('race_1', 'c_thin');
    expect(match).not.toBeNull();
    expect(match!.countedIssuesCount).toBeLessThan(MIN_OVERLAP);
    expect(match!.confidence).toBe('no_data');
    expect(match!.notes.some((n) => n.type === 'low_candidate_coverage')).toBe(true);
  });

  it('a candidate with zero renderable positions gets coverage tier C and empty stances', async () => {
    mockLoadBallotForSession.mockResolvedValue({
      races: [mkBallotRace({ id: 'race_1', candidates: [EMPTY] })],
      quality: new Map(),
      bridgeStats: { legacy: 0, newGraph: 1 },
    });
    dbTables.positions = [];

    const cand = await liveProvider.getCandidate('c_empty');
    expect(cand).not.toBeNull();
    expect(cand!.coverageTier).toBe('C');
    expect(cand!.stances).toHaveLength(0);
  });

  it('hides low-confidence (non-self-stated) positions per the display gate', async () => {
    const lowCand = mkBallotCandidate({ id: 'c_low', name: 'Lee Low' });
    mockLoadBallotForSession.mockResolvedValue({
      races: [mkBallotRace({ id: 'race_1', candidates: [lowCand] })],
      quality: new Map(),
      bridgeStats: { legacy: 0, newGraph: 1 },
    });
    dbTables.positions = SUB_DIMS.map((sd) =>
      mkPosition({ candidate_id: 'c_low', sub_dimension_id: sd.id, confidence: 'low' }),
    );
    const cand = await liveProvider.getCandidate('c_low');
    // All low-confidence, none self-stated → gate hides them all.
    expect(cand!.stances).toHaveLength(0);
    expect(cand!.coverageTier).toBe('C');
  });

  it('no voter profile → getVoterProfile null and matches use empty-profile fallback', async () => {
    mockGetSessionUser.mockResolvedValue({ ...VOTER_USER, quick_match_answers: null });
    mockLoadBallotForSession.mockResolvedValue({
      races: [mkBallotRace({ id: 'race_1', candidates: [AGREER] })],
      quality: new Map(),
      bridgeStats: { legacy: 0, newGraph: 1 },
    });
    dbTables.positions = AGREER_POS;

    expect(await liveProvider.getVoterProfile()).toBeNull();
    const match = await liveProvider.getMatch('race_1', 'c_agree');
    // Empty profile → no voter stances overlap → insufficient, not fabricated.
    expect(match!.countedIssuesCount).toBe(0);
    expect(match!.confidence).toBe('no_data');
  });
});

describe('live guide provider — ballot plan', () => {
  it('picks the top scorable candidate per race; undecided when only insufficient candidates exist', async () => {
    mockLoadBallotForSession.mockResolvedValue({
      races: [
        mkBallotRace({ id: 'race_1', name: 'US Senate', candidates: [AGREER, THIN] }),
        mkBallotRace({ id: 'race_2', name: 'Empty Race', candidates: [EMPTY] }),
      ],
      quality: new Map(),
      bridgeStats: { legacy: 0, newGraph: 2 },
    });
    dbTables.positions = [...AGREER_POS, ...THIN_POS];

    const plan = await liveProvider.getBallotPlan();
    expect(plan.picks).toHaveLength(2);
    const senate = plan.picks.find((p) => p.raceId === 'race_1')!;
    expect(senate.candidateId).toBe('c_agree');
    expect(senate.matchScore).toBeGreaterThan(70);
    const emptyRace = plan.picks.find((p) => p.raceId === 'race_2')!;
    expect(emptyRace.candidateId).toBeNull();
    expect(emptyRace.matchScore).toBeNull();
  });
});

// MIN_OVERLAP_FOR_SCORE is 5 (council #29). Kept local to avoid importing the
// server-only algorithm module into the test's mock graph twice.
const MIN_OVERLAP = 5;
