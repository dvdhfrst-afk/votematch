/**
 * Every-two-hours state campaign-finance wave.
 *
 * Mirrors `ingest-state-sos-wave.ts`. Fires one `ingest/state-cf.shard` event
 * per registered CF state per run, and a per-state worker hands off to
 * `runAdapter()`. The registry at `src/lib/adapters/state-registry.ts` is
 * the source of truth for which states have a working factory (32 as of
 * 2026-04-24).
 *
 * At a cadence of every 2 hours with 32 states on a 12-shard rotation
 * (totalHours=12 gives ~3 states per run), each state is polled roughly
 * every 24 hours. That matches the per-state reporting cadences (most state
 * CF portals refresh bulk extracts nightly).
 */

import { inngest } from '../client';
import { runAdapter } from '@/lib/adapters';
import {
  STATE_CF_ADAPTERS,
  pickShard,
} from '@/lib/adapters/state-registry';

const CF_STATES = Object.keys(STATE_CF_ADAPTERS).sort();

/** 12 two-hour slots across a day → picks for each cron fire. */
const CF_TOTAL_SHARDS = 12;

export const ingestStateCfWave = inngest.createFunction(
  {
    id: 'ingest-state-cf-wave',
    retries: 2,
    concurrency: [{ limit: 3 }],
    triggers: [
      { cron: '15 */2 * * *' }, // every 2 hours at :15
      { event: 'retention/ingest.state-cf.wave' },
    ],
  },
  async ({ step }: { step: any }) => {
    const slot = await step.run('compute-shard', async () => {
      // Every-2h cron fires at hours 0,2,4,...,22. Turn that into a
      // stable 0..11 slot so 12 shards round-robin across 24h.
      return Math.floor(new Date().getUTCHours() / 2);
    });

    const shard = pickShard(CF_STATES, slot, CF_TOTAL_SHARDS);
    if (shard.length === 0) {
      return { slot, shard: [], fanout: 0, reason: 'no states in shard' };
    }

    await step.sendEvent(
      'fanout-cf-shard',
      shard.map((state) => ({
        name: 'ingest/state-cf.shard',
        data: { state, slot },
      })),
    );

    return { slot, shard, fanout: shard.length };
  },
);

/**
 * Per-state CF shard worker. Receives one event per registered state and
 * runs that state's CF adapter through `runAdapter()`.
 */
export const ingestStateCfShard = inngest.createFunction(
  {
    id: 'ingest-state-cf-shard',
    retries: 2,
    concurrency: [{ limit: 3, key: 'event.data.state' }],
    triggers: [{ event: 'ingest/state-cf.shard' }],
  },
  async ({ event, step }: { event: any; step: any }) => {
    const state = String(event.data?.state ?? '').toUpperCase();
    const factory = STATE_CF_ADAPTERS[state];
    if (!factory) {
      return { skipped: true, state, reason: 'no adapter registered' };
    }

    return await step.run(`run-cf-${state.toLowerCase()}`, async () => {
      const adapter = factory();
      const result = await runAdapter(adapter);
      return {
        state,
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
