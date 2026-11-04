/**
 * State adapter registry.
 *
 * Central lookup of working per-state adapter factories, keyed by the USPS
 * two-letter postal code. This avoids duplicating the per-domain dispatcher
 * registries (e.g. `scripts/ingest-state-cf.ts`) inside every Inngest wave
 * function — the waves import from here to decide which states to fan out to.
 *
 * Inclusion policy
 * ----------------
 * Only list adapters that **currently work end-to-end** (fetch + parse +
 * insert pass against the live portal). States that have a directory but no
 * live factory — or whose factory still points at a Cloudflare-walled URL
 * awaiting a Playwright pass — are deliberately omitted. They come back in
 * when a Tier-2 fallback lands.
 *
 * EXCEPTION — candidacies registry (STATE_SOS_CANDIDACY_ADAPTERS, below):
 * the candidacy adapter family registers EVERY state/territory regardless of
 * source-blocker status. Adapters that can't currently fetch ship as
 * empty-but-correct stubs (parserSignal='no_table' | 'table_empty') and the
 * daily refresh re-checks. Source of truth is
 * `state-sos/candidacy-registry.ts`. The earlier inclusion-policy paragraph
 * does NOT apply to candidacies — registering only "currently working"
 * candidacy adapters is the artificial-scope-limit bug we hit on 2026-04-26.
 *
 * A wave function that iterates an empty shard should no-op, not error; the
 * helper `pickShard()` (below) guarantees a `[]` return when the hour-of-day
 * slice doesn't hit a registered state.
 *
 * Mirrors the dispatcher registries in:
 *   - `scripts/ingest-state-cf.ts`   (state_cf domain — 32 working states)
 *   - `state-sos/candidacy-registry.ts` (state SoS candidacies — 56 entries)
 *   - OH live-results NIST XML
 */

import type { SourceAdapter } from './types';
import type { StateCfEventRow } from './state-cf/shared/base';
import type { StateResultRow } from './state-sos/base';

// ---------------------------------------------------------------------------
// state-sos candidacies — filed candidates for the current cycle
// ---------------------------------------------------------------------------

/**
 * Re-export the canonical 56-entry candidacy registry (50 states + DC + 5 U.S.
 * territories). The map itself lives in `state-sos/candidacy-registry.ts` so
 * the CLI dispatcher (`scripts/ingest-state-candidacies.ts`) and the Inngest
 * wave (`src/lib/inngest/functions/ingest-state-sos-wave.ts`) consume the
 * same object — the previous design carried two copies and silently drifted
 * by 55 entries (the wave fanned out only to IN). See registry header for
 * the empty-but-correct adapter contract.
 */
export {
  CANDIDACY_ADAPTERS as STATE_SOS_CANDIDACY_ADAPTERS,
  type CandidacyAdapterFactory,
} from './state-sos/candidacy-registry';

// ---------------------------------------------------------------------------
// state-cf — campaign finance events (contributions / expenditures)
// ---------------------------------------------------------------------------

import { createFlCfAdapter } from './state-cf/fl/cf-events';
import { createAlCfAdapter } from './state-cf/al/cf-events';
import { createMsCfAdapter } from './state-cf/ms/cf-events';
import { createLaCfAdapter } from './state-cf/la/cf-events';
import { createTnCfAdapter } from './state-cf/tn/cf-events';
import { createKyCfAdapter } from './state-cf/ky/cf-events';
import { createOhCfAdapter } from './state-cf/oh/cf-events';
import { createMiCfAdapter } from './state-cf/mi/cf-events';
import { createInCfAdapter } from './state-cf/in/cf-events';
import { createIlCfAdapter } from './state-cf/il/cf-events';
import { createWiCfAdapter } from './state-cf/wi/cf-events';
import { createMnCfAdapter } from './state-cf/mn/cf-events';
import { createIaCfAdapter } from './state-cf/ia/cf-events';
import { createMoCfAdapter } from './state-cf/mo/cf-events';
import { createKsCfAdapter } from './state-cf/ks/cf-events';
import { createNeCfAdapter } from './state-cf/ne/cf-events';
import { createNdCfAdapter } from './state-cf/nd/cf-events';
import { createSdCfAdapter } from './state-cf/sd/cf-events';
import { createAkCfAdapter } from './state-cf/ak/cf-events';
import { createAzCfAdapter } from './state-cf/az/cf-events';
import { createCaCfAdapter } from './state-cf/ca/cf-events';
import { createCoCfAdapter } from './state-cf/co/cf-events';
import { createHiCfAdapter } from './state-cf/hi/cf-events';
import { createIdCfAdapter } from './state-cf/id/cf-events';
import { createMtCfAdapter } from './state-cf/mt/cf-events';
import { createNmCfAdapter } from './state-cf/nm/cf-events';
import { createNvCfAdapter } from './state-cf/nv/cf-events';
import { createOrCfAdapter } from './state-cf/or/cf-events';
import { createUtCfAdapter } from './state-cf/ut/cf-events';
import { createWaCfAdapter } from './state-cf/wa/cf-events';
import { createWyCfAdapter } from './state-cf/wy/cf-events';
import { createMeCfAdapter } from './state-cf/me/cf-events';

/**
 * Registered campaign-finance adapters. Mirrors the MERGE set from
 * `scripts/ingest-state-cf.ts`. 32 states live; 16 directories (CT/DC/DE/GA/
 * MA/MD/NC/NH/NJ/NY/PA/RI/SC/VA/VT/WV) exist without a factory and are
 * excluded.
 */
export const STATE_CF_ADAPTERS: Record<
  string,
  () => SourceAdapter<StateCfEventRow>
> = {
  // South
  FL: () => createFlCfAdapter({}),
  AL: () => createAlCfAdapter({}),
  MS: () => createMsCfAdapter({}),
  LA: () => createLaCfAdapter({}),
  TN: () => createTnCfAdapter({}),
  KY: () => createKyCfAdapter({}),
  // Midwest
  OH: () => createOhCfAdapter({}),
  MI: () => createMiCfAdapter({}),
  IN: () => createInCfAdapter({}),
  IL: () => createIlCfAdapter({}),
  WI: () => createWiCfAdapter({}),
  MN: () => createMnCfAdapter({}),
  IA: () => createIaCfAdapter({}),
  MO: () => createMoCfAdapter({}),
  KS: () => createKsCfAdapter({}),
  NE: () => createNeCfAdapter({}),
  ND: () => createNdCfAdapter({}),
  SD: () => createSdCfAdapter({}),
  // Mountain + Pacific
  AK: () => createAkCfAdapter({}),
  AZ: () => createAzCfAdapter({}),
  CA: () => createCaCfAdapter({}),
  CO: () => createCoCfAdapter({}),
  HI: () => createHiCfAdapter({}),
  ID: () => createIdCfAdapter({}),
  MT: () => createMtCfAdapter({}),
  NM: () => createNmCfAdapter({}),
  NV: () => createNvCfAdapter({}),
  OR: () => createOrCfAdapter({}),
  UT: () => createUtCfAdapter({}),
  WA: () => createWaCfAdapter({}),
  WY: () => createWyCfAdapter({}),
  // Northeast (partial)
  ME: () => createMeCfAdapter({}),
};

// ---------------------------------------------------------------------------
// state-sos results — post-canvass certified + unofficial landing pages
// ---------------------------------------------------------------------------

import { createOhResultsAdapter } from './state-sos/oh/results';

/**
 * Registered SoS results adapters. Off-cycle these return `[]` (empty) and
 * the runner records the ingestion as `partial` — benign; we just don't
 * surface stale results. During a hot window the dispatcher overrides the
 * landing URL with a deep-link.
 *
 * TODO(2026-04-26): primaries already passed in TX (3/3), AR (3/3), IL
 * (3/17), MS (3/10), NC (3/3), WV (5/12) — we have NO state-results parser
 * for any of them. Need a per-state results parser per state (each SoS
 * publishes a different post-canvass shape: TX civix JSON, NC HTML+CSV,
 * IL ASP.NET, etc.). This is a real coverage gap, not stale code — leaving
 * it as-is until parsers ship rather than registering empty stubs that would
 * mask the gap.
 */
export const STATE_SOS_RESULTS_ADAPTERS: Record<
  string,
  () => SourceAdapter<StateResultRow>
> = {
  OH: () => createOhResultsAdapter(),
};

// ---------------------------------------------------------------------------
// state-sos live results — NIST 1500-100 XML during active election windows
// ---------------------------------------------------------------------------

import { createOhLiveResultsAdapter } from './state-sos/oh/live-results';

/**
 * Registered live-results (NIST XML) adapters. Polled every ~3 min during
 * active election windows; off-cycle they return the most-recent election's
 * rollup (harmless — content_hash dedup prevents duplicate data_sources
 * rows).
 */
export const STATE_SOS_LIVE_RESULTS_ADAPTERS: Record<
  string,
  () => SourceAdapter<StateResultRow>
> = {
  OH: () => createOhLiveResultsAdapter(),
};

// ---------------------------------------------------------------------------
// Sharding helper — round-robin a state list across N hours
// ---------------------------------------------------------------------------

/**
 * Slice an array into `totalHours` chunks and return the chunk for the
 * given hour-of-day.
 *
 * Distribution rule: sizes differ by at most 1 across all shards. When
 * `items.length` is not divisible by `totalHours`, the first
 * `items.length % totalHours` shards get `floor+1` items; the rest get
 * `floor`. This keeps every hour productive instead of front-loading
 * several full shards and leaving later hours empty.
 *
 * Example (50 items, 24 hours): 50 = 24*2 + 2, so shards 0 and 1 each get
 * 3 items and shards 2..23 each get 2. With 48 items the split is exactly
 * 2 items per shard.
 *
 * The hour wraps modulo `totalHours`, so `pickShard(arr, 25, 24)` returns
 * the same slice as `pickShard(arr, 1, 24)`. Negative hours also wrap:
 * `pickShard(arr, -1, 24)` === `pickShard(arr, 23, 24)`.
 *
 * When `items.length < totalHours`, every item goes in its own single-item
 * shard for the first `items.length` hours; subsequent hours return `[]`.
 *
 * Pure function; no I/O, no clock reads. Call sites pass the hour from
 * `new Date().getUTCHours()` (or from an Inngest event payload) so the test
 * harness can pin it deterministically.
 */
export function pickShard<T>(
  items: T[],
  hourOfDay: number,
  totalHours = 24,
): T[] {
  const n = items.length;
  if (n === 0) return [];
  if (totalHours <= 0) return items.slice();
  const h = ((hourOfDay % totalHours) + totalHours) % totalHours;
  const base = Math.floor(n / totalHours);
  const extras = n % totalHours;
  // First `extras` shards get size `base+1`; rest get `base`.
  const size = h < extras ? base + 1 : base;
  if (size === 0) return [];
  const start = h < extras ? h * (base + 1) : extras * (base + 1) + (h - extras) * base;
  return items.slice(start, start + size);
}
