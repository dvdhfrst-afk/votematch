/**
 * Shared runner for every source adapter.
 *
 * Lifecycle (see blueprint-v6 council review 2026-04-23 and the
 * data_sources + council_foundation migrations):
 *
 *   1. Capture git sha.
 *   2. Open a pg transaction and try pg_try_advisory_xact_lock on
 *      hashtext(name || '|' || stateFips). If another runner holds it,
 *      return {status:'rejected_concurrent'} without writing anything.
 *   3. Reserve cost via cost_cap_check_and_consume(service, estimate).
 *      If refused, return {status:'rejected_cost_cap'}.
 *   4. Insert ingestion_runs(status='running', git_sha, ...).
 *      This is written via the supabase client (separate connection) so
 *      it is always committed, even when the pg transaction holding the
 *      data writes is rolled back for a dry-run.
 *   5. Call adapter.run(ctx). On throw: mark ingestion_runs 'failed',
 *      rollback pg tx, return.
 *   6. Upsert data_sources on content_hash; stash id on ingestion_runs.
 *   7. Update ingestion_runs.expected_min_rows.
 *   8. If adapter.validateRow is defined, partition rows. Log invalids
 *      to ingestion_errors (error_type='validation').
 *   9. Call adapter.insert(validRows, refs, ctx) inside the pg tx.
 *  10. Classify status: failed if rowsFailed > rowsInserted;
 *      partial if (inserted + updated) < expected * 0.8;
 *      else success. Dry-runs always end 'skipped'.
 *  11. Commit (normal) or rollback (dry-run).
 *  12. Final update to ingestion_runs with counts + status + finished_at.
 *
 * Intentionally separate from pipeline_runs (Inngest / Claude-Batch
 * cost sentinel). That table is scoped to paid-batch scheduling; this
 * one is lineage per scraper run. Both patterns co-exist.
 */

import { execSync } from 'node:child_process';
import { hostname } from 'node:os';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { Pool, type PoolClient } from 'pg';
import type {
  AdapterContext,
  AdapterLogger,
  AdapterOutcome,
  AdapterRunResult,
  InsertStats,
  RunAdapterOptions,
  SourceAdapter,
} from './types';
import { reportIngestionFailure } from '@/lib/monitoring/sentry-report';

// ---------------------------------------------------------------------------
// External-kill finalizer (SIGTERM / SIGINT)
// ---------------------------------------------------------------------------
//
// 2026-04-25: when continuous-ingest's per-task timeout fires it killTree()s
// the tsx child with SIGKILL, which gives us no chance to clean up. Before
// that, the pool sends SIGTERM (or Ctrl+C sends SIGINT). We register one-shot
// handlers that best-effort UPDATE every in-flight ingestion_runs row to
// status='unknown_termination' so the row never leaks into 'running' forever.
//
// Bounded by a 5s wall clock so we don't block exit longer than the parent
// will wait before escalating to SIGKILL.

type InFlightRun = {
  ingestionRunId: string;
  adapterName: string;
  supabase: SupabaseClient;
};

const inFlightRuns = new Set<InFlightRun>();
let signalHandlersInstalled = false;

function installSignalHandlers(): void {
  if (signalHandlersInstalled) return;
  signalHandlersInstalled = true;

  const finalize = async (signal: string): Promise<void> => {
    if (inFlightRuns.size === 0) return;
    const runs = [...inFlightRuns];
    inFlightRuns.clear();
    const summary = `runner: process received ${signal} before adapter completed`;
    const finishedAt = new Date().toISOString();

    // Race each update against a 5s budget. If the DB call hangs we still exit.
    const updates = runs.map(async (r) => {
      try {
        await r.supabase
          .from('ingestion_runs')
          .update({
            status: 'unknown_termination',
            error_summary: summary,
            finished_at: finishedAt,
          })
          .eq('id', r.ingestionRunId)
          .eq('status', 'running'); // only finalize if still running
      } catch {
        /* best-effort */
      }
    });

    await Promise.race([
      Promise.allSettled(updates),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
  };

  const handler = (signal: 'SIGTERM' | 'SIGINT') => {
    void finalize(signal).finally(() => {
      // Re-raise default behavior: exit with the conventional 128+signo code.
      const code = signal === 'SIGINT' ? 130 : 143;
      process.exit(code);
    });
  };

  process.on('SIGTERM', () => handler('SIGTERM'));
  process.on('SIGINT', () => handler('SIGINT'));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function captureGitSha(override?: string): string {
  if (override) return override;
  try {
    const sha = execSync('git rev-parse HEAD', {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    if (sha) return sha;
  } catch {
    // git unavailable / not a repo — fall through to env
  }
  return process.env.GIT_SHA ?? 'unknown';
}

function defaultLogger(): AdapterLogger {
  /* eslint-disable no-console */
  return {
    info: (m, meta) => console.log(`[adapter] ${m}`, meta ?? ''),
    warn: (m, meta) => console.warn(`[adapter] ${m}`, meta ?? ''),
    error: (m, meta) => console.error(`[adapter] ${m}`, meta ?? ''),
  };
  /* eslint-enable no-console */
}

function defaultSupabase(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      'runAdapter: NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY must be set ' +
        '(or pass opts.supabase).',
    );
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function defaultPool(): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'runAdapter: DATABASE_URL must be set (or pass opts.pg with an existing Pool).',
    );
  }
  return new Pool({ connectionString });
}

function zeroStats(): InsertStats {
  return {
    rowsInserted: 0,
    rowsUpdated: 0,
    rowsSkipped: 0,
    rowsFailed: 0,
    errors: [],
  };
}

// ---------------------------------------------------------------------------
// Error formatting for `error_summary` — bug fix 2026-04-26.
//
// The failure-analyzer classifies runs by regex-matching `error_summary`. If
// that field is empty/null, every run lands in the 'unknown' bucket and
// triage is blind. The prior code stored `err.message` directly, which:
//
//   1. Yielded an empty string when `err` was an Error('') (rare but real —
//      e.g. some libraries `throw new Error()` without a message).
//   2. Yielded the literal string `"undefined"` / `"null"` for non-Error
//      throws (`throw undefined`, `throw null`, `throw {code:500}`).
//   3. Lost the error class name (TypeError vs RangeError vs HttpError),
//      which is often the most diagnostic single token.
//
// formatErrorSummary() fixes all three:
//   - Always produces a non-empty string for any throw value.
//   - Prefixes `[ClassName]` for Error subclasses with a useful message.
//   - For non-Error throws, falls back to `JSON.stringify` (with a guard
//     for circular refs) or `String()`.
//   - Scrubs Bearer/Authorization tokens that might appear in error
//     messages from fetch/HTTP libraries (defense-in-depth — we don't
//     currently send Bearer headers, but a future adapter might).
//   - Truncates to MAX_ERROR_SUMMARY_LEN (500). The runner DB columns
//     allow more, but 500 is enough for triage and prevents log bloat.
// ---------------------------------------------------------------------------

const MAX_ERROR_SUMMARY_LEN = 500;

/** Strip Bearer tokens, basic-auth credentials, and api-key query params. */
function scrubSecrets(s: string): string {
  return s
    // Bearer / Token <value>  →  Bearer [REDACTED]
    .replace(/\b(Bearer|Token)\s+[A-Za-z0-9._\-+/=]+/gi, '$1 [REDACTED]')
    // Authorization: ... header lines
    .replace(/\bAuthorization\s*:\s*\S+/gi, 'Authorization: [REDACTED]')
    // ?api_key=... / &key=... / ?token=... query params
    .replace(/([?&](?:api[_-]?key|key|token|access[_-]?token|secret)=)[^&\s"']+/gi, '$1[REDACTED]')
    // basic-auth credentials embedded in a URL authority (user and password before @)
    .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1[REDACTED]@');
}

function formatErrorSummary(err: unknown): string {
  let summary: string;
  if (err instanceof Error) {
    const className = err.constructor?.name || 'Error';
    const msg = typeof err.message === 'string' ? err.message.trim() : '';
    if (msg.length > 0) {
      summary = `[${className}] ${msg}`;
    } else {
      // Error with no message — surface class name + best-effort fallback
      // (some libraries throw `new TypeError()` with no message). Try to
      // include the stack's first frame, which usually contains the file:line.
      const firstStackFrame = typeof err.stack === 'string'
        ? err.stack.split('\n').find((l) => l.trim().startsWith('at ')) ?? ''
        : '';
      summary = firstStackFrame
        ? `[${className}] (no message) ${firstStackFrame.trim()}`
        : `[${className}] (no message)`;
    }
  } else if (err === undefined) {
    summary = '[non-Error throw] undefined';
  } else if (err === null) {
    summary = '[non-Error throw] null';
  } else if (typeof err === 'string') {
    summary = err.trim().length > 0
      ? `[non-Error throw] ${err}`
      : '[non-Error throw] (empty string)';
  } else {
    // Object / number / boolean — try JSON, fall back to String().
    let serialized: string;
    try {
      serialized = JSON.stringify(err);
      if (serialized === undefined) serialized = String(err);
    } catch {
      // Circular ref, BigInt, etc.
      serialized = String(err);
    }
    summary = `[non-Error throw] ${serialized}`;
  }

  return scrubSecrets(summary).slice(0, MAX_ERROR_SUMMARY_LEN);
}

// ---------------------------------------------------------------------------
// next_check_at backoff for chronic-unchanged adapters (council 2026-04-25).
//
// When an adapter chains 'unchanged' outcomes (content_hash unchanged,
// short-circuit before insert), it's pointless to keep checking it every
// cycle — ballot-measures-* adapters were burning ~13K worker-seconds/hour
// on this. We track `consecutive_unchanged` per adapter and push
// `next_check_at` further into the future as the chain gets longer.
//
// Schedule:
//   1st-2nd unchanged in a row: now() + 5 min   (cheap probe, no real backoff)
//   3rd-9th unchanged in a row: now() + 1 hour
//   10th+   unchanged in a row: now() + 6 hours
//   any non-unchanged outcome: reset to now() + 5 min (eligible immediately
//                              next cycle)
//
// continuous-ingest's buildTaskQueue() reads next_check_at and skips any
// adapter whose value is in the future.
// ---------------------------------------------------------------------------

function backoffMinutes(consecutive: number): number {
  if (consecutive >= 10) return 6 * 60; // 6 hours
  if (consecutive >= 3) return 60;       // 1 hour
  return 5;                              // 5 minutes (no real backoff)
}

// Council #44 (2026-05-03): on the Nth consecutive no_data outcome we stop
// backing off and route the adapter into the escalation queue for higher-tier
// triage. Threshold is intentionally tight — exponential backoff just slowly
// hides bugs, an escalation surfaces them. Operators can clear an escalation
// once the underlying URL/parser is fixed (resolve-adapter.ts).
const ESCALATION_THRESHOLD_NO_DATA = 2;

// When an adapter is escalated we set next_check_at to a far-future sentinel
// so continuous-ingest's task queue skips it indefinitely. resolve-adapter.ts
// resets this to now() + 5min when the escalation is closed.
const ESCALATED_NEXT_CHECK_AT = '2099-01-01T00:00:00Z';

/**
 * Outcomes the runner reports to the backoff bookkeeper.
 *
 *   success_with_rows  : rowsInserted+rowsUpdated > 0 AND status='success'.
 *                        Resets BOTH chronic counters; next_check = +5m.
 *   unchanged          : content-hash short-circuit fired. Bumps
 *                        consecutive_unchanged; tiered backoff.
 *   no_data            : 'unproductive' | 'failed' | 'partial' (with 0 rows)
 *                        | 'success' (with 0 rows; legit empty).
 *                        Bumps consecutive_no_data; tiered backoff.
 *                        This is what fixes the chronic-failure runaway —
 *                        previously these all reset to +5m.
 *   partial_with_rows  : status='partial' AND rows > 0 (some progress, but
 *                        below floor). Adapter is partially working — use a
 *                        mid-tier 30m backoff and reset consecutive_no_data
 *                        so it doesn't poison the chain.
 */
type AdapterBackoffOutcome =
  | 'success_with_rows'
  | 'unchanged'
  | 'no_data'
  | 'partial_with_rows';

async function writeAdapterBackoff(opts: {
  pool: Pool;
  adapterName: string;
  stateFips: string | null;
  outcome: AdapterBackoffOutcome;
}): Promise<void> {
  try {
    if (opts.outcome === 'unchanged') {
      // Bump the unchanged chain. Compute backoff from the *new* counter.
      const { rows } = await opts.pool.query<{ consecutive_unchanged: number }>(
        `INSERT INTO adapter_status (adapter_name, state_fips, status,
                                     consecutive_unchanged, updated_at)
         VALUES ($1, $2, 'productive', 1, now())
         ON CONFLICT (adapter_name) DO UPDATE
           SET consecutive_unchanged = adapter_status.consecutive_unchanged + 1,
               state_fips = COALESCE(adapter_status.state_fips, EXCLUDED.state_fips),
               updated_at = now()
         RETURNING consecutive_unchanged`,
        [opts.adapterName, opts.stateFips],
      );
      const consec = rows[0]?.consecutive_unchanged ?? 1;
      const minutes = backoffMinutes(consec);
      await opts.pool.query(
        `UPDATE adapter_status
            SET next_check_at = now() + ($2 || ' minutes')::interval,
                updated_at = now()
          WHERE adapter_name = $1`,
        [opts.adapterName, String(minutes)],
      );
    } else if (opts.outcome === 'no_data') {
      // Bump the no-data chain (unproductive / failed / 0-row outcomes).
      const { rows } = await opts.pool.query<{ consecutive_no_data: number }>(
        `INSERT INTO adapter_status (adapter_name, state_fips, status,
                                     consecutive_no_data, updated_at)
         VALUES ($1, $2, 'productive', 1, now())
         ON CONFLICT (adapter_name) DO UPDATE
           SET consecutive_no_data = adapter_status.consecutive_no_data + 1,
               state_fips = COALESCE(adapter_status.state_fips, EXCLUDED.state_fips),
               updated_at = now()
         RETURNING consecutive_no_data`,
        [opts.adapterName, opts.stateFips],
      );
      const consec = rows[0]?.consecutive_no_data ?? 1;

      if (consec >= ESCALATION_THRESHOLD_NO_DATA) {
        // Council #44: on 2nd consecutive failure, route into the escalation
        // queue rather than continuing to back off. The runner will skip this
        // adapter (status='escalated', next_check_at far future) until the
        // escalation is resolved by /investigate-adapter + resolve-adapter.
        await escalateAdapter(opts.pool, opts.adapterName, opts.stateFips, consec);
      } else {
        // Below threshold — short backoff, give it one more chance.
        const minutes = backoffMinutes(consec);
        await opts.pool.query(
          `UPDATE adapter_status
              SET next_check_at = now() + ($2 || ' minutes')::interval,
                  updated_at = now()
            WHERE adapter_name = $1`,
          [opts.adapterName, String(minutes)],
        );
      }
    } else if (opts.outcome === 'partial_with_rows') {
      // Adapter wrote SOME rows (just below the expected floor). It's
      // partially working — reset the no-data chain but use a mid-tier
      // 30-minute backoff so we don't pound the source.
      // consecutive_unchanged is intentionally NOT touched here: a partial
      // run does not change the unchanged chain semantics.
      await opts.pool.query(
        `INSERT INTO adapter_status (adapter_name, state_fips, status,
                                     consecutive_no_data, next_check_at, updated_at)
         VALUES ($1, $2, 'productive', 0, now() + interval '30 minutes', now())
         ON CONFLICT (adapter_name) DO UPDATE
           SET consecutive_no_data = 0,
               next_check_at = now() + interval '30 minutes',
               state_fips = COALESCE(adapter_status.state_fips, EXCLUDED.state_fips),
               updated_at = now()`,
        [opts.adapterName, opts.stateFips],
      );
    } else {
      // success_with_rows — full reset of BOTH chains.
      await opts.pool.query(
        `INSERT INTO adapter_status (adapter_name, state_fips, status,
                                     consecutive_unchanged, consecutive_no_data,
                                     next_check_at, updated_at)
         VALUES ($1, $2, 'productive', 0, 0, now() + interval '5 minutes', now())
         ON CONFLICT (adapter_name) DO UPDATE
           SET consecutive_unchanged = 0,
               consecutive_no_data = 0,
               next_check_at = now() + interval '5 minutes',
               state_fips = COALESCE(adapter_status.state_fips, EXCLUDED.state_fips),
               updated_at = now()`,
        [opts.adapterName, opts.stateFips],
      );
    }
  } catch (e) {
    // Backoff bookkeeping must NEVER fail the run. Log + continue.
    // eslint-disable-next-line no-console
    console.error(
      `[adapter-backoff] ${opts.adapterName} failed:`,
      e instanceof Error ? e.message : e,
    );
  }
}

// ---------------------------------------------------------------------------
// Escalation (council #44, 2026-05-03)
// ---------------------------------------------------------------------------
//
// Promote a failing adapter from the retry-with-backoff loop into the
// triage queue. The unique partial index on adapter_escalations dedupes
// open rows per adapter, so re-firing during a transient race is a no-op.
//
// Side effects:
//   - inserts a row into adapter_escalations (or no-ops if one is already
//     open for this adapter)
//   - sets adapter_status.status = 'escalated' and pushes next_check_at
//     to a sentinel year-2099 timestamp (continuous-ingest skips it)
//   - emits a Sentry alert + console line tagged escalation_id
//
// Never throws. Bookkeeping failure here must not fail the underlying run.

const ESCALATION_FAILURE_HISTORY_DEPTH = 3;
const ESCALATION_RESPONSE_SAMPLE_BYTES = 2048;

async function escalateAdapter(
  pool: Pool,
  adapterName: string,
  stateFips: string | null,
  consecutiveFailures: number,
): Promise<void> {
  // 1. Pull the last few failure runs for context. The triage agent uses
  //    this as the dossier — status codes, error summaries, response samples.
  type FailureRow = {
    id: string;
    status: string;
    error_summary: string | null;
    finished_at: Date | null;
    expected_min_rows: number | null;
  };
  let history: FailureRow[] = [];
  try {
    const { rows } = await pool.query<FailureRow>(
      `SELECT id, status, error_summary, finished_at, expected_min_rows
         FROM ingestion_runs
        WHERE adapter_name = $1
          AND status IN ('failed','unproductive','partial')
        ORDER BY started_at DESC
        LIMIT $2`,
      [adapterName, ESCALATION_FAILURE_HISTORY_DEPTH],
    );
    history = rows;
  } catch (e) {
    // Don't block escalation if the lookup fails — write the row without
    // history and let the triage agent fetch its own context.
    // eslint-disable-next-line no-console
    console.warn(
      `[escalateAdapter] failed to read failure history for ${adapterName}:`,
      e instanceof Error ? e.message : e,
    );
  }

  // Best-effort URL extraction from the most recent error summary.
  const sourceUrl = extractFirstUrl(history[0]?.error_summary ?? null);

  const failureHistoryJson = history.map((r) => ({
    ingestion_run_id: r.id,
    status: r.status,
    error_summary: (r.error_summary ?? '').slice(0, ESCALATION_RESPONSE_SAMPLE_BYTES),
    finished_at: r.finished_at,
    expected_min_rows: r.expected_min_rows,
  }));

  let escalationId: string | null = null;
  try {
    // Dedupe via the partial unique index (uq_adapter_escalations_open_per_adapter).
    // CTE form is robust against the ON-CONFLICT-with-partial-predicate edge
    // cases where PG's predicate matcher can't infer the index reliably.
    const { rows } = await pool.query<{ id: string }>(
      `WITH new_row AS (
         INSERT INTO adapter_escalations (
           adapter_name, state_fips, failure_history, source_url
         )
         SELECT $1, $2, $3::jsonb, $4
         WHERE NOT EXISTS (
           SELECT 1 FROM adapter_escalations
            WHERE adapter_name = $1
              AND triage_status IN ('open','investigating')
         )
         RETURNING id
       )
       SELECT id FROM new_row`,
      [adapterName, stateFips, JSON.stringify(failureHistoryJson), sourceUrl],
    );
    escalationId = rows[0]?.id ?? null;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(
      `[escalateAdapter] insert failed for ${adapterName}:`,
      e instanceof Error ? e.message : e,
    );
    // Even if the insert failed, still flip adapter_status — better to skip
    // than to keep retrying. The next pass will retry the insert.
  }

  // 2. Park the adapter — status='escalated', next_check_at far future.
  try {
    await pool.query(
      `INSERT INTO adapter_status (adapter_name, state_fips, status,
                                   consecutive_no_data, next_check_at, updated_at)
       VALUES ($1, $2, 'escalated', $3, $4::timestamptz, now())
       ON CONFLICT (adapter_name) DO UPDATE
         SET status = 'escalated',
             next_check_at = $4::timestamptz,
             state_fips = COALESCE(adapter_status.state_fips, EXCLUDED.state_fips),
             updated_at = now()`,
      [adapterName, stateFips, consecutiveFailures, ESCALATED_NEXT_CHECK_AT],
    );
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(
      `[escalateAdapter] status update failed for ${adapterName}:`,
      e instanceof Error ? e.message : e,
    );
  }

  // 3. Tell the operator. Sentry + structured console line.
  await reportIngestionFailure({
    adapter_name: adapterName,
    state_fips: stateFips,
    status: 'escalated',
    ingestion_run_id: history[0]?.id ?? null,
    error_summary: escalationId
      ? `escalated after ${consecutiveFailures} consecutive failures (escalation_id=${escalationId})`
      : `escalated after ${consecutiveFailures} consecutive failures`,
    rows_failed: 0,
    rows_inserted: 0,
    expected_min_rows: history[0]?.expected_min_rows ?? null,
  });
}

/** Pull the first http(s) URL out of an error_summary, if any. */
function extractFirstUrl(text: string | null): string | null {
  if (!text) return null;
  const match = text.match(/https?:\/\/[^\s'"<>)]+/);
  return match ? match[0] : null;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export async function runAdapter<Row>(
  adapter: SourceAdapter<Row>,
  options: RunAdapterOptions = {},
): Promise<AdapterRunResult> {
  const supabase = options.supabase ?? defaultSupabase();
  const pool = options.pg ?? defaultPool();
  const logger = options.logger ?? defaultLogger();
  const dryRun = options.dryRun ?? false;
  const gitSha = captureGitSha(options.gitSha);

  const lockKey = `${adapter.name}|${adapter.stateFips ?? ''}`;

  // 1 — acquire a dedicated connection + open transaction for the
  // advisory lock + data work. The supabase client writes to
  // ingestion_runs independently so the audit row survives rollback.
  let pgClient: PoolClient;
  try {
    pgClient = await pool.connect();
  } catch (err) {
    logger.error('runAdapter: pg connect failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  try {
    await pgClient.query('BEGIN');

    // 2 — try advisory lock scoped to (name, state). If another worker
    // has it we exit immediately with no rows written.
    const lockRes = await pgClient.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked',
      [lockKey],
    );
    const locked = lockRes.rows[0]?.locked === true;
    if (!locked) {
      await pgClient.query('ROLLBACK');
      logger.warn(`runAdapter: concurrent run detected, skipping`, {
        adapter: adapter.name,
        state: adapter.stateFips,
      });
      const reason = `another run of ${adapter.name} (state=${adapter.stateFips ?? '-'}) holds the advisory lock`;
      await reportIngestionFailure({
        adapter_name: adapter.name,
        state_fips: adapter.stateFips ?? null,
        status: 'rejected_concurrent',
        ingestion_run_id: null,
        error_summary: reason,
        rows_failed: 0,
        rows_inserted: 0,
        expected_min_rows: null,
      });
      return {
        status: 'rejected_concurrent',
        reason,
      };
    }

    // 3 — cost reservation. Only meaningful if the adapter declares both.
    if (adapter.costService && adapter.estimatedCostUsd && adapter.estimatedCostUsd > 0) {
      const costRes = await pgClient.query<{ ok: boolean }>(
        'SELECT cost_cap_check_and_consume($1, $2::numeric) AS ok',
        [adapter.costService, adapter.estimatedCostUsd],
      );
      if (costRes.rows[0]?.ok !== true) {
        await pgClient.query('ROLLBACK');
        logger.warn(`runAdapter: cost cap refused`, {
          adapter: adapter.name,
          service: adapter.costService,
          estimate: adapter.estimatedCostUsd,
        });
        const reason = `cost_cap_check_and_consume refused service=${adapter.costService} estimate=$${adapter.estimatedCostUsd}`;
        await reportIngestionFailure({
          adapter_name: adapter.name,
          state_fips: adapter.stateFips ?? null,
          status: 'rejected_cost_cap',
          ingestion_run_id: null,
          error_summary: reason,
          rows_failed: 0,
          rows_inserted: 0,
          expected_min_rows: null,
        });
        return {
          status: 'rejected_cost_cap',
          reason,
        };
      }
    }

    // 4 — open the ingestion_runs row BEFORE adapter.run, so a hang /
    // crash during fetch still leaves a trail. Uses supabase (separate
    // connection) so dry-run rollback of pgClient doesn't wipe it.
    const startedAt = new Date().toISOString();
    const { data: runRow, error: runErr } = await supabase
      .from('ingestion_runs')
      .insert({
        adapter_name: adapter.name,
        state_fips: adapter.stateFips ?? null,
        status: 'running',
        git_sha: gitSha,
        expected_min_rows: 0,
        started_at: startedAt,
        runner_host: hostname(),
        runner_pid: process.pid,
        meta: {
          runner_host: hostname(),
          runner_pid: process.pid,
          ...(dryRun ? { dry_run: true } : {}),
        },
      })
      .select('id')
      .single();
    if (runErr || !runRow) {
      await pgClient.query('ROLLBACK');
      throw new Error(
        `runAdapter: ingestion_runs insert failed: ${runErr?.message ?? 'no row returned'}`,
      );
    }
    const ingestionRunId: string = runRow.id;

    // Register with the SIGTERM/SIGINT finalizer so an external kill from
    // continuous-ingest's per-task timeout (or a PM2 restart) updates the
    // ingestion_runs row to 'unknown_termination' instead of leaving it
    // wedged in 'running'. SIGKILL will still leak — nothing prevents that —
    // but most kills go through SIGTERM first.
    installSignalHandlers();
    const inFlightHandle: InFlightRun = {
      ingestionRunId,
      adapterName: adapter.name,
      supabase,
    };
    inFlightRuns.add(inFlightHandle);

    const ctx: AdapterContext = {
      supabase,
      pg: pool,
      dryRun,
      gitSha,
      ingestionRunId,
      costService: adapter.costService,
      logger,
    };

    // 5 — run the adapter. On throw, mark failed and return.
    let outcome: AdapterOutcome<Row>;
    try {
      outcome = await adapter.run(ctx);
    } catch (err) {
      const errMsg = formatErrorSummary(err);
      await pgClient.query('ROLLBACK');
      await supabase
        .from('ingestion_runs')
        .update({
          status: 'failed',
          error_summary: errMsg,
          finished_at: new Date().toISOString(),
        })
        .eq('id', ingestionRunId);
      logger.error(`runAdapter: adapter.run threw`, { adapter: adapter.name, error: errMsg });
      await reportIngestionFailure({
        adapter_name: adapter.name,
        state_fips: adapter.stateFips ?? null,
        status: 'failed',
        ingestion_run_id: ingestionRunId,
        error_summary: errMsg,
        rows_failed: 0,
        rows_inserted: 0,
        expected_min_rows: null,
      });
      // Bump consecutive_no_data so chronic-throwing adapters back off.
      await writeAdapterBackoff({
        pool,
        adapterName: adapter.name,
        stateFips: adapter.stateFips ?? null,
        outcome: 'no_data',
      });
      return {
        status: 'failed',
        ingestionRunId,
        reason: errMsg,
      };
    }

    // 6 — upsert data_sources. Prefer content_hash for dedup; fall back
    // to (name, url, fetched_at) so re-runs of the same adapter without
    // a hash still produce a row.
    //
    // Council 2026-04-25 (Skeptic#3): when content_hash matches AND we
    // have a recent successful run for THIS adapter against THIS data
    // source, short-circuit before re-running adapter.insert(). This is
    // what kills the federal-votes 4.16M-rows-per-6h re-ingest churn.
    const src = outcome.source;
    let dataSourceId: string | undefined;
    let unchangedShortCircuit = false;
    /**
     * Per-source `expected_min_rows_floor` (council #7). When an adapter
     * declared `expectedMinRows: 0` we degrade gracefully to the historical
     * 7d-median backfilled by migration 20260425000002. NULL = no history.
     */
    let dataSourceFloor: number | null = null;
    /**
     * Per-source `unchanged_window_seconds` (council #25). Defaults to 6h
     * (21600s); live-results adapters set it to 60–300s, daily-bulk dumps
     * set 86400s.
     */
    let unchangedWindowSeconds = 21600;
    {
      // See if a row with this content_hash already exists — tolerates
      // the case where two different URL fetches produced identical bytes.
      const existing = await supabase
        .from('data_sources')
        .select('id, last_successful_fetch_at, meta, unchanged_window_seconds, expected_min_rows_floor')
        .eq('content_hash', src.contentHash)
        .limit(1)
        .maybeSingle();

      if (existing.data?.id) {
        dataSourceId = existing.data.id;
        const existingRow = existing.data as {
          id: string;
          unchanged_window_seconds?: number | null;
          expected_min_rows_floor?: number | null;
          meta?: Record<string, unknown>;
        };
        if (typeof existingRow.unchanged_window_seconds === 'number') {
          unchangedWindowSeconds = existingRow.unchanged_window_seconds;
        }
        if (typeof existingRow.expected_min_rows_floor === 'number') {
          dataSourceFloor = existingRow.expected_min_rows_floor;
        }

        // Check whether THIS adapter has a recent productive run against
        // this data_source. If so, content is unchanged AND we already
        // ingested it — skip insert. Window comes from the per-source
        // `unchanged_window_seconds` column (council #25); defaults to 6h.
        const { data: recentSuccess } = await supabase
          .from('ingestion_runs')
          .select('id, finished_at, rows_inserted, rows_updated')
          .eq('adapter_name', adapter.name)
          .eq('data_source_id', dataSourceId)
          .eq('status', 'success')
          .gt('finished_at', new Date(Date.now() - unchangedWindowSeconds * 1000).toISOString())
          .order('finished_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (
          recentSuccess?.id &&
          recentSuccess.finished_at &&
          recentSuccess.rows_inserted !== null
        ) {
          unchangedShortCircuit = true;
          logger.info('runAdapter: content unchanged, short-circuiting', {
            adapter: adapter.name,
            data_source_id: dataSourceId,
            previous_rows_inserted: recentSuccess.rows_inserted,
          });
        }

        // Bump fingerprint history regardless (used by v_likely_stale_urls).
        const existingMeta =
          (existing.data as { meta?: Record<string, unknown> }).meta ?? {};
        const fingerprints = Array.isArray(existingMeta.body_fingerprints)
          ? (existingMeta.body_fingerprints as Array<Record<string, unknown>>)
          : [];
        const updatedFingerprints = [
          ...fingerprints,
          { hash: src.contentHash, at: new Date().toISOString() },
        ].slice(-10); // keep last 10
        const updatedMeta = { ...existingMeta, body_fingerprints: updatedFingerprints };

        await supabase
          .from('data_sources')
          .update({
            last_successful_fetch_at: new Date().toISOString(),
            meta: updatedMeta,
          })
          .eq('id', existing.data.id);
      } else {
        const { data: inserted, error: dsErr } = await supabase
          .from('data_sources')
          .insert({
            source_type: src.sourceType,
            name: src.name,
            url: src.url,
            archive_url: src.archiveUrl ?? null,
            content_hash: src.contentHash,
            license: src.license,
            state_fips: src.stateFips ?? null,
            fetched_at: new Date().toISOString(),
            last_successful_fetch_at: new Date().toISOString(),
            meta: src.meta ?? {},
          })
          .select('id')
          .single();
        if (dsErr || !inserted) {
          await pgClient.query('ROLLBACK');
          const errMsg = formatErrorSummary(
            new Error(`data_sources upsert failed: ${dsErr?.message ?? 'no row'}`),
          );
          await supabase
            .from('ingestion_runs')
            .update({
              status: 'failed',
              error_summary: errMsg,
              finished_at: new Date().toISOString(),
            })
            .eq('id', ingestionRunId);
          logger.error(`runAdapter: ${errMsg}`);
          await reportIngestionFailure({
            adapter_name: adapter.name,
            state_fips: adapter.stateFips ?? null,
            status: 'failed',
            ingestion_run_id: ingestionRunId,
            error_summary: errMsg,
            rows_failed: 0,
            rows_inserted: 0,
            expected_min_rows: outcome.expectedMinRows,
          });
          await writeAdapterBackoff({
            pool,
            adapterName: adapter.name,
            stateFips: adapter.stateFips ?? null,
            outcome: 'no_data',
          });
          return { status: 'failed', ingestionRunId, reason: errMsg };
        }
        dataSourceId = inserted.id;
      }
    }

    // Council #7: degrade gracefully when adapter declared `expectedMinRows: 0`.
    // Prefer adapter-declared > data_sources.expected_min_rows_floor (7d-median
    // backfill) > 0. This makes "I don't know what to expect" surface real
    // shortfalls when historical data is available.
    const effectiveExpectedMinRows =
      outcome.expectedMinRows > 0
        ? outcome.expectedMinRows
        : dataSourceFloor !== null && dataSourceFloor > 0
          ? dataSourceFloor
          : 0;

    if (
      outcome.expectedMinRows === 0 &&
      dataSourceFloor !== null &&
      dataSourceFloor > 0
    ) {
      logger.warn('runAdapter: adapter declared expectedMinRows=0 but data_sources floor is non-zero', {
        adapter: adapter.name,
        data_source_id: dataSourceId,
        data_source_floor: dataSourceFloor,
        suggestion: 'Set expectedMinRows in the adapter to suppress this warning.',
      });
    }

    // Link ingestion_runs → data_sources and record expected floor.
    await supabase
      .from('ingestion_runs')
      .update({
        data_source_id: dataSourceId,
        expected_min_rows: effectiveExpectedMinRows,
      })
      .eq('id', ingestionRunId);

    ctx.dataSourceId = dataSourceId;

    // 6b — content-unchanged short-circuit. Skip the insert path entirely.
    // Marks the run 'unchanged' so dashboards can distinguish from real
    // productive runs.
    if (unchangedShortCircuit) {
      await pgClient.query('ROLLBACK'); // we never wrote anything in this tx
      await supabase
        .from('ingestion_runs')
        .update({
          status: 'unchanged',
          rows_inserted: 0,
          rows_updated: 0,
          rows_skipped: 0,
          rows_failed: 0,
          finished_at: new Date().toISOString(),
          meta: {
            unchanged: true,
            content_hash: src.contentHash,
            unchanged_window_seconds: unchangedWindowSeconds,
          },
        })
        .eq('id', ingestionRunId);
      // Bump the consecutive_unchanged counter and push next_check_at forward.
      // This is what kills the ballot-measures-* worker-second waste.
      await writeAdapterBackoff({
        pool,
        adapterName: adapter.name,
        stateFips: adapter.stateFips ?? null,
        outcome: 'unchanged',
      });
      return {
        status: 'unchanged' as const,
        ingestionRunId,
        dataSourceId,
        stats: zeroStats(),
        expectedMinRows: effectiveExpectedMinRows,
        reason: `content_hash unchanged within ${unchangedWindowSeconds}s`,
      };
    }

    // 8 — validate rows. Partition into valid/invalid; log invalids to
    // ingestion_errors with error_type='validation'.
    let validRows: Row[] = outcome.rows;
    let validationFailures = 0;
    if (adapter.validateRow) {
      const kept: Row[] = [];
      const errors: Array<{ ingestion_run_id: string; raw_input: unknown; error_type: string; error_message: string }> = [];
      for (const row of outcome.rows) {
        const msg = adapter.validateRow(row);
        if (msg === null) {
          kept.push(row);
        } else {
          validationFailures += 1;
          errors.push({
            ingestion_run_id: ingestionRunId,
            raw_input: row as unknown,
            error_type: 'validation',
            error_message: msg.slice(0, 2000),
          });
        }
      }
      if (errors.length > 0) {
        // Chunk at 500 per insert to stay under Supabase payload limits.
        for (let i = 0; i < errors.length; i += 500) {
          const chunk = errors.slice(i, i + 500);
          const { error: ieErr } = await supabase.from('ingestion_errors').insert(chunk);
          if (ieErr) {
            logger.warn('runAdapter: ingestion_errors insert failed', { error: ieErr.message });
          }
        }
      }
      validRows = kept;
    }

    // 9 — call adapter.insert. Caller is expected to honor ctx.dryRun
    // by either using ctx.pg inside the transaction we've already opened
    // OR by respecting the flag and no-op'ing writes. We default to
    // "do the writes; we'll rollback if dry-run".
    let stats: InsertStats;
    try {
      stats = await adapter.insert(
        validRows,
        { dataSourceId: dataSourceId!, ingestionRunId },
        ctx,
      );
    } catch (err) {
      const errMsg = formatErrorSummary(err);
      const insertErrMsg = `insert(): ${errMsg}`.slice(0, MAX_ERROR_SUMMARY_LEN);
      await pgClient.query('ROLLBACK');
      await supabase
        .from('ingestion_runs')
        .update({
          status: 'failed',
          error_summary: insertErrMsg,
          finished_at: new Date().toISOString(),
        })
        .eq('id', ingestionRunId);
      logger.error('runAdapter: adapter.insert threw', { adapter: adapter.name, error: errMsg });
      await reportIngestionFailure({
        adapter_name: adapter.name,
        state_fips: adapter.stateFips ?? null,
        status: 'failed',
        ingestion_run_id: ingestionRunId,
        error_summary: insertErrMsg,
        rows_failed: 0,
        rows_inserted: 0,
        expected_min_rows: effectiveExpectedMinRows,
      });
      await writeAdapterBackoff({
        pool,
        adapterName: adapter.name,
        stateFips: adapter.stateFips ?? null,
        outcome: 'no_data',
      });
      return { status: 'failed', ingestionRunId, dataSourceId, reason: errMsg };
    }

    // Roll validation failures into the reported failure count so status
    // classification accounts for them.
    const allStats: InsertStats = {
      ...stats,
      rowsFailed: stats.rowsFailed + validationFailures,
    };

    // 10 — classify. Order matters:
    //   failed > unproductive > partial > success
    // 'unproductive' is the new bucket for "parser signaled non-OK AND we
    // got zero rows" — distinguishes URL-pointed-at-wrong-page from real
    // empty results. Council 2026-04-25 SRE#1 / DE#1.
    const effective = allStats.rowsInserted + allStats.rowsUpdated;
    const floor = Math.ceil(effectiveExpectedMinRows * 0.8);
    const parserSignal = outcome.parserSignal ?? 'ok';
    let status: 'success' | 'partial' | 'failed' | 'skipped' | 'unproductive' = 'success';
    if (allStats.rowsFailed > allStats.rowsInserted) {
      status = 'failed';
    } else if (effective === 0 && (parserSignal === 'no_table' || parserSignal === 'parse_failed')) {
      status = 'unproductive';
    } else if (effective < floor) {
      status = 'partial';
    }

    if (dryRun) {
      // 11 — dry-run path: we report via ingestion_runs but roll back data.
      await pgClient.query('ROLLBACK');
      status = 'skipped';
    } else {
      await pgClient.query('COMMIT');
    }

    // 12 — final audit update. Stored in supabase so it survives rollback.
    //
    // 2026-04-26 fix: previously this only set a summary for 'failed' and
    // left 'partial' / 'unproductive' with NULL error_summary. The downstream
    // failure-analyzer classifies on regex-match against this field, so a
    // null summary always landed in the 'unknown' bucket — which is exactly
    // what triggered the OH candidacies blind-triage incident. Now every
    // non-success terminal status carries a useful summary.
    let finalErrorSummary: string | null = null;
    if (status === 'failed') {
      const joined = allStats.errors
        .map((e) => `[${e.type}] ${scrubSecrets(e.message ?? '')}`)
        .filter((m) => m.length > 4) // drop empty `[type] ` shells
        .join('; ');
      finalErrorSummary = (joined || `rowsFailed=${allStats.rowsFailed} > rowsInserted=${allStats.rowsInserted}`)
        .slice(0, MAX_ERROR_SUMMARY_LEN);
    } else if (status === 'partial') {
      finalErrorSummary = `partial: rowsInserted+rowsUpdated=${effective} < floor=${floor} (expected_min=${effectiveExpectedMinRows}, parser_signal=${parserSignal})`
        .slice(0, MAX_ERROR_SUMMARY_LEN);
    } else if (status === 'unproductive') {
      finalErrorSummary = `unproductive: parser_signal=${parserSignal} returned 0 rows (expected_min=${effectiveExpectedMinRows})`
        .slice(0, MAX_ERROR_SUMMARY_LEN);
    }

    await supabase
      .from('ingestion_runs')
      .update({
        status,
        rows_inserted: allStats.rowsInserted,
        rows_updated: allStats.rowsUpdated,
        rows_skipped: allStats.rowsSkipped,
        rows_failed: allStats.rowsFailed,
        finished_at: new Date().toISOString(),
        error_summary: finalErrorSummary,
        meta: dryRun
          ? { dry_run: true }
          : { parser_signal: parserSignal },
      })
      .eq('id', ingestionRunId);

    // Fire observability alert for failed/partial/unproductive runs.
    // Skipped (dry-run), unchanged (no work), and successful runs don't alert.
    if (status === 'failed' || status === 'partial' || status === 'unproductive') {
      await reportIngestionFailure({
        adapter_name: adapter.name,
        state_fips: adapter.stateFips ?? null,
        status: status,
        ingestion_run_id: ingestionRunId,
        error_summary:
          finalErrorSummary ??
          (status === 'partial'
            ? `rowsInserted+rowsUpdated=${effective} < floor=${floor}`
            : null),
        rows_failed: allStats.rowsFailed,
        rows_inserted: allStats.rowsInserted,
        expected_min_rows: effectiveExpectedMinRows,
      });
    }

    // Classify outcome for backoff bookkeeping.
    //
    //   skipped (dry-run)        → success_with_rows (treat as "real run, no
    //                              chronic state worth tracking"; full reset)
    //   success | partial w/ rows: 0-row → no_data; >0 rows → success/partial
    //   failed | unproductive    → no_data
    //
    // This is the 2026-04-26 fix: previously every non-unchanged outcome
    // reset to +5m, so chronic-failure adapters retried every 5m forever.
    let backoffOutcome: AdapterBackoffOutcome;
    if (dryRun) {
      backoffOutcome = 'success_with_rows';
    } else if (status === 'failed' || status === 'unproductive') {
      backoffOutcome = 'no_data';
    } else if (status === 'partial') {
      backoffOutcome = effective > 0 ? 'partial_with_rows' : 'no_data';
    } else {
      // status === 'success'
      backoffOutcome = effective > 0 ? 'success_with_rows' : 'no_data';
    }
    await writeAdapterBackoff({
      pool,
      adapterName: adapter.name,
      stateFips: adapter.stateFips ?? null,
      outcome: backoffOutcome,
    });

    return {
      status,
      ingestionRunId,
      dataSourceId,
      stats: allStats,
      expectedMinRows: effectiveExpectedMinRows,
      reason: status === 'partial' ? `rowsInserted+rowsUpdated=${effective} < floor=${floor}` : undefined,
    };
  } catch (err) {
    // Unexpected error (DB connection drop, etc). Best-effort rollback.
    try {
      await pgClient.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    // Drop any in-flight registrations belonging to this runner invocation.
    // We can't reference inFlightHandle directly from this scope (declared
    // inside the try), so sweep the set looking for matching adapter+supabase.
    // In practice each tsx child runs one adapter at a time so this is fine.
    for (const h of [...inFlightRuns]) {
      if (h.adapterName === adapter.name && h.supabase === supabase) {
        inFlightRuns.delete(h);
      }
    }
    pgClient.release();
    // Only close the pool if we created it ourselves — don't wreck a
    // shared pool the caller handed in.
    if (!options.pg) {
      await pool.end().catch(() => undefined);
    }
  }
}

// Re-export zeroStats helper for adapter authors who want to start from a
// clean InsertStats and increment.
export { zeroStats };

// Test-only re-exports. These are not part of the public API; tests use
// `__writeAdapterBackoff` and `__escalateAdapter` to exercise the chronic-
// failure / escalation paths without spinning up runAdapter end-to-end.
export {
  writeAdapterBackoff as __writeAdapterBackoff,
  escalateAdapter as __escalateAdapter,
  ESCALATION_THRESHOLD_NO_DATA as __ESCALATION_THRESHOLD_NO_DATA,
  ESCALATED_NEXT_CHECK_AT as __ESCALATED_NEXT_CHECK_AT,
};
