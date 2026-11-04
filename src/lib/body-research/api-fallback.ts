/**
 * API-mode fallback for body research.
 *
 * Per notes/ballot-bridge-execution-order.md Week 3 item 14: "feature-flagged
 * API-mode code path. Smoke-tested once, then dormant. Cheap insurance."
 *
 * # When this runs
 *
 * Set `BB_RESEARCH_USE_API_FALLBACK=true` in the environment of
 * scripts/research-body.ts. The CLI/plan-auth path is the default; the API
 * fallback only fires when this flag is set.
 *
 * # Why it exists
 *
 * Plan-auth via Claude Code CLI (the default) consumes the user's Anthropic
 * Max plan quota. If that quota gets exhausted mid-cycle — bad rate-limit
 * day, hot 5-state primary, anything — there's no backup. This module is the
 * backup: a code path that uses the bare Anthropic API (`@anthropic-ai/sdk`)
 * to do single-shot completions against the same prompt the CLI uses.
 *
 * # KNOWN LIMITATIONS — read before flipping the flag in production
 *
 * 1. **No iterative tool use.** The CLI path can call smart_fetch, WebFetch,
 *    WebSearch, Read, Write across multiple turns. This API path is a
 *    single completion with no tools. The model only has its training-data
 *    knowledge + whatever is in the prompt. For most state legislatures
 *    that's enough (the chamber size and structure are well-known). For
 *    obscure local bodies it almost certainly is NOT enough.
 * 2. **Billing is real money.** The Max plan covers CLI usage; this path
 *    bills against ANTHROPIC_API_KEY directly. As of 2026-05-26 that
 *    account is exhausted, so this code is not callable until either a
 *    new API key lands or the existing one is replenished.
 * 3. **No verified-domain enforcement.** smart_fetch + the CLI's allowlist
 *    keep ingestion within curated source domains. The API path doesn't
 *    fetch URLs, so the constraint is vacuous — but if the model
 *    hallucinates a citation URL, the downstream `extraction_audit` rows
 *    won't catch it. Anything from this path should be marked
 *    `authoritative=false` until human-reviewed.
 *
 * # Smoke test
 *
 * `app/src/lib/body-research/__tests__/api-fallback.test.ts` exercises the
 * parsing layer with a mocked SDK response — verifies the wiring works
 * without making a real API call. To smoke-test the real path:
 *   1. Set ANTHROPIC_API_KEY to a working key (post-VC).
 *   2. Run `npx tsx scripts/research-body.ts --body-id <id> --dry-run`
 *      with `BB_RESEARCH_USE_API_FALLBACK=true` prepended.
 *   3. Compare the AgentResult against the CLI's output for the same body.
 *
 * # Intentional dormancy
 *
 * This file is the "off switch in case of fire" — not the daily-driver path.
 * Don't accidentally promote it to default. The README check is the env var
 * default: `process.env.BB_RESEARCH_USE_API_FALLBACK === 'true'`.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { AgentResult } from './types';

// The model used for fallback. Match the CLI's default (sonnet) for the
// closest output-shape compatibility. Configurable via env if a future op
// wants to cap costs by routing to haiku.
const FALLBACK_MODEL =
  process.env.BB_FALLBACK_MODEL || 'claude-sonnet-4-5-20250929';

const MAX_TOKENS = 8000;

export interface ApiFallbackInput {
  /** The full prompt text the CLI would have piped via stdin. */
  prompt: string;
  /** body_id, used only for log breadcrumbs. */
  body_id?: string;
}

export interface ApiFallbackOutput {
  /** The parsed AgentResult, when the model returned valid JSON. */
  result: AgentResult | null;
  /** Raw assistant text, for debugging when parsing fails. */
  rawText: string;
  /** Input + output token usage for cost tracking. */
  usage: { input_tokens: number; output_tokens: number };
  /** True when the model's response parsed into a valid AgentResult. */
  parsed: boolean;
  /** Reason for parse failure, if any. */
  parseError?: string;
}

/**
 * Extract the JSON object from the model's response. The CLI prompts ask for
 * JSON output but models will sometimes wrap in markdown fences or add
 * explanatory prose. This pulls out the first ```json fenced block, or the
 * first top-level `{...}` if no fence is present.
 */
export function extractJsonBlock(text: string): string | null {
  // Try ```json fenced block first
  const fenceMatch = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (fenceMatch) return fenceMatch[1];
  // Fall back to first balanced { ... }
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Validate that a parsed object looks like an AgentResult. Conservative: we
 * only check for the presence of the structural fields, not their full
 * shape. The downstream write.ts will re-validate before persisting.
 */
export function looksLikeAgentResult(obj: unknown): obj is AgentResult {
  if (!obj || typeof obj !== 'object') return false;
  const o = obj as Record<string, unknown>;
  return (
    typeof o.body === 'object' &&
    Array.isArray(o.seats) &&
    Array.isArray(o.citations) &&
    typeof o.authoritative === 'boolean'
  );
}

/**
 * Run a single-completion API call and parse the response.
 *
 * Callers (research-body.ts) should:
 *   1. Check the feature flag before calling this.
 *   2. Catch errors and route to the regular CLI path as a final fallback,
 *      so a bad API key doesn't kill ingestion entirely.
 *   3. Force authoritative=false on any result that comes back, regardless
 *      of what the model claimed — this path has no tool-use to ground
 *      claims, so authoritative=true is never appropriate.
 */
export async function runViaApi(
  input: ApiFallbackInput,
  // Injected for tests; defaults to a real SDK client.
  clientFactory: () => Pick<Anthropic, 'messages'> = () =>
    new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }),
): Promise<ApiFallbackOutput> {
  const client = clientFactory();

  const response = await client.messages.create({
    model: FALLBACK_MODEL,
    max_tokens: MAX_TOKENS,
    messages: [
      {
        role: 'user',
        content:
          input.prompt +
          '\n\nIMPORTANT (fallback mode): you have no web-fetch tools in this ' +
          'path. Use only your training data + the source hints already in ' +
          'this prompt. Set `authoritative: false` in your output regardless ' +
          'of confidence — a separate verification pass will run before any ' +
          'row is marked authoritative. Return ONLY valid JSON conforming to ' +
          'the AgentResult schema; no markdown fences, no commentary.',
      },
    ],
  });

  const rawText = response.content
    .filter((block) => block.type === 'text')
    .map((b) => ('text' in b ? b.text : ''))
    .join('\n');

  const usage = {
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
  };

  const jsonBlock = extractJsonBlock(rawText);
  if (!jsonBlock) {
    return {
      result: null,
      rawText,
      usage,
      parsed: false,
      parseError: 'no_json_block_found',
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonBlock);
  } catch (e) {
    return {
      result: null,
      rawText,
      usage,
      parsed: false,
      parseError: `json_parse_error: ${(e as Error).message}`,
    };
  }

  if (!looksLikeAgentResult(parsed)) {
    return {
      result: null,
      rawText,
      usage,
      parsed: false,
      parseError: 'shape_mismatch_not_agent_result',
    };
  }

  // CRITICAL SAFETY OVERRIDE: this path has no tools; force authoritative=false
  // regardless of what the model said. Per LIMITATIONS above.
  const result: AgentResult = {
    ...parsed,
    authoritative: false,
    notes:
      ((parsed as AgentResult).notes ? (parsed as AgentResult).notes + '\n\n' : '') +
      '[api-fallback] authoritative forced FALSE — model had no tool access.',
  };

  return {
    result,
    rawText,
    usage,
    parsed: true,
  };
}

/**
 * Check the env-var flag in one place so research-body.ts can branch cleanly.
 */
export function isApiFallbackEnabled(): boolean {
  return process.env.BB_RESEARCH_USE_API_FALLBACK === 'true';
}
