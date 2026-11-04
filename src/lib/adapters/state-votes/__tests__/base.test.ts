/**
 * Unit tests for state-votes base adapter + UT/OH/TX parsers.
 *
 * Self-contained — no DB, no network. Runs via:
 *   npx tsx --test src/lib/adapters/state-votes/__tests__/base.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicalKey,
  createStateVotesAdapter,
  normalizePosition,
  normalizeDate,
  normalizeChamber,
  type StateLegVoteRow,
} from '../base';
import { parseUtahLegVotes, parseSessionYear } from '../ut/votes';
import { parseOhioLegVotes } from '../oh/votes';
import { parseTxLegVotes } from '../tx/votes';
import { parsePaLegVotes } from '../pa/votes';
import { runAdapter } from '../../run';
import type { Pool } from 'pg';
import type { SupabaseClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type QueryHandler = (
  sql: string,
  params: unknown[],
) => { rows: unknown[] } | Promise<{ rows: unknown[] }>;

// ---------------------------------------------------------------------------
// 1. canonicalKey + normalizers
// ---------------------------------------------------------------------------

describe('canonicalKey', () => {
  it('lowercases and strips non-alphanumerics', () => {
    assert.equal(canonicalKey('Jane Smith'), 'janesmith');
    assert.equal(canonicalKey("O'Brien-Núñez, Jr."), 'obriennezjr');
    assert.equal(canonicalKey('   Alice   Wong   '), 'alicewong');
  });
});

describe('normalizePosition', () => {
  it('maps common yea/nay/abstain/absent strings', () => {
    assert.equal(normalizePosition('Y'), 'yea');
    assert.equal(normalizePosition('yes'), 'yea');
    assert.equal(normalizePosition('Aye'), 'yea');
    assert.equal(normalizePosition('N'), 'nay');
    assert.equal(normalizePosition('NO'), 'nay');
    assert.equal(normalizePosition('abstain'), 'abstain');
    assert.equal(normalizePosition('Present'), 'abstain');
    assert.equal(normalizePosition('Excused'), 'absent');
    assert.equal(normalizePosition('NV'), 'absent');
    assert.equal(normalizePosition(null), 'other');
    assert.equal(normalizePosition(''), 'other');
    assert.equal(normalizePosition('garbled'), 'other');
  });
});

describe('normalizeDate', () => {
  it('handles ISO, US, and ISO-datetime formats', () => {
    assert.equal(normalizeDate('2025-02-14'), '2025-02-14');
    assert.equal(normalizeDate('2/14/2025'), '2025-02-14');
    assert.equal(normalizeDate('02/14/2025'), '2025-02-14');
    assert.equal(normalizeDate('2025-02-14T12:00:00Z'), '2025-02-14');
    assert.equal(normalizeDate(null), null);
    assert.equal(normalizeDate(''), null);
  });
});

describe('normalizeChamber', () => {
  it('maps common chamber strings', () => {
    assert.equal(normalizeChamber('House'), 'lower');
    assert.equal(normalizeChamber('H'), 'lower');
    assert.equal(normalizeChamber('Senate'), 'upper');
    assert.equal(normalizeChamber('S'), 'upper');
    assert.equal(normalizeChamber('Assembly'), 'lower');
    assert.equal(normalizeChamber('joint'), 'joint');
    assert.equal(normalizeChamber(undefined), 'lower');
  });
});

// ---------------------------------------------------------------------------
// 2. Utah parser
// ---------------------------------------------------------------------------

const UT_SAMPLE_JSON = JSON.stringify({
  number: 'HB0001',
  title: 'General Session Appropriations',
  session: '2025GS',
  actions: [
    {
      action: '3rd Reading / Final Passage',
      date: '2025-02-14',
      location: 'House',
      votes: [
        {
          yeas: [
            { name: 'Smith, Jane', district: '10', party: 'R' },
            { name: 'Doe, John', district: '11', party: 'D' },
          ],
          nays: [{ name: 'Jones, Bob', district: '12', party: 'D' }],
          absent: [{ name: 'Brown, Alice', district: '13', party: 'R' }],
        },
      ],
    },
  ],
});

describe('parseUtahLegVotes', () => {
  it('extracts rows per member and per position', () => {
    const rows = parseUtahLegVotes(UT_SAMPLE_JSON);
    assert.equal(rows.length, 4, `expected 4 rows, got ${rows.length}`);

    const smith = rows.find((r) => r.legislator_name === 'Smith, Jane');
    assert.ok(smith);
    assert.equal(smith.position, 'yea');
    assert.equal(smith.bill_identifier, 'HB0001');
    assert.equal(smith.chamber, 'lower');
    assert.equal(smith.session_year, 2025);
    assert.equal(smith.vote_date, '2025-02-14');
    assert.equal(smith.legislator_district, '10');

    const bob = rows.find((r) => r.legislator_name === 'Jones, Bob');
    assert.ok(bob);
    assert.equal(bob.position, 'nay');

    const alice = rows.find((r) => r.legislator_name === 'Brown, Alice');
    assert.ok(alice);
    assert.equal(alice.position, 'absent');
  });

  it('handles array of bills', () => {
    const wrapped = JSON.stringify([JSON.parse(UT_SAMPLE_JSON)]);
    const rows = parseUtahLegVotes(wrapped);
    assert.equal(rows.length, 4);
  });

  it('returns [] for invalid JSON', () => {
    assert.deepEqual(parseUtahLegVotes('{not json'), []);
    assert.deepEqual(parseUtahLegVotes(''), []);
  });

  it('parseSessionYear handles various shapes', () => {
    assert.equal(parseSessionYear('2025GS'), 2025);
    assert.equal(parseSessionYear('2025S1'), 2025);
    assert.equal(parseSessionYear(undefined), new Date().getUTCFullYear());
  });
});

// ---------------------------------------------------------------------------
// 3. Ohio parser
// ---------------------------------------------------------------------------

const OH_SAMPLE_HTML = `
<html>
<head><title>House Bill 42 Votes | Ohio House of Representatives</title></head>
<body>
  <h1>House Bill 42</h1>
  <h2>YEAS: 62</h2>
  <ul>
    <li>Representative Smith, Jane</li>
    <li>Representative Doe, John</li>
  </ul>
  <h2>NAYS: 31</h2>
  <ul>
    <li>Representative Jones, Bob</li>
  </ul>
  <h2>PRESENT / NOT VOTING</h2>
  <ul>
    <li>Representative Brown, Alice</li>
  </ul>
</body></html>
`;

describe('parseOhioLegVotes', () => {
  it('extracts yea/nay/abstain sections', () => {
    const rows = parseOhioLegVotes(OH_SAMPLE_HTML, { sessionYear: 2025 });
    assert.equal(rows.length, 4);
    const smith = rows.find((r) => r.legislator_name.includes('Smith'));
    assert.ok(smith);
    assert.equal(smith.position, 'yea');
    assert.equal(smith.bill_identifier, 'HB42');

    const bob = rows.find((r) => r.legislator_name.includes('Jones'));
    assert.ok(bob);
    assert.equal(bob.position, 'nay');

    const alice = rows.find((r) => r.legislator_name.includes('Brown'));
    assert.ok(alice);
    assert.equal(alice.position, 'abstain');
  });

  it('uses injected billIdentifier when title sniff fails', () => {
    const html = '<html><body><h2>YEAS</h2><ul><li>Smith, Jane</li></ul></body></html>';
    const rows = parseOhioLegVotes(html, {
      sessionYear: 2025,
      billIdentifier: 'HB999',
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].bill_identifier, 'HB999');
  });

  it('returns [] when no bill identifier can be found and none injected', () => {
    const html = '<html><body><h2>YEAS</h2><ul><li>Smith, Jane</li></ul></body></html>';
    const rows = parseOhioLegVotes(html, { sessionYear: 2025 });
    assert.equal(rows.length, 0);
  });
});

// ---------------------------------------------------------------------------
// 4. Texas parser
// ---------------------------------------------------------------------------

const TX_SAMPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Journal>
  <Chamber>House</Chamber>
  <SessionYear>2025</SessionYear>
  <Date>2025-04-15</Date>
  <RecordVote>
    <BillNumber>HB 1</BillNumber>
    <Description>General Appropriations Act</Description>
    <Yeas>
      <Member>Smith</Member>
      <Member>Doe</Member>
    </Yeas>
    <Nays>
      <Member>Jones</Member>
    </Nays>
    <PresentNotVoting>
      <Member>Brown</Member>
    </PresentNotVoting>
    <Absent>
      <Member>White</Member>
    </Absent>
  </RecordVote>
</Journal>`;

describe('parseTxLegVotes', () => {
  it('extracts yeas, nays, PNV, absent from Journal XML', () => {
    const rows = parseTxLegVotes(TX_SAMPLE_XML);
    assert.equal(rows.length, 5);
    const smith = rows.find((r) => r.legislator_name === 'Smith');
    assert.ok(smith);
    assert.equal(smith.position, 'yea');
    assert.equal(smith.bill_identifier, 'HB1');
    assert.equal(smith.chamber, 'lower');
    assert.equal(smith.session_year, 2025);
    assert.equal(smith.vote_date, '2025-04-15');

    const brown = rows.find((r) => r.legislator_name === 'Brown');
    assert.ok(brown);
    assert.equal(brown.position, 'abstain');

    const white = rows.find((r) => r.legislator_name === 'White');
    assert.ok(white);
    assert.equal(white.position, 'absent');
  });

  it('returns [] for malformed XML', () => {
    assert.deepEqual(parseTxLegVotes('<not<<<xml'), []);
    assert.deepEqual(parseTxLegVotes(''), []);
  });

  it('handles Journals wrapper', () => {
    const wrapped = `<?xml version="1.0"?><Journals>${TX_SAMPLE_XML.replace(/<\?xml[^>]+\?>/, '')}</Journals>`;
    const rows = parseTxLegVotes(wrapped);
    assert.equal(rows.length, 5);
  });
});

// ---------------------------------------------------------------------------
// 5. PA parser (smoke check — confirms XML shape round-trips)
// ---------------------------------------------------------------------------

const PA_SAMPLE_XML = `<?xml version="1.0"?>
<RollCall>
  <Chamber>House</Chamber>
  <SessionYear>2025</SessionYear>
  <BillNumber>HB0123</BillNumber>
  <BillTitle>An Act concerning X</BillTitle>
  <VoteDate>2025-03-12</VoteDate>
  <Members>
    <Member><Name>Smith, John</Name><District>123</District><Party>D</Party><Vote>Y</Vote></Member>
    <Member><Name>Doe, Jane</Name><District>45</District><Party>R</Party><Vote>N</Vote></Member>
  </Members>
</RollCall>`;

describe('parsePaLegVotes', () => {
  it('extracts members from a single RollCall', () => {
    const rows = parsePaLegVotes(PA_SAMPLE_XML);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].bill_identifier, 'HB0123');
    assert.equal(rows[0].legislator_name, 'Smith, John');
    assert.equal(rows[0].position, 'yea');
    assert.equal(rows[1].position, 'nay');
  });
});

// ---------------------------------------------------------------------------
// 6. createStateVotesAdapter — integration via runAdapter + mocks
// ---------------------------------------------------------------------------

function makeMiniMockSupabase() {
  const state = {
    inserted: [] as Array<{ table: string; row: Record<string, unknown> }>,
    updated: [] as Array<{ table: string; patch: Record<string, unknown>; id: string }>,
    nextId: 1,
  };
  function makeQuery(table: string) {
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
        const last = (self as { _lastInsert?: Record<string, unknown>[] })._lastInsert;
        if (last && table === 'state_legislator_votes') {
          resolve({ data: last.map((_r, i) => ({ id: `slv-${i}` })), error: null });
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

describe('createStateVotesAdapter — integration via runAdapter', () => {
  it('composes fetch + parse into a runnable adapter that writes state_legislator_votes', async () => {
    const { pool } = makeMiniMockPool(async (sql) => {
      if (/FROM people/i.test(sql)) {
        return { rows: [{ person_id: 'person-1', ocd_id: 'ocd-ut-house-10' }] };
      }
      return { rows: [] };
    });
    const { supabase, state: sbState } = makeMiniMockSupabase();

    const adapter = createStateVotesAdapter({
      stateFips: '49',
      stateAbbrev: 'UT',
      sourceName: 'utah-leg-votes-fixture',
      sourceUrl: 'https://example.test/ut.json',
      license: 'state_open_records',
      expectedMinRows: 0,
      fetch: async () => ({ rawBody: '{"fake": true}' }),
      parse: async (): Promise<StateLegVoteRow[]> => [
        {
          legislator_name: 'Jane Smith',
          legislator_district: '10',
          legislator_party: 'R',
          bill_identifier: 'HB0001',
          bill_title: 'General Appropriations',
          vote_date: '2025-02-14',
          position: 'yea',
          chamber: 'lower',
          session_year: 2025,
          source_url: 'https://le.utah.gov/~2025/bills/static/HB0001.html',
          source_row_id: 'fixture-1',
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
    assert.equal(irRow.row.adapter_name, 'leg-votes-utah-leg-votes-fixture');
    assert.equal(irRow.row.state_fips, '49');

    const dsRow = sbState.inserted.find((i) => i.table === 'data_sources');
    assert.ok(dsRow, 'data_sources row inserted');
    assert.equal(dsRow.row.state_fips, '49');
    assert.equal(dsRow.row.source_type, 'legislator_votes');

    const slvRow = sbState.inserted.find((i) => i.table === 'state_legislator_votes');
    assert.ok(slvRow, 'state_legislator_votes row inserted');
    assert.equal(slvRow.row.state, 'UT');
    assert.equal(slvRow.row.chamber, 'lower');
    assert.equal(slvRow.row.bill_identifier, 'HB0001');
    assert.equal(slvRow.row.position, 'yea');
    assert.equal(slvRow.row.source, 'direct_scrape');
    assert.equal(slvRow.row.legislator_ocd_id, 'ocd-ut-house-10');
  });

  it('validateRow rejects invalid position / chamber / date', async () => {
    const adapter = createStateVotesAdapter({
      stateFips: '49',
      stateAbbrev: 'UT',
      sourceName: 'ut-test',
      sourceUrl: 'https://example.test/',
      license: 'state_open_records',
      expectedMinRows: 0,
      fetch: async () => ({ rawBody: '' }),
      parse: async () => [],
    });
    assert.ok(adapter.validateRow);
    // Invalid position
    assert.ok(
      adapter.validateRow!({
        legislator_name: 'Jane Smith',
        legislator_district: null,
        legislator_party: null,
        bill_identifier: 'HB1',
        bill_title: null,
        vote_date: null,
        // @ts-expect-error — intentional invalid
        position: 'bogus',
        chamber: 'lower',
        session_year: 2025,
        source_url: null,
        source_row_id: 'x',
      }),
    );
    // Missing legislator name
    assert.ok(
      adapter.validateRow!({
        legislator_name: '',
        legislator_district: null,
        legislator_party: null,
        bill_identifier: 'HB1',
        bill_title: null,
        vote_date: null,
        position: 'yea',
        chamber: 'lower',
        session_year: 2025,
        source_url: null,
        source_row_id: 'x',
      }),
    );
    // Valid row returns null
    assert.equal(
      adapter.validateRow!({
        legislator_name: 'Jane Smith',
        legislator_district: null,
        legislator_party: null,
        bill_identifier: 'HB1',
        bill_title: null,
        vote_date: '2025-02-14',
        position: 'yea',
        chamber: 'lower',
        session_year: 2025,
        source_url: null,
        source_row_id: 'x',
      }),
      null,
    );
  });
});
