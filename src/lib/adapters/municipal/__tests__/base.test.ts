/**
 * Unit tests for the municipal-meetings adapter + Legistar + Granicus parsers.
 *
 * Self-contained — no DB, no network, no Claude. Uses node:test + node:assert
 * and is run via:
 *
 *   npx tsx --test src/lib/adapters/municipal/__tests__/base.test.ts
 *
 * Coverage:
 *   1. Legistar URL builder encodes the filter window correctly
 *   2. Legistar parser: synthetic JSON → intermediate rows with times combined
 *   3. Legistar classifyBody routes school/planning/council/other
 *   4. Granicus parser: synthetic HTML → rows with date + agenda href resolved
 *   5. Granicus parseGranicusDate handles 'Apr 29, 2026 - 10:00 AM'
 *   6. createMunicipalMeetingsAdapter: unknown city throws
 *   7. createMunicipalMeetingsAdapter: 'todo' city throws
 *   8. createMunicipalMeetingsAdapter: integration via runAdapter → writes municipal_meetings
 *   9. validateRow rejects empty title and bad confidence
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { Pool } from 'pg';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  createMunicipalMeetingsAdapter,
  type MunicipalMeetingRow,
} from '../base';
import {
  buildLegistarEventsUrl,
  classifyBody,
  combineLegistarDateTime,
  parseLegistarEvents,
  type LegistarEvent,
} from '../platform-legistar';
import {
  parseGranicusCalendar,
  parseGranicusDate,
} from '../platform-granicus';
import { runAdapter } from '../../run';

// ---------------------------------------------------------------------------
// 1. Legistar URL builder
// ---------------------------------------------------------------------------

describe('legistar url builder', () => {
  it('1. includes date window + $top and omits token when no key', () => {
    const url = buildLegistarEventsUrl({
      client: 'chicago',
      sinceIso: '2026-04-23T00:00:00Z',
      untilIso: '2026-05-23T23:59:59Z',
      fetchFn: async () => ({ status: 200, body: '[]' }),
    });
    assert.ok(url.startsWith('https://webapi.legistar.com/v1/chicago/Events?'));
    assert.ok(url.includes('%24filter='));
    assert.ok(url.includes("datetime%272026-04-23%27"));
    assert.ok(url.includes("datetime%272026-05-23%27"));
    assert.ok(url.includes('%24top=1000'));
    assert.ok(!url.includes('token='));
  });

  it('1b. appends token when apiKey is supplied', () => {
    const url = buildLegistarEventsUrl({
      client: 'seattle',
      sinceIso: '2026-04-23',
      untilIso: '2026-04-30',
      apiKey: 'test-api-key',
      fetchFn: async () => ({ status: 200, body: '[]' }),
    });
    assert.ok(url.includes('token=test-api-key'));
  });
});

// ---------------------------------------------------------------------------
// 2 + 3. Legistar parser + body classifier
// ---------------------------------------------------------------------------

describe('legistar parser', () => {
  const events: LegistarEvent[] = [
    {
      EventId: 42,
      EventBodyName: 'City Council',
      EventDate: '2026-04-29T00:00:00',
      EventTime: '10:00 AM',
      EventLocation: 'City Hall',
      EventAgendaFile: 'https://example.test/agenda-42.pdf',
      EventMinutesFile: null,
      EventInSiteURL: 'https://chicago.legistar.com/MeetingDetail.aspx?ID=42',
      EventComment: null,
    },
    {
      EventId: 43,
      EventBodyName: 'Committee on Education and Child Development',
      EventDate: '2026-05-01T00:00:00',
      EventTime: '2:30 PM',
      EventLocation: null,
      EventAgendaFile: null,
      EventMinutesFile: null,
      EventInSiteURL: null,
      EventComment: null,
    },
    {
      // Missing date → should be filtered out
      EventId: 44,
      EventBodyName: 'Phantom Meeting',
      EventDate: '',
      EventTime: null,
      EventLocation: null,
      EventAgendaFile: null,
      EventMinutesFile: null,
      EventInSiteURL: null,
      EventComment: null,
    },
  ];

  it('2. maps events to rows and drops ones missing a date', () => {
    const rows = parseLegistarEvents(events, 'chicago');
    assert.equal(rows.length, 2);

    const council = rows.find((r) => r.title === 'City Council');
    assert.ok(council, 'city council row present');
    assert.equal(council.jurisdiction_type, 'city_council');
    assert.equal(council.meeting_datetime, '2026-04-29T10:00:00');
    assert.equal(council.agenda_url, 'https://example.test/agenda-42.pdf');
    assert.equal(
      council.source_url,
      'https://chicago.legistar.com/MeetingDetail.aspx?ID=42',
    );

    const edu = rows.find((r) => r.title.startsWith('Committee on Education'));
    assert.ok(edu);
    assert.equal(edu.jurisdiction_type, 'school_board');
    assert.equal(edu.meeting_datetime, '2026-05-01T14:30:00');
    // Fallback URL synthesis when EventInSiteURL is null.
    assert.equal(
      edu.source_url,
      'https://chicago.legistar.com/MeetingDetail.aspx?ID=43',
    );
  });

  it('3. classifyBody routes body names to jurisdiction_type', () => {
    assert.equal(classifyBody('City Council'), 'city_council');
    assert.equal(classifyBody('Planning Commission'), 'planning');
    assert.equal(classifyBody('Board of Education'), 'school_board');
    assert.equal(classifyBody('Ethics Advisory Board'), 'other');
  });

  it('3b. combineLegistarDateTime handles AM/PM + 12 o\'clock edge', () => {
    assert.equal(
      combineLegistarDateTime('2026-04-29T00:00:00', '12:00 PM'),
      '2026-04-29T12:00:00',
    );
    assert.equal(
      combineLegistarDateTime('2026-04-29T00:00:00', '12:00 AM'),
      '2026-04-29T00:00:00',
    );
    // null time falls back to midnight.
    assert.equal(
      combineLegistarDateTime('2026-04-29T00:00:00', null),
      '2026-04-29T00:00:00',
    );
  });
});

// ---------------------------------------------------------------------------
// 4 + 5. Granicus parser
// ---------------------------------------------------------------------------

const SYNTHETIC_GRANICUS_HTML = `
<html><body>
<table class="listingTable">
  <tr class="listingRow">
    <td class="listItem" headers="Name">City Council Meeting</td>
    <td class="listItem" headers="Date">Apr 29, 2026 - 10:00 AM</td>
    <td class="listItem" headers="Agenda"><a href="/AgendaViewer.php?event_id=101">Agenda</a></td>
    <td class="listItem" headers="Minutes"><a href="/MinutesViewer.php?event_id=101">Minutes</a></td>
  </tr>
  <tr class="listingRow">
    <td class="listItem" headers="Name">Planning Commission &amp; Zoning</td>
    <td class="listItem" headers="Date">May 3, 2026 6:00 PM</td>
    <td class="listItem" headers="Agenda"><a href="https://absolute.test/a.pdf">Agenda</a></td>
  </tr>
  <tr class="listingRow">
    <td class="listItem" headers="Name"></td>
    <td class="listItem" headers="Date">Unparseable date string</td>
  </tr>
</table>
</body></html>`;

describe('granicus parser', () => {
  it('4. parses synthetic calendar into rows and resolves relative hrefs', () => {
    const rows = parseGranicusCalendar(SYNTHETIC_GRANICUS_HTML, {
      baseUrl: 'https://www.austintexas.gov/calendar',
    });
    assert.equal(rows.length, 2);

    const council = rows[0];
    assert.equal(council.title, 'City Council Meeting');
    assert.equal(council.meeting_datetime, '2026-04-29T10:00:00');
    assert.equal(council.jurisdiction_type, 'city_council');
    assert.equal(
      council.agenda_url,
      'https://www.austintexas.gov/AgendaViewer.php?event_id=101',
    );
    assert.equal(
      council.minutes_url,
      'https://www.austintexas.gov/MinutesViewer.php?event_id=101',
    );

    const planning = rows[1];
    assert.equal(planning.title, 'Planning Commission & Zoning');
    assert.equal(planning.jurisdiction_type, 'planning');
    assert.equal(planning.meeting_datetime, '2026-05-03T18:00:00');
    // Absolute hrefs are preserved.
    assert.equal(planning.agenda_url, 'https://absolute.test/a.pdf');
  });

  it('5. parseGranicusDate handles Granicus variants', () => {
    assert.equal(parseGranicusDate('Apr 29, 2026 - 10:00 AM'), '2026-04-29T10:00:00');
    assert.equal(parseGranicusDate('April 3, 2026 6:00 PM'), '2026-04-03T18:00:00');
    assert.equal(parseGranicusDate('Jan 1, 2026'), '2026-01-01T00:00:00');
    assert.equal(parseGranicusDate('not a date at all'), null);
  });
});

// ---------------------------------------------------------------------------
// 6 + 7. Factory guards
// ---------------------------------------------------------------------------

describe('createMunicipalMeetingsAdapter factory guards', () => {
  it('6. unknown city throws a descriptive error', () => {
    assert.throws(
      () => createMunicipalMeetingsAdapter({ cityKey: 'atlantis' }),
      /unknown cityKey "atlantis"/,
    );
  });

  it('7. todo-platform city throws with a follow-up pointer', () => {
    assert.throws(
      () => createMunicipalMeetingsAdapter({ cityKey: 'phoenix' }),
      /marked 'todo'/,
    );
  });

  it('9. adapter.validateRow rejects empty title + bad confidence', () => {
    const adapter = createMunicipalMeetingsAdapter({
      cityKey: 'chicago',
      fetchOverride: async () => ({ status: 200, body: '[]' }),
    });
    assert.ok(adapter.validateRow);
    const bad1: MunicipalMeetingRow = {
      state: 'IL',
      jurisdiction: 'Chicago',
      jurisdiction_type: 'city_council',
      title: '',
      meeting_datetime: '2026-04-29T10:00:00',
      agenda_url: null,
      minutes_url: null,
      source_url: 'https://x',
      platform: 'legistar',
      topic_tags: [],
      confidence_score: 1,
      source_row_id: 'x',
    };
    assert.equal(adapter.validateRow!(bad1), 'missing title');

    const bad2: MunicipalMeetingRow = { ...bad1, title: 'Council', confidence_score: 2 };
    assert.match(String(adapter.validateRow!(bad2)), /confidence_score/);

    const ok: MunicipalMeetingRow = { ...bad1, title: 'Council' };
    assert.equal(adapter.validateRow!(ok), null);
  });
});

// ---------------------------------------------------------------------------
// 8. Integration via runAdapter — miniature mock copy-paste
// ---------------------------------------------------------------------------

function makeMiniMockSupabase(): {
  supabase: SupabaseClient;
  state: { inserted: Array<{ table: string; row: Record<string, unknown> }> };
} {
  const state = {
    inserted: [] as Array<{ table: string; row: Record<string, unknown> }>,
    nextId: 1,
  };
  function makeQuery(table: string): Record<string, unknown> {
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
      eq: () => self,
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
        if (last && table === 'municipal_meetings') {
          resolve({
            data: last.map((_r, i) => ({ id: `mm-${i}` })),
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

function makeMiniMockPool(): { pool: Pool } {
  const client = {
    query: async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('pg_try_advisory_xact_lock')) return { rows: [{ locked: true }] };
      if (sql.includes('cost_cap_check_and_consume')) return { rows: [{ ok: true }] };
      return { rows: [] };
    },
    release: () => undefined,
  };
  const pool = {
    connect: async () => client,
    end: async () => undefined,
    query: async () => ({ rows: [] }),
  } as unknown as Pool;
  return { pool };
}

describe('createMunicipalMeetingsAdapter — integration via runAdapter', () => {
  it('8. legistar end-to-end writes municipal_meetings via runAdapter', async () => {
    const syntheticEvents: LegistarEvent[] = [
      {
        EventId: 9001,
        EventBodyName: 'City Council',
        // Well inside the 30-day lookahead so it survives filtering.
        EventDate: new Date(Date.now() + 7 * 86_400_000)
          .toISOString()
          .slice(0, 10),
        EventTime: '10:00 AM',
        EventLocation: 'City Hall',
        EventAgendaFile: 'https://example.test/agenda.pdf',
        EventMinutesFile: null,
        EventInSiteURL: 'https://chicago.legistar.com/MeetingDetail.aspx?ID=9001',
        EventComment: null,
      },
    ];

    const adapter = createMunicipalMeetingsAdapter({
      cityKey: 'chicago',
      daysAhead: 30,
      fetchOverride: async () => ({
        status: 200,
        body: JSON.stringify(syntheticEvents),
      }),
    });

    const { supabase, state: sbState } = makeMiniMockSupabase();
    const { pool } = makeMiniMockPool();

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
    assert.equal(irRow.row.adapter_name, 'municipal-chicago');
    assert.equal(irRow.row.state_fips, '17');

    const dsRow = sbState.inserted.find((i) => i.table === 'data_sources');
    assert.ok(dsRow, 'data_sources row inserted');
    assert.equal(dsRow.row.source_type, 'municipal_meetings_portal');

    const mmRow = sbState.inserted.find((i) => i.table === 'municipal_meetings');
    assert.ok(mmRow, 'municipal_meetings row inserted');
    assert.equal(mmRow.row.state, 'IL');
    assert.equal(mmRow.row.jurisdiction, 'Chicago');
    assert.equal(mmRow.row.jurisdiction_type, 'city_council');
    assert.equal(mmRow.row.platform, 'legistar');
    assert.equal(mmRow.row.verified, true);
    assert.equal(mmRow.row.agenda_url, 'https://example.test/agenda.pdf');
  });

  it('8b. granicus end-to-end writes municipal_meetings via runAdapter', async () => {
    // Build a synthetic Granicus row with a date inside our lookahead window.
    const soon = new Date(Date.now() + 10 * 86_400_000);
    const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][soon.getUTCMonth()];
    const dateCell = `${mon} ${soon.getUTCDate()}, ${soon.getUTCFullYear()} - 10:00 AM`;
    const html = `
      <table>
        <tr class="listingRow">
          <td headers="Name">City Council Meeting</td>
          <td headers="Date">${dateCell}</td>
          <td headers="Agenda"><a href="/AgendaViewer.php?id=1">Agenda</a></td>
        </tr>
      </table>`;

    const adapter = createMunicipalMeetingsAdapter({
      cityKey: 'austin',
      daysAhead: 30,
      fetchOverride: async () => ({ status: 200, body: html }),
    });

    const { supabase, state: sbState } = makeMiniMockSupabase();
    const { pool } = makeMiniMockPool();

    const result = await runAdapter(adapter, {
      supabase,
      pg: pool,
      gitSha: 'test-sha',
    });

    assert.equal(result.status, 'success', `got ${result.status}: ${result.reason ?? ''}`);
    const mmRow = sbState.inserted.find((i) => i.table === 'municipal_meetings');
    assert.ok(mmRow, 'municipal_meetings row inserted');
    assert.equal(mmRow.row.state, 'TX');
    assert.equal(mmRow.row.jurisdiction, 'Austin');
    assert.equal(mmRow.row.platform, 'granicus');
    assert.equal(mmRow.row.verified, true);
  });
});
