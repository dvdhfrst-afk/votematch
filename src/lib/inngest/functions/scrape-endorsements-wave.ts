/**
 * Three-times-daily newspaper editorial endorsement scraper.
 *
 * Runs the shared `newspaperEndorsementsAdapter` across all 30 seed papers
 * at 10:00 / 14:00 / 18:00 UTC. One wave = one adapter run = one
 * `ingestion_runs` row. The adapter internally iterates the seed list and
 * is already injection-defended, Wayback-fallback capable, and verbatim-
 * checked — nothing in this wave function needs to know about any of that.
 *
 * Concurrency 2: multiple Inngest instances may hit the same host if we
 * fanned out per-paper, so we deliberately run the adapter single-flight
 * per wave (concurrency at the Inngest level, token-bucket inside the
 * adapter).
 */

import { inngest } from '../client';
import { runAdapter } from '@/lib/adapters';
import { newspaperEndorsementsAdapter } from '@/lib/adapters/endorsements/newspaper-endorsements-adapter';

export const scrapeEndorsementsWave = inngest.createFunction(
  {
    id: 'scrape-endorsements-wave',
    retries: 2,
    concurrency: [{ limit: 2 }],
    triggers: [
      { cron: '0 10,14,18 * * *' }, // 3x daily
      { event: 'retention/scrape.endorsements' },
    ],
  },
  async ({ step }: { step: any }) => {
    return await step.run('run-endorsements-adapter', async () => {
      const adapter = newspaperEndorsementsAdapter();
      const result = await runAdapter(adapter);
      return {
        status: result.status,
        ingestionRunId: result.ingestionRunId ?? null,
        dataSourceId: result.dataSourceId ?? null,
        rowsInserted: result.stats?.rowsInserted ?? 0,
        rowsFailed: result.stats?.rowsFailed ?? 0,
        reason: result.reason ?? null,
      };
    });
  },
);
