import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration for Havesay.
 *
 * Existing test files in `src/lib/adapters/` and a few other locations are
 * written against the built-in `node:test` runner (`import { test } from
 * 'node:test'`). Those tests run via their own bespoke harnesses and must NOT
 * be picked up by vitest, or vitest tries to execute them with `describe/it`
 * semantics they were not written for.
 *
 * Strategy: opt-in include list — only the three highest-blast-radius paths
 * below run under vitest. Adapter tests continue to run via `node:test`.
 *
 * Path aliases (`@/*`) are resolved via Vite's native tsconfig paths support
 * (no plugin needed since Vite 6).
 */
export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    environment: 'node',
    globals: false,
    include: [
      // Highest-blast-radius critical paths — explicit allow-list. We
      // intentionally do NOT use a glob like '**/*.test.ts' because the
      // adapters suite uses node:test (incompatible API).
      'src/lib/matching/__tests__/**/*.test.ts',
      'src/lib/device/__tests__/**/*.test.ts',
      'src/lib/signal-pool/__tests__/**/*.test.ts',
      'src/lib/ballot-lookup/__tests__/**/*.test.ts',
      'src/lib/text/__tests__/**/*.test.ts',
      'src/lib/body-research/__tests__/**/*.test.ts',
      'src/lib/positioning/__tests__/**/*.test.ts',
      'src/lib/ingest/__tests__/**/*.test.ts',
      'src/lib/guide/__tests__/**/*.test.ts',
      'src/lib/pwa/__tests__/**/*.test.ts',
      'src/app/__tests__/**/*.test.ts',
    ],
    exclude: [
      'node_modules/**',
      '.next/**',
      'dist/**',
    ],
  },
});
