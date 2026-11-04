import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        // The embeddable widget must be frameable by partner newsrooms (the
        // CalMatters model). Permissive frame-ancestors for the pilot; a
        // partner-specific deployment tightens this to that partner's domain.
        // We deliberately do NOT set X-Frame-Options here (it cannot express an
        // allowlist and would conflict); frame-ancestors is the modern control.
        source: "/embed/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value: "frame-ancestors *",
          },
        ],
      },
    ];
  },
  async redirects() {
    return [
      // Canonical voter-journey cleanup (2026-05-22): the legacy-graph
      // post-match "full ballot" booth view (/ballot-view, built on
      // precincts.race_ids + legacy races/candidates + server-side matches)
      // is consolidated into the modern /guide booth surface. 308 so the
      // redirect is cached and link-rot-safe for anything already in the wild.
      { source: "/ballot-view", destination: "/guide", permanent: true },
    ];
  },
};

// Sentry wrapping. Soft-launch sprint 2026-05-14:
//   * Sources maps uploaded automatically when SENTRY_AUTH_TOKEN is in env
//   * No-op silently if SENTRY_AUTH_TOKEN absent — build still passes
//   * Org/project pulled from env (SENTRY_ORG / SENTRY_PROJECT)
// See https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/
export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  // Only upload source maps when auth token is present (CI / production builds).
  authToken: process.env.SENTRY_AUTH_TOKEN,
  // Suppress Sentry telemetry warnings in dev.
  silent: !process.env.CI,
  // Source-map handling: keep them hidden from end users.
  sourcemaps: {
    disable: false,
    deleteSourcemapsAfterUpload: true,
  },
  // Automatically tree-shake out logger statements to reduce bundle size.
  disableLogger: true,
  // Tunnel through a Next.js route to bypass ad-blockers (optional but cheap).
  tunnelRoute: "/monitoring",
});
