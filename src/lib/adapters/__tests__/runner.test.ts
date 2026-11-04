/**
 * Runner lifecycle tests for the source-adapter framework.
 *
 * Self-contained harness — no test framework dependency. Run with:
 *   npx tsx src/lib/adapters/__tests__/runner.test.ts
 *
 * Mocks the Supabase client + pg Pool so no live DB is required. Follows
 * the script-harness convention already used in scripts/test-retention-pipeline.ts.
 *
 * Cases covered:
 *   1. Successful run → ingestion_runs(status='success') with correct counts.
 *   2. Throwing adapter → status='failed' with error_summary.
 *   3. Below 80% floor → status='partial'.
 *   4. Advisory-lock collision → status='rejected_concurrent', no data_sources row.
 *   5. Dry-run → no data persisted but ingestion_runs records the attempt.
 */

import type { Pool } from 'pg';
import type { SupabaseClient } from '@supabase/supabase-js';
import { runAdapter } from '../run';
import type {
  AdapterContext,
  AdapterOutcome,
  InsertRefs,
  InsertStats,
  SourceAdapter,
} from '../types';

// ---------------------------------------------------------------------------
// Mock infrastructure
// ---------------------------------------------------------------------------

type InsertedRow = { table: string; row: Record<string, unknown> };
type UpdatedRow = { table: string; patch: Record<string, unknown>; id: string };
type PgQueryCall = { sql: string; params: unknown[] };

type MockSupabaseState = {
  inserted: InsertedRow[];
  updated: UpdatedRow[];
  /** next id used for synthesized .select('id').single() responses */
  nextId: number;
  /** Precanned responses keyed by table for .select() chains */
  selectStubs: Record<
    string,
    (filter: Record<string, unknown>) => { data: unknown; error: null } | { data: null; error: { message: string } | null }
  >;
};

function makeMockSupabase(): { supabase: SupabaseClient; state: MockSupabaseState } {
  const state: MockSupabaseState = {
    inserted: [],
    updated: [],
    nextId: 1,
    selectStubs: {},
  };

  function makeQuery(table: string) {
    // Builder is an object that returns itself from chaining methods and is
    // `await`able (it is thenable) returning a generic ok response; the
    // terminal methods (.single / .maybeSingle) also return a Promise.
    const filters: Record<string, unknown> = {};
    const self: Record<string, unknown> = {
      insert: (row: Record<string, unknown> | Record<string, unknown>[]) => {
        const rows = Array.isArray(row) ? row : [row];
        for (const r of rows) state.inserted.push({ table, row: r });
        // Cache the last insert so .select('id').single() can return the id.
        (self as { _lastInsert?: Record<string, unknown>[] })._lastInsert = rows;
        return self;
      },
      update: (patch: Record<string, unknown>) => {
        (self as { _lastUpdate?: Record<string, unknown> })._lastUpdate = patch;
        return self;
      },
      upsert: (row: Record<string, unknown>) => {
        state.inserted.push({ table, row });
        (self as { _lastInsert?: Record<string, unknown>[] })._lastInsert = [row];
        return self;
      },
      select: (_cols: string) => self,
      eq: (col: string, val: unknown) => {
        filters[col] = val;
        if ((self as { _lastUpdate?: Record<string, unknown> })._lastUpdate && col === 'id') {
          state.updated.push({
            table,
            id: String(val),
            patch: (self as { _lastUpdate?: Record<string, unknown> })._lastUpdate!,
          });
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
        const stub = state.selectStubs[table];
        if (stub) return stub(filters);
        return { data: null, error: null };
      },
      maybeSingle: async () => {
        const stub = state.selectStubs[table];
        if (stub) return stub(filters);
        return { data: null, error: null };
      },
      // Thenable — lets `await supabase.from(...).update(...).eq(...)` resolve.
      then: (resolve: (v: { data: null; error: null }) => void) =>
        resolve({ data: null, error: null }),
    };
    return self;
  }

  const supabase = {
    from: (table: string) => makeQuery(table),
  } as unknown as SupabaseClient;

  return { supabase, state };
}

type MockPgState = {
  queries: PgQueryCall[];
  /** When set, advisory lock query returns { locked: false } on the first call. */
  lockAlwaysFails: boolean;
  /** Captures the commit/rollback terminal call. */
  terminal: 'COMMIT' | 'ROLLBACK' | null;
};

function makeMockPool(initialLockFails = false): { pool: Pool; state: MockPgState } {
  const state: MockPgState = {
    queries: [],
    lockAlwaysFails: initialLockFails,
    terminal: null,
  };

  const client = {
    query: async (sql: string, params?: unknown[]) => {
      state.queries.push({ sql, params: params ?? [] });
      const sqlUpper = sql.trim().toUpperCase();
      if (sqlUpper === 'BEGIN') return { rows: [] };
      if (sqlUpper === 'COMMIT') {
        state.terminal = 'COMMIT';
        return { rows: [] };
      }
      if (sqlUpper === 'ROLLBACK') {
        state.terminal = 'ROLLBACK';
        return { rows: [] };
      }
      if (sql.includes('pg_try_advisory_xact_lock')) {
        return { rows: [{ locked: !state.lockAlwaysFails }] };
      }
      if (sql.includes('cost_cap_check_and_consume')) {
        return { rows: [{ ok: true }] };
      }
      return { rows: [] };
    },
    release: () => undefined,
  };

  const pool = {
    connect: async () => client,
    end: async () => undefined,
  } as unknown as Pool;

  return { pool, state };
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

type TestResult = { name: string; ok: boolean; detail?: string };
const results: TestResult[] = [];

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

async function runCase(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  OK  ${name}`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    results.push({ name, ok: false, detail });
    console.log(`  FAIL ${name} — ${detail}`);
  }
}

// ---------------------------------------------------------------------------
// Sample adapter fixtures
// ---------------------------------------------------------------------------

type FakeRow = { id: number; name: string };

function makeAdapter(
  overrides: Partial<SourceAdapter<FakeRow>> & {
    runImpl?: (ctx: AdapterContext) => Promise<AdapterOutcome<FakeRow>>;
    insertImpl?: (rows: FakeRow[], refs: InsertRefs, ctx: AdapterContext) => Promise<InsertStats>;
  } = {},
): SourceAdapter<FakeRow> {
  return {
    name: overrides.name ?? 'test-adapter',
    stateFips: overrides.stateFips ?? '49',
    costService: overrides.costService,
    estimatedCostUsd: overrides.estimatedCostUsd,
    validateRow: overrides.validateRow,
    async run(ctx) {
      if (overrides.runImpl) return overrides.runImpl(ctx);
      return {
        rows: [
          { id: 1, name: 'alpha' },
          { id: 2, name: 'beta' },
          { id: 3, name: 'gamma' },
        ],
        expectedMinRows: 3,
        source: {
          sourceType: 'other',
          name: 'Fixture Source',
          url: 'https://example.test/fixture',
          contentHash: 'deadbeef'.repeat(8),
          license: 'public_domain',
          stateFips: '49',
        },
      };
    },
    async insert(rows, _refs, _ctx) {
      if (overrides.insertImpl) return overrides.insertImpl(rows, _refs, _ctx);
      return {
        rowsInserted: rows.length,
        rowsUpdated: 0,
        rowsSkipped: 0,
        rowsFailed: 0,
        errors: [],
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

async function caseSuccess() {
  const { supabase, state: sbState } = makeMockSupabase();
  const { pool } = makeMockPool();

  const adapter = makeAdapter();
  const result = await runAdapter(adapter, { supabase, pg: pool, gitSha: 'test-sha' });

  assert(result.status === 'success', `expected success, got ${result.status}`);
  assert(result.stats?.rowsInserted === 3, `expected rowsInserted=3, got ${result.stats?.rowsInserted}`);

  // An ingestion_runs row was inserted, and was updated twice (link + final).
  const irInserts = sbState.inserted.filter((i) => i.table === 'ingestion_runs');
  assert(irInserts.length === 1, `expected 1 ingestion_runs insert, got ${irInserts.length}`);
  assert(irInserts[0].row.status === 'running', 'initial status should be running');

  const irUpdates = sbState.updated.filter((u) => u.table === 'ingestion_runs');
  const finalUpdate = irUpdates.find((u) => u.patch.status === 'success');
  assert(finalUpdate, 'expected an ingestion_runs update with status=success');
  assert(finalUpdate.patch.rows_inserted === 3, 'final rows_inserted should be 3');

  // data_sources was upserted once.
  const dsInserts = sbState.inserted.filter((i) => i.table === 'data_sources');
  assert(dsInserts.length === 1, `expected 1 data_sources insert, got ${dsInserts.length}`);
}

async function caseThrowingAdapter() {
  const { supabase, state: sbState } = makeMockSupabase();
  const { pool } = makeMockPool();

  const adapter = makeAdapter({
    runImpl: async () => {
      throw new Error('parser exploded');
    },
  });
  const result = await runAdapter(adapter, { supabase, pg: pool, gitSha: 'test-sha' });

  assert(result.status === 'failed', `expected failed, got ${result.status}`);
  assert(result.reason?.includes('parser exploded'), `reason should include the thrown message: ${result.reason}`);

  const irUpdates = sbState.updated.filter((u) => u.table === 'ingestion_runs');
  const failedUpdate = irUpdates.find((u) => u.patch.status === 'failed');
  assert(failedUpdate, 'expected an ingestion_runs update with status=failed');
  assert(
    typeof failedUpdate.patch.error_summary === 'string' &&
      (failedUpdate.patch.error_summary as string).includes('parser exploded'),
    'error_summary should capture the thrown message',
  );
}

async function casePartialBelowFloor() {
  const { supabase, state: sbState } = makeMockSupabase();
  const { pool } = makeMockPool();

  // expected floor: ceil(10 * 0.8) = 8. We return 3 rows; insert reports 3
  // inserted, 0 updated — 3 < 8 → partial.
  const adapter = makeAdapter({
    runImpl: async () => ({
      rows: [
        { id: 1, name: 'a' },
        { id: 2, name: 'b' },
        { id: 3, name: 'c' },
      ],
      expectedMinRows: 10,
      source: {
        sourceType: 'other',
        name: 'Partial Source',
        url: 'https://example.test/partial',
        contentHash: 'aa'.repeat(32),
        license: 'public_domain',
      },
    }),
    insertImpl: async (rows) => ({
      rowsInserted: rows.length,
      rowsUpdated: 0,
      rowsSkipped: 0,
      rowsFailed: 0,
      errors: [],
    }),
  });

  const result = await runAdapter(adapter, { supabase, pg: pool, gitSha: 'test-sha' });

  assert(result.status === 'partial', `expected partial, got ${result.status}`);
  const irUpdates = sbState.updated.filter((u) => u.table === 'ingestion_runs');
  const partialUpdate = irUpdates.find((u) => u.patch.status === 'partial');
  assert(partialUpdate, 'expected an ingestion_runs update with status=partial');
}

async function caseLockCollision() {
  const { supabase, state: sbState } = makeMockSupabase();
  const { pool } = makeMockPool(true); // advisory lock always fails

  const adapter = makeAdapter();
  const result = await runAdapter(adapter, { supabase, pg: pool, gitSha: 'test-sha' });

  assert(
    result.status === 'rejected_concurrent',
    `expected rejected_concurrent, got ${result.status}`,
  );

  // Spec: no rows are created when the lock is unavailable.
  const dsInserts = sbState.inserted.filter((i) => i.table === 'data_sources');
  assert(dsInserts.length === 0, `expected 0 data_sources inserts, got ${dsInserts.length}`);
  const irInserts = sbState.inserted.filter((i) => i.table === 'ingestion_runs');
  assert(irInserts.length === 0, `expected 0 ingestion_runs inserts, got ${irInserts.length}`);
}

async function caseDryRun() {
  const { supabase, state: sbState } = makeMockSupabase();
  const { pool, state: pgState } = makeMockPool();

  const adapter = makeAdapter();
  const result = await runAdapter(adapter, {
    supabase,
    pg: pool,
    dryRun: true,
    gitSha: 'test-sha',
  });

  assert(result.status === 'skipped', `expected skipped, got ${result.status}`);

  // pg transaction was rolled back, not committed.
  assert(pgState.terminal === 'ROLLBACK', `expected ROLLBACK, got ${pgState.terminal}`);

  // ingestion_runs still records the attempt (survives rollback because it
  // goes through the independent supabase client).
  const irInserts = sbState.inserted.filter((i) => i.table === 'ingestion_runs');
  assert(irInserts.length === 1, `expected 1 ingestion_runs insert, got ${irInserts.length}`);
  const irUpdates = sbState.updated.filter((u) => u.table === 'ingestion_runs');
  const skippedUpdate = irUpdates.find((u) => u.patch.status === 'skipped');
  assert(skippedUpdate, 'expected an ingestion_runs update with status=skipped');
  const meta = skippedUpdate.patch.meta as { dry_run?: boolean } | undefined;
  assert(meta?.dry_run === true, 'meta.dry_run should be true on the skipped update');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('\nadapter runner lifecycle tests');
  console.log('================================');
  await runCase('1. successful run → status=success + counts', caseSuccess);
  await runCase('2. throwing adapter → status=failed with error_summary', caseThrowingAdapter);
  await runCase('3. rows below 80% floor → status=partial', casePartialBelowFloor);
  await runCase('4. advisory-lock collision → rejected_concurrent, no rows', caseLockCollision);
  await runCase('5. dry-run → data rolled back, audit row kept', caseDryRun);

  const failed = results.filter((r) => !r.ok);
  console.log('');
  if (failed.length > 0) {
    console.log(`FAILED: ${failed.length} of ${results.length}`);
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
    process.exitCode = 1;
  } else {
    console.log(`All ${results.length} tests passed.`);
  }
}

// Only run when invoked directly (tsx src/lib/adapters/__tests__/runner.test.ts),
// not when imported by a future test runner.
// tsx treats `import.meta.url` as a file:// URL; argv[1] is the script path.
const invokedDirectly = (() => {
  try {
    const entry = process.argv[1] ?? '';
    return entry.includes('runner.test');
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { main as runRunnerTests };
