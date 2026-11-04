/**
 * Tests for the LIVE request-path wiring (doc 09 Part 3.4, task #23).
 *
 * These exercise buildAxisWeightsByRace and computeMultivariableMatches against
 * a MOCK supabase client returning seeded-style rows. NO live database: the
 * mock is a chainable query-builder that resolves per-table, so the test runs
 * in the sandbox's stead on a Windows vitest run without any Supabase stack.
 *
 * Run on Windows:  cd app && npm run test:matcher
 * (The cowork Linux sandbox cannot run vitest reliably - Windows-native
 * node_modules + the stale FUSE mount. Authored against the contract and
 * verified by Read/tsc here; a Windows run is required to execute them.)
 *
 * Acronyms, spelled out on first use: UID (unique identifier), DB (database),
 * FIPS (Federal Information Processing Standards), USPS (United States Postal
 * Service).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  buildAxisWeightsByRace,
  computeMultivariableMatches,
  voterSalienceByAxisUid,
} from '@/lib/matching/multivariable-match';
import { computeAxisUid } from '@/lib/positioning/axis-set';
import type {
  CandidateWithPositions,
  Domain,
  SubDimension,
  User,
} from '@/types/database';

// ---------------------------------------------------------------------------
// Seed-style fixtures. Two issues, one in the 'environment' domain (water,
// which a Western Water cluster raises in Utah) and one in 'education'. The
// race office is a school board: it holds 'education' (legislative) but NOT the
// water domain, so the water axis competence-masks to 0 and must be DROPPED.
// ---------------------------------------------------------------------------

const SUBDIM_WATER = '11111111-1111-1111-1111-111111111111';
const SUBDIM_EDU = '22222222-2222-2222-2222-222222222222';
const BACKBONE_EDU = '33333333-3333-3333-3333-333333333333';
const RACE_ID = 'race-school-board';
const ELECTION_ID = 'election-school-board';
const CLUSTER_ID = 'cluster-western-water';

// axis_uids the matcher / loader will vector on.
const UID_WATER_PRIMARY = computeAxisUid(SUBDIM_WATER, 'sub_dimension', null);
const UID_EDU_PRIMARY = computeAxisUid(SUBDIM_EDU, 'sub_dimension', null);
const UID_EDU_BACKBONE = computeAxisUid(SUBDIM_EDU, 'backbone', BACKBONE_EDU);

// sub_dimensions rows (both in scope at the school_board scope for the test).
const SUB_DIMENSIONS: SubDimension[] = [
  {
    id: SUBDIM_WATER,
    domain: 'environment' as Domain,
    name: 'Water policy',
    spectrum_low: 'Conservation',
    spectrum_high: 'Development',
    display_order: 1,
    scope_applicability: { school_board: 'matching' },
    editorial_salience: 0.5,
  },
  {
    id: SUBDIM_EDU,
    domain: 'education' as Domain,
    name: 'Curriculum',
    spectrum_low: 'Local',
    spectrum_high: 'Standardized',
    display_order: 2,
    scope_applicability: { school_board: 'matching' },
    editorial_salience: 0.5,
  },
];

// ---------------------------------------------------------------------------
// Chainable mock supabase client. Each table resolves to a fixed rowset; the
// chain methods (select/in/eq/contains/order/range) return `this`, and the
// builder is thenable so `await` and destructuring `{ data, error }` both work.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

function makeMockSupabase(opts?: {
  // Spy hook: record every table read so a test can assert the loader did/did
  // not run.
  onFrom?: (table: string) => void;
}): SupabaseClient {
  const tableRows: Record<string, Row[]> = {
    sub_dimensions: [
      { id: SUBDIM_WATER, name: 'Water policy', domain: 'environment', spectrum_low: 'Conservation', spectrum_high: 'Development', editorial_salience: 0.5 },
      { id: SUBDIM_EDU, name: 'Curriculum', domain: 'education', spectrum_low: 'Local', spectrum_high: 'Standardized', editorial_salience: 0.5 },
    ],
    // resolveActiveAxisSet: water has only its primary axis; education has a
    // matching-mode backbone axis too.
    issue_backbone_activation: [
      {
        sub_dimension_id: SUBDIM_EDU,
        mode: 'matching',
        backbone_axes: { id: BACKBONE_EDU, code: 'LOC', display_label: 'Local control', pole_low: 'Local', pole_high: 'State' },
      },
    ],
    propositions: [], // no active propositions in the fixture.
    // Competence: water requires the (utilities) domain at legislative; education
    // requires the education domain at legislative.
    axis_authority_map: [
      { axis_kind: 'sub_dimension', axis_id: null, sub_dimension_id: SUBDIM_WATER, required_authority_domain: 'utilities', authority_subdomain: 'water', min_authority_mode: 'legislative' },
      { axis_kind: 'sub_dimension', axis_id: null, sub_dimension_id: SUBDIM_EDU, required_authority_domain: 'education', authority_subdomain: null, min_authority_mode: 'legislative' },
      { axis_kind: 'backbone', axis_id: BACKBONE_EDU, sub_dimension_id: SUBDIM_EDU, required_authority_domain: 'education', authority_subdomain: null, min_authority_mode: 'legislative' },
    ],
    // Office authority + state: a school board holding 'education' (legislative)
    // in Utah (FIPS 49). NOTE no 'utilities' domain -> water masks out.
    elections: [
      {
        id: ELECTION_ID,
        office: {
          policy_authority_domains_v1: ['education'],
          authority_mode: 'legislative',
          governing_body: null,
          jurisdiction: { fips_state: '49' },
        },
      },
    ],
    // Western Water cluster includes UT; raises water salience (but water is
    // dropped by competence anyway, so this only matters if the office held it).
    regional_clusters: [{ id: CLUSTER_ID, member_states: ['UT', 'AZ', 'NV', 'CO', 'NM', 'ID'] }],
    cluster_axis_salience: [
      { cluster_id: CLUSTER_ID, axis_kind: 'sub_dimension', axis_id: null, sub_dimension_id: SUBDIM_WATER, salience_modifier: 0.95 },
    ],
    jurisdiction_axis_salience: [],
  };

  const builder = (table: string) => {
    opts?.onFrom?.(table);
    const rows = tableRows[table] ?? [];
    // The mock must HONOR .eq()/.in()/.is()/.contains() the way real PostgREST
    // does. Without this, resolveActiveAxisSet's
    //   .from('sub_dimensions').eq('id', subDimensionId).maybeSingle()
    // always returned rows[0] (the first sub_dimension), so the SECOND issue
    // resolved to the wrong row and its axes never reached the weight map. We
    // record filters as they are chained and apply them when the query resolves.
    const filters: Array<{ op: 'eq' | 'is' | 'in' | 'contains'; col: string; val: unknown }> = [];
    const apply = (rs: Row[]): Row[] =>
      rs.filter((r) =>
        filters.every((f) => {
          const cell = r[f.col];
          switch (f.op) {
            case 'eq':
            case 'is':
              return cell === f.val;
            case 'in':
              return Array.isArray(f.val) && (f.val as unknown[]).includes(cell);
            case 'contains':
              return (
                Array.isArray(cell) &&
                Array.isArray(f.val) &&
                (f.val as unknown[]).every((v) => (cell as unknown[]).includes(v))
              );
            default:
              return true;
          }
        }),
      );
    const chain: Record<string, unknown> = {};
    const passthrough = () => chain;
    // Non-filtering chain methods just return the builder.
    for (const m of ['select', 'order', 'range', 'not']) {
      chain[m] = vi.fn(passthrough);
    }
    // Filtering chain methods record their predicate, then return the builder.
    for (const op of ['eq', 'is', 'in', 'contains'] as const) {
      chain[op] = vi.fn((col: string, val: unknown) => {
        filters.push({ op, col, val });
        return chain;
      });
    }
    // maybeSingle / single resolve the FIRST row that survives the filters.
    chain.maybeSingle = vi.fn(async () => ({ data: apply(rows)[0] ?? null, error: null }));
    chain.single = vi.fn(async () => ({ data: apply(rows)[0] ?? null, error: null }));
    // Thenable: `await chain` and `const { data } = await chain` both resolve the
    // filtered rowset.
    (chain as { then: unknown }).then = (
      resolve: (v: { data: Row[]; error: null | { message: string } }) => unknown,
    ) => resolve({ data: apply(rows), error: null });
    return chain;
  };

  return { from: vi.fn(builder) } as unknown as SupabaseClient;
}

// ---------------------------------------------------------------------------
// A voter + a single school-board candidate. The candidate's positions are not
// load-bearing for the weight-map shape, so an empty array is fine here.
// ---------------------------------------------------------------------------

const USER: User = {
  id: 'user-1',
  session_token: 'tok',
  address_text: null,
  precinct_id: 'p1',
  quick_match_answers: { domains: ['education', 'environment', 'economy'], positions: [] },
  weights: { education: 0.3, environment: 0.2, economy: 0.1 },
  email: null,
  spi_consent_at: '2026-06-01T00:00:00Z',
  created_at: '2026-06-01T00:00:00Z',
};

const CANDIDATES: CandidateWithPositions[] = [
  {
    id: 'cand-1',
    name: 'Pat Candidate',
    party: null,
    race_id: RACE_ID,
    bio: null,
    photo_url: null,
    website_url: null,
    questionnaire_status: 'not_invited',
    published: true,
    created_at: '',
    updated_at: '',
    positions: [],
    race: {
      id: RACE_ID,
      name: 'School Board District 1',
      level: 'school',
      district: 'District 1',
      election_date: '2026-11-03',
      type: 'general',
      relevant_dimensions: null,
    },
  },
];

const RACE_TO_ELECTION = new Map<string, string>([[RACE_ID, ELECTION_ID]]);

// ---------------------------------------------------------------------------

describe('voterSalienceByAxisUid', () => {
  it('spreads a domain weight equally across that domain axes, keyed by axis_uid', () => {
    // education domain has two axes (primary + backbone), weight 0.3 -> 0.15 each.
    const axesBySubDim = new Map([
      [SUBDIM_EDU, [
        { axis_kind: 'sub_dimension' as const, axis_id: null, sub_dimension_id: SUBDIM_EDU, axis_uid: UID_EDU_PRIMARY },
        { axis_kind: 'backbone' as const, axis_id: BACKBONE_EDU, sub_dimension_id: SUBDIM_EDU, axis_uid: UID_EDU_BACKBONE },
      ]],
    ]);
    const subDimDomain = new Map<string, Domain>([[SUBDIM_EDU, 'education' as Domain]]);
    const out = voterSalienceByAxisUid({ education: 0.3 }, axesBySubDim, subDimDomain);
    expect(out.get(UID_EDU_PRIMARY)).toBeCloseTo(0.15, 10);
    expect(out.get(UID_EDU_BACKBONE)).toBeCloseTo(0.15, 10);
  });

  it('leaves a domain with no voter emphasis OUT of the map (so the loader defaults it to 1)', () => {
    const axesBySubDim = new Map([
      [SUBDIM_WATER, [
        { axis_kind: 'sub_dimension' as const, axis_id: null, sub_dimension_id: SUBDIM_WATER, axis_uid: UID_WATER_PRIMARY },
      ]],
    ]);
    const subDimDomain = new Map<string, Domain>([[SUBDIM_WATER, 'environment' as Domain]]);
    // weights has no 'environment' key -> the water axis is absent from output.
    const out = voterSalienceByAxisUid({ education: 0.3 }, axesBySubDim, subDimDomain);
    expect(out.has(UID_WATER_PRIMARY)).toBe(false);
  });
});

describe('buildAxisWeightsByRace (flag ON)', () => {
  beforeEach(() => {
    process.env.MATCHING_MULTIVARIABLE = 'true';
  });
  afterEach(() => {
    delete process.env.MATCHING_MULTIVARIABLE;
  });

  it('produces a Map keyed by race_id whose inner map keys on axis_uid', async () => {
    const sb = makeMockSupabase();
    const map = await buildAxisWeightsByRace(sb, USER, CANDIDATES, SUB_DIMENSIONS, {
      raceToElectionId: RACE_TO_ELECTION,
    });
    expect(map.has(RACE_ID)).toBe(true);
    const inner = map.get(RACE_ID)!;
    // Inner keys are axis_uids of the surviving (education) axes.
    for (const key of inner.keys()) {
      expect(key).toMatch(/:(sub_dimension|backbone|proposition):/);
    }
  });

  it('DROPS the competence-masked water axis - the school board has no water authority', async () => {
    const sb = makeMockSupabase();
    const map = await buildAxisWeightsByRace(sb, USER, CANDIDATES, SUB_DIMENSIONS, {
      raceToElectionId: RACE_TO_ELECTION,
    });
    const inner = map.get(RACE_ID)!;
    // Water is masked out (office holds 'education', not 'utilities'); only the
    // education axes survive.
    expect(inner.has(UID_WATER_PRIMARY)).toBe(false);
    expect(inner.has(UID_EDU_PRIMARY)).toBe(true);
    expect(inner.has(UID_EDU_BACKBONE)).toBe(true);
    // Surviving weights normalize to sum 1.0.
    const sum = [...inner.values()].reduce((s, w) => s + w, 0);
    expect(sum).toBeCloseTo(1.0, 6);
  });
});

describe('computeMultivariableMatches (OFF path)', () => {
  afterEach(() => {
    delete process.env.MATCHING_MULTIVARIABLE;
  });

  it('does NOT call the weight loader / any DB read when the flag is OFF', async () => {
    delete process.env.MATCHING_MULTIVARIABLE; // OFF (unset).
    const seen: string[] = [];
    const sb = makeMockSupabase({ onFrom: (t) => seen.push(t) });

    const results = await computeMultivariableMatches(
      sb,
      USER,
      CANDIDATES,
      SUB_DIMENSIONS,
      null,
      { raceToElectionId: RACE_TO_ELECTION },
    );

    // OFF path must touch ZERO tables - it skips buildAxisWeightsByRace entirely.
    expect(seen).toEqual([]);
    // It still returns a MatchResult array (from computeMatchesForUser).
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBe(1);
    expect(results[0].race.id).toBe(RACE_ID);
  });

  it('DOES read tables (runs the loader) when the flag is ON', async () => {
    process.env.MATCHING_MULTIVARIABLE = 'true';
    const seen: string[] = [];
    const sb = makeMockSupabase({ onFrom: (t) => seen.push(t) });

    await computeMultivariableMatches(sb, USER, CANDIDATES, SUB_DIMENSIONS, null, {
      raceToElectionId: RACE_TO_ELECTION,
    });

    // ON path resolves axes + office authority + salience: it must have read at
    // least the elections (office authority) and axis_authority_map tables.
    expect(seen).toContain('elections');
    expect(seen).toContain('axis_authority_map');
  });
});
