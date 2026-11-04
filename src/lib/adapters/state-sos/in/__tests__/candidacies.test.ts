/**
 * Unit tests for the Indiana candidacies adapter.
 *
 * Drives parseIndianaXlsx() + resolveInOfficeBySlug() + the full insert()
 * pipeline against synthetic fixtures and a mock pg/supabase pair. No
 * network, no real DB.
 *
 * Run:
 *   npx tsx --test src/lib/adapters/state-sos/in/__tests__/candidacies.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import type { Pool } from 'pg';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  canonicalKey,
  createInCandidaciesAdapter,
  extractDistrictId,
  parseIndianaXlsx,
  resolveInOfficeBySlug,
  type InCandidacyRow,
} from '../candidacies';
import type {
  AdapterContext,
  InsertRefs,
  InsertStats,
} from '../../../types';

// ---------------------------------------------------------------------------
// Fixtures — build a tiny in-memory XLSX that mirrors the SoS schema
// ---------------------------------------------------------------------------

function buildFixtureWorkbook(
  rows: (string | null)[][],
  sheetName = 'Candidate_List_Abbreviated_2026',
): Uint8Array {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  return new Uint8Array(out);
}

const FIXTURE_ROWS: (string | null)[][] = [
  ['ALL COUNTIES', '2026 PRIMARY ELECTION - 5/5/2026', null, null, null],
  [null, null, null, null, null],
  ['OFFICE', 'CANDIDATE NAME', 'POLITICAL PARTY', 'DISTRICT', 'DATE FILED'],
  // US Rep — ordinal word district
  ['US REPRESENTATIVE', 'Alex J. Testcandidate', 'Democratic', 'United States Representative, First District', '1/8/26'],
  ['US REPRESENTATIVE', 'Jordan Placeholder', 'Republican', 'United States Representative, First District', '1/14/26'],
  ['US REPRESENTATIVE', 'Pat Example', 'Republican', 'United States Representative, Second District', '1/12/26'],
  ['US REPRESENTATIVE', 'Robin Sample', 'Democratic', 'United States Representative, Second District', '1/20/26'],
  // Dup row — must dedup to one
  ['US REPRESENTATIVE', 'Alex J. Testcandidate', 'Democratic', 'United States Representative, First District', '1/8/26'],
  // State Senator — zero-padded district
  ['STATE SENATOR', 'Alice Example', 'Democratic', 'State Senator, District 01', '1/5/26'],
  ['STATE SENATOR', 'Bob Example', 'Republican', 'State Senator, District 04', '1/6/26'],
  // State Rep — three-digit zero-padded district
  ['STATE REPRESENTATIVE', 'Carol Smith', 'Democratic', 'State Representative, District 001', '1/7/26'],
  ['STATE REPRESENTATIVE', 'Dave Jones', 'Republican', 'State Representative, District 042', '1/8/26'],
  ['STATE REPRESENTATIVE', 'Eve Brown', 'Republican', 'State Representative, District 100', '1/9/26'],
  // Local — should be filtered out
  ['PRECINCT COMMITTEEMAN', 'Frank Q. Public', 'Democratic', 'Ward 1', '1/10/26'],
  ['TOWNSHIP TRUSTEE', 'Casey Fictional', 'Republican', 'Center Township', '1/11/26'],
  ['COUNTY SHERIFF', 'Henry Q', 'Republican', 'Marion County', '1/12/26'],
  // Header / section / blank lines — must be ignored
  [null, null, null, null, null],
  ['OFFICE', 'CANDIDATE NAME', 'POLITICAL PARTY', 'DISTRICT', 'DATE FILED'],
];

// ---------------------------------------------------------------------------
// 1. Factory configuration
// ---------------------------------------------------------------------------

describe('IN candidacies — factory configuration', () => {
  it('declares FIPS 18, the correct tokenBucket, sourceName, and adapter name', () => {
    const adapter = createInCandidaciesAdapter();
    assert.equal(adapter.stateFips, '18');
    assert.deepEqual(adapter.tokenBucket, { rps: 0.5, burst: 2 });
    assert.equal(adapter.name, 'sos-indiana-candidacies');
  });

  it('respects custom tokenBucket / sourceUrl overrides', () => {
    const adapter = createInCandidaciesAdapter({
      tokenBucket: { rps: 1, burst: 4 },
      sourceUrl: 'https://example.test/in.xlsx',
    });
    assert.deepEqual(adapter.tokenBucket, { rps: 1, burst: 4 });
    // stateFips remains 18 regardless
    assert.equal(adapter.stateFips, '18');
  });
});

// ---------------------------------------------------------------------------
// 2. Parser happy-path
// ---------------------------------------------------------------------------

describe('IN candidacies — parseIndianaXlsx', () => {
  it('parses ≥10 rows from the synthetic XLSX fixture and filters local races', () => {
    const bytes = buildFixtureWorkbook(FIXTURE_ROWS);
    const rows = parseIndianaXlsx(bytes);
    assert.ok(
      rows.length >= 7,
      `expected ≥7 non-local rows, got ${rows.length}`,
    );
    // All rows should have one of the three target slugs.
    for (const r of rows) {
      assert.ok(
        ['us_representative', 'state_senator', 'state_representative'].includes(
          r.office_type_slug,
        ),
        `unexpected slug ${r.office_type_slug}`,
      );
    }
    // Specific assertions
    const testcandidate = rows.find((r) => r.reported_name === 'Alex J. Testcandidate');
    assert.ok(testcandidate, 'Testcandidate row');
    assert.equal(testcandidate.office_type_slug, 'us_representative');
    assert.equal(testcandidate.district_identifier, '1');
    assert.equal(testcandidate.party_raw, 'Democratic');
    assert.equal(testcandidate.date_filed, '2026-01-08');

    const alice = rows.find((r) => r.reported_name === 'Alice Example');
    assert.ok(alice);
    assert.equal(alice.office_type_slug, 'state_senator');
    assert.equal(alice.district_identifier, '1');

    const dave = rows.find((r) => r.reported_name === 'Dave Jones');
    assert.ok(dave);
    assert.equal(dave.district_identifier, '42');

    const eve = rows.find((r) => r.reported_name === 'Eve Brown');
    assert.ok(eve);
    assert.equal(eve.district_identifier, '100');
  });

  it('dedupes rows that repeat (same slug+district+party+name)', () => {
    const bytes = buildFixtureWorkbook(FIXTURE_ROWS);
    const rows = parseIndianaXlsx(bytes);
    const testcandidateRows = rows.filter((r) => r.reported_name === 'Alex J. Testcandidate');
    assert.equal(testcandidateRows.length, 1, 'Testcandidate must be deduped to a single row');
  });

  it('excludes PRECINCT COMMITTEEMAN / TOWNSHIP / COUNTY races entirely', () => {
    const bytes = buildFixtureWorkbook(FIXTURE_ROWS);
    const rows = parseIndianaXlsx(bytes);
    assert.equal(
      rows.find((r) => r.reported_name === 'Frank Q. Public'),
      undefined,
    );
    assert.equal(
      rows.find((r) => r.reported_name === 'Casey Fictional'),
      undefined,
    );
    assert.equal(
      rows.find((r) => r.reported_name === 'Henry Q'),
      undefined,
    );
  });

  it('returns [] for empty/short inputs', () => {
    assert.equal(parseIndianaXlsx(new Uint8Array(0)).length, 0);
    assert.equal(parseIndianaXlsx(new Uint8Array([1, 2, 3])).length, 0);
  });
});

// ---------------------------------------------------------------------------
// 3. extractDistrictId
// ---------------------------------------------------------------------------

describe('IN candidacies — extractDistrictId', () => {
  it('parses ordinal-word districts', () => {
    assert.equal(
      extractDistrictId('United States Representative, First District'),
      '1',
    );
    assert.equal(
      extractDistrictId('United States Representative, Eighth District'),
      '8',
    );
    assert.equal(
      extractDistrictId('United States Representative, Ninth District'),
      '9',
    );
  });

  it('parses zero-padded numeric districts', () => {
    assert.equal(extractDistrictId('State Senator, District 01'), '1');
    assert.equal(extractDistrictId('State Senator, District 25'), '25');
    assert.equal(extractDistrictId('State Representative, District 001'), '1');
    assert.equal(extractDistrictId('State Representative, District 042'), '42');
    assert.equal(extractDistrictId('State Representative, District 100'), '100');
  });

  it('returns null for garbage', () => {
    assert.equal(extractDistrictId(''), null);
    assert.equal(extractDistrictId('At Large'), null);
  });
});

// ---------------------------------------------------------------------------
// 4. canonicalKey matches the DB trigger transform
// ---------------------------------------------------------------------------

describe('IN candidacies — canonicalKey', () => {
  it('lowercases, strips non-alphanumerics, matches people trigger', () => {
    assert.equal(canonicalKey('Alex J. Testcandidate'), 'alexjtestcandidate');
    assert.equal(canonicalKey("O'Example, Quinn"), 'oexamplequinn');
    assert.equal(canonicalKey('  Jane  Doe  '), 'janedoe');
  });
});

// ---------------------------------------------------------------------------
// pg/supabase mocks
// ---------------------------------------------------------------------------

type QueryHandler = (
  sql: string,
  params: unknown[],
) => { rows: unknown[]; rowCount?: number };

function makeMockPg(handler: QueryHandler): Pool {
  const q = async (sql: string, params?: unknown[]) => {
    const res = handler(sql, params ?? []);
    return { rows: res.rows, rowCount: res.rowCount ?? res.rows.length };
  };
  const client = { query: q, release: () => undefined };
  return {
    connect: async () => client,
    end: async () => undefined,
    query: q,
  } as unknown as Pool;
}

type SupabaseCall = { table: string; op: string; payload?: unknown };

function makeMockSupabase(collector: SupabaseCall[]): SupabaseClient {
  const client = {
    from(table: string) {
      return {
        insert: async (payload: unknown) => {
          collector.push({ table, op: 'insert', payload });
          return { data: null, error: null };
        },
      };
    },
  };
  return client as unknown as SupabaseClient;
}

function makeCtx(pg: Pool, supabase: SupabaseClient, dryRun = false): AdapterContext {
  return {
    supabase,
    pg,
    dryRun,
    gitSha: 'test',
    ingestionRunId: 'run-1',
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  };
}

// ---------------------------------------------------------------------------
// 5. resolveInOfficeBySlug
// ---------------------------------------------------------------------------

describe('IN candidacies — resolveInOfficeBySlug', () => {
  it('returns the first office row matching slug+district', async () => {
    const pg = makeMockPg((sql, params) => {
      assert.match(sql, /FROM offices o/);
      assert.match(sql, /ot\.slug = \$2/);
      assert.equal(params[0], '18');
      assert.equal(params[1], 'us_representative');
      return { rows: [{ office_id: 'office-in-us-house-d1' }] };
    });
    const officeId = await resolveInOfficeBySlug(pg, {
      office_type_slug: 'us_representative',
      district_identifier: '1',
    });
    assert.equal(officeId, 'office-in-us-house-d1');
  });

  it('returns null when no office row matches', async () => {
    const pg = makeMockPg(() => ({ rows: [] }));
    const officeId = await resolveInOfficeBySlug(pg, {
      office_type_slug: 'state_senator',
      district_identifier: '99',
    });
    assert.equal(officeId, null);
  });
});

// ---------------------------------------------------------------------------
// 6. Full insert() pipeline — office resolution + party resolution + dedup
// ---------------------------------------------------------------------------

/**
 * Queries the pg handler dispatches on, in order:
 *   - resolveInOfficeBySlug (FROM offices o JOIN office_types ot ...)
 *   - [resolveOfficeElection fallback — only on miss]
 *   - findOrCreateElection (SELECT id FROM elections ...)
 *   - (INSERT elections if new)
 *   - findOrCreatePerson (SELECT id FROM people WHERE canonical_key ...)
 *   - (INSERT people if new)
 *   - upsertCandidacy (SELECT / INSERT / UPDATE candidacies)
 *   - resolvePartyId (SELECT from parties ...)
 *   - upsertPartyLine (INSERT INTO candidacy_party_lines ON CONFLICT)
 */
describe('IN candidacies — adapter.insert() end-to-end', () => {
  it('inserts candidacies + party lines for a happy-path batch', async () => {
    const rows: InCandidacyRow[] = [
      {
        reported_name: 'Alex J. Testcandidate',
        office_category: 'US REPRESENTATIVE',
        office_type_slug: 'us_representative',
        district_identifier: '1',
        party_raw: 'Democratic',
        date_filed: '2026-01-08',
        source_row_id: 'us_representative|1|democratic|frank j. testcandidate',
      },
      {
        reported_name: 'Jordan Placeholder',
        office_category: 'US REPRESENTATIVE',
        office_type_slug: 'us_representative',
        district_identifier: '1',
        party_raw: 'Republican',
        date_filed: '2026-01-14',
        source_row_id: 'us_representative|1|republican|barb regnitz',
      },
      // Same candidate appearing twice post-parse (shouldn't happen, but
      // adapter.insert must be idempotent in any case). The first call
      // creates, the second updates. We simulate that by creating the
      // candidacy row server-side after the first INSERT lands.
      {
        reported_name: 'Alex J. Testcandidate',
        office_category: 'US REPRESENTATIVE',
        office_type_slug: 'us_representative',
        district_identifier: '1',
        party_raw: 'Democratic',
        date_filed: '2026-01-08',
        source_row_id: 'us_representative|1|democratic|frank j. testcandidate',
      },
    ];

    // Track state across queries so dedup reads back what we just wrote.
    const peopleByKey = new Map<string, string>();
    const candidaciesByKey = new Map<string, string>();

    let officeCalls = 0;
    let personInserts = 0;
    let candidacyInserts = 0;
    let candidacyUpdates = 0;
    let partyLineUpserts = 0;
    let electionInserts = 0;

    const pg = makeMockPg((sql, params) => {
      // resolveInOfficeBySlug
      if (/FROM offices o/.test(sql) && /JOIN office_types/.test(sql)) {
        officeCalls += 1;
        return { rows: [{ office_id: 'office-in-us-house-d1' }] };
      }
      // findOrCreateElection SELECT
      if (/FROM elections\b/.test(sql) && /SELECT id/.test(sql)) {
        return { rows: [{ id: 'election-in-2026-us-house-d1' }] };
      }
      if (/INSERT INTO elections/.test(sql)) {
        electionInserts += 1;
        return { rows: [{ id: 'election-in-2026-us-house-d1' }] };
      }
      // findOrCreatePerson lookup (state-disambiguated). Returns rows
      // shaped to match the new structured query in candidate-resolver.ts:
      // each row carries has_candidacy_in_state / has_tenure_in_state so
      // the helper can determine whether the canonical_key match belongs
      // to THIS state.
      if (/FROM people p\b/.test(sql) && /canonical_key = \$1/.test(sql)) {
        const key = params[0] as string;
        const existing = peopleByKey.get(key);
        if (!existing) return { rows: [] };
        return {
          rows: [
            {
              id: existing,
              created_at: new Date('2026-01-01'),
              has_candidacy_in_state: true,
              has_tenure_in_state: false,
              latest_candidacy_in_state: new Date('2026-01-01'),
              latest_tenure_in_state: null,
            },
          ],
        };
      }
      // people INSERT
      if (/INSERT INTO people\b/.test(sql)) {
        personInserts += 1;
        const name = params[0] as string;
        const key = params[1] as string;
        const id = `person-${name.replace(/\s+/g, '-')}`;
        peopleByKey.set(key, id);
        return { rows: [{ id }] };
      }
      // candidacies SELECT
      if (/FROM candidacies\b/.test(sql) && /SELECT id/.test(sql)) {
        const electionId = params[0] as string;
        const personId = params[1] as string;
        const cKey = `${electionId}|${personId}`;
        const existing = candidaciesByKey.get(cKey);
        return existing ? { rows: [{ id: existing }] } : { rows: [] };
      }
      // candidacies INSERT
      if (/INSERT INTO candidacies\b/.test(sql)) {
        candidacyInserts += 1;
        const electionId = params[0] as string;
        const personId = params[1] as string;
        const id = `cand-${candidacyInserts}`;
        candidaciesByKey.set(`${electionId}|${personId}`, id);
        return { rows: [{ id }] };
      }
      // candidacies UPDATE
      if (/UPDATE candidacies/.test(sql)) {
        candidacyUpdates += 1;
        return { rows: [] };
      }
      // resolvePartyId (parties table)
      if (/FROM parties\b/.test(sql)) {
        const upper = params[0] as string;
        if (upper === 'DEMOCRATIC' || upper === 'DEM' || upper === 'D') {
          return { rows: [{ id: 'party-dem-national' }] };
        }
        if (upper === 'REPUBLICAN' || upper === 'REP' || upper === 'R') {
          return { rows: [{ id: 'party-rep-national' }] };
        }
        return { rows: [] };
      }
      // candidacy_party_lines INSERT ON CONFLICT
      if (/INSERT INTO candidacy_party_lines/.test(sql)) {
        partyLineUpserts += 1;
        return { rows: [] };
      }
      return { rows: [] };
    });

    const supabaseCalls: SupabaseCall[] = [];
    const supabase = makeMockSupabase(supabaseCalls);

    const adapter = createInCandidaciesAdapter();
    const ctx = makeCtx(pg, supabase);
    const refs: InsertRefs = {
      dataSourceId: 'ds-1',
      ingestionRunId: 'run-1',
    };

    const stats: InsertStats = await adapter.insert(rows, refs, ctx);

    assert.equal(stats.rowsFailed, 0, 'no failures');
    // First Testcandidate = insert, Placeholder = insert, second Testcandidate = update
    assert.equal(stats.rowsInserted, 2);
    assert.equal(stats.rowsUpdated, 1);
    // Office resolution should have been cached after the first call —
    // all three rows share slug+district. Still, we allow up to 1 call.
    assert.equal(officeCalls, 1, 'office resolution is cached per run');
    // Two distinct people
    assert.equal(personInserts, 2);
    assert.equal(candidacyInserts, 2);
    assert.equal(candidacyUpdates, 1);
    assert.equal(partyLineUpserts, 3); // one per row (party lines are idempotent upserts)
    assert.equal(electionInserts, 0); // existing election row found
  });

  it('skips rows with unresolvable office and logs a validation error', async () => {
    const rows: InCandidacyRow[] = [
      {
        reported_name: 'Unknown Office Candidate',
        office_category: 'STATE REPRESENTATIVE',
        office_type_slug: 'state_representative',
        district_identifier: '999',
        party_raw: 'Democratic',
        date_filed: null,
        source_row_id: 'state_representative|999|democratic|unknown office candidate',
      },
    ];

    const pg = makeMockPg((sql) => {
      // Both primary and fallback resolvers return no rows
      if (/FROM offices o/.test(sql)) return { rows: [] };
      return { rows: [] };
    });
    const supabaseCalls: SupabaseCall[] = [];
    const supabase = makeMockSupabase(supabaseCalls);

    const adapter = createInCandidaciesAdapter();
    const ctx = makeCtx(pg, supabase);
    const refs: InsertRefs = { dataSourceId: 'ds-1', ingestionRunId: 'run-1' };
    const stats = await adapter.insert(rows, refs, ctx);

    assert.equal(stats.rowsInserted, 0);
    assert.equal(stats.rowsSkipped, 1);
    // ingestion_errors insert should have been recorded
    const errCall = supabaseCalls.find(
      (c) => c.table === 'ingestion_errors' && c.op === 'insert',
    );
    assert.ok(errCall, 'should log to ingestion_errors');
    const payload = errCall.payload as { error_message: string };
    assert.match(payload.error_message, /office not resolved/);
  });

  it('logs a validation error when party cannot be resolved', async () => {
    const rows: InCandidacyRow[] = [
      {
        reported_name: 'Fringe Candidate',
        office_category: 'STATE SENATOR',
        office_type_slug: 'state_senator',
        district_identifier: '4',
        party_raw: 'Modern Whig',
        date_filed: '2026-01-06',
        source_row_id: 'state_senator|4|modern whig|fringe candidate',
      },
    ];

    const pg = makeMockPg((sql) => {
      if (/FROM offices o/.test(sql))
        return { rows: [{ office_id: 'office-in-state-senator-d4' }] };
      if (/FROM elections\b/.test(sql) && /SELECT id/.test(sql))
        return { rows: [{ id: 'election-in-2026-ss-d4' }] };
      if (/FROM people\b/.test(sql)) return { rows: [] };
      if (/INSERT INTO people/.test(sql))
        return { rows: [{ id: 'person-fringe' }] };
      if (/FROM candidacies\b/.test(sql)) return { rows: [] };
      if (/INSERT INTO candidacies/.test(sql))
        return { rows: [{ id: 'cand-1' }] };
      // Party resolution returns nothing
      if (/FROM parties\b/.test(sql)) return { rows: [] };
      return { rows: [] };
    });

    const supabaseCalls: SupabaseCall[] = [];
    const supabase = makeMockSupabase(supabaseCalls);

    const adapter = createInCandidaciesAdapter();
    const ctx = makeCtx(pg, supabase);
    const refs: InsertRefs = { dataSourceId: 'ds-1', ingestionRunId: 'run-1' };
    const stats = await adapter.insert(rows, refs, ctx);

    // Candidacy still inserted; party line skipped
    assert.equal(stats.rowsInserted, 1);
    const errCall = supabaseCalls.find(
      (c) =>
        c.table === 'ingestion_errors' &&
        (c.payload as { error_message: string }).error_message.includes(
          'party not resolved',
        ),
    );
    assert.ok(errCall, 'should log party-not-resolved');
  });
});

// ---------------------------------------------------------------------------
// 7. Party resolution — REP → Republican party_id
// ---------------------------------------------------------------------------

describe('IN candidacies — party resolution via insert()', () => {
  it('passes "Republican" through to resolvePartyId and consumes the REP-matching row', async () => {
    const rows: InCandidacyRow[] = [
      {
        reported_name: 'GOP Candidate',
        office_category: 'STATE REPRESENTATIVE',
        office_type_slug: 'state_representative',
        district_identifier: '12',
        party_raw: 'Republican',
        date_filed: null,
        source_row_id: 'state_representative|12|republican|gop candidate',
      },
    ];

    let partyQueryParams: unknown[] | null = null;
    let partyLineSawRepId = false;

    const pg = makeMockPg((sql, params) => {
      if (/FROM offices o/.test(sql))
        return { rows: [{ office_id: 'office-in-sr-d12' }] };
      if (/FROM elections\b/.test(sql) && /SELECT id/.test(sql))
        return { rows: [{ id: 'election-in-2026-sr-d12' }] };
      if (/FROM people\b/.test(sql)) return { rows: [] };
      if (/INSERT INTO people/.test(sql))
        return { rows: [{ id: 'person-gop' }] };
      if (/FROM candidacies\b/.test(sql)) return { rows: [] };
      if (/INSERT INTO candidacies/.test(sql))
        return { rows: [{ id: 'cand-gop' }] };
      if (/FROM parties\b/.test(sql)) {
        partyQueryParams = params;
        // First positional param should be the upper-cased input
        assert.equal(params[0], 'REPUBLICAN');
        assert.equal(params[1], '18'); // state_fips
        return { rows: [{ id: 'party-rep-national' }] };
      }
      if (/INSERT INTO candidacy_party_lines/.test(sql)) {
        // party_id is second positional param
        if (params[1] === 'party-rep-national') partyLineSawRepId = true;
        return { rows: [] };
      }
      return { rows: [] };
    });

    const supabaseCalls: SupabaseCall[] = [];
    const supabase = makeMockSupabase(supabaseCalls);

    const adapter = createInCandidaciesAdapter();
    const ctx = makeCtx(pg, supabase);
    const refs: InsertRefs = { dataSourceId: 'ds-1', ingestionRunId: 'run-1' };
    await adapter.insert(rows, refs, ctx);

    assert.ok(partyQueryParams, 'parties table was queried');
    assert.ok(
      partyLineSawRepId,
      'candidacy_party_lines was inserted with the Republican party_id',
    );
  });
});
