/**
 * Daily ballot-measures wave. Fires at 12:00 UTC.
 *
 * Runs every state in `BALLOT_MEASURES_ADAPTERS` (14 states as of
 * 2026-04-24) sequentially through `runAdapter()`. The per-state adapters
 * are ollama-LLM-heavy (each ballot measure triggers an extraction call),
 * so concurrency is capped at 2 — we'd rather take ~30 minutes end-to-end
 * than saturate the local phi4 worker.
 *
 * Off-cycle most of these return zero rows; that's fine. `expectedMinRows`
 * is set to 0 inside each state's factory so empty days classify as
 * `success`, not `partial`.
 *
 * Pattern: wave function fans out one event per state; per-state worker
 * runs the adapter. This matches the SoS / CF wave functions.
 */

import { inngest } from '../client';
import { runAdapter } from '@/lib/adapters';
import { BALLOT_MEASURES_ADAPTERS } from '@/lib/adapters/ballot-measures';

const BALLOT_MEASURE_STATES = Object.keys(BALLOT_MEASURES_ADAPTERS).sort();

export const ingestBallotMeasuresWave = inngest.createFunction(
  {
    id: 'ingest-ballot-measures-wave',
    retries: 2,
    concurrency: [{ limit: 2 }],
    triggers: [
      { cron: '0 12 * * *' }, // 12:00 UTC daily
      { event: 'retention/ingest.ballot-measures.wave' },
    ],
  },
  async ({ step }: { step: any }) => {
    if (BALLOT_MEASURE_STATES.length === 0) {
      return { fanout: 0, reason: 'no states registered' };
    }

    await step.sendEvent(
      'fanout-ballot-measures',
      BALLOT_MEASURE_STATES.map((state) => ({
        name: 'ingest/ballot-measures.shard',
        data: { state },
      })),
    );

    return { fanout: BALLOT_MEASURE_STATES.length, states: BALLOT_MEASURE_STATES };
  },
);

/**
 * Per-state ballot-measures worker. One event = one adapter run. Concurrency
 * cap of 2 (keyed on state so duplicate events for the same state still
 * serialize) throttles the ollama extractor.
 */
export const ingestBallotMeasuresShard = inngest.createFunction(
  {
    id: 'ingest-ballot-measures-shard',
    retries: 2,
    concurrency: [{ limit: 2 }, { limit: 1, key: 'event.data.state' }],
    triggers: [{ event: 'ingest/ballot-measures.shard' }],
  },
  async ({ event, step }: { event: any; step: any }) => {
    const state = String(event.data?.state ?? '').toUpperCase();
    const factory = BALLOT_MEASURES_ADAPTERS[state];
    if (!factory) {
      return { skipped: true, state, reason: 'no adapter registered' };
    }

    return await step.run(`run-ballot-measures-${state.toLowerCase()}`, async () => {
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
