/**
 * Unit tests for the state adapter registry + sharding helper.
 *
 * Run:
 *   npx tsx --test src/lib/adapters/__tests__/state-registry.test.ts
 *
 * What we assert
 * --------------
 *   1. Each registry exports the expected factory under the expected USPS key
 *      (spot-checks — full enumeration is exercised by the dispatcher scripts).
 *   2. Factories return an object with a `name` string and an async `run`
 *      method — enough to prove we're getting a SourceAdapter back.
 *   3. `pickShard` distributes items evenly (within ±1) across 24 hours.
 *   4. `pickShard` wraps: hour 25 === hour 1.
 *
 * No network, no DB. Pure function test for the sharder; factory
 * invocation only — we never call adapter.run().
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  STATE_SOS_CANDIDACY_ADAPTERS,
  STATE_CF_ADAPTERS,
  STATE_SOS_RESULTS_ADAPTERS,
  STATE_SOS_LIVE_RESULTS_ADAPTERS,
  pickShard,
} from '../state-registry';

describe('state-registry — STATE_SOS_CANDIDACY_ADAPTERS', () => {
  it('registers IN as the canonical SoS candidacies adapter', () => {
    const factory = STATE_SOS_CANDIDACY_ADAPTERS.IN;
    assert.ok(factory, 'IN factory must be registered');
    const adapter = factory({});
    assert.equal(typeof adapter.name, 'string');
    assert.match(adapter.name, /indiana/i);
    assert.equal(typeof adapter.run, 'function');
  });

  it('registers OH (empty-but-correct stub; CF-walled pending Playwright)', () => {
    // Per 2026-04-26 cleanup: every state/territory ships an adapter, even
    // when the source URL is currently blocked. Stubs return [] with
    // parserSignal='no_table' so runAdapter records `partial` and the daily
    // refresh re-checks. Registering only "live" adapters re-introduces the
    // artificial-scope-limit bug this refactor was created to fix.
    const factory = STATE_SOS_CANDIDACY_ADAPTERS.OH;
    assert.ok(factory, 'OH factory must be registered');
    const adapter = factory({});
    assert.match(adapter.name, /ohio/i);
  });

  it('registers all 56 jurisdictions (50 states + DC + 5 territories)', () => {
    const keys = Object.keys(STATE_SOS_CANDIDACY_ADAPTERS);
    assert.equal(
      keys.length,
      56,
      `expected 56 candidacy adapters; got ${keys.length}: ${keys.sort().join(',')}`,
    );
    // Spot-check a state, DC, and a territory.
    assert.ok(STATE_SOS_CANDIDACY_ADAPTERS.UT, 'UT (project home state) must be registered');
    assert.ok(STATE_SOS_CANDIDACY_ADAPTERS.DC, 'DC must be registered');
    assert.ok(STATE_SOS_CANDIDACY_ADAPTERS.PR, 'PR (territory) must be registered');
  });
});

describe('state-registry — STATE_CF_ADAPTERS', () => {
  it('registers at least 30 working CF states', () => {
    const keys = Object.keys(STATE_CF_ADAPTERS);
    assert.ok(
      keys.length >= 30,
      `expected ≥ 30 CF states, got ${keys.length}`,
    );
  });

  it('registers IN and WA (spot check)', () => {
    const inFactory = STATE_CF_ADAPTERS.IN;
    const waFactory = STATE_CF_ADAPTERS.WA;
    assert.ok(inFactory, 'IN CF factory must be registered');
    assert.ok(waFactory, 'WA CF factory must be registered');
    const inAdapter = inFactory();
    const waAdapter = waFactory();
    assert.match(inAdapter.name, /indiana/i);
    assert.match(waAdapter.name, /washington|wa-/i);
  });

  it('excludes unregistered states (NY, PA)', () => {
    // These state directories exist but have no factory yet. Keep them
    // out of the registry so Inngest doesn't schedule empty runs.
    assert.equal(STATE_CF_ADAPTERS.NY, undefined);
    assert.equal(STATE_CF_ADAPTERS.PA, undefined);
  });
});

describe('state-registry — results adapters', () => {
  it('registers OH results (landing-page default)', () => {
    const factory = STATE_SOS_RESULTS_ADAPTERS.OH;
    assert.ok(factory, 'OH results factory must be registered');
    const adapter = factory();
    assert.match(adapter.name, /ohio/i);
  });

  it('registers OH live-results (NIST XML)', () => {
    const factory = STATE_SOS_LIVE_RESULTS_ADAPTERS.OH;
    assert.ok(factory, 'OH live-results factory must be registered');
    const adapter = factory();
    assert.match(adapter.name, /ohio.*liveresults/i);
  });
});

describe('pickShard', () => {
  it('returns [] for an empty input regardless of hour', () => {
    assert.deepEqual(pickShard<number>([], 0), []);
    assert.deepEqual(pickShard<number>([], 12), []);
  });

  it('partitions a 48-item list into 24 shards of size 2', () => {
    const items = Array.from({ length: 48 }, (_, i) => i);
    for (let h = 0; h < 24; h += 1) {
      const shard = pickShard(items, h);
      assert.equal(shard.length, 2, `hour=${h} expected size 2`);
      assert.deepEqual(shard, [h * 2, h * 2 + 1]);
    }
  });

  it('distributes 50 items across 24 hours within ±1', () => {
    const items = Array.from({ length: 50 }, (_, i) => `s${i}`);
    const sizes: number[] = [];
    for (let h = 0; h < 24; h += 1) {
      sizes.push(pickShard(items, h).length);
    }
    const maxSize = Math.max(...sizes);
    const minSize = Math.min(...sizes);
    assert.ok(
      maxSize - minSize <= 1,
      `spread was ${maxSize - minSize}; expected ≤ 1 (sizes: ${sizes.join(',')})`,
    );
  });

  it('covers every item across the full 24-hour rotation', () => {
    const items = Array.from({ length: 32 }, (_, i) => i);
    const seen = new Set<number>();
    for (let h = 0; h < 24; h += 1) {
      for (const item of pickShard(items, h)) seen.add(item);
    }
    assert.equal(seen.size, items.length, 'every item must appear in some shard');
  });

  it('wraps: hour 25 === hour 1', () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    assert.deepEqual(pickShard(items, 25), pickShard(items, 1));
  });

  it('wraps: hour 48 === hour 0', () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    assert.deepEqual(pickShard(items, 48), pickShard(items, 0));
  });

  it('handles negative hours by normalizing modulo totalHours', () => {
    const items = Array.from({ length: 24 }, (_, i) => i);
    assert.deepEqual(pickShard(items, -1), pickShard(items, 23));
    assert.deepEqual(pickShard(items, -24), pickShard(items, 0));
  });

  it('respects a custom totalHours (12-slot rotation)', () => {
    const items = Array.from({ length: 12 }, (_, i) => `s${i}`);
    for (let h = 0; h < 12; h += 1) {
      const shard = pickShard(items, h, 12);
      assert.equal(shard.length, 1);
      assert.equal(shard[0], `s${h}`);
    }
  });
});
