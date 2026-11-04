'use client';

import { useEffect, useState } from 'react';
import {
  INSTALL_PROMPT_STORAGE_KEY as STORAGE_KEY,
  EMPTY_INSTALL_STATE,
  shouldShowByPolicy,
  type InstallPromptState as PromptState,
} from '@/lib/pwa/install-policy';

/**
 * "Add Havesay to your home screen" affordance (1C).
 *
 * Two platforms, one component:
 *   · Chromium (Android Chrome, desktop Chrome/Edge): captures the
 *     `beforeinstallprompt` event and drives the native install flow on tap.
 *   · iOS Safari: no prompt API exists, so we show an instructional card
 *     ("tap Share, then Add to Home Screen") only on iOS Safari that is not
 *     already running standalone.
 *
 * Frequency cap: dismissals and installs are recorded in localStorage (device
 * storage, never the server, per the on-device invariant). Capped so the
 * family is not nagged: hidden permanently once installed or dismissed 2x, and
 * snoozed for 7 days after a single dismissal.
 */

// Minimal typing for the non-standard beforeinstallprompt event.
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

function readState(): PromptState {
  if (typeof localStorage === 'undefined') return { ...EMPTY_INSTALL_STATE };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...EMPTY_INSTALL_STATE };
    const parsed = JSON.parse(raw) as Partial<PromptState>;
    return {
      dismissCount: parsed.dismissCount ?? 0,
      lastDismissedAt: parsed.lastDismissedAt ?? null,
      installed: parsed.installed ?? false,
    };
  } catch {
    return { ...EMPTY_INSTALL_STATE };
  }
}

function writeState(next: PromptState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* private-mode / storage-full: cap silently degrades to "always show" */
  }
}

function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    // iOS Safari legacy flag
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

function isIosSafari(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  const iOS = /iPad|iPhone|iPod/.test(ua);
  // Exclude in-app browsers (Chrome/Firefox on iOS use CriOS/FxiOS) which also
  // cannot Add to Home Screen from the toolbar.
  const safari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
  return iOS && safari;
}

export default function InstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [mode, setMode] = useState<'hidden' | 'chromium' | 'ios'>('hidden');

  useEffect(() => {
    if (isStandalone()) return; // already installed / launched from home screen

    const state = readState();
    if (!shouldShowByPolicy(state, Date.now())) return;

    // Chromium path: wait for the browser to offer install.
    const onBeforeInstall = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
      setMode('chromium');
    };
    window.addEventListener('beforeinstallprompt', onBeforeInstall);

    const onInstalled = () => {
      writeState({ ...readState(), installed: true });
      setMode('hidden');
      setDeferred(null);
    };
    window.addEventListener('appinstalled', onInstalled);

    // iOS path: no event fires, so surface the instructional card directly.
    if (isIosSafari()) setMode('ios');

    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const dismiss = () => {
    const state = readState();
    writeState({
      ...state,
      dismissCount: state.dismissCount + 1,
      lastDismissedAt: Date.now(),
    });
    setMode('hidden');
  };

  const install = async () => {
    if (!deferred) return;
    try {
      await deferred.prompt();
      const choice = await deferred.userChoice;
      if (choice.outcome === 'accepted') {
        writeState({ ...readState(), installed: true });
      } else {
        dismiss();
        return;
      }
    } catch {
      /* prompt already consumed / unsupported */
    }
    setMode('hidden');
    setDeferred(null);
  };

  if (mode === 'hidden') return null;

  return (
    <div
      className="civic-card"
      role="region"
      aria-label="Add Havesay to your home screen"
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 12,
        borderColor: 'var(--civic-border-strong)',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          flexShrink: 0,
          display: 'inline-grid',
          placeItems: 'center',
          width: 40,
          height: 40,
          borderRadius: 8,
          background: 'var(--civic-primary)',
          color: 'var(--civic-on-primary)',
          fontFamily: 'var(--font-serif)',
          fontWeight: 700,
          fontSize: 18,
        }}
      >
        H
      </span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <p
          style={{
            fontFamily: 'var(--font-serif)',
            fontWeight: 700,
            fontSize: 15,
            color: 'var(--civic-text)',
          }}
        >
          Add Havesay to your home screen
        </p>
        {mode === 'ios' ? (
          <p
            style={{
              marginTop: 4,
              fontSize: 13,
              lineHeight: 1.5,
              color: 'var(--civic-text-secondary)',
            }}
          >
            Tap the Share button{' '}
            <span aria-hidden="true">⬆️</span>, then choose{' '}
            <strong>Add to Home Screen</strong>. Your ballot and plan open in one
            tap and stay on your device.
          </p>
        ) : (
          <p
            style={{
              marginTop: 4,
              fontSize: 13,
              lineHeight: 1.5,
              color: 'var(--civic-text-secondary)',
            }}
          >
            One tap back to your ballot next time. Works offline, and your
            answers stay on this device.
          </p>
        )}

        <div className="mt-3 flex items-center gap-2 flex-wrap">
          {mode === 'chromium' && (
            <button
              type="button"
              onClick={install}
              className="civic-btn civic-btn-primary civic-btn-sm"
            >
              Add to home screen
            </button>
          )}
          <button
            type="button"
            onClick={dismiss}
            className="civic-btn civic-btn-tertiary civic-btn-sm"
            aria-label="Dismiss the install prompt"
          >
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}
