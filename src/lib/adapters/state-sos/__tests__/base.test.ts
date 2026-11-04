/**
 * Unit tests for the state-sos base adapter + resolvers + NIST parser.
 *
 * Self-contained — no DB, no network. Uses node:test (same convention as
 * extractors/__tests__/injection-defense.test.ts) so it runs via:
 *
 *   npx tsx --test src/lib/adapters/state-sos/__tests__/base.test.ts
 *
 * The pg Pool is mocked at the .query() level; we verify the resolvers
 * produce the right (SQL, params) pair and handle ambiguity correctly.
 *
 * Coverage:
 *   1. Candidate resolver: canonical_key match → 1 row → returns candidacy
 *   2. Candidate resolver: canonical_key match → 2 rows → null
 *   3. Party resolver: 'DEM' → national D; 'DFL' → MN state-scoped DFL
 *   4. Party resolver: 'DFL' with state 27 prefers state row over national
 *   5. NIST parser: valid synthetic XML → rows with vote counts + flags
 *   6. NIST parser: malformed XML → throws
 *   7. createStateSosAdapter: integration via runAdapter mock → success run
 *   8. canonicalKey() matches DB trigger transform
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { canonicalKey, createStateSosAdapter } from '../base';
import {
  findOrCreatePerson,
  normalizeOfficeName,
  resolveCandidacy,
} from '../candidate-resolver';
import { resolvePartyId } from '../party-resolver';
import { parseNistXml, parseNistXmlOrThrow } from '../nist-xml-parser';
import { runAdapter } from '../../run';
import type { Pool } from 'pg';
import type { SupabaseClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Mock pg Pool (matches the style in runner.test.ts)
// ---------------------------------------------------------------------------

type QueryHandler = (
  sql: string,
  params: unknown[],
) => { rows: unknown[] } | Promise<{ rows: unknown[] }>;

function makeMockPg(handler: QueryHandler): Pool {
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      const res = await handler(sql, params ?? []);
      return res;
    },
    release: () => undefined,
  };
  return {
    connect: async () => client,
    end: async () => undefined,
    query: async (sql: string, params?: unknown[]) => handler(sql, params ?? []),
  } as unknown as Pool;
}

// ---------------------------------------------------------------------------
// 1 + 2. Candidate resolver
// ---------------------------------------------------------------------------

describe('candidate resolver', () => {
  it('1. canonical_key match with one active candidacy → returns the row', async () => {
    const pg = makeMockPg(async (sql, params) => {
      if (/FROM offices/i.test(sql)) {
        // resolveOfficeElection
        return {
          rows: [
            {
              office_id: 'office-ut-house-d1',
              election_id: 'election-2026-ut-house-d1',
              district_score: 1,
            },
          ],
        };
      }
      if (/FROM candidacies/i.test(sql)) {
        assert.equal(params[0], 'election-2026-ut-house-d1');
        assert.equal(params[1], 'janesmith');
        return {
          rows: [{ candidacy_id: 'cand-123', person_id: 'person-456' }],
        };
      }
      return { rows: [] };
    });

    const result = await resolveCandidacy(pg, {
      reported_name: 'Jane Smith',
      state_fips: '49',
      office_name: 'U.S. House District 1',
      district_identifier: '1',
      election_year: 2026,
    });

    assert.deepEqual(result, {
      candidacy_id: 'cand-123',
      person_id: 'person-456',
    });
  });

  it('2. canonical_key match with two active candidacies → null (ambiguous)', async () => {
    const pg = makeMockPg(async (sql) => {
      if (/FROM offices/i.test(sql)) {
        return {
          rows: [
            {
              office_id: 'office-x',
              election_id: 'election-x',
              district_score: 1,
            },
          ],
        };
      }
      if (/FROM candidacies/i.test(sql)) {
        return {
          rows: [
            { candidacy_id: 'a', person_id: 'p-a' },
            { candidacy_id: 'b', person_id: 'p-b' },
          ],
        };
      }
      return { rows: [] };
    });

    const result = await resolveCandidacy(pg, {
      reported_name: 'John Doe',
      state_fips: '49',
      office_name: 'Governor',
      district_identifier: null,
      election_year: 2026,
    });
    assert.equal(result, null);
  });

  it('returns null when office resolution fails (no office match)', async () => {
    const pg = makeMockPg(async () => ({ rows: [] }));
    const result = await resolveCandidacy(pg, {
      reported_name: 'Jane Smith',
      state_fips: '49',
      office_name: 'Nonsense Office 9000',
      district_identifier: null,
      election_year: 2026,
    });
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------------------
// findOrCreatePerson — cross-state isolation (council 2026-04-25 DE#3)
// ---------------------------------------------------------------------------

describe('findOrCreatePerson — cross-state isolation', () => {
  /**
   * Build a mock pool that simulates a database holding TWO unrelated
   * "John Smith" rows: one with a candidacy in CA (state_fips '06') and
   * one with a candidacy in OH (state_fips '39'). The lookup query
   * scopes by state_fips passed as $2, so each call returns only the
   * matching state's row. New inserts append to a shared store keyed
   * by id.
   */
  function makeTwoStatePool() {
    type Row = {
      id: string;
      state_fips: string; // for test bookkeeping only
      created_at: Date;
    };
    const store: Row[] = [
      {
        id: 'person-john-smith-ca',
        state_fips: '06',
        created_at: new Date('2025-01-01'),
      },
      {
        id: 'person-john-smith-oh',
        state_fips: '39',
        created_at: new Date('2025-02-01'),
      },
    ];
    let nextId = 1;
    const inserts: Array<{ name: string; key: string }> = [];

    const pg = makeMockPg(async (sql, params) => {
      // findOrCreatePerson lookup: returns only rows whose simulated
      // state matches the $2 state_fips parameter.
      if (/FROM people p\b/i.test(sql) && /canonical_key = \$1/i.test(sql)) {
        const targetState = params[1] as string;
        const matches = store
          .filter((r) => r.state_fips === targetState)
          .map((r) => ({
            id: r.id,
            created_at: r.created_at,
            has_candidacy_in_state: true,
            has_tenure_in_state: false,
            latest_candidacy_in_state: new Date('2026-01-01'),
            latest_tenure_in_state: null,
          }));
        return { rows: matches };
      }
      // findOrCreatePerson insert: simulate a new uncollided row.
      if (/INSERT INTO people\b/i.test(sql)) {
        const name = params[0] as string;
        const key = params[1] as string;
        inserts.push({ name, key });
        const id = `person-new-${nextId++}`;
        return { rows: [{ id }] };
      }
      // Fallback canonical_key-only re-read (only hit if INSERT returns no row).
      if (/SELECT id, meta\b/i.test(sql) && /FROM people\b/i.test(sql)) {
        return { rows: [] };
      }
      return { rows: [] };
    });

    return { pg, inserts };
  }

  it('returns DIFFERENT person_ids for the same name in different states', async () => {
    const { pg } = makeTwoStatePool();

    const caPersonId = await findOrCreatePerson(pg, {
      name: 'John Smith',
      state_fips: '06',
    });
    const ohPersonId = await findOrCreatePerson(pg, {
      name: 'John Smith',
      state_fips: '39',
    });

    assert.equal(caPersonId, 'person-john-smith-ca');
    assert.equal(ohPersonId, 'person-john-smith-oh');
    assert.notEqual(
      caPersonId,
      ohPersonId,
      'CA and OH John Smiths must NOT collapse into a single people row',
    );
  });

  it('inserts a fresh row when no in-state match exists', async () => {
    // Pool with no existing rows for any state.
    const pg = makeMockPg(async (sql, params) => {
      if (/FROM people p\b/i.test(sql) && /canonical_key = \$1/i.test(sql)) {
        return { rows: [] };
      }
      if (/INSERT INTO people\b/i.test(sql)) {
        return { rows: [{ id: 'person-fresh-tx' }] };
      }
      return { rows: [] };
    });

    const id = await findOrCreatePerson(pg, {
      name: 'Jane Doe',
      state_fips: '48',
      source: 'sos-texas-candidacies',
    });
    assert.equal(id, 'person-fresh-tx');
  });

  it('rejects a missing or malformed state_fips', async () => {
    const pg = makeMockPg(async () => ({ rows: [] }));
    await assert.rejects(
      () => findOrCreatePerson(pg, { name: 'X', state_fips: '' }),
      /state_fips must be a 2-digit FIPS string/,
    );
    await assert.rejects(
      () => findOrCreatePerson(pg, { name: 'X', state_fips: '6' }),
      /state_fips must be a 2-digit FIPS string/,
    );
  });

  it('rejects an empty canonical_key (name with no alphanumerics)', async () => {
    const pg = makeMockPg(async () => ({ rows: [] }));
    await assert.rejects(
      () => findOrCreatePerson(pg, { name: '   ', state_fips: '49' }),
      /empty canonical_key/,
    );
  });

  it('passes state_fips through to resolveCandidacy SQL as $3', async () => {
    let candidacyParams: unknown[] | null = null;
    const pg = makeMockPg(async (sql, params) => {
      if (/FROM offices/i.test(sql)) {
        return {
          rows: [{ office_id: 'office-x', election_id: 'election-x', district_score: 1 }],
        };
      }
      if (/FROM candidacies/i.test(sql)) {
        candidacyParams = params;
        return { rows: [{ candidacy_id: 'c-1', person_id: 'p-1' }] };
      }
      return { rows: [] };
    });

    await resolveCandidacy(pg, {
      reported_name: 'Alex Reyes',
      state_fips: '06',
      office_name: 'Governor',
      district_identifier: null,
      election_year: 2026,
    });

    assert.ok(candidacyParams, 'candidacy SQL was issued');
    assert.equal(
      candidacyParams[2],
      '06',
      'state_fips should be passed as the third positional arg',
    );
  });
});

// ---------------------------------------------------------------------------
// Office name normalization
// ---------------------------------------------------------------------------

describe('normalizeOfficeName', () => {
  it('expands common abbreviations', () => {
    assert.equal(
      normalizeOfficeName('U.S. HOUSE OF REPRESENTATIVES, DISTRICT 1'),
      'united states house of representatives district 1',
    );
    assert.equal(normalizeOfficeName('Lt. Gov.'), 'lieutenant governor');
    assert.equal(normalizeOfficeName('Atty. Gen.'), 'attorney general');
  });

  it('collapses punctuation and whitespace', () => {
    assert.equal(
      normalizeOfficeName('  Governor  --  Utah  '),
      'governor utah',
    );
  });
});

// ---------------------------------------------------------------------------
// canonicalKey() — must match DB trigger
// ---------------------------------------------------------------------------

describe('canonicalKey', () => {
  it('lowercases and strips all non-alphanumerics', () => {
    assert.equal(canonicalKey('Jane Smith'), 'janesmith');
    assert.equal(canonicalKey('   Alice   Wong   '), 'alicewong');
  });

  it('folds diacritics via NFD before stripping (council #8)', () => {
    // Vázquez and Vazquez collapse to the same key — required for PR +
    // bilingual states where the same person may be reported either way.
    assert.equal(canonicalKey('Vázquez'), 'vazquez');
    assert.equal(canonicalKey('Vazquez'), 'vazquez');
    assert.equal(canonicalKey('Núñez'), 'nunez');
    assert.equal(canonicalKey('Müller'), 'muller');
    assert.equal(canonicalKey("O'Brien-Núñez, Jr."), 'obriennunezjr');
    // Spanish ñ is two NFD codepoints (n + combining tilde); folds to 'n'.
    assert.equal(canonicalKey('PIÑEIRO'), 'pineiro');
  });
});

// ---------------------------------------------------------------------------
// 3 + 4. Party resolver
// ---------------------------------------------------------------------------

describe('party resolver', () => {
  it('3a. "DEM" → national D row', async () => {
    const pg = makeMockPg(async (sql, params) => {
      // national-only lookup order: state_fips='53' (WA) but only national
      // rows exist in this fixture, so scope_rank=1.
      assert.equal(params[0], 'DEM');
      assert.equal(params[1], '53');
      return { rows: [{ id: 'party-national-d' }] };
    });
    const id = await resolvePartyId(pg, 'DEM', '53');
    assert.equal(id, 'party-national-d');
  });

  it('3b. write-in variant resolves via write-in fallback query', async () => {
    const pg = makeMockPg(async (sql) => {
      if (/party_family = 'write_in'/i.test(sql)) {
        return { rows: [{ id: 'party-write-in' }] };
      }
      return { rows: [] };
    });
    const id = await resolvePartyId(pg, 'W/I', '39');
    assert.equal(id, 'party-write-in');
  });

  it('4. "DFL" with state=27 prefers state-scoped MN DFL row over any national match', async () => {
    // Mock returns both a state-scoped row (rank 0) and a national row
    // (rank 1); ORDER BY scope_rank ASC means the query returns the state
    // row LIMIT 1 — we assert that's what the resolver picks.
    const pg = makeMockPg(async (sql, params) => {
      assert.equal(params[0], 'DFL');
      assert.equal(params[1], '27');
      // Query already applies ORDER BY + LIMIT 1 → emit the state row only.
      return { rows: [{ id: 'party-mn-dfl' }] };
    });
    const id = await resolvePartyId(pg, 'DFL', '27');
    assert.equal(id, 'party-mn-dfl');
  });

  it('returns null for null / empty input', async () => {
    const pg = makeMockPg(async () => ({ rows: [] }));
    assert.equal(await resolvePartyId(pg, null, '49'), null);
    assert.equal(await resolvePartyId(pg, '', '49'), null);
    assert.equal(await resolvePartyId(pg, '   ', '49'), null);
  });
});

// ---------------------------------------------------------------------------
// 5 + 6. NIST parser
// ---------------------------------------------------------------------------

// Synthetic NIST 1500-100 v2 fragment. Deliberately tiny but exercises:
//  - Multiple contests (Governor + US House D1)
//  - Party resolution via PartyId ref
//  - Vote count sum across Type='total' entries
//  - Write-in flag
//  - District extraction via GpUnit Name
const SYNTHETIC_NIST_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ElectionReport xmlns="http://itl.nist.gov/ns/voting/1500-100/v2">
  <Party ObjectId="party-dem">
    <Abbreviation>DEM</Abbreviation>
    <Name>Democratic Party</Name>
  </Party>
  <Party ObjectId="party-rep">
    <Abbreviation>REP</Abbreviation>
    <Name>Republican Party</Name>
  </Party>
  <GpUnit ObjectId="gp-state">
    <Name>Ohio</Name>
    <Type>state</Type>
  </GpUnit>
  <GpUnit ObjectId="gp-cd1">
    <Name>Congressional District 1</Name>
    <Type>congressional</Type>
  </GpUnit>
  <Election>
    <Candidate ObjectId="cand-smith">
      <BallotName>Jane Smith</BallotName>
      <PartyId>party-dem</PartyId>
      <IsWriteIn>false</IsWriteIn>
    </Candidate>
    <Candidate ObjectId="cand-jones">
      <BallotName>Bob Jones</BallotName>
      <PartyId>party-rep</PartyId>
    </Candidate>
    <Candidate ObjectId="cand-write">
      <BallotName>Write-In</BallotName>
      <IsWriteIn>true</IsWriteIn>
    </Candidate>
    <Contest ObjectId="contest-gov" type="CandidateContest">
      <Name>Governor</Name>
      <ElectoralDistrictId>gp-state</ElectoralDistrictId>
      <PctReporting>72.5</PctReporting>
      <ContestSelection ObjectId="sel-gov-smith" type="CandidateSelection">
        <CandidateIds>cand-smith</CandidateIds>
        <IsWinner>true</IsWinner>
        <VoteCounts>
          <Count>123456</Count>
          <Type>total</Type>
        </VoteCounts>
      </ContestSelection>
      <ContestSelection ObjectId="sel-gov-jones" type="CandidateSelection">
        <CandidateIds>cand-jones</CandidateIds>
        <VoteCounts>
          <Count>100000</Count>
          <Type>total</Type>
        </VoteCounts>
      </ContestSelection>
    </Contest>
    <Contest ObjectId="contest-hd1" type="CandidateContest">
      <Name>U.S. House of Representatives</Name>
      <ElectoralDistrictId>gp-cd1</ElectoralDistrictId>
      <ContestSelection ObjectId="sel-hd1-write" type="CandidateSelection">
        <CandidateIds>cand-write</CandidateIds>
        <VoteCounts>
          <Count>42</Count>
          <Type>early</Type>
        </VoteCounts>
        <VoteCounts>
          <Count>8</Count>
          <Type>electionday</Type>
        </VoteCounts>
      </ContestSelection>
    </Contest>
  </Election>
</ElectionReport>`;

describe('NIST 1500-100 XML parser', () => {
  it('5a. parses valid XML into populated StateResultRow[]', () => {
    const rows = parseNistXml(SYNTHETIC_NIST_XML, {
      reportingLevel: 'unofficial_partial',
    });

    // 3 selections total (Governor has 2 + HD1 has 1 write-in)
    assert.equal(rows.length, 3, `expected 3 rows, got ${rows.length}`);

    const smith = rows.find((r) => r.reported_name === 'Jane Smith');
    assert.ok(smith, 'Jane Smith row should exist');
    assert.equal(smith.office_name, 'Governor');
    assert.equal(smith.party_abbreviation, 'DEM');
    assert.equal(smith.vote_count, 123456);
    assert.equal(smith.is_winner, true);
    assert.equal(smith.pct_precincts_reporting, 72.5);
    assert.equal(smith.is_write_in, false);

    const jones = rows.find((r) => r.reported_name === 'Bob Jones');
    assert.ok(jones, 'Bob Jones row should exist');
    assert.equal(jones.is_winner, false);
    assert.equal(jones.vote_count, 100000);

    const write = rows.find((r) => r.is_write_in);
    assert.ok(write, 'write-in row should exist');
    // Sums early + electionday because no 'total' entry present.
    assert.equal(write.vote_count, 50);
    assert.equal(write.district_identifier, '1');
  });

  it('5b. excludeWriteIns=false drops write-in selections', () => {
    const rows = parseNistXml(SYNTHETIC_NIST_XML, {
      includeWriteIns: false,
    });
    assert.equal(rows.length, 2);
    assert.equal(rows.filter((r) => r.is_write_in).length, 0);
  });

  it('6a. malformed XML throws from parseNistXmlOrThrow', () => {
    assert.throws(
      () => parseNistXmlOrThrow('<not-valid<<<xml'),
      /parseNistXml: /,
    );
  });

  it('6b. empty body throws in strict mode', () => {
    assert.throws(() => parseNistXmlOrThrow(''), /empty or too-short/);
  });

  it('6c. valid XML with no ElectionReport throws in strict mode', () => {
    const xml = '<?xml version="1.0"?><Root><Wrong/></Root>';
    assert.throws(() => parseNistXmlOrThrow(xml), /no <ElectionReport>/);
  });
});

// ---------------------------------------------------------------------------
// 7. createStateSosAdapter — integration via runAdapter + mocks
// ---------------------------------------------------------------------------

/**
 * Minimal supabase + pg mock copy-pasted in miniature from runner.test.ts.
 * We don't import the full mock because it lives inside a non-exported scope
 * there. Just enough to exercise one success run.
 */
function makeMiniMockSupabase() {
  const state = {
    inserted: [] as Array<{ table: string; row: Record<string, unknown> }>,
    updated: [] as Array<{ table: string; patch: Record<string, unknown>; id: string }>,
    nextId: 1,
  };
  function makeQuery(table: string) {
    const filters: Record<string, unknown> = {};
    const self: Record<string, unknown> = {
      insert: (row: Record<string, unknown> | Record<string, unknown>[]) => {
        const rows = Array.isArray(row) ? row : [row];
        for (const r of rows) state.inserted.push({ table, row: r });
        (self as { _lastInsert?: Record<string, unknown>[] })._lastInsert = rows;
        return self;
      },
      update: (patch: Record<string, unknown>) => {
        (self as { _lastUpdate?: Record<string, unknown> })._lastUpdate = patch;
        return self;
      },
      upsert: (row: Record<string, unknown> | Record<string, unknown>[]) => {
        const rows = Array.isArray(row) ? row : [row];
        for (const r of rows) state.inserted.push({ table, row: r });
        (self as { _lastInsert?: Record<string, unknown>[] })._lastInsert = rows;
        return self;
      },
      select: () => self,
      eq: (col: string, val: unknown) => {
        filters[col] = val;
        const lastUpdate = (self as { _lastUpdate?: Record<string, unknown> })._lastUpdate;
        if (lastUpdate && col === 'id') {
          state.updated.push({ table, id: String(val), patch: lastUpdate });
        }
        return self;
      },
      neq: () => self,
      limit: () => self,
      order: () => self,
      single: async () => {
        const last = (self as { _lastInsert?: Record<string, unknown>[] })._lastInsert;
        if (last && last.length === 1) {
          const id = `mock-id-${state.nextId++}`;
          return { data: { id, ...last[0] }, error: null };
        }
        return { data: null, error: null };
      },
      maybeSingle: async () => ({ data: null, error: null }),
      then: (resolve: (v: { data: unknown[]; error: null }) => void) => {
        // For .upsert(...).select() — return an array of ids matching the
        // last inserted batch so election_results upsert looks successful.
        const last = (self as { _lastInsert?: Record<string, unknown>[] })._lastInsert;
        if (last && table === 'election_results') {
          resolve({
            data: last.map((_r, i) => ({ id: `er-${i}` })),
            error: null,
          });
          return;
        }
        resolve({ data: [], error: null });
      },
    };
    return self;
  }
  const supabase = {
    from: (table: string) => makeQuery(table),
  } as unknown as SupabaseClient;
  return { supabase, state };
}

function makeMiniMockPool(handler?: QueryHandler) {
  const state = { terminal: null as 'COMMIT' | 'ROLLBACK' | null };
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      if (sql === 'BEGIN') return { rows: [] };
      if (sql === 'COMMIT') {
        state.terminal = 'COMMIT';
        return { rows: [] };
      }
      if (sql === 'ROLLBACK') {
        state.terminal = 'ROLLBACK';
        return { rows: [] };
      }
      if (sql.includes('pg_try_advisory_xact_lock')) {
        return { rows: [{ locked: true }] };
      }
      if (sql.includes('cost_cap_check_and_consume')) {
        return { rows: [{ ok: true }] };
      }
      if (handler) return handler(sql, params ?? []);
      return { rows: [] };
    },
    release: () => undefined,
  };
  const pool = {
    connect: async () => client,
    end: async () => undefined,
    query: async (sql: string, params?: unknown[]) => {
      if (handler) return handler(sql, params ?? []);
      return { rows: [] };
    },
  } as unknown as Pool;
  return { pool, state };
}

describe('createStateSosAdapter — integration via runAdapter', () => {
  it('7. composes fetch + parse into a runnable adapter that writes election_results', async () => {
    // Resolvers all succeed against our mock pool.
    const { pool } = makeMiniMockPool(async (sql) => {
      if (/FROM offices/i.test(sql)) {
        return {
          rows: [
            { office_id: 'office-1', election_id: 'election-1', district_score: 1 },
          ],
        };
      }
      if (/FROM candidacies/i.test(sql)) {
        return {
          rows: [{ candidacy_id: 'cand-1', person_id: 'person-1' }],
        };
      }
      if (/FROM parties/i.test(sql)) {
        return { rows: [{ id: 'party-1' }] };
      }
      return { rows: [] };
    });
    const { supabase, state: sbState } = makeMiniMockSupabase();

    const adapter = createStateSosAdapter({
      stateFips: '49',
      sourceName: 'utah-sos-results-fixture',
      sourceUrl: 'https://example.test/utah.xml',
      sourceType: 'sos_results_api',
      license: 'state_open_records',
      expectedMinRows: 1,
      electionYear: 2026,
      fetch: async () => ({
        rawBody: '<fake-xml/>',
      }),
      parse: async () => [
        {
          reported_name: 'Jane Smith',
          party_abbreviation: 'DEM',
          office_name: 'Governor',
          district_identifier: null,
          vote_count: 12345,
          vote_percentage: 55.2,
          pct_precincts_reporting: 72.5,
          is_winner: true,
          is_runoff_advancer: false,
          is_write_in: false,
          reporting_level: 'unofficial_partial',
          source_row_id: 'fixture-row-1',
        },
      ],
    });

    const result = await runAdapter(adapter, {
      supabase,
      pg: pool,
      gitSha: 'test-sha',
    });

    assert.equal(
      result.status,
      'success',
      `expected success, got ${result.status} (${result.reason ?? ''})`,
    );

    const irRow = sbState.inserted.find((i) => i.table === 'ingestion_runs');
    assert.ok(irRow, 'ingestion_runs row inserted');
    assert.equal(irRow.row.adapter_name, 'sos-utah-sos-results-fixture');
    assert.equal(irRow.row.state_fips, '49');

    const dsRow = sbState.inserted.find((i) => i.table === 'data_sources');
    assert.ok(dsRow, 'data_sources row inserted');
    assert.equal(dsRow.row.state_fips, '49');
    assert.equal(dsRow.row.source_type, 'sos_results_api');

    const erRow = sbState.inserted.find((i) => i.table === 'election_results');
    assert.ok(erRow, 'election_results row inserted');
    assert.equal(erRow.row.election_id, 'election-1');
    assert.equal(erRow.row.candidacy_id, 'cand-1');
    assert.equal(erRow.row.party_id, 'party-1');
    assert.equal(erRow.row.vote_count, 12345);
    assert.equal(erRow.row.is_winner, true);
    assert.equal(erRow.row.reporting_level, 'unofficial_partial');
  });
});
