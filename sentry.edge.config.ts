/**
 * Sentry edge runtime init.
 *
 * Loaded automatically by @sentry/nextjs for code running on the Edge
 * runtime (proxy.ts, edge route handlers).
 *
 * Stays inert when SENTRY_DSN is unset so dev/CI don't report.
 */
import * as Sentry from '@sentry/nextjs';

const dsn = process.env.SENTRY_DSN;

Sentry.init({
  dsn,
  enabled: !!dsn,
  tracesSampleRate: 0.1,
});
