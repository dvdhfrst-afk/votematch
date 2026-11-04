/**
 * Daily Legistar wave — scrape municipal-meetings from every city in
 * `MUNICIPAL_CITIES` whose platform is `'legistar'`.
 *
 * Fires at 11:00 UTC. Fan-out pattern mirrors the state-SoS wave: one
 * `ingest/legistar.city` event per legistar-platform city, per-city worker
 * runs the adapter. Concurrency 5 — Legistar's shared `webapi.legistar.com`
 * host absorbs parallel requests from different client slugs fine (each
 * client has its own rate bucket on their side), and we throttle per-client
 * inside the adapter with a 0.5 rps token bucket.
 *
 * "Legistar-like" custom cities (NYC) are ALSO scheduled via this wave
 * because their adapter dispatches to the Legistar backend under the hood —
 * see `isLegistarLike()` in `municipal/base.ts`.
 */

import { inngest } from '../client';
import { runAdapter } from '@/lib/adapters';
import { createMunicipalMeetingsAdapter } from '@/lib/adapters/municipal/base';
import { MUNICIPAL_CITIES } from '@/lib/adapters/municipal/cities-seed';

/**
 * Cities scheduled by this wave: anything with platform === 'legistar' OR
 * platform === 'custom' with a Legistar-backed endpoint. The base adapter's
 * `isLegistarLike()` check handles the custom case at run time, so we
 * include custom cities here and let the adapter error out cleanly if the
 * endpoint isn't actually Legistar (the city.platform check in the factory
 * rejects 'todo' entries before we get that far).
 */
const LEGISTAR_CITIES = MUNICIPAL_CITIES.filter(
  (c) => c.platform === 'legistar' || c.platform === 'custom',
).map((c) => c.cityKey);

export const scrapeLegistarWave = inngest.createFunction(
  {
    id: 'scrape-legistar-wave',
    retries: 2,
    concurrency: [{ limit: 5 }],
    triggers: [
      { cron: '0 11 * * *' }, // 11:00 UTC daily
      { event: 'retention/scrape.legistar.wave' },
    ],
  },
  async ({ step }: { step: any }) => {
    if (LEGISTAR_CITIES.length === 0) {
      return { fanout: 0, reason: 'no legistar cities registered' };
    }

    await step.sendEvent(
      'fanout-legistar',
      LEGISTAR_CITIES.map((cityKey) => ({
        name: 'ingest/legistar.city',
        data: { cityKey },
      })),
    );

    return { fanout: LEGISTAR_CITIES.length, cities: LEGISTAR_CITIES };
  },
);

/**
 * Per-city worker. One event → one `createMunicipalMeetingsAdapter` run.
 * The adapter's advisory lock is keyed per (adapter_name, state_fips) so
 * NYC (city_key=nyc) and San Francisco (city_key=sf) never block each
 * other, but two concurrent runs of the same city DO serialize.
 */
export const scrapeLegistarCity = inngest.createFunction(
  {
    id: 'scrape-legistar-city',
    retries: 2,
    concurrency: [{ limit: 5, key: 'event.data.cityKey' }],
    triggers: [{ event: 'ingest/legistar.city' }],
  },
  async ({ event, step }: { event: any; step: any }) => {
    const cityKey = String(event.data?.cityKey ?? '');
    if (!cityKey) {
      return { skipped: true, reason: 'missing cityKey' };
    }

    return await step.run(`run-legistar-${cityKey}`, async () => {
      let adapter;
      try {
        adapter = createMunicipalMeetingsAdapter({ cityKey });
      } catch (err) {
        // Throws on unknown cityKey or platform='todo'. Record and move on.
        return {
          cityKey,
          skipped: true,
          reason: err instanceof Error ? err.message : String(err),
        };
      }
      const result = await runAdapter(adapter);
      return {
        cityKey,
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
