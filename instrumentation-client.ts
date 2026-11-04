// Browser-side Sentry instrumentation for Next.js 16+.
// Runs once on initial client hydration.
//
// Soft-launch context (2026-05-14):
//   * Trial unlimited until 2026-05-28 → all sample rates at 1.0
//   * Session Replay: 100% of normal sessions during trial, 100% on errored
//   * Post-trial: lower replaysSessionSampleRate to 0.1
//
// DSN from env: NEXT_PUBLIC_SENTRY_DSN (must be the public-key DSN, not the
// auth-token form. Format: https://<key>@<org>.ingest.us.sentry.io/<project>)

import * as Sentry from '@sentry/nextjs';

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    // During trial: everything.
    tracesSampleRate: 1.0,
    replaysSessionSampleRate: 1.0,
    replaysOnErrorSampleRate: 1.0,
    integrations: [
      Sentry.replayIntegration({
        // Mask all input/text by default — voters may type addresses.
        // Whitelist non-sensitive elements via [data-sentry-unmask].
        maskAllText: true,
        maskAllInputs: true,
        blockAllMedia: false,
      }),
    ],
    release: process.env.NEXT_PUBLIC_SENTRY_RELEASE ?? 'dev-local',
    environment: process.env.NODE_ENV ?? 'development',
    enabled: process.env.NODE_ENV === 'production' || process.env.NEXT_PUBLIC_SENTRY_LOCAL === '1',
    attachStacktrace: true,
  });
}

// Required for client-side router-navigation instrumentation in App Router.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
