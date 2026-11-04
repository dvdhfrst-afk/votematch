'use client';

/**
 * Screen Wake Lock hook (Booth Mode, V2 pillar 5b).
 *
 * The one thing web can do to keep a phone screen readable at arm's length in
 * the booth is the Screen Wake Lock API. There is no web control over auto-DIM
 * or brightness, so this is the honest ceiling: request a 'screen' wake lock
 * while the view is mounted and visible, re-acquire it when the tab returns to
 * the foreground (the OS releases the lock on tab hide), and release it on
 * unmount. Feature-detected: unsupported browsers no-op and report supported:false.
 *
 * No em-dashes or en-dashes anywhere per the project formatting rule.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

// The DOM lib in this TS target does not universally type WakeLock, so we reach
// for it through a narrow structural type rather than depending on lib updates.
interface WakeLockSentinelLike {
  release: () => Promise<void>;
  addEventListener: (type: 'release', listener: () => void) => void;
}
interface WakeLockLike {
  request: (type: 'screen') => Promise<WakeLockSentinelLike>;
}

export interface WakeLockState {
  /** True when the browser exposes the Screen Wake Lock API. */
  supported: boolean;
  /** True while a wake lock is currently held. */
  active: boolean;
}

export function useWakeLock(enabled: boolean = true): WakeLockState {
  // Static capability, read as an external store so it needs no setState-in-effect
  // and is hydration-safe (server snapshot = unsupported).
  const supported = useSyncExternalStore(
    () => () => {},
    () => typeof navigator !== 'undefined' && 'wakeLock' in navigator,
    () => false,
  );
  const [active, setActive] = useState(false);
  const sentinelRef = useRef<WakeLockSentinelLike | null>(null);

  useEffect(() => {
    const wl =
      typeof navigator !== 'undefined'
        ? ((navigator as unknown as { wakeLock?: WakeLockLike }).wakeLock ?? null)
        : null;
    if (!wl) return;

    let cancelled = false;

    const acquire = async () => {
      if (!enabled) return;
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      if (sentinelRef.current) return;
      try {
        const sentinel = await wl.request('screen');
        if (cancelled) {
          sentinel.release().catch(() => {});
          return;
        }
        sentinelRef.current = sentinel;
        setActive(true);
        sentinel.addEventListener('release', () => {
          sentinelRef.current = null;
          setActive(false);
        });
      } catch {
        // Denied (e.g. low battery) or not permitted: degrade quietly.
        setActive(false);
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') void acquire();
    };

    void acquire();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      const s = sentinelRef.current;
      sentinelRef.current = null;
      if (s) s.release().catch(() => {});
    };
  }, [enabled]);

  return { supported, active };
}
