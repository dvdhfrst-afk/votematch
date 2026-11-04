/**
 * /api/health — Public uptime endpoint.
 *
 * Wraps a subset of `scripts/health-check.ts` for external uptime monitors
 * (UptimeRobot / Pingdom / BetterStack / Hyperping).
 *
 * UptimeRobot wiring:
 *   Type: HTTP(s)
 *   URL:  https://ballotbridge.org/api/health
 *   Method: GET
 *   Expected status: 200
 *   Alerting status: 503 (degraded), 500 (down), or any non-200
 *   Interval: 60s minimum (response is cached server-side for 30s)
 *
 * Status semantics:
 *   200 + { status: 'ok',       checks }                 — all green
 *   503 + { status: 'degraded', checks, failures: [...] } — one or more checks failed
 *   500 + { status: 'down',     error }                  — endpoint itself crashed
 *
 * NOTE: No auth. Body never contains secrets, raw SQL, table contents, or
 * stack traces — anything that could leak operational detail to a public
 * scraper is flattened into a boolean + a short label.
 */

import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

// 30s server-side cache — a 1-per-minute uptime monitor only hits Supabase
// every other request, and a fleet of monitors gets near-zero amplification.
export const revalidate = 30;

// Force this route to run on Node runtime (need fs for migration listing).
export const runtime = 'nodejs';

type CheckStatus = 'ok' | 'warn' | 'fail' | 'unknown';
type CheckResult = { status: CheckStatus; detail: string; ms?: number };

const CHECK_TIMEOUT_MS = 1000;

function withTimeout<T>(
  thenable: PromiseLike<T>,
  ms: number,
  label: string,
): Promise<T> {
  return Promise.race([
    Promise.resolve(thenable),
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label}_timeout`)), ms),
    ),
  ]);
}

type QueryResult = { count: number | null; error: { message: string } | null };

async function checkDbResponsive(): Promise<CheckResult> {
  const t0 = Date.now();
  try {
    const supabase = await createServiceClient();
    // Cheapest possible query that touches the network + db.
    // `head: true` skips the row payload entirely.
    const { error } = await withTimeout<QueryResult>(
      supabase
        .from('ingestion_runs')
        .select('id', { count: 'exact', head: true })
        .limit(1),
      CHECK_TIMEOUT_MS,
      'db_responsive',
    );
    const ms = Date.now() - t0;
    if (error) return { status: 'fail', detail: 'query_error', ms };
    if (ms > CHECK_TIMEOUT_MS)
      return { status: 'fail', detail: 'slow', ms };
    return { status: 'ok', detail: 'reachable', ms };
  } catch {
    // Don't leak error.message — it can include connection strings.
    return { status: 'fail', detail: 'unreachable', ms: Date.now() - t0 };
  }
}

async function checkDbRecentWrites(): Promise<CheckResult> {
  const t0 = Date.now();
  try {
    const supabase = await createServiceClient();
    const sixHoursAgoIso = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    const { count, error } = await withTimeout<QueryResult>(
      supabase
        .from('ingestion_runs')
        .select('id', { count: 'exact', head: true })
        .gte('started_at', sixHoursAgoIso),
      CHECK_TIMEOUT_MS,
      'db_recent_writes',
    );
    const ms = Date.now() - t0;
    if (error) return { status: 'fail', detail: 'query_error', ms };
    const n = count ?? 0;
    // Per spec: warn if 0 in last 6h, but don't fail.
    return {
      status: n > 0 ? 'ok' : 'warn',
      detail: n > 0 ? 'pipeline_active' : 'no_runs_6h',
      ms,
    };
  } catch {
    return { status: 'fail', detail: 'unreachable', ms: Date.now() - t0 };
  }
}

async function checkInngestReachable(): Promise<CheckResult> {
  const t0 = Date.now();
  try {
    const supabase = await createServiceClient();
    const oneDayAgoIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    // Inngest functions write back into ingestion_runs; a 'success' row in
    // the last 24h means the worker is alive.
    const { count, error } = await withTimeout<QueryResult>(
      supabase
        .from('ingestion_runs')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'success')
        .gte('started_at', oneDayAgoIso),
      CHECK_TIMEOUT_MS,
      'inngest_reachable',
    );
    const ms = Date.now() - t0;
    if (error) return { status: 'fail', detail: 'query_error', ms };
    const n = count ?? 0;
    return {
      status: n > 0 ? 'ok' : 'warn',
      detail: n > 0 ? 'success_24h' : 'no_success_24h',
      ms,
    };
  } catch {
    return { status: 'fail', detail: 'unreachable', ms: Date.now() - t0 };
  }
}

async function checkMigrationVersion(): Promise<CheckResult> {
  const t0 = Date.now();
  try {
    // Resolve relative to cwd (Next dev/start is launched from app/).
    const migrationsDir = join(process.cwd(), 'supabase', 'migrations');
    const files = await readdir(migrationsDir);
    const sql = files
      .filter((f) => f.endsWith('.sql'))
      .sort();
    const latest = sql[sql.length - 1] ?? 'none';
    // Cap to filename only (no list dump per spec).
    return {
      status: 'ok',
      detail: latest,
      ms: Date.now() - t0,
    };
  } catch {
    return {
      status: 'unknown',
      detail: 'migrations_dir_unreadable',
      ms: Date.now() - t0,
    };
  }
}

export async function GET() {
  try {
    const [
      dbResponsive,
      dbRecentWrites,
      inngestReachable,
      migrationVersion,
    ] = await Promise.allSettled([
      checkDbResponsive(),
      checkDbRecentWrites(),
      checkInngestReachable(),
      checkMigrationVersion(),
    ]);

    const settle = (p: PromiseSettledResult<CheckResult>): CheckResult =>
      p.status === 'fulfilled'
        ? p.value
        : { status: 'fail', detail: 'check_threw' };

    const checks: Record<string, CheckResult> = {
      db_responsive: settle(dbResponsive),
      db_recent_writes: settle(dbRecentWrites),
      inngest_reachable: settle(inngestReachable),
      migration_version: settle(migrationVersion),
      app_uptime_seconds: {
        status: 'ok',
        detail: Math.round(process.uptime()).toString(),
      },
    };

    const failures = Object.entries(checks)
      .filter(([, r]) => r.status === 'fail')
      .map(([name]) => name);

    if (failures.length === 0) {
      return NextResponse.json(
        { status: 'ok', checks },
        { status: 200 },
      );
    }

    return NextResponse.json(
      { status: 'degraded', checks, failures },
      { status: 503 },
    );
  } catch {
    // Hard fail — don't leak the underlying error message.
    return NextResponse.json(
      { status: 'down', error: 'health_check_crashed' },
      { status: 500 },
    );
  }
}
