/**
 * Unit tests for the device store (work-order 1A). Runs against the in-memory
 * IndexedDB shim (no headless browser, no new dependency). Covers: empty-load,
 * round-trip persistence, each typed mutator, weight derivation on setEmphasis,
 * export/erase/import, migration back-fill, and the SSR guard.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEVICE_SCHEMA_VERSION,
  emptyProfile,
  eraseProfile,
  exportProfile,
  importProfile,
  isDeviceStorageAvailable,
  loadProfile,
  migrateProfile,
  recordPromptShown,
  saveProfile,
  setAnswer,
  setEmphasis,
  setMatchView,
  setPick,
  setPlanState,
} from '../store';
import { makeShimFactory, resetShimData } from './idb-shim';
import { deriveWeights } from '@/lib/matching/weights';
import type { Domain } from '@/types/database';

let factory: IDBFactory;

beforeEach(() => {
  resetShimData();
  factory = makeShimFactory();
});

describe('device store — availability + empty load', () => {
  it('reports available when a factory is provided', () => {
    expect(isDeviceStorageAvailable(factory)).toBe(true);
  });

  it('load with nothing stored returns an empty, unpersisted profile', async () => {
    const { profile, persisted } = await loadProfile(factory);
    expect(persisted).toBe(false);
    expect(profile.schemaVersion).toBe(DEVICE_SCHEMA_VERSION);
    expect(Object.keys(profile.answers)).toHaveLength(0);
    expect(profile.emphasis).toBeNull();
    expect(profile.matchView).toBe('inferred');
  });
});

describe('device store — round trip', () => {
  it('save then load returns the same profile, persisted=true', async () => {
    const p = emptyProfile();
    p.localId = 'fixed-id';
    await saveProfile(p, factory);
    const { profile, persisted } = await loadProfile(factory);
    expect(persisted).toBe(true);
    expect(profile.localId).toBe('fixed-id');
  });

  it('setAnswer upserts by sub_dimension_id', async () => {
    await setAnswer('sd-1', 0.7, 'quick-match', factory);
    await setAnswer('sd-2', 0.2, 'daily-prompt', factory);
    await setAnswer('sd-1', 0.9, 'quick-match', factory); // update
    const { profile } = await loadProfile(factory);
    expect(Object.keys(profile.answers).sort()).toEqual(['sd-1', 'sd-2']);
    expect(profile.answers['sd-1'].score).toBe(0.9);
    expect(profile.answers['sd-2'].source).toBe('daily-prompt');
    expect(typeof profile.answers['sd-1'].answeredAt).toBe('string');
  });
});

describe('device store — emphasis derives weights identically to the server', () => {
  it('setEmphasis stores chosenDomains + deriveWeights output', async () => {
    const chosen: Domain[] = ['economy', 'healthcare', 'environment'];
    await setEmphasis(chosen, factory);
    const { profile } = await loadProfile(factory);
    expect(profile.emphasis?.chosenDomains).toEqual(chosen);
    const expected = deriveWeights({ domains: chosen, positions: [] });
    expect(profile.emphasis?.domainWeights).toEqual(expected);
    // Sanity: weights sum to ~1.
    const sum = Object.values(profile.emphasis!.domainWeights).reduce(
      (a, b) => a + b,
      0,
    );
    expect(sum).toBeCloseTo(1, 6);
  });
});

describe('device store — picks, plan, matchView, prompt history', () => {
  it('setPick records a pick (and null = undecided)', async () => {
    await setPick('race-1', 'cand-a', undefined, factory);
    await setPick('race-2', null, 'decide at booth', factory);
    const { profile } = await loadProfile(factory);
    expect(profile.picks['race-1'].candidateId).toBe('cand-a');
    expect(profile.picks['race-2'].candidateId).toBeNull();
    expect(profile.picks['race-2'].note).toBe('decide at booth');
  });

  it('setPlanState merges + stamps updatedAt', async () => {
    await setPlanState({ ready: true }, factory);
    const { profile } = await loadProfile(factory);
    expect(profile.plan.ready).toBe(true);
    expect(typeof profile.plan.updatedAt).toBe('string');
  });

  it('setMatchView persists', async () => {
    await setMatchView('both', factory);
    const { profile } = await loadProfile(factory);
    expect(profile.matchView).toBe('both');
  });

  it('recordPromptShown appends history keyed by questionId', async () => {
    await recordPromptShown(
      { questionId: 'q-1', subDimensionId: 'sd-1', answered: true, score: 0.5 },
      factory,
    );
    const { profile } = await loadProfile(factory);
    expect(profile.promptHistory['q-1'].answered).toBe(true);
    expect(profile.promptHistory['q-1'].score).toBe(0.5);
    expect(typeof profile.promptHistory['q-1'].shownAt).toBe('string');
  });
});

describe('device store — privacy controls', () => {
  it('exportProfile returns a versioned envelope', async () => {
    await setAnswer('sd-1', 0.5, 'quick-match', factory);
    const exported = await exportProfile(factory);
    expect(exported.format).toBe('havesay.voter-profile');
    expect(exported.profile.answers['sd-1'].score).toBe(0.5);
  });

  it('eraseProfile clears everything', async () => {
    await setAnswer('sd-1', 0.5, 'quick-match', factory);
    await eraseProfile(factory);
    const { profile, persisted } = await loadProfile(factory);
    expect(persisted).toBe(false);
    expect(Object.keys(profile.answers)).toHaveLength(0);
  });

  it('importProfile round-trips an export', async () => {
    await setAnswer('sd-9', 0.3, 'quick-match', factory);
    const exported = await exportProfile(factory);
    await eraseProfile(factory);
    await importProfile(exported, factory);
    const { profile } = await loadProfile(factory);
    expect(profile.answers['sd-9'].score).toBe(0.3);
  });

  it('importProfile rejects an unknown envelope', async () => {
    await expect(
      // @ts-expect-error deliberately malformed
      importProfile({ format: 'nope', profile: {} }, factory),
    ).rejects.toThrow(/Unrecognized/);
  });
});

describe('device store — migration back-fill', () => {
  it('migrateProfile fills missing fields from a partial record', () => {
    const partial = { schemaVersion: 1, localId: 'x', answers: { a: 1 } };
    const migrated = migrateProfile(partial);
    expect(migrated.schemaVersion).toBe(DEVICE_SCHEMA_VERSION);
    expect(migrated.localId).toBe('x');
    expect(migrated.matchView).toBe('inferred');
    expect(migrated.plan).toBeTruthy();
    expect(migrated.picks).toEqual({});
  });

  it('migrateProfile resets a corrupt (non-object) record to empty', () => {
    const migrated = migrateProfile('garbage');
    expect(migrated.schemaVersion).toBe(DEVICE_SCHEMA_VERSION);
    expect(Object.keys(migrated.answers)).toHaveLength(0);
  });
});

describe('device store — SSR guard', () => {
  it('reports unavailable with no factory + no global indexedDB', () => {
    // In the node test env there is no global indexedDB.
    expect(isDeviceStorageAvailable()).toBe(false);
  });

  it('loadProfile without storage returns empty, unpersisted', async () => {
    const { profile, persisted } = await loadProfile(undefined);
    expect(persisted).toBe(false);
    expect(profile.answers).toEqual({});
  });

  it('saveProfile without storage rejects', async () => {
    await expect(saveProfile(emptyProfile(), undefined)).rejects.toThrow(
      /unavailable/,
    );
  });
});
