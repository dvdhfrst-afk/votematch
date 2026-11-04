'use client';

/**
 * Daily-reminder opt-in + scheduler (work-order Phase 2B, PWA path).
 *
 * Permission-gated, device-scheduled, honest. When the voter turns reminders on
 * we request Notification permission; if granted we arm an in-app timer that,
 * at the preferred local hour, asks the service worker to show a local
 * notification linking back to /guide?prompt=1. Tapping it opens the guide with
 * today's question surfaced.
 *
 * This is the HONEST version of "daily reminder": it fires while the app is open
 * (or opened that day). True background push (fires when the app is CLOSED)
 * needs a push service + a server-stored, device-linked subscription, which we
 * deliberately do NOT build - see src/lib/pwa/daily-reminder.ts for the privacy
 * reasoning. Nothing here talks to a server; state lives in localStorage.
 *
 * The reminder never contains an opinion. Its payload is a generic nudge; the
 * question itself is fetched on-device when the guide opens.
 */

import { useEffect, useRef, useState } from 'react';
import {
  DAILY_REMINDER_STORAGE_KEY as KEY,
  EMPTY_REMINDER_STATE,
  localDayKey,
  msUntilNextReminder,
  shouldFireReminder,
  type DailyReminderState,
} from '@/lib/pwa/daily-reminder';

function readState(): DailyReminderState {
  if (typeof localStorage === 'undefined') return { ...EMPTY_REMINDER_STATE };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...EMPTY_REMINDER_STATE };
    const p = JSON.parse(raw) as Partial<DailyReminderState>;
    return {
      enabled: p.enabled ?? false,
      lastShownDay: p.lastShownDay ?? null,
      hour: typeof p.hour === 'number' ? p.hour : 18,
    };
  } catch {
    return { ...EMPTY_REMINDER_STATE };
  }
}

function writeState(next: DailyReminderState) {
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* private mode / quota: reminder silently degrades to off */
  }
}

/** Supported = SW + Notification API present in a secure context. */
function reminderSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'Notification' in window &&
    window.isSecureContext
  );
}

async function showReminderNow(): Promise<boolean> {
  if (!('serviceWorker' in navigator)) return false;
  try {
    const reg = await navigator.serviceWorker.ready;
    await reg.showNotification('Your daily Havesay question', {
      body: "One tap to keep your ballot match current with the news.",
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: 'havesay-daily-prompt',
      data: { url: '/guide?prompt=1' },
    });
    return true;
  } catch {
    return false;
  }
}

export default function DailyReminder() {
  const [supported, setSupported] = useState(false);
  const [state, setState] = useState<DailyReminderState>({
    ...EMPTY_REMINDER_STATE,
  });
  const [busy, setBusy] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Hydrate from localStorage on mount (browser only).
  useEffect(() => {
    setSupported(reminderSupported());
    setState(readState());
  }, []);

  // Arm / re-arm the in-app timer whenever enabled state changes.
  useEffect(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (!state.enabled || !supported) return;

    const fire = async () => {
      const cur = readState();
      if (shouldFireReminder(cur, new Date())) {
        const shown = await showReminderNow();
        if (shown) {
          const next = { ...cur, lastShownDay: localDayKey() };
          writeState(next);
          setState(next);
        }
      }
      // Re-arm for the next boundary regardless.
      arm();
    };

    const arm = () => {
      const ms = msUntilNextReminder(readState(), new Date());
      if (ms === null) return;
      // Cap the timer so we do not schedule days out (tab may sleep); clamp to
      // at most 6 hours and re-arm on wake.
      const clamped = Math.min(Math.max(ms, 0), 6 * 60 * 60 * 1000);
      timerRef.current = setTimeout(fire, clamped);
    };

    arm();
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [state.enabled, supported]);

  if (!supported) return null;

  async function enable() {
    setBusy(true);
    try {
      const perm = await Notification.requestPermission();
      if (perm === 'granted') {
        const next: DailyReminderState = { ...readState(), enabled: true };
        writeState(next);
        setState(next);
      }
    } catch {
      /* permission prompt unavailable */
    } finally {
      setBusy(false);
    }
  }

  function disable() {
    const next: DailyReminderState = { ...readState(), enabled: false };
    writeState(next);
    setState(next);
  }

  const denied =
    typeof Notification !== 'undefined' && Notification.permission === 'denied';

  return (
    <div
      className="civic-card"
      role="region"
      aria-label="Daily question reminder"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        borderColor: 'var(--civic-border)',
      }}
    >
      <span aria-hidden="true" style={{ fontSize: 20, flexShrink: 0 }}>
        🔔
      </span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <p
          style={{
            fontFamily: 'var(--font-serif)',
            fontWeight: 700,
            fontSize: 14,
            color: 'var(--civic-text)',
          }}
        >
          {state.enabled ? 'Daily reminder is on' : 'Remind me daily'}
        </p>
        <p
          style={{
            marginTop: 2,
            fontSize: 12,
            color: 'var(--civic-text-secondary)',
            lineHeight: 1.5,
          }}
        >
          {denied
            ? 'Notifications are blocked in your browser settings. Enable them there to get a daily nudge.'
            : state.enabled
              ? 'A gentle nudge to answer one question a day, while the app is open. Fully on-device.'
              : 'Get a gentle daily nudge to keep your ballot match current. Nothing leaves your device.'}
        </p>
      </div>
      {!denied &&
        (state.enabled ? (
          <button
            type="button"
            onClick={disable}
            className="civic-btn civic-btn-tertiary civic-btn-sm"
          >
            Turn off
          </button>
        ) : (
          <button
            type="button"
            onClick={enable}
            disabled={busy}
            className="civic-btn civic-btn-secondary civic-btn-sm"
          >
            {busy ? '…' : 'Turn on'}
          </button>
        ))}
    </div>
  );
}
