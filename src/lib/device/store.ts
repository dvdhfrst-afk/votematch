/**
 * Device store — a typed IndexedDB wrapper for the on-device VoterProfile
 * (work-order 1A). No new dependencies: a hand-rolled promise wrapper over the
 * raw IndexedDB API, plus a migration scaffold.
 *
 * SSR-SAFE: every path that touches IndexedDB is guarded for a browser-only
 * environment. On the server (or any runtime without `indexedDB`) the store's
 * reads resolve to the empty default profile and its writes reject with a
 * clear error, so importing this module during SSR never throws.
 *
 * PRIVACY (work-order invariant 1): this is the ONLY persistence layer for
 * voter opinions. `exportProfile()` and `eraseProfile()` back the privacy
 * page's data-portability + right-to-delete controls.
 *
 * TESTABILITY: the store accepts an injectable `IDBFactory` (defaults to the
 * global `indexedDB`) so unit tests can pass an in-memory shim without a
 * headless browser. See __tests__/store.test.ts.
 */

import type {
  DeviceAnswer,
  DevicePick,
  DevicePlanState,
  DevicePromptHistoryEntry,
  ProfileExport,
  VoterProfile,
} from './types';
import type { Domain, MatchView } from '@/types/database';
import { deriveWeights } from '@/lib/matching/weights';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Current on-device schema version. Bump + add a migration when the shape
 * changes. v2 (Phase 3B, part 1) added the optional `credential` slot; it is a
 * purely ADDITIVE change (no existing field moved or was reshaped), so the v1
 * -> v2 migration is a no-op beyond stamping the new version number. Old
 * profiles simply gain the version bump and keep `credential` undefined.
 */
export const DEVICE_SCHEMA_VERSION = 2;

const DB_NAME = 'havesay-voter';
/**
 * IndexedDB store version. This is the IndexedDB `onupgradeneeded` version, NOT
 * the VoterProfile schemaVersion. Keep it at 1 unless we add/rename object
 * stores; profile-shape migrations run in-record via migrateProfile().
 */
const IDB_VERSION = 1;
const STORE_NAME = 'profile';
/** The single object-store key under which the whole VoterProfile lives. */
const PROFILE_KEY = 'singleton';

// ---------------------------------------------------------------------------
// Environment guard
// ---------------------------------------------------------------------------

/** True only in a browser with IndexedDB available. */
export function isDeviceStorageAvailable(factory?: IDBFactory): boolean {
  const idb = factory ?? (typeof indexedDB !== 'undefined' ? indexedDB : undefined);
  return typeof idb !== 'undefined' && idb !== null;
}

// ---------------------------------------------------------------------------
// Default / empty profile
// ---------------------------------------------------------------------------

/** A random localId. crypto.randomUUID where available; fallback otherwise. */
function newLocalId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback: timestamp + random. Only hit in ancient runtimes / some test envs.
  return `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** A fresh, empty profile at the current schema version. */
export function emptyProfile(now: string = new Date().toISOString()): VoterProfile {
  return {
    schemaVersion: DEVICE_SCHEMA_VERSION,
    localId: newLocalId(),
    answers: {},
    emphasis: null,
    matchView: 'inferred',
    picks: {},
    plan: { ready: false, updatedAt: now },
    promptHistory: {},
    updatedAt: now,
    createdAt: now,
  };
}

// ---------------------------------------------------------------------------
// Migration scaffold
// ---------------------------------------------------------------------------

/**
 * Bring a persisted profile up to DEVICE_SCHEMA_VERSION. Each step is a pure
 * function from vN to vN+1. v1 is the initial version, so there is nothing to
 * migrate yet; the scaffold exists so future shape changes have a home and the
 * store never hands back a stale-shaped record.
 */
export function migrateProfile(raw: unknown): VoterProfile {
  // Defensive: a corrupt / non-object record resets to empty rather than crash.
  if (!raw || typeof raw !== 'object') return emptyProfile();
  const p = raw as Partial<VoterProfile> & { schemaVersion?: number };
  const version = typeof p.schemaVersion === 'number' ? p.schemaVersion : 0;

  // Migration steps run in order. v1 -> v2 (Phase 3B, part 1) is additive: it
  // introduces the optional `credential` slot, which a v1 record simply lacks,
  // so there is nothing to backfill. The `credential ?? undefined` passthrough
  // below preserves an already-present v2 credential across a re-migration.
  //   if (version < 2) { /* additive: no field changes needed */ }
  void version;

  // Fill any missing top-level fields from the empty template so a partially
  // written record (e.g. an interrupted first save) is always well-formed.
  const base = emptyProfile();
  // Optional signal-pool device state (Phase 3B, part 2) rides on the profile as
  // an additive field. Preserved verbatim when present so the opt-in flag +
  // pending contribution survive a load/save round trip; absent otherwise.
  const pool = p.pool;
  return {
    schemaVersion: DEVICE_SCHEMA_VERSION,
    localId: p.localId ?? base.localId,
    answers: p.answers ?? base.answers,
    emphasis: p.emphasis ?? base.emphasis,
    matchView: p.matchView ?? base.matchView,
    picks: p.picks ?? base.picks,
    plan: p.plan ?? base.plan,
    promptHistory: p.promptHistory ?? base.promptHistory,
    // Optional (schema v2). Preserved when present; stays undefined otherwise so
    // the field never appears on a profile that has not run the ceremony.
    ...(p.credential ? { credential: p.credential } : {}),
    ...(pool ? { pool } : {}),
    updatedAt: p.updatedAt ?? base.updatedAt,
    createdAt: p.createdAt ?? base.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Low-level IndexedDB promise wrapper
// ---------------------------------------------------------------------------

function resolveFactory(factory?: IDBFactory): IDBFactory {
  const idb = factory ?? (typeof indexedDB !== 'undefined' ? indexedDB : undefined);
  if (!idb) {
    throw new Error(
      'Device storage is not available in this environment (no IndexedDB).',
    );
  }
  return idb;
}

/** Open (and upgrade) the database, returning a promise for the connection. */
function openDb(factory?: IDBFactory): Promise<IDBDatabase> {
  const idb = resolveFactory(factory);
  return new Promise((resolve, reject) => {
    const req = idb.open(DB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
    req.onblocked = () =>
      reject(new Error('IndexedDB open blocked by another connection'));
  });
}

/** Run a transaction against the profile store and resolve when it commits. */
function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T> | void,
  factory?: IDBFactory,
): Promise<T | undefined> {
  return openDb(factory).then(
    (db) =>
      new Promise<T | undefined>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, mode);
        const store = tx.objectStore(STORE_NAME);
        let result: T | undefined;
        const maybeReq = fn(store);
        if (maybeReq) {
          maybeReq.onsuccess = () => {
            result = maybeReq.result;
          };
          maybeReq.onerror = () =>
            reject(maybeReq.error ?? new Error('IndexedDB request failed'));
        }
        tx.oncomplete = () => {
          db.close();
          resolve(result);
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error ?? new Error('IndexedDB transaction failed'));
        };
        tx.onabort = () => {
          db.close();
          reject(tx.error ?? new Error('IndexedDB transaction aborted'));
        };
      }),
  );
}

// ---------------------------------------------------------------------------
// Public store API
// ---------------------------------------------------------------------------

/**
 * Load the profile. Returns the migrated, well-formed VoterProfile. When there
 * is no stored profile OR device storage is unavailable (SSR), returns a fresh
 * empty profile so callers never have to null-check the shape. `persisted`
 * tells a caller whether the returned profile actually came from disk.
 */
export async function loadProfile(
  factory?: IDBFactory,
): Promise<{ profile: VoterProfile; persisted: boolean }> {
  if (!isDeviceStorageAvailable(factory)) {
    return { profile: emptyProfile(), persisted: false };
  }
  const raw = await withStore<unknown>(
    'readonly',
    (store) => store.get(PROFILE_KEY) as IDBRequest<unknown>,
    factory,
  );
  if (raw == null) return { profile: emptyProfile(), persisted: false };
  return { profile: migrateProfile(raw), persisted: true };
}

/**
 * Persist the whole profile, stamping `updatedAt`. Rejects when device storage
 * is unavailable (never silently drops a write). Returns the stored profile.
 */
export async function saveProfile(
  profile: VoterProfile,
  factory?: IDBFactory,
): Promise<VoterProfile> {
  if (!isDeviceStorageAvailable(factory)) {
    throw new Error('Cannot save profile: device storage unavailable.');
  }
  const toStore: VoterProfile = {
    ...profile,
    schemaVersion: DEVICE_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
  };
  await withStore(
    'readwrite',
    (store) => store.put(toStore, PROFILE_KEY),
    factory,
  );
  return toStore;
}

/**
 * Read-modify-write helper. Loads the current profile (creating an empty one if
 * absent), applies `mutate`, and saves. The single funnel every mutation below
 * goes through so `updatedAt` + schema stamping happen in one place.
 */
export async function updateProfile(
  mutate: (draft: VoterProfile) => VoterProfile,
  factory?: IDBFactory,
): Promise<VoterProfile> {
  const { profile } = await loadProfile(factory);
  const next = mutate(profile);
  return saveProfile(next, factory);
}

// ---------------------------------------------------------------------------
// Typed mutation helpers (thin, pure transforms + a save)
// ---------------------------------------------------------------------------

/** Upsert one answer keyed by sub_dimension_id. */
export async function setAnswer(
  subDimensionId: string,
  score: number,
  source: DeviceAnswer['source'] = 'quick-match',
  factory?: IDBFactory,
): Promise<VoterProfile> {
  const answeredAt = new Date().toISOString();
  return updateProfile(
    (p) => ({
      ...p,
      answers: {
        ...p.answers,
        [subDimensionId]: { subDimensionId, score, answeredAt, source },
      },
    }),
    factory,
  );
}

/**
 * Set the voter's chosen top-3 domains + (re)derive the normalized weight
 * vector from them. `domainWeights` is always recomputed here so the two never
 * drift. Uses the SAME deriveWeights() the server uses, keyed off the chosen
 * domains, so device emphasis matches the server's emphasis math exactly.
 */
export async function setEmphasis(
  chosenDomains: Domain[],
  factory?: IDBFactory,
): Promise<VoterProfile> {
  const domainWeights = deriveWeights({ domains: chosenDomains, positions: [] });
  return updateProfile(
    (p) => ({ ...p, emphasis: { chosenDomains, domainWeights } }),
    factory,
  );
}

/** Set the matcher view preference (stated | inferred | both). */
export async function setMatchView(
  matchView: MatchView,
  factory?: IDBFactory,
): Promise<VoterProfile> {
  return updateProfile((p) => ({ ...p, matchView }), factory);
}

/** Record (or update) the voter's pick for one race. null candidate = undecided. */
export async function setPick(
  raceId: string,
  candidateId: string | null,
  note?: string,
  factory?: IDBFactory,
): Promise<VoterProfile> {
  const pick: DevicePick = {
    raceId,
    candidateId,
    pickedAt: new Date().toISOString(),
    ...(note !== undefined ? { note } : {}),
  };
  return updateProfile(
    (p) => ({ ...p, picks: { ...p.picks, [raceId]: pick } }),
    factory,
  );
}

/** Merge plan-level state (ready flag / note). Stamps plan.updatedAt. */
export async function setPlanState(
  patch: Partial<Omit<DevicePlanState, 'updatedAt'>>,
  factory?: IDBFactory,
): Promise<VoterProfile> {
  return updateProfile(
    (p) => ({
      ...p,
      plan: { ...p.plan, ...patch, updatedAt: new Date().toISOString() },
    }),
    factory,
  );
}

/** Record that a prompt-question was shown (and possibly answered). */
export async function recordPromptShown(
  entry: Omit<DevicePromptHistoryEntry, 'shownAt'> & { shownAt?: string },
  factory?: IDBFactory,
): Promise<VoterProfile> {
  const full: DevicePromptHistoryEntry = {
    ...entry,
    shownAt: entry.shownAt ?? new Date().toISOString(),
  };
  return updateProfile(
    (p) => ({
      ...p,
      promptHistory: { ...p.promptHistory, [full.questionId]: full },
    }),
    factory,
  );
}

// ---------------------------------------------------------------------------
// Privacy controls: export + erase
// ---------------------------------------------------------------------------

/**
 * Export the profile as a JSON-serializable envelope for the user to download.
 * Backs the privacy page's data-portability control. Reads only; never mutates.
 */
export async function exportProfile(factory?: IDBFactory): Promise<ProfileExport> {
  const { profile } = await loadProfile(factory);
  return {
    format: 'havesay.voter-profile',
    exportedAt: new Date().toISOString(),
    profile,
  };
}

/**
 * Erase all on-device voter data (right-to-delete). Deletes the profile record.
 * No-op (resolves) when storage is unavailable, so the privacy page's "erase"
 * button never throws on a server-rendered pass.
 */
export async function eraseProfile(factory?: IDBFactory): Promise<void> {
  if (!isDeviceStorageAvailable(factory)) return;
  await withStore('readwrite', (store) => store.delete(PROFILE_KEY), factory);
}

/**
 * Import a previously-exported profile envelope, replacing the current profile.
 * Validates the envelope format + migrates the inner profile. Used by the
 * privacy page's restore control and by the 1B legacy-import migration shim.
 */
export async function importProfile(
  exported: ProfileExport,
  factory?: IDBFactory,
): Promise<VoterProfile> {
  if (exported?.format !== 'havesay.voter-profile') {
    throw new Error('Unrecognized profile export format.');
  }
  const migrated = migrateProfile(exported.profile);
  return saveProfile(migrated, factory);
}
