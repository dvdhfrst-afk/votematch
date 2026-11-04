'use client';

import { useEffect } from 'react';

/**
 * Registers the hand-rolled service worker (public/sw.js) once, on the client,
 * after the window has loaded. No UI. Safe to mount in the root layout.
 *
 * · Registration is gated on `serviceWorker` support (older browsers no-op).
 * · Registered at scope '/' so it can serve the whole app shell.
 * · Respects Save-Data / prefers-reduced-data: when the user has opted into
 *   data saving we still register (the SW SAVES data by serving from cache),
 *   but we skip the eager positions-bundle warm-up in the SW install list.
 * · Never blocks render; failures are swallowed (the app works without it).
 */
export default function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
      return;
    }
    // Only register in secure contexts (https or localhost). Vercel + local dev
    // both qualify; a plain-http proxy would not, and SW registration would
    // throw there.
    if (typeof window !== 'undefined' && !window.isSecureContext) {
      return;
    }

    const register = () => {
      navigator.serviceWorker
        .register('/sw.js', { scope: '/' })
        .catch(() => {
          /* SW is a progressive enhancement; ignore failures */
        });
    };

    if (document.readyState === 'complete') {
      register();
    } else {
      window.addEventListener('load', register, { once: true });
      return () => window.removeEventListener('load', register);
    }
  }, []);

  return null;
}
