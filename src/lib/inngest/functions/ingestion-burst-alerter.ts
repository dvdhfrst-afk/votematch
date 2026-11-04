import { inngest } from '../client';
import { pollIngestionErrorBurst } from '@/lib/monitoring/poll-ingestion-errors';

/**
 * Ingestion-burst alerter. Runs every 5 min; fires a Sentry (or structured
 * console) alert when `ingestion_errors` has more than 10 rows in the last
 * 5 minutes.
 *
 * Per council 2026-04-23:
 *   - retries: 0 — if the alerter itself fails, we don't want to spam
 *     re-attempts (and a failed alerter is its own signal in Vercel logs).
 *   - concurrency: 1 — single flight; no point in parallel pollers.
 */
export const ingestionBurstAlerter = inngest.createFunction(
  {
    id: 'ingestion-burst-alerter',
    retries: 0,
    concurrency: [{ limit: 1 }],
    triggers: [
      { cron: '*/5 * * * *' }, // every 5 min
      { event: 'monitoring/ingestion-burst.check' },
    ],
  },
  async ({ step }: { step: any }) => {
    return await step.run('poll', () =>
      pollIngestionErrorBurst({ windowMinutes: 5, threshold: 10 }),
    );
  },
);
