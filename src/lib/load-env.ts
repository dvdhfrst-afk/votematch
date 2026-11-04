/**
 * Fallback environment loader for the `.env.local` file.
 *
 * Why this exists: Node's built-in `--env-file` parser silently skips some
 * entries under specific conditions we haven't fully diagnosed (observed
 * 2026-04-17 on Node 24.14.1 with a 108-char ANTHROPIC_API_KEY value — the
 * line was well-formed, clean ASCII, no specials, yet Node skipped it while
 * loading every other variable). Rather than guess Node's rule set, we ship
 * a small manual parser that's permissive and predictable.
 *
 * Usage at the top of any script that needs reliable env loading:
 *
 *   import { loadEnvLocal } from '@/lib/load-env';
 *   loadEnvLocal();  // populates process.env from .env.local if missing
 *
 * Does NOT override env vars that are already set (shell export wins,
 * matching dotenv behavior). Silent no-op if the file doesn't exist.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function loadEnvLocal(filePath?: string): void {
  const path = filePath ?? join(process.cwd(), '.env.local');
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return; // file missing; silent no-op
  }

  for (const rawLine of text.split(/\r?\n/)) {
    // Skip blanks and comments
    if (!rawLine || /^\s*#/.test(rawLine)) continue;

    const eq = rawLine.indexOf('=');
    if (eq === -1) continue;

    const key = rawLine.slice(0, eq).trim();
    if (!key) continue;

    let value = rawLine.slice(eq + 1);

    // Unwrap surrounding double quotes if the user chose to quote
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }

    // Don't override an already-set *non-empty* env var (dotenv semantics
    // modified: Node's --env-file has been observed to set some keys to "",
    // which would prevent our loader from filling them in).
    const existing = process.env[key];
    if (existing !== undefined && existing !== '') continue;

    process.env[key] = value;
  }
}

/**
 * Plan-auth guards (2026-07-03 incident): the research swarm authenticates via
 * the flat-rate plan token (CLAUDE_CODE_OAUTH_TOKEN). Both the Agent SDK and
 * the Anthropic SDK PREFER ANTHROPIC_API_KEY when it is set, so a bogus or
 * stale value there makes every plan-token consumer fail with a silent 401
 * (authentication_failed) that surfaces only as the dead-batch
 * 'no_file_written'/exit-3 signature — indistinguishable from rate-limit
 * exhaustion. (The plan-usage preflight in check-usage.ts uses the OAuth token
 * directly, so it keeps reading 'allowed' while everything else dies.)
 *
 * Two shapes, pick by process lifetime:
 *
 * - forcePlanAuth(): for DEDICATED plan-token scripts (research-via-claude and
 *   friends) — strips the metered-auth vars from this process's own env.
 * - planAuthEnv(): for code living in a SHARED long-lived process (Next.js /
 *   Inngest) that must not clobber the metered API paths (llm-router,
 *   declarations/extract, body-research/api-fallback). Returns a child env for
 *   Agent SDK `query({ options: { env } })` or child_process spawns. Note the
 *   SDK REPLACES the child env with this object; it does not merge.
 */
export function forcePlanAuth(): void {
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) return;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

export function planAuthEnv(): Record<string, string | undefined> {
  return { ...process.env, ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '' };
}
