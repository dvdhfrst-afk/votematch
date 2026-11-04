/**
 * Poll `ingestion_errors` for a burst of failures. Called by the
 * ingestion-burst-alerter Inngest cron (every 5 min).
 *
 * Definition of "burst": more than `threshold` rows inserted in the last
 * `windowMinutes` minutes. Default threshold=10, window=5min per council
 * 2026-04-23 spec.
 *
 * Returns the count + a breakdown by error_type. Never throws — logs and
 * returns `{ fired: false }` on DB errors (observability must not block).
 */

import { createServiceClient } from '@/lib/supabase/server';
import { reportIngestionBurst } from './sentry-report';

export interface BurstPollResult {
  fired: boolean;
  errorCount: number;
  windowMinutes: number;
  threshold: number;
  breakdown: Array<{ error_type: string | null; count: number }>;
  reason?: string;
}

export async function pollIngestionErrorBurst(opts: {
  windowMinutes?: number;
  threshold?: number;
} = {}): Promise<BurstPollResult> {
  const windowMinutes = opts.windowMinutes ?? 5;
  const threshold = opts.threshold ?? 10;

  const sinceIso = new Date(Date.now() - windowMinutes * 60_000).toISOString();

  try {
    const supabase = await createServiceClient();
    const { data, error } = await supabase
      .from('ingestion_errors')
      .select('error_type, created_at')
      .gte('created_at', sinceIso);

    if (error) {
      return {
        fired: false,
        errorCount: 0,
        windowMinutes,
        threshold,
        breakdown: [],
        reason: `ingestion_errors query failed: ${error.message}`,
      };
    }

    const rows = (data ?? []) as Array<{ error_type: string | null; created_at: string }>;
    const errorCount = rows.length;

    // Group by error_type for the breakdown.
    const byType = new Map<string | null, number>();
    for (const r of rows) {
      byType.set(r.error_type, (byType.get(r.error_type) ?? 0) + 1);
    }
    const breakdown = Array.from(byType.entries())
      .map(([error_type, count]) => ({ error_type, count }))
      .sort((a, b) => b.count - a.count);

    if (errorCount > threshold) {
      await reportIngestionBurst({
        error_count: errorCount,
        window_minutes: windowMinutes,
        threshold,
        breakdown,
      });
      return {
        fired: true,
        errorCount,
        windowMinutes,
        threshold,
        breakdown,
      };
    }

    return {
      fired: false,
      errorCount,
      windowMinutes,
      threshold,
      breakdown,
    };
  } catch (err) {
    return {
      fired: false,
      errorCount: 0,
      windowMinutes,
      threshold,
      breakdown: [],
      reason: `exception: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
