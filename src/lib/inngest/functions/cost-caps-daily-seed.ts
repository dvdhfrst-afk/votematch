/**
 * Cost-caps daily seeder. Fires every day at 00:05 UTC.
 *
 * Why this exists (Council Fix C, 2026-04-25):
 *   The `cost_caps` table is keyed `(service, date)`. Initial migrations seed
 *   today's row with `CURRENT_DATE` only at apply time. After day 1 those
 *   rows are stale, and the `cost_cap_check_and_consume` function silently
 *   inserts a fresh row with `daily_usd_cap = 0.00` whenever it sees a service
 *   with no row for `CURRENT_DATE`. Result: every cost-capped service starts
 *   refusing every reservation at 00:00 UTC the day after a deploy. This was
 *   confirmed for ballot-measures and the same timebomb hits every other
 *   service that goes through `runAdapter`'s cost reservation step.
 *
 * Fix: pre-seed today's row for each known service before any adapter runs.
 *   The list mirrors the canonical service catalog (see
 *   `cost_caps.service` COMMENT in 20260425000011_interpretation_pipeline.sql).
 *   Free services seed at $0 (matches existing migration behavior); paid
 *   services seed at the same caps the migrations originally used.
 *
 * Cron: `5 0 * * *` (00:05 UTC daily). The 5-minute offset gives any
 * still-running 23:59 adapter a window to finish before today's row exists.
 *
 * Idempotent: ON CONFLICT (service, date) DO NOTHING — re-running is safe.
 *
 * ----------------------------------------------------------------------------
 * Project policy: $0 budget for the Anthropic Claude API + Claude Batch.
 *
 * The project has a $0 budget for the Anthropic Claude API and Claude Batch APIs.
 * The seeder must not silently restore a non-zero cap on those services every
 * day at 00:05 UTC — that would re-arm spend after manual zeroing. Therefore
 * `claude_api`, `claude_batch`, and `interpretation-llm-claude` (the LLM-router
 * Claude path) all seed at $0.00. Any reservation against these services
 * should be refused by `cost_cap_check_and_consume`.
 *
 * Bulk LLM workloads run via spawned Claude Code agents against a
 * Claude Plan subscription, NOT against the Anthropic API. Local Ollama
 * (`interpretation-llm-ollama`) is the preferred path for batch classification
 * and is intentionally seeded at $0 because it incurs no per-token cost.
 *
 * To spend on the Claude API for a specific reason, bump the cap explicitly
 * for that single day. Default is $0.
 * ----------------------------------------------------------------------------
 */

import { inngest } from '../client';
import { Pool } from 'pg';

interface KnownService {
  service: string;
  daily_cap: number;
}

// Canonical service catalog. Keep in sync with the COMMENT on
// `cost_caps.service` in supabase/migrations.
//
// Free services (cap=0) auto-pass through cost_cap_check_and_consume because
// adapters reserve $0 for them — see lib/adapters/run.ts.
export const KNOWN_SERVICES: KnownService[] = [
  // Anthropic: $0 Claude API/Batch policy. See header comment.
  { service: 'claude_api', daily_cap: 0.0 },
  { service: 'claude_batch', daily_cap: 0.0 },
  // Interpretation pipeline (added 20260425000011)
  // claude path also locked to $0 per the same policy; ollama is local + free.
  { service: 'interpretation-llm-claude', daily_cap: 0.0 },
  { service: 'interpretation-llm-ollama', daily_cap: 0.0 },
  // Ingestion
  { service: 'ingestion-fetch', daily_cap: 0.0 },
  // Geocoding
  { service: 'geocoding', daily_cap: 1.0 },
  { service: 'census_geocoder', daily_cap: 0.0 },
  { service: 'nominatim', daily_cap: 0.0 },
  // Federal data sources (free)
  { service: 'wayback_cdx', daily_cap: 0.0 },
  { service: 'openfec', daily_cap: 0.0 },
  { service: 'congress_gov', daily_cap: 0.0 },
  { service: 'regulations_gov', daily_cap: 0.0 },
  // Email
  { service: 'resend', daily_cap: 20.0 },
  // Anti-scrape tier 2
  { service: 'scraperapi', daily_cap: 50.0 },
  { service: 'playwright', daily_cap: 10.0 },
  // Catch-all for state-cf / municipal / state-sos adapters
  { service: 'other', daily_cap: 1.0 },
];

export interface CostCapsSeedResult {
  scanned_at: string;
  services_total: number;
  inserted: number;
  already_existed: number;
  rows_today: number;
}

function getPool(): Pool {
  const connectionString = process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL;
  if (!connectionString) {
    throw new Error('cost-caps-daily-seed: DATABASE_URL must be set');
  }
  return new Pool({ connectionString });
}

async function runCostCapsDailySeed(): Promise<CostCapsSeedResult> {
  const scannedAt = new Date().toISOString();
  const pool = getPool();
  const client = await pool.connect();
  try {
    // 1. Insert one row per known service for CURRENT_DATE. ON CONFLICT skip.
    //    We insert one at a time so we can attribute the count of inserts
    //    accurately (and because the row count from a multi-VALUES insert with
    //    ON CONFLICT in pg returns only successful inserts anyway, but the
    //    per-row loop also lets us log per-service rejections cleanly).
    let inserted = 0;
    for (const s of KNOWN_SERVICES) {
      const res = await client.query(
        `INSERT INTO cost_caps (service, date, daily_usd_cap)
           VALUES ($1, CURRENT_DATE, $2::numeric)
         ON CONFLICT (service, date) DO NOTHING`,
        [s.service, s.daily_cap],
      );
      if ((res.rowCount ?? 0) > 0) {
        inserted += 1;
      }
    }

    // 2. Confirm today's row count matches expectations.
    const countRes = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM cost_caps WHERE date = CURRENT_DATE`,
    );
    const rowsToday = parseInt(countRes.rows[0]?.n ?? '0', 10);

    const result: CostCapsSeedResult = {
      scanned_at: scannedAt,
      services_total: KNOWN_SERVICES.length,
      inserted,
      already_existed: KNOWN_SERVICES.length - inserted,
      rows_today: rowsToday,
    };

    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        level: 'info',
        event: 'cost_caps_daily_seed',
        ...result,
      }),
    );
    return result;
  } finally {
    client.release();
    await pool.end().catch(() => undefined);
  }
}

export const costCapsDailySeed = inngest.createFunction(
  {
    id: 'cost-caps-daily-seed',
    retries: 2,
    concurrency: [{ limit: 1 }],
    triggers: [
      { cron: '5 0 * * *' }, // 00:05 UTC daily
      { event: 'monitoring/cost-caps.seed' },
    ],
  },
  async ({ step }: { step: any }) => {
    return await step.run('seed-today', () => runCostCapsDailySeed());
  },
);

// Exported for direct invocation (manual runs + tests).
export { runCostCapsDailySeed };
