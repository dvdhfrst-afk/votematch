/**
 * Tests for the adapter escalation path (council #44, 2026-05-03).
 *
 * Covers the writeAdapterBackoff → escalateAdapter handoff at the 2nd
 * consecutive no_data outcome. Uses a hand-rolled pg-Pool mock that
 * captures every query and returns canned rows. No live DB required.
 *
 * Run:
 *   npx tsx --test src/lib/adapters/__tests__/escalation.test.ts
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';

import {
  __writeAdapterBackoff,
  __escalateAdapter,
  __ESCALATION_THRESHOLD_NO_DATA,
  __ESCALATED_NEXT_CHECK_AT,
} from '../run';

// ---------------------------------------------------------------------------
// Mock pool — minimal, query-by-substring matching
// ---------------------------------------------------------------------------

type Query = { sql: string; params: readonly unknown[] };

interface MockPool {
  pool: Pool;
  queries: Query[];
  // Test rigging: which counter value to return when the no_data UPSERT runs.
  setConsecutiveNoData: (n: number) => void;
  // Test rigging: which failure rows to return when the dossier query runs.
  setFailureHistory: (rows: ReadonlyArray<Record<string, unknown>>) => void;
  // Test rigging: simulate a row already-open in the escalation queue.
  setEscalationConflict: (alreadyOpen: boolean) => void;
}

function makeMockPool(): MockPool {
  const queries: Query[] = [];
  let consecutiveNoData = 1;
  let failureHistory: ReadonlyArray<Record<string, unknown>> = [];
  let escalationConflict = false;

  const pool = {
    async query(sql: string, params: readonly unknown[] = []) {
      queries.push({ sql, params });

      // adapter_status UPSERT for no_data — returns the new counter value.
      if (sql.includes('INSERT INTO adapter_status') && sql.includes('consecutive_no_data')) {
        return { rows: [{ consecutive_no_data: consecutiveNoData }] };
      }
      // SELECT recent failed runs for the dossier.
      if (sql.includes('FROM ingestion_runs') && sql.includes("status IN ('failed'")) {
        return { rows: failureHistory };
      }
      // Escalation INSERT (CTE-form). Returns id unless a row is already open.
      if (sql.includes('INSERT INTO adapter_escalations')) {
        if (escalationConflict) return { rows: [] };
        return { rows: [{ id: 'esc-mock-uuid-0001' }] };
      }
      // adapter_status update to status='escalated'.
      if (sql.includes('escalated')) return { rows: [] };
      // Plain backoff UPDATE on adapter_status.
      if (sql.includes('UPDATE adapter_status')) return { rows: [] };
      return { rows: [] };
    },
  } as unknown as Pool;

  return {
    pool,
    queries,
    setConsecutiveNoData: (n) => { consecutiveNoData = n; },
    setFailureHistory: (r) => { failureHistory = r; },
    setEscalationConflict: (b) => { escalationConflict = b; },
  };
}

function findQuery(queries: readonly Query[], substring: string): Query | undefined {
  return queries.find((q) => q.sql.includes(substring));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('writeAdapterBackoff — no_data escalation handoff', () => {
  let mock: MockPool;
  beforeEach(() => {
    mock = makeMockPool();
  });

  it('1st consecutive no_data: applies normal backoff, does NOT escalate', async () => {
    mock.setConsecutiveNoData(1);
    await __writeAdapterBackoff({
      pool: mock.pool,
      adapterName: 'cf-test',
      stateFips: '36',
      outcome: 'no_data',
    });
    // Counter UPSERT should have run.
    assert.ok(findQuery(mock.queries, 'INSERT INTO adapter_status'));
    // Plain backoff UPDATE should have run.
    const updateQ = findQuery(mock.queries, "now() + ($2 || ' minutes')::interval");
    assert.ok(updateQ, 'expected the normal backoff UPDATE');
    // The escalation insert should NOT have run.
    assert.equal(
      findQuery(mock.queries, 'INSERT INTO adapter_escalations'),
      undefined,
      'must not escalate on the first failure',
    );
    // Status UPDATE to 'escalated' must NOT have run.
    assert.equal(
      mock.queries.some((q) => q.sql.includes("'escalated'")),
      false,
    );
  });

  it(`Nth consecutive no_data (>=${__ESCALATION_THRESHOLD_NO_DATA}): escalates and parks adapter`, async () => {
    mock.setConsecutiveNoData(2);  // crosses the threshold
    mock.setFailureHistory([
      {
        id: 'run-001',
        status: 'failed',
        error_summary: 'state-cf fetch: HTTP 403 for https://elections.ny.gov/campaign-finance',
        finished_at: new Date('2026-05-02T12:00:00Z'),
        expected_min_rows: 50,
      },
    ]);
    await __writeAdapterBackoff({
      pool: mock.pool,
      adapterName: 'cf-new-york-sboe-cf',
      stateFips: '36',
      outcome: 'no_data',
    });

    // Escalation INSERT must have fired.
    const escInsert = findQuery(mock.queries, 'INSERT INTO adapter_escalations');
    assert.ok(escInsert, 'expected escalation INSERT');
    // The CTE should carry the failure_history JSON and the source URL.
    const params = escInsert!.params;
    assert.equal(params[0], 'cf-new-york-sboe-cf');
    assert.equal(params[1], '36');
    const historyJson = JSON.parse(params[2] as string) as Array<{ status: string }>;
    assert.equal(historyJson.length, 1);
    assert.equal(historyJson[0]?.status, 'failed');
    assert.equal(params[3], 'https://elections.ny.gov/campaign-finance');

    // adapter_status flipped to 'escalated' with far-future next_check_at.
    const parkQ = mock.queries.find((q) =>
      q.sql.includes("'escalated'") && q.sql.includes('INSERT INTO adapter_status'),
    );
    assert.ok(parkQ, 'expected adapter_status UPSERT to escalated');
    assert.ok(
      parkQ!.params.includes(__ESCALATED_NEXT_CHECK_AT),
      `expected next_check_at sentinel ${__ESCALATED_NEXT_CHECK_AT} in params`,
    );

    // The normal backoff UPDATE must NOT have run.
    assert.equal(
      findQuery(mock.queries, "now() + ($2 || ' minutes')::interval"),
      undefined,
      'normal backoff UPDATE must NOT run when we escalate',
    );
  });

  it('escalation never throws even when the failure-history query errors', async () => {
    // Replace the pool with one that throws on the SELECT.
    const errorPool = {
      async query(sql: string, _params: readonly unknown[] = []) {
        if (sql.includes('INSERT INTO adapter_status') && sql.includes('consecutive_no_data')) {
          return { rows: [{ consecutive_no_data: 2 }] };
        }
        if (sql.includes('FROM ingestion_runs')) {
          throw new Error('simulated DB error during dossier read');
        }
        if (sql.includes('INSERT INTO adapter_escalations')) {
          return { rows: [{ id: 'esc-mock' }] };
        }
        return { rows: [] };
      },
    } as unknown as Pool;

    // Should not throw.
    await __writeAdapterBackoff({
      pool: errorPool,
      adapterName: 'cf-test',
      stateFips: '36',
      outcome: 'no_data',
    });
  });

  it('successive failures while already escalated: escalation INSERT no-ops via CTE', async () => {
    mock.setConsecutiveNoData(5);
    mock.setEscalationConflict(true);  // simulates an open row already exists

    await __writeAdapterBackoff({
      pool: mock.pool,
      adapterName: 'cf-test',
      stateFips: '36',
      outcome: 'no_data',
    });

    // The CTE INSERT still ran (correctly) but returned 0 rows.
    assert.ok(findQuery(mock.queries, 'INSERT INTO adapter_escalations'));
    // adapter_status park-as-escalated still updates (idempotent).
    assert.ok(
      mock.queries.some((q) =>
        q.sql.includes("'escalated'") && q.sql.includes('INSERT INTO adapter_status'),
      ),
    );
  });

  it('success_with_rows resets state and does NOT touch escalations', async () => {
    await __writeAdapterBackoff({
      pool: mock.pool,
      adapterName: 'cf-test',
      stateFips: '36',
      outcome: 'success_with_rows',
    });
    // Reset path (consecutive_unchanged=0, consecutive_no_data=0).
    const resetQ = findQuery(mock.queries, "consecutive_no_data = 0");
    assert.ok(resetQ, 'expected reset UPSERT on success_with_rows');
    assert.equal(
      findQuery(mock.queries, 'INSERT INTO adapter_escalations'),
      undefined,
      'success path must not touch escalations',
    );
  });
});

describe('escalateAdapter — direct invocation', () => {
  it('extracts URL from the most recent error_summary', async () => {
    const mock = makeMockPool();
    mock.setFailureHistory([
      {
        id: 'run-A',
        status: 'failed',
        error_summary: 'state-cf fetch: HTTP 403 for https://example.gov/path?q=1',
        finished_at: new Date('2026-05-02T12:00:00Z'),
        expected_min_rows: null,
      },
    ]);
    await __escalateAdapter(mock.pool, 'cf-some-state', '12', 2);

    const escInsert = findQuery(mock.queries, 'INSERT INTO adapter_escalations');
    assert.ok(escInsert);
    // 4th param = source_url, extracted via regex.
    assert.equal(escInsert!.params[3], 'https://example.gov/path?q=1');
  });

  it('handles empty failure history gracefully (source_url null)', async () => {
    const mock = makeMockPool();
    mock.setFailureHistory([]);
    await __escalateAdapter(mock.pool, 'cf-empty', '49', 2);
    const escInsert = findQuery(mock.queries, 'INSERT INTO adapter_escalations');
    assert.ok(escInsert);
    assert.equal(escInsert!.params[3], null);
  });
});
