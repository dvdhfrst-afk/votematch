'use client';

/**
 * React hook layer over the device store (work-order 1A).
 *
 * Provides load / save / subscribe semantics safe for App Router client
 * components:
 *   - SSR-safe: the initial render returns { profile: null, loading: true }
 *     with NO IndexedDB access, so the server render and the client's first
 *     paint agree (no hydration mismatch). The profile loads in an effect,
 *     browser-only.
 *   - Shared subscription: all hook instances read one in-memory snapshot and
 *     re-render together when any of them mutates, so two components on the
 *     same page never disagree about the current profile.
 *   - Every mutation persists to IndexedDB via the store, then broadcasts the
 *     new snapshot to all subscribers.
 *
 * PRIVACY: this hook only ever talks to the device store. It has no network
 * path for opinions (work-order invariant 1).
 */

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { Domain, MatchView } from '@/types/database';
import type { AnswerSource, ProfileExport, VoterProfile } from './types';
import {
  eraseProfile as storeErase,
  exportProfile as storeExport,
  importProfile as storeImport,
  isDeviceStorageAvailable,
  loadProfile,
  recordPromptShown as storeRecordPrompt,
  setAnswer as storeSetAnswer,
  setEmphasis as storeSetEmphasis,
  setMatchView as storeSetMatchView,
  setPick as storeSetPick,
  setPlanState as storeSetPlanState,
} from './store';

// ---------------------------------------------------------------------------
// Module-level shared snapshot + subscriber registry
// ---------------------------------------------------------------------------
// One snapshot shared by every useVoterProfile() consumer so they stay in sync.
// useSyncExternalStore requires getSnapshot to return a STABLE reference when
// nothing changed, so we cache the snapshot object and only replace it on a
// real update.

interface Snapshot {
  profile: VoterProfile | null;
  loading: boolean;
  /** True when IndexedDB is present (browser). False during SSR. */
  available: boolean;
}

let snapshot: Snapshot = { profile: null, loading: true, available: false };
const listeners = new Set<() => void>();
let didKickOffInitialLoad = false;

function emit(next: Snapshot) {
  snapshot = next;
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): Snapshot {
  return snapshot;
}

/**
 * Server + first-client-render snapshot: never touches IndexedDB.
 * MUST return a STABLE reference — useSyncExternalStore calls getServerSnapshot
 * on every render during hydration and React warns / can loop if the object
 * identity changes each call. So we return one frozen constant.
 */
const SERVER_SNAPSHOT: Snapshot = { profile: null, loading: true, available: false };
function getServerSnapshot(): Snapshot {
  return SERVER_SNAPSHOT;
}

/** Load from IndexedDB once, browser-only, and publish to all subscribers. */
async function ensureLoaded(): Promise<void> {
  if (didKickOffInitialLoad) return;
  didKickOffInitialLoad = true;
  const available = isDeviceStorageAvailable();
  if (!available) {
    emit({ profile: null, loading: false, available: false });
    return;
  }
  try {
    const { profile } = await loadProfile();
    emit({ profile, loading: false, available: true });
  } catch {
    // Storage error (private mode, quota, blocked) — degrade to no-profile,
    // not-loading so the UI shows its honest "answer questions" state.
    emit({ profile: null, loading: false, available: false });
  }
}

/** After any store mutation returns the new profile, publish it. */
function publish(profile: VoterProfile) {
  emit({ profile, loading: false, available: true });
}

// ---------------------------------------------------------------------------
// Hook return shape
// ---------------------------------------------------------------------------

export interface UseVoterProfile {
  /** The current on-device profile, or null before load / when unavailable. */
  profile: VoterProfile | null;
  /** True until the first IndexedDB load resolves. */
  loading: boolean;
  /** True when device storage is available (browser with IndexedDB). */
  available: boolean;

  // Mutations — each persists then broadcasts.
  setAnswer: (
    subDimensionId: string,
    score: number,
    source?: AnswerSource,
  ) => Promise<void>;
  setEmphasis: (chosenDomains: Domain[]) => Promise<void>;
  setMatchView: (matchView: MatchView) => Promise<void>;
  setPick: (
    raceId: string,
    candidateId: string | null,
    note?: string,
  ) => Promise<void>;
  setPlanState: (patch: {
    ready?: boolean;
    note?: string;
  }) => Promise<void>;
  recordPromptShown: (entry: {
    questionId: string;
    subDimensionId: string | null;
    answered: boolean;
    score?: number;
  }) => Promise<void>;

  // Privacy controls.
  exportProfile: () => Promise<ProfileExport>;
  importProfile: (exported: ProfileExport) => Promise<void>;
  eraseProfile: () => Promise<void>;

  /** Force a fresh reload from IndexedDB (rarely needed). */
  reload: () => Promise<void>;
}

/**
 * Subscribe a client component to the on-device voter profile. Returns the
 * current profile + typed mutators. Safe to call in multiple components on one
 * page; they share a single snapshot and re-render together.
 */
export function useVoterProfile(): UseVoterProfile {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  // Kick off the browser-only initial load exactly once, after mount.
  useEffect(() => {
    void ensureLoaded();
  }, []);

  const setAnswer = useCallback(
    async (subDimensionId: string, score: number, source: AnswerSource = 'quick-match') => {
      publish(await storeSetAnswer(subDimensionId, score, source));
    },
    [],
  );

  const setEmphasis = useCallback(async (chosenDomains: Domain[]) => {
    publish(await storeSetEmphasis(chosenDomains));
  }, []);

  const setMatchView = useCallback(async (matchView: MatchView) => {
    publish(await storeSetMatchView(matchView));
  }, []);

  const setPick = useCallback(
    async (raceId: string, candidateId: string | null, note?: string) => {
      publish(await storeSetPick(raceId, candidateId, note));
    },
    [],
  );

  const setPlanState = useCallback(
    async (patch: { ready?: boolean; note?: string }) => {
      publish(await storeSetPlanState(patch));
    },
    [],
  );

  const recordPromptShown = useCallback(
    async (entry: {
      questionId: string;
      subDimensionId: string | null;
      answered: boolean;
      score?: number;
    }) => {
      publish(await storeRecordPrompt(entry));
    },
    [],
  );

  const exportProfile = useCallback(() => storeExport(), []);

  const importProfile = useCallback(async (exported: ProfileExport) => {
    publish(await storeImport(exported));
  }, []);

  const eraseProfile = useCallback(async () => {
    // NUKE-BEFORE-ERASE (red-team finding 2): before we destroy the credential,
    // send a best-effort server-side slot delete so a contributed slot is not
    // orphaned with its only removal key gone. Flag-gated + fail-open: it never
    // blocks the local erase. Imported lazily to keep this hook's static import
    // graph free of the submission client (and its crypto) on the common paths.
    try {
      const { isSignalPoolEnabled } = await import('@/lib/signal-pool/flag');
      if (isSignalPoolEnabled()) {
        const { nukePoolBeforeErase } = await import('./pool-submission');
        await nukePoolBeforeErase();
      }
    } catch {
      // Fail-open: a failed pool delete must never prevent the user from erasing
      // their local data. The slot decays out at the staleness horizon as a
      // backstop, and the go-live checklist notes this residual.
    }
    await storeErase();
    emit({ profile: null, loading: false, available: isDeviceStorageAvailable() });
  }, []);

  const reload = useCallback(async () => {
    didKickOffInitialLoad = false;
    emit({ ...snapshot, loading: true });
    await ensureLoaded();
  }, []);

  return {
    profile: snap.profile,
    loading: snap.loading,
    available: snap.available,
    setAnswer,
    setEmphasis,
    setMatchView,
    setPick,
    setPlanState,
    recordPromptShown,
    exportProfile,
    importProfile,
    eraseProfile,
    reload,
  };
}
