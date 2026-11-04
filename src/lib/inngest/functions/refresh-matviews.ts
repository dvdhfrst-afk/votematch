/**
 * Daily materialized-view refresher. Fires at 11:00 UTC.
 *
 * Calls `public.refresh_ballot_for_precinct()` (PL/pgSQL function that
 * REFRESHes `ballot_for_precinct` CONCURRENTLY and writes a
 * `materialized_view_refresh_log` row with `triggered_by='cron'`).
 *
 * `v_district_coverage_summary` is a plain VIEW, not a matview — it re-runs
 * its SELECT on every read, so there's nothing to refresh. We touch it here
 * only to record a heartbeat in `materialized_view_refresh_log` so
 * `/admin/coverage` can show "last verified X minutes ago" without pretending
 * the view was actually rebuilt.
 *
 * The refresh function takes a session setting:
 *   SET LOCAL ballot_bridge.refresh_trigger = 'cron'
 * to label this row as cron-triggered in the log. We wrap both calls in a
 * single transaction so the label sticks for both log rows.
 */

import { inngest } from '../client';
import { Pool } from 'pg';

function getPool(): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('refresh-matviews: DATABASE_URL must be set');
  }
  return new Pool({ connectionString });
}

export const refreshMatviews = inngest.createFunction(
  {
    id: 'refresh-matviews',
    retries: 2,
    concurrency: [{ limit: 1 }], // single-flight; REFRESH CONCURRENTLY still locks
    triggers: [
      { cron: '0 11 * * *' }, // 11:00 UTC daily
      { event: 'retention/refresh.matviews' },
    ],
  },
  async ({ step }: { step: any }) => {
    return await step.run('refresh-all-matviews', async () => {
      const pool = getPool();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          "SELECT set_config('ballot_bridge.refresh_trigger', 'cron', true)",
        );

        // 1. ballot_for_precinct — the one real matview. Function writes its
        //    own log row on success.
        const matStart = Date.now();
        await client.query('SELECT public.refresh_ballot_for_precinct()');
        const matDuration = Date.now() - matStart;

        // 2. v_district_coverage_summary — regular view. Record a heartbeat
        //    row so the coverage admin can show freshness.
        const covStart = Date.now();
        const covRes = await client.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM v_district_coverage_summary',
        );
        const covRows = parseInt(covRes.rows[0]?.count ?? '0', 10);
        const covDuration = Date.now() - covStart;
        await client.query(
          `INSERT INTO materialized_view_refresh_log
             (view_name, refreshed_at, duration_ms, rows_after, triggered_by, meta)
           VALUES ($1, now(), $2, $3, 'cron', $4::jsonb)`,
          [
            'v_district_coverage_summary',
            covDuration,
            covRows,
            JSON.stringify({ note: 'plain view — heartbeat only' }),
          ],
        );

        // 3. v_interpretation_backlog — real matview (created 2026-05-26;
        //    swapped from a plain VIEW because count(*) across 6 source
        //    tables timed out under PostgREST's 8s statement_timeout). Has
        //    a UNIQUE index on (kind), so REFRESH CONCURRENTLY works.
        const interpStart = Date.now();
        await client.query(
          'REFRESH MATERIALIZED VIEW CONCURRENTLY public.v_interpretation_backlog',
        );
        const interpDuration = Date.now() - interpStart;
        const interpRes = await client.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM public.v_interpretation_backlog',
        );
        const interpRows = parseInt(interpRes.rows[0]?.count ?? '0', 10);
        await client.query(
          `INSERT INTO materialized_view_refresh_log
             (view_name, refreshed_at, duration_ms, rows_after, triggered_by, meta)
           VALUES ($1, now(), $2, $3, 'cron', $4::jsonb)`,
          [
            'v_interpretation_backlog',
            interpDuration,
            interpRows,
            JSON.stringify({ note: 'matview refresh (real)' }),
          ],
        );

        await client.query('COMMIT');

        return {
          status: 'success',
          ballot_for_precinct_ms: matDuration,
          v_district_coverage_summary_ms: covDuration,
          v_district_coverage_summary_rows: covRows,
          v_interpretation_backlog_ms: interpDuration,
          v_interpretation_backlog_rows: interpRows,
        };
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch {
          /* ignore */
        }
        throw err;
      } finally {
        client.release();
        await pool.end().catch(() => undefined);
      }
    });
  },
);
