import { inngest } from '../client';
import { createServiceClient } from '@/lib/supabase/server';
import { reportIngestionFailure } from '@/lib/monitoring/sentry-report';

/**
 * Heartbeat watchdog. Runs every 5 minutes; reads `worker_heartbeats` and
 * fires a critical data_quality_flag (plus a Sentry/log alert) for any
 * worker whose last_heartbeat_at is older than expected_tick_seconds × 2.
 *
 * Council 2026-04-25 SRE finding #3: the heartbeat table is written by all
 * 5 long-running workers (continuous-ingest, failure-analyzer,
 * stuck-task-janitor, adapter-doctor, data-quality-watcher,
 * primary-readiness-checker) but nothing reads it — so a crashed loop is a
 * silent regression. This function closes that loop.
 *
 * Per the existing alerter pattern (ingestion-burst-alerter, staleness-scanner):
 *   - retries: 0 — observability must not spam re-attempts.
 *   - concurrency: 1 — single-flight; parallel watchdogs would double-flag.
 *
 * Resolution: when a stale worker recovers (next heartbeat upserts a fresh
 * last_heartbeat_at), the next watchdog tick stops detecting it. Open flags
 * are auto-resolved by setting resolved_at = now() on rows whose worker is
 * no longer stale.
 */

interface HeartbeatRow {
  worker_name: string;
  pid: number | null;
  last_heartbeat_at: string;
  expected_tick_seconds: number;
  cycle_count: number;
  last_event: string | null;
}

export interface StaleWorker {
  worker_name: string;
  pid: number | null;
  last_heartbeat_at: string;
  expected_tick_seconds: number;
  cycle_count: number;
  last_event: string | null;
  staleness_seconds: number;
  threshold_seconds: number;
}

export interface HeartbeatWatchdogResult {
  scanned_at: string;
  total_workers: number;
  stale_count: number;
  flagged: number;
  resolved: number;
  stale_workers: StaleWorker[];
  reason?: string;
}

const RULE_NAME = 'worker_heartbeat_stale';
const TABLE_NAME = 'worker_heartbeats';

async function runHeartbeatWatchdog(): Promise<HeartbeatWatchdogResult> {
  const scannedAt = new Date();
  const scannedAtIso = scannedAt.toISOString();
  const supabase = await createServiceClient();

  // 1. Pull every heartbeat row. The table is bounded (one row per worker,
  //    currently 5–6 rows total) so no pagination needed.
  const { data: rowsRaw, error: rowsError } = await supabase
    .from('worker_heartbeats')
    .select(
      'worker_name, pid, last_heartbeat_at, expected_tick_seconds, cycle_count, last_event',
    );
  if (rowsError) {
    return {
      scanned_at: scannedAtIso,
      total_workers: 0,
      stale_count: 0,
      flagged: 0,
      resolved: 0,
      stale_workers: [],
      reason: `worker_heartbeats query failed: ${rowsError.message}`,
    };
  }
  const rows = (rowsRaw ?? []) as HeartbeatRow[];

  // 2. Compute staleness in app code. The migration's threshold is
  //    last_heartbeat_at < now() - expected_tick_seconds*2 seconds.
  const stale: StaleWorker[] = [];
  for (const r of rows) {
    const lastBeatMs = new Date(r.last_heartbeat_at).getTime();
    if (Number.isNaN(lastBeatMs)) continue;
    const stalenessSeconds = Math.max(
      0,
      Math.floor((scannedAt.getTime() - lastBeatMs) / 1000),
    );
    const thresholdSeconds = (r.expected_tick_seconds ?? 0) * 2;
    if (thresholdSeconds > 0 && stalenessSeconds > thresholdSeconds) {
      stale.push({
        worker_name: r.worker_name,
        pid: r.pid,
        last_heartbeat_at: r.last_heartbeat_at,
        expected_tick_seconds: r.expected_tick_seconds,
        cycle_count: r.cycle_count,
        last_event: r.last_event,
        staleness_seconds: stalenessSeconds,
        threshold_seconds: thresholdSeconds,
      });
    }
  }

  // 3. Upsert one critical data_quality_flag per stale worker.
  let flagged = 0;
  if (stale.length > 0) {
    const flagRows = stale.map((s) => ({
      table_name: TABLE_NAME,
      row_id: s.worker_name,
      rule: RULE_NAME,
      severity: 'critical' as const,
      details: {
        worker_name: s.worker_name,
        last_heartbeat_at: s.last_heartbeat_at,
        staleness_seconds: s.staleness_seconds,
        threshold_seconds: s.threshold_seconds,
        expected_tick_seconds: s.expected_tick_seconds,
        cycle_count: s.cycle_count,
        last_event: s.last_event,
        pid: s.pid,
        scanned_at: scannedAtIso,
      },
      resolved_at: null,
      resolution_note: null,
    }));
    const { error: insErr, count } = await supabase
      .from('data_quality_flags')
      .upsert(flagRows, {
        onConflict: 'table_name,row_id,rule',
        count: 'exact',
      });
    if (!insErr && typeof count === 'number') {
      flagged = count;
    } else if (insErr) {
      // eslint-disable-next-line no-console
      console.error(
        '[heartbeat-watchdog] data_quality_flags upsert failed:',
        insErr.message,
      );
    }

    // 4. Fire structured alert (Sentry if configured, console.error otherwise)
    //    via the existing reportIngestionFailure helper. We re-use the helper
    //    because it already centralises the Sentry probe + JSON-line fallback.
    //    One alert per stale worker so Sentry can dedupe by adapter_name.
    for (const s of stale) {
      const summary =
        `worker ${s.worker_name} stale: ${s.staleness_seconds}s since last heartbeat`
        + ` (expected_tick=${s.expected_tick_seconds}s, threshold=${s.threshold_seconds}s,`
        + ` cycle_count=${s.cycle_count}, last_event=${s.last_event ?? 'none'})`;
      try {
        await reportIngestionFailure({
          adapter_name: `heartbeat:${s.worker_name}`,
          state_fips: null,
          status: 'failed',
          ingestion_run_id: null,
          error_summary: summary,
          rows_failed: 0,
          rows_inserted: 0,
          expected_min_rows: null,
        });
      } catch (e) {
        // reportIngestionFailure is documented as never-throws, but defensive.
        // eslint-disable-next-line no-console
        console.error(
          '[heartbeat-watchdog] reportIngestionFailure threw (unexpected):',
          e instanceof Error ? e.message : String(e),
        );
      }
      // eslint-disable-next-line no-console
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'worker_heartbeat_stale',
          worker_name: s.worker_name,
          pid: s.pid,
          last_heartbeat_at: s.last_heartbeat_at,
          staleness_seconds: s.staleness_seconds,
          threshold_seconds: s.threshold_seconds,
          expected_tick_seconds: s.expected_tick_seconds,
          cycle_count: s.cycle_count,
          last_event: s.last_event,
          scanned_at: scannedAtIso,
        }),
      );
    }
  }

  // 5. Auto-resolve any previously-flagged worker that's no longer stale.
  //    We re-check only flags currently un-resolved for this rule.
  let resolved = 0;
  const staleSet = new Set(stale.map((s) => s.worker_name));
  const { data: openFlagsRaw } = await supabase
    .from('data_quality_flags')
    .select('row_id')
    .eq('table_name', TABLE_NAME)
    .eq('rule', RULE_NAME)
    .is('resolved_at', null);
  const openIds = (openFlagsRaw ?? []).map((r) => (r as { row_id: string }).row_id);
  const recoveredIds = openIds.filter((id) => !staleSet.has(id));
  if (recoveredIds.length > 0) {
    const { error: resErr, count } = await supabase
      .from('data_quality_flags')
      .update(
        {
          resolved_at: scannedAtIso,
          resolution_note: 'auto: heartbeat resumed',
        },
        { count: 'exact' },
      )
      .eq('table_name', TABLE_NAME)
      .eq('rule', RULE_NAME)
      .is('resolved_at', null)
      .in('row_id', recoveredIds);
    if (!resErr && typeof count === 'number') {
      resolved = count;
    }
  }

  return {
    scanned_at: scannedAtIso,
    total_workers: rows.length,
    stale_count: stale.length,
    flagged,
    resolved,
    stale_workers: stale,
  };
}

export const heartbeatWatchdog = inngest.createFunction(
  {
    id: 'heartbeat-watchdog',
    retries: 0,
    concurrency: [{ limit: 1 }],
    triggers: [
      { cron: '*/5 * * * *' }, // every 5 min
      { event: 'monitoring/heartbeat.check' },
    ],
  },
  async ({ step }: { step: any }) => {
    const stale = await step.run('query-stale', () => runHeartbeatWatchdog());
    return stale;
  },
);

// Exported for direct invocation (manual runs + tests).
export { runHeartbeatWatchdog };
