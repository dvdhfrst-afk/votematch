/**
 * Sentry error reporter for ingestion pipeline failures.
 *
 * Behavior:
 *   - If SENTRY_DSN is set, captures a structured error event via the
 *     installed @sentry/nextjs package.
 *   - Always emits a structured console.error too. Sentry can drop events
 *     under load; Vercel logs don't.
 *
 * Contract: NEVER THROWS. This is observability; it must not break the
 * ingestion pipeline. Any error inside the reporter is swallowed (and surfaced
 * via a secondary console.error so we notice in dev).
 *
 * @sentry/nextjs is installed (sentry.{client,server,edge}.config.ts pick up
 * SENTRY_DSN / NEXT_PUBLIC_SENTRY_DSN at startup). When the env var is unset,
 * Sentry.init runs with enabled:false and captureMessage is a no-op.
 */

import * as Sentry from '@sentry/nextjs';
import type { AdapterRunResult } from '@/lib/adapters/types';

export type IngestionFailureStatus =
  | 'failed'
  | 'partial'
  | 'unproductive'    // parser signaled non-ok AND zero rows (council 2026-04-25)
  | 'rejected_concurrent'
  | 'rejected_cost_cap'
  | 'escalated';      // chronic failure routed into the triage queue (council 2026-05-03)

export interface IngestionFailureContext {
  adapter_name: string;
  state_fips: string | null;
  status: IngestionFailureStatus;
  ingestion_run_id: string | null;
  error_summary: string | null;
  rows_failed: number;
  rows_inserted: number;
  expected_min_rows: number | null;
}

/**
 * Returns the Sentry SDK only when DSN is set. Lets us preserve the
 * "no DSN → don't bother calling captureMessage" optimization without
 * a dynamic-import dance.
 */
function activeSentry(): typeof Sentry | null {
  return process.env.SENTRY_DSN ? Sentry : null;
}

/**
 * Report an ingestion failure. Accepts either the raw `AdapterRunResult`
 * (the caller will extract adapter name + state from the run context) or a
 * fully-built `IngestionFailureContext`.
 *
 * Never throws.
 */
export async function reportIngestionFailure(
  ctx: IngestionFailureContext,
): Promise<void> {
  const payload = {
    level: 'error' as const,
    event: 'ingestion_run_failed',
    adapter_name: ctx.adapter_name,
    state_fips: ctx.state_fips,
    status: ctx.status,
    ingestion_run_id: ctx.ingestion_run_id,
    error_summary: ctx.error_summary,
    rows_failed: ctx.rows_failed,
    rows_inserted: ctx.rows_inserted,
    expected_min_rows: ctx.expected_min_rows,
  };

  try {
    const sentry = activeSentry();
    if (sentry) {
      const msg =
        `ingestion_run_failed: ${ctx.adapter_name}` +
        (ctx.state_fips ? ` (state ${ctx.state_fips})` : '') +
        ` [${ctx.status}]`;
      try {
        sentry.captureMessage(msg, {
          level: 'error',
          extra: payload,
          tags: {
            adapter_name: ctx.adapter_name,
            state_fips: ctx.state_fips ?? 'none',
            ingestion_status: ctx.status,
          },
        });
      } catch {
        // Sentry threw — fall through to console.
      }
    }
    // Always log to console too. Sentry can drop events; Vercel logs don't.
    // Using a single JSON line so log ingestors (Vercel / Datadog / etc.)
    // parse it cleanly.
    // eslint-disable-next-line no-console
    console.error(JSON.stringify(payload));
  } catch (err) {
    // Reporter must never throw. Surface internal errors via a second
    // console line so we see them in dev without tripping callers.
    // eslint-disable-next-line no-console
    try {
      console.error(
        '[sentry-report] reporter failed (swallowed):',
        err instanceof Error ? err.message : String(err),
      );
    } catch {
      // Truly nothing we can do.
    }
  }
}

/**
 * Convenience: translate an AdapterRunResult + adapter identity into a
 * failure context. The runner calls this at each write-failure path.
 */
export function buildContextFromRun(opts: {
  adapterName: string;
  stateFips: string | null;
  result: AdapterRunResult;
  errorSummary?: string | null;
  expectedMinRows?: number | null;
}): IngestionFailureContext {
  const { adapterName, stateFips, result, errorSummary, expectedMinRows } = opts;
  return {
    adapter_name: adapterName,
    state_fips: stateFips,
    status: result.status as IngestionFailureStatus,
    ingestion_run_id: result.ingestionRunId ?? null,
    error_summary: errorSummary ?? result.reason ?? null,
    rows_failed: result.stats?.rowsFailed ?? 0,
    rows_inserted: result.stats?.rowsInserted ?? 0,
    expected_min_rows: expectedMinRows ?? result.expectedMinRows ?? null,
  };
}

/**
 * Report a freshness SLA breach — called by the staleness-scanner Inngest
 * function. Distinct event name so Sentry / log pipelines can route it
 * separately from other alerters.
 *
 * Severity:
 *   - 'warning' → the state has >N breaches, but no imminent election.
 *   - 'critical' → the state has an election within 7 days and at least
 *     one breached source. Paged, not just logged.
 *
 * Never throws.
 */
export async function reportSlaBreach(opts: {
  state_fips: string | null;
  source_type: string | null;
  breach_count: number;
  warning_count: number;
  severity: 'warning' | 'critical';
  days_to_next_election: number | null;
  breached_sources: Array<{
    data_source_id: string;
    name: string;
    source_type: string;
    sla_hours: number | null;
    actual_staleness_hours: number | null;
  }>;
}): Promise<void> {
  const payload = {
    level: opts.severity === 'critical' ? ('error' as const) : ('warning' as const),
    event: opts.severity === 'critical' ? 'sla.breach.critical' : 'sla.breach.warning',
    state_fips: opts.state_fips,
    source_type: opts.source_type,
    breach_count: opts.breach_count,
    warning_count: opts.warning_count,
    days_to_next_election: opts.days_to_next_election,
    breached_sources: opts.breached_sources,
  };

  try {
    const sentry = activeSentry();
    if (sentry) {
      try {
        const stateSuffix = opts.state_fips ? ` (state ${opts.state_fips})` : '';
        const typeSuffix = opts.source_type ? ` [${opts.source_type}]` : '';
        const msg =
          `${payload.event}: ${opts.breach_count} breaches${stateSuffix}${typeSuffix}`;
        sentry.captureMessage(msg, {
          level: payload.level,
          extra: payload,
          tags: {
            event: payload.event,
            state_fips: opts.state_fips ?? 'none',
            source_type: opts.source_type ?? 'all',
            severity: opts.severity,
          },
        });
      } catch {
        /* fall through */
      }
    }
    // eslint-disable-next-line no-console
    console.error(JSON.stringify(payload));
  } catch (err) {
    try {
      // eslint-disable-next-line no-console
      console.error(
        '[sentry-report] sla-breach reporter failed (swallowed):',
        err instanceof Error ? err.message : String(err),
      );
    } catch {
      /* ignore */
    }
  }
}

/**
 * Report a burst of ingestion_errors — called by the alerter. Distinct
 * event name so Sentry / log pipelines can route it separately.
 */
export async function reportIngestionBurst(opts: {
  error_count: number;
  window_minutes: number;
  threshold: number;
  breakdown: Array<{ error_type: string | null; count: number }>;
}): Promise<void> {
  const payload = {
    level: 'error' as const,
    event: 'ingestion_errors_burst',
    error_count: opts.error_count,
    window_minutes: opts.window_minutes,
    threshold: opts.threshold,
    breakdown: opts.breakdown,
  };

  try {
    const sentry = activeSentry();
    if (sentry) {
      try {
        sentry.captureMessage(
          `ingestion_errors_burst: ${opts.error_count} errors in ${opts.window_minutes}m (threshold ${opts.threshold})`,
          { level: 'error', extra: payload, tags: { event: 'ingestion_errors_burst' } },
        );
      } catch {
        /* fall through */
      }
    }
    // eslint-disable-next-line no-console
    console.error(JSON.stringify(payload));
  } catch (err) {
    try {
      // eslint-disable-next-line no-console
      console.error(
        '[sentry-report] burst reporter failed (swallowed):',
        err instanceof Error ? err.message : String(err),
      );
    } catch {
      /* ignore */
    }
  }
}
