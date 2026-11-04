/**
 * Hourly state-SoS candidacies wave.
 *
 * Round-robins the registered SoS candidacies adapters across 24 hours so we
 * never hit every state's portal in the same minute. The wave function runs
 * every hour at :00; each run fires one `ingest/state-sos.shard` event per
 * registered state in the current-hour shard. A per-state worker receives the
 * event, instantiates that state's adapter via the registry, and hands off to
 * `runAdapter()` for the full 12-step lifecycle (advisory lock, cost cap,
 * data_sources upsert, validation, insert, status classification).
 *
 * Why a fan-out pattern
 * ---------------------
 * The alternative — one cron per state — wouldn't hit the Inngest concurrency
 * controls or retries evenly. Fan-out via events lets us cap overall state-
 * SoS concurrency at 3 without special-casing per state, and gives each state
 * its own retry counter.
 *
 * Throttle
 * --------
 * Per-state throttling is handled inside the adapter itself (each factory
 * configures a token bucket from `data_sources.meta.min_request_interval_ms`
 * via `createTokenBucket()`). The wave function does NOT re-throttle — the
 * adapter's bucket is the source of truth.
 *
 * Alerting policy (per council 2026-04-24)
 * ----------------------------------------
 * `runAdapter()` already fires `reportIngestionFailure` via Sentry on per-
 * state failures. This wave function therefore logs but does NOT re-page on
 * the same failure — duplicate alerts would dilute the signal.
 */

import { inngest } from '../client';
import { runAdapter } from '@/lib/adapters';
import {
  STATE_SOS_CANDIDACY_ADAPTERS,
  pickShard,
} from '@/lib/adapters/state-registry';

/** Sorted state list for deterministic hour-of-day sharding. */
const SOS_STATES = Object.keys(STATE_SOS_CANDIDACY_ADAPTERS).sort();

export const ingestStateSosWave = inngest.createFunction(
  {
    id: 'ingest-state-sos-wave',
    retries: 2,
    concurrency: [{ limit: 3 }],
    triggers: [
      { cron: '0 */1 * * *' }, // every hour
      { event: 'retention/ingest.state-sos.wave' }, // manual trigger
    ],
  },
  async ({ step }: { step: any }) => {
    const hour = await step.run('compute-shard', async () => {
      return new Date().getUTCHours();
    });

    const shard = pickShard(SOS_STATES, hour);

    if (shard.length === 0) {
      return { hour, shard: [], fanout: 0, reason: 'no states in shard' };
    }

    // Fan out one event per state. Each event is processed by the
    // per-state worker (`ingestStateSosShard`) below.
    await step.sendEvent(
      'fanout-sos-shard',
      shard.map((state) => ({
        name: 'ingest/state-sos.shard',
        data: { state, hour },
      })),
    );

    return { hour, shard, fanout: shard.length };
  },
);

/**
 * Per-state shard worker. Receives one event per registered state from the
 * wave function above (or from a manual send) and runs that state's SoS
 * candidacies adapter.
 *
 * Concurrency is capped to 3 at the wave level so at most 3 state portals
 * are hit simultaneously. The worker itself is keyed per-state so two runs
 * of the same state never stack.
 */
export const ingestStateSosShard = inngest.createFunction(
  {
    id: 'ingest-state-sos-shard',
    retries: 2,
    concurrency: [{ limit: 3, key: 'event.data.state' }],
    triggers: [{ event: 'ingest/state-sos.shard' }],
  },
  async ({ event, step }: { event: any; step: any }) => {
    const state = String(event.data?.state ?? '').toUpperCase();
    const factory = STATE_SOS_CANDIDACY_ADAPTERS[state];
    if (!factory) {
      return { skipped: true, state, reason: 'no adapter registered' };
    }

    return await step.run(`run-sos-${state.toLowerCase()}`, async () => {
      // Factory accepts an options bag with optional electionYear; the wave
      // always uses the adapter's default (current UTC year) so we pass {}.
      const adapter = factory({});
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
