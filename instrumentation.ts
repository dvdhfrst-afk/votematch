// Server + Edge Sentry instrumentation for Next.js 16+.
// Runs in node runtime AND edge runtime via the dispatching hook below.
// Client init lives in `instrumentation-client.ts` at the same root.
//
// Soft-launch context (2026-05-14):
//   * Free trial = unlimited volume for 14 days → all sample rates at 1.0
//   * After 2026-05-28 trial ends, dial back to 0.1 traces / 0.1 replays in prod
//
// DSN comes from env: NEXT_PUBLIC_SENTRY_DSN (shared client/server format).

import * as Sentry from '@sentry/nextjs';

export async function register() {
  // Accept either name server-side. Client-side (instrumentation-client.ts) can
  // only read NEXT_PUBLIC_* per Next.js bundling rules.
  const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN ?? process.env.SENTRY_DSN;
  if (!dsn) {
    // Don't crash builds when DSN isn't set. Just silently skip.
    return;
  }

  if (process.env.NEXT_RUNTIME === 'nodejs') {
    Sentry.init({
      dsn,
      // Trial period: capture everything. After 2026-05-28, drop to 0.1.
      tracesSampleRate: 1.0,
      // Profile a subset of traces.
      profilesSampleRate: 1.0,
      // Release tag — pulled from CI env or default to dev.
      release: process.env.NEXT_PUBLIC_SENTRY_RELEASE ?? 'dev-local',
      environment: process.env.NODE_ENV ?? 'development',
      // Don't send events from local dev unless explicitly enabled.
      enabled: process.env.NODE_ENV === 'production' || process.env.SENTRY_LOCAL === '1',
      // Surface unhandled promise rejections.
      attachStacktrace: true,
    });
  }

  if (process.env.NEXT_RUNTIME === 'edge') {
    Sentry.init({
      dsn,
      tracesSampleRate: 1.0,
      release: process.env.NEXT_PUBLIC_SENTRY_RELEASE ?? 'dev-local',
      environment: process.env.NODE_ENV ?? 'development',
      enabled: process.env.NODE_ENV === 'production' || process.env.SENTRY_LOCAL === '1',
    });
  }
}

// Required by Sentry — propagates errors from nested request handlers to the
// SDK so they show up as proper exception events rather than getting swallowed.
export const onRequestError = Sentry.captureRequestError;
