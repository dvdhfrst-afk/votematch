/**
 * Sentry client-side init for the browser bundle.
 *
 * Loaded automatically by @sentry/nextjs at app start. Stays inert when
 * SENTRY_DSN is unset so dev/CI don't accidentally report.
 *
 * No DSN is committed here — set NEXT_PUBLIC_SENTRY_DSN in Vercel env.
 * (Client init reads NEXT_PUBLIC_SENTRY_DSN; server init reads SENTRY_DSN.)
 */
import * as Sentry from '@sentry/nextjs';

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

Sentry.init({
  dsn,
  enabled: !!dsn,
  // 10% sampling — enough to spot trends without blowing through quota.
  tracesSampleRate: 0.1,
  // Session replay disabled by default — re-enable per-environment if
  // we decide we want it.
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 0,
});
