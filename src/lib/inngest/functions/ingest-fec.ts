import { inngest } from '../client';
import { createServiceClient } from '@/lib/supabase/server';
import { runAdapter } from '@/lib/adapters';
import { createFecAlertsAdapter } from '@/lib/adapters/federal/fec-alerts-adapter';

/**
 * Daily FEC ingestion for followed federal members.
 *
 * Only runs for members who have at least one active subscriber_follow to avoid
 * burning FEC quota on un-followed members.
 *
 * Ported to the SourceAdapter framework (2026-04-23, pilot #3). This
 * function now:
 *   1. Discovers the set of currently-followed federal members.
 *   2. Builds a scoped FEC-alerts adapter around that set.
 *   3. Hands off to runAdapter() for the 12-step lifecycle — advisory lock,
 *      data_sources upsert, ingestion_runs audit, validation, insert,
 *      status classification.
 *
 * The outward behavior (daily cron at 09:00 UTC, event trigger at
 * `retention/ingest.fec`, concurrency: 1) is unchanged.
 */
export const ingestFec = inngest.createFunction(
  {
    id: 'ingest-fec-daily',
    retries: 2,
    // Throttle prevents per-subscriber-follow fan-out from hammering the FEC
    // API + our DB when the followed-member set is large (council 2026-04-23).
    // No `key` — the throttle is function-global (one bucket for all ingest-fec
    // runs), which is what we want for a single-flight daily cron + event.
    throttle: { limit: 5, period: '1m' },
    concurrency: [{ limit: 3 }],
    triggers: [
      { cron: '0 9 * * *' },
      { event: 'retention/ingest.fec' },
    ],
  },
  async ({ step }: { step: any }) => {
    const followed = await step.run('discover-followed-federals', async () => {
      const supabase = await createServiceClient();
      const { data } = await supabase
        .from('subscriber_follows')
        .select('target_id')
        .eq('target_type', 'federal_member')
        .is('ended_at', null);

      const bioguideIds = Array.from(new Set((data ?? []).map((r: any) => r.target_id as string)));
      if (bioguideIds.length === 0) return [];

      const { data: members } = await supabase
        .from('federal_members')
        .select('bioguide_id, full_name, state, chamber, party')
        .in('bioguide_id', bioguideIds);

      return (members ?? []) as {
        bioguide_id: string;
        full_name: string;
        state: string | null;
        chamber: string | null;
        party: string | null;
      }[];
    });

    if (followed.length === 0) {
      return { skipped: true, reason: 'no followed federal members' };
    }

    const result = await step.run('run-fec-adapter', async () => {
      const adapter = createFecAlertsAdapter({ followed });
      const runResult = await runAdapter(adapter);
      return {
        status: runResult.status,
        ingestionRunId: runResult.ingestionRunId ?? null,
        dataSourceId: runResult.dataSourceId ?? null,
        rowsInserted: runResult.stats?.rowsInserted ?? 0,
        rowsFailed: runResult.stats?.rowsFailed ?? 0,
        reason: runResult.reason ?? null,
      };
    });

    return { followed_count: followed.length, ...result };
  },
);
