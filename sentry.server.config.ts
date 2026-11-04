/**
 * Sentry server-side init (Node.js runtime).
 *
 * Loaded automatically by @sentry/nextjs for App Router server code,
 * server actions, and route handlers running on the Node.js runtime.
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
