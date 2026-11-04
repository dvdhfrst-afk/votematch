/**
 * LLM router for the extraction pipeline.
 *
 * Thesis (2026-04-24): we pay real money per Anthropic call, but the
 * local-LLM bakeoff (see 11-local-llm/03-comprehensive-bakeoff.md) showed
 * phi4:14b + RAG achieves 84% direction agreement with Claude at $0/call.
 * For the five Phase F extractors — state rulemaking, ballot measures,
 * municipal meetings, state CF, officeholders, endorsements — defaulting
 * to local phi4 preserves Claude budget without sacrificing the injection
 * defenses that already ship (they are backend-agnostic).
 *
 * Routing rules (default `backend='auto'`):
 *
 *   riskClass=low_stakes            -> ollama (phi4:14b). Calendar/meeting/comment-window.
 *   riskClass=attributed_position   -> ollama first; on schema/nonce failure, fall back
 *                                     to Claude. Defamation-adjacent — phi4 takes the
 *                                     first pass, Claude verifies when phi4 stumbles.
 *   riskClass=ethics_or_character   -> Claude only. Never auto-publish; never local.
 *
 * Explicit `backend='claude'` / `'ollama'` overrides the risk-class decision.
 *
 * Env:
 *   EXTRACTION_BACKEND_OVERRIDE=claude|ollama  — force every call to one backend
 *                                                 (module-load-time; restart to change).
 *
 * Cost accounting:
 *   Every call wires through cost_cap_check_and_consume(). Ollama ticks
 *   the request_count at $0; Claude ticks the daily spend with an estimated
 *   cost computed from prompt+completion tokens and the public rate card.
 *   If the cap helper refuses, callExtractor throws with a clear message.
 *
 * This module intentionally does NOT modify src/lib/claude.ts or
 * src/lib/ollama.ts. It reuses the same HTTP pattern (ollama /api/chat,
 * Anthropic messages.create) because those wrappers are tuned for position
 * classification, not free-form extraction schemas.
 */
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { createServiceClient } from '@/lib/supabase/server';
import { loadEnvLocal } from '@/lib/load-env';

loadEnvLocal();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ExtractorBackend = 'ollama' | 'claude' | 'auto';
export type ResolvedBackend = 'ollama' | 'claude';

export type RiskClass = 'low_stakes' | 'attributed_position' | 'ethics_or_character';

export type LlmRouterOptions<T> = {
  /** Explicit override. Defaults to 'auto' which consults riskClass. */
  backend?: ExtractorBackend;
  riskClass: RiskClass;
  systemPrompt: string;
  userMessage: string;
  /** Zod schema used to validate + type the parsed JSON output. */
  schema: z.ZodType<T>;
  /** Extra claude-specific knobs, ignored by ollama. */
  claude?: {
    /** Model id override; defaults to CLAUDE_MODEL env or claude-opus-4-7. */
    model?: string;
    /** max_tokens for the response. Defaults to 4096. */
    maxTokens?: number;
    /** effort (low|medium|high). Defaults to 'medium'. */
    effort?: 'low' | 'medium' | 'high';
    /** Whether to attach cache_control to the system block. Defaults to true. */
    cacheControl?: boolean;
    /**
     * The JSON Schema to pass as the output_config format. When omitted, the
     * schema is derived from the Zod `schema` via z.toJSONSchema(). For
     * existing extractors that hand-roll a JSON Schema (e.g. to add _echo),
     * pass it through here explicitly.
     */
    jsonSchema?: Record<string, unknown>;
  };
  /** Extra ollama-specific knobs. */
  ollama?: {
    model?: string;
    numCtx?: number;
    /** JSON Schema for constrained decoding. When omitted, derived from Zod. */
    jsonSchema?: Record<string, unknown>;
  };
  /**
   * Call-site label for metrics. Stored nowhere right now, but included in
   * the logged error message on failure for easier triage.
   */
  label?: string;
  /**
   * Optional second-stage validator that runs AFTER `schema.parse`. Used by
   * extractors to run their own injection-defense checks (nonce echo,
   * grounding, ethics) against the raw body. Throw from this callback — or
   * return `{ ok: false }` — to signal the validation failed.
   *
   * When a validation failure occurs on an attributed_position extraction
   * that resolved to ollama under 'auto', the router automatically retries
   * on Claude. For all other combinations the error propagates.
   */
  postValidate?: (raw: string, parsed: T) => void | { ok: true } | { ok: false; reason: string };
  /**
   * Optional caller-supplied AbortSignal. Composes with the router's internal
   * per-call timeout (LLM_CALL_TIMEOUT_MS, default 60s) — whichever fires
   * first aborts the underlying fetch. Use this to propagate a higher-level
   * cancellation (e.g. an Inngest step deadline) down into the LLM call.
   */
  signal?: AbortSignal;
};

export type LlmRouterResult<T> = {
  parsed: T;
  raw: string;
  backend: ResolvedBackend;
  model: string;
  promptVersion: string;
  tokensInput?: number;
  tokensOutput?: number;
  costUsd: number;
  latencyMs: number;
  /** True if ollama was tried first and we fell back to claude. */
  fellBackToClaude?: boolean;
  /**
   * Set when the router intended to call Claude (either as the resolved
   * backend or as the attributed_position fallback) but Claude's daily
   * cost cap was exhausted. When this flag is set on a result that came
   * back from ollama, the caller should record `validation_status='ollama_only'`
   * on its audit row — the row is not Claude-verified, but is a valid
   * ollama-only extraction the caller can use as a graceful degradation.
   */
  claudeSkippedDueToCap?: boolean;
};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const OLLAMA_HOST = process.env.OLLAMA_HOST ?? 'http://localhost:11434';
const OLLAMA_EXTRACT_MODEL = process.env.OLLAMA_EXTRACT_MODEL ?? process.env.OLLAMA_MODEL ?? 'phi4:14b';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL ?? 'claude-opus-4-7';
/** Bumped together with extractors/index.ts PROMPT_VERSION. */
export const ROUTER_PROMPT_VERSION = '2026-04-23-v2-injection-defense';

/**
 * Default per-call timeout for LLM fetches. Without this, a hung ollama
 * request (or a slow model run) can wedge the entire pipeline indefinitely
 * — Swarm 3 saw this in newspaper-endorsements before per-article timeouts
 * were added at the caller layer.
 *
 * Override at runtime via `LLM_CALL_TIMEOUT_MS=N` in env (e.g. set higher
 * for `--once` runs against a slow local model, or lower in CI). The value
 * applies to BOTH backends: ollama via fetch's `signal`, Claude via the
 * Anthropic SDK's request `signal`.
 */
const DEFAULT_LLM_TIMEOUT_MS = (() => {
  const raw = process.env.LLM_CALL_TIMEOUT_MS;
  if (!raw) return 60_000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60_000;
})();

/**
 * Build an AbortController that fires after `DEFAULT_LLM_TIMEOUT_MS` AND
 * relays an optional caller-supplied signal. Either source aborts the
 * controller — whichever fires first wins.
 *
 * Returns the controller plus a `cleanup` that the caller MUST invoke in a
 * `finally` block to clear the timer and detach the listener (otherwise we
 * leak a setTimeout handle and a one-shot listener per call).
 */
function buildLlmAbort(callerSignal?: AbortSignal): {
  controller: AbortController;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    if (!controller.signal.aborted) {
      controller.abort(new Error(`LLM call timed out after ${DEFAULT_LLM_TIMEOUT_MS}ms`));
    }
  }, DEFAULT_LLM_TIMEOUT_MS);

  let onCallerAbort: (() => void) | null = null;
  if (callerSignal) {
    if (callerSignal.aborted) {
      // Already aborted — propagate immediately. The reason may be undefined
      // on older runtimes; pass through whatever the caller provided.
      controller.abort(
        (callerSignal as AbortSignal & { reason?: unknown }).reason ?? new Error('aborted'),
      );
    } else {
      onCallerAbort = () => {
        controller.abort(
          (callerSignal as AbortSignal & { reason?: unknown }).reason ?? new Error('aborted'),
        );
      };
      callerSignal.addEventListener('abort', onCallerAbort, { once: true });
    }
  }

  return {
    controller,
    cleanup: () => {
      clearTimeout(timer);
      if (callerSignal && onCallerAbort) {
        callerSignal.removeEventListener('abort', onCallerAbort);
      }
    },
  };
}

/**
 * Global override captured once at module init. Changing the env after the
 * module loads has no effect (intentional: prevents mid-run routing flips).
 */
const GLOBAL_OVERRIDE: ExtractorBackend | null = (() => {
  const v = (process.env.EXTRACTION_BACKEND_OVERRIDE ?? '').toLowerCase().trim();
  if (v === 'claude' || v === 'ollama') return v;
  return null;
})();

// Anthropic API prices as of 2026-04-24 for claude-opus-4-7 (USD per token).
// Used only for metering; the cap decision uses the same numbers to stay in sync.
// Rates: $15/M input, $75/M output. If pricing changes, update here only.
const CLAUDE_INPUT_COST_PER_TOKEN = 15 / 1_000_000;
const CLAUDE_OUTPUT_COST_PER_TOKEN = 75 / 1_000_000;

// ---------------------------------------------------------------------------
// Backend resolution
// ---------------------------------------------------------------------------

/**
 * Decide which backend a call should use before the first attempt.
 *
 * Returns the concrete backend to try first. For `attributed_position` under
 * `auto`, returns 'ollama' (the fallback to claude is handled by callExtractor
 * when the ollama attempt fails validation).
 */
export function resolveBackend(riskClass: RiskClass, requested?: ExtractorBackend): ResolvedBackend {
  // Global override wins over everything.
  if (GLOBAL_OVERRIDE === 'claude' || GLOBAL_OVERRIDE === 'ollama') {
    return GLOBAL_OVERRIDE;
  }
  if (requested === 'claude' || requested === 'ollama') {
    return requested;
  }
  // auto (or undefined): consult risk class.
  if (riskClass === 'ethics_or_character') return 'claude';
  // low_stakes and attributed_position both try ollama first.
  return 'ollama';
}

/** Thrown when a caller-supplied postValidate callback rejects a response. */
export class PostValidationError extends Error {
  constructor(reason: string) {
    super(`post-validation failed: ${reason}`);
    this.name = 'PostValidationError';
  }
}

/**
 * Thrown when the cost cap helper (cost_caps + cost_cap_check_and_consume RPC)
 * refuses a Claude call OR when the helper itself cannot be reached
 * (schema-cache miss, RPC timeout). Both conditions are transient — the row
 * should be retried on the next pipeline cycle, NOT marked unresolvable.
 *
 * Callers that catch this error should:
 *   - log it (e.g. console.error / ingestion_errors)
 *   - leave any per-row interpretation_status at 0 (pending) so the next
 *     pipeline cycle picks the row up again
 *   - NOT mark the row as unresolvable
 *
 * The wrapped `kind` field distinguishes the two transient subtypes so an
 * operator can tell `cap_exhausted` (raise the cap or wait for UTC reset)
 * from `rpc_unreachable` (DB connectivity / schema cache issue).
 */
export class LlmRouterCapExceededError extends Error {
  /** 'cap_exhausted' = budget refused; 'rpc_unreachable' = helper unavailable. */
  readonly kind: 'cap_exhausted' | 'rpc_unreachable';
  /** Service name that was refused (e.g. 'claude_api'). */
  readonly service: string;
  constructor(kind: 'cap_exhausted' | 'rpc_unreachable', service: string, message: string) {
    super(message);
    this.name = 'LlmRouterCapExceededError';
    this.kind = kind;
    this.service = service;
  }
}

/**
 * Detect whether an arbitrary thrown value should be treated as a transient
 * cost-cap / RPC failure. Used by callers (e.g. classify-bills-batch) that
 * still see legacy plain-Error throws from older paths during deploys.
 */
export function isTransientCapError(err: unknown): boolean {
  if (err instanceof LlmRouterCapExceededError) return true;
  const msg = err instanceof Error ? err.message : String(err);
  if (!msg) return false;
  return (
    msg.includes('Cost cap exceeded') ||
    msg.includes('cost_cap_check_and_consume RPC failed') ||
    msg.includes('schema cache') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('ECONNREFUSED') ||
    msg.includes('ECONNRESET')
  );
}

// ---------------------------------------------------------------------------
// Cost cap
// ---------------------------------------------------------------------------

/**
 * Test hook: replace the cost-cap check. Returning `true` allows the call;
 * returning `false` (or throwing a synthetic Cost-cap-exceeded error) mirrors
 * the real cost_caps RPC. Set to `null` to restore real behavior.
 */
let _costCapOverride: ((service: string, costUsd: number) => boolean) | null = null;
export function _setCostCapForTests(
  override: null | ((service: string, costUsd: number) => boolean),
): void {
  _costCapOverride = override;
}

// ---------------------------------------------------------------------------
// Claude $0-cap pre-check (added 2026-04-25 for the operator's $0 budget reality).
//
// Reading: feedback_no_claude_api_use_plan.md — `cost_caps.claude_api` is
// pinned to $0/day so the API never charges. The router should detect that
// once per UTC day and skip every Claude attempt for the rest of the day.
// This avoids the round-trip to the cost-cap RPC AND the misleading
// "Cost cap exceeded" error that gets reported as adapter failure.
//
// Behavior:
//   - First call after UTC-midnight: query cost_caps for today's claude_api row.
//   - Cache the result (cap value + date) for the rest of the UTC day.
//   - Subsequent calls hit the cache.
//   - On DB error: return `null` (unknown). callers treat unknown as
//     "let the real RPC decide" so we never lock ourselves out due to a
//     transient query failure.
//
// Test hook: `_setClaudeCapForTests(usd | null)` lets tests pin the cached
// cap value without touching the DB.
// ---------------------------------------------------------------------------

type ClaudeCapCacheEntry = {
  /** UTC date (YYYY-MM-DD) for which the cap was queried. */
  date: string;
  /** daily_usd_cap from cost_caps. NULL = unknown (DB query failed). */
  capUsd: number | null;
};

let _claudeCapCache: ClaudeCapCacheEntry | null = null;
let _claudeCapTestOverride: number | null | undefined = undefined;

/** Test hook: pin the Claude cap. Pass `undefined` to clear the override. */
export function _setClaudeCapForTests(usd: number | null | undefined): void {
  _claudeCapTestOverride = usd;
  _claudeCapCache = null; // force re-fetch on next call
}

/** Test hook: clear the Claude-cap cache so the next call re-reads. */
export function _resetClaudeCapCacheForTests(): void {
  _claudeCapCache = null;
}

function utcDateString(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/**
 * Read today's claude_api cost cap. Cached for the rest of the UTC day.
 * Returns the cap in USD, or `null` if the DB query failed (treat as unknown).
 */
async function readClaudeDailyCap(): Promise<number | null> {
  if (_claudeCapTestOverride !== undefined) {
    return _claudeCapTestOverride;
  }
  const today = utcDateString();
  if (_claudeCapCache && _claudeCapCache.date === today) {
    return _claudeCapCache.capUsd;
  }
  try {
    const supabase = await createServiceClient();
    const { data, error } = await supabase
      .from('cost_caps')
      .select('daily_usd_cap')
      .eq('service', 'claude_api')
      .eq('date', today)
      .limit(1)
      .maybeSingle();
    if (error) {
      // Unknown — don't cache (next call retries).
      return null;
    }
    const cap =
      data && typeof (data as { daily_usd_cap: number | string }).daily_usd_cap !== 'undefined'
        ? Number((data as { daily_usd_cap: number | string }).daily_usd_cap)
        : null;
    _claudeCapCache = { date: today, capUsd: Number.isFinite(cap as number) ? (cap as number) : null };
    return _claudeCapCache.capUsd;
  } catch {
    // DB unreachable / network — unknown.
    return null;
  }
}

/**
 * Returns true when Claude is hard-disabled by configuration for today
 * (cap=0). Returns false when cap > 0 OR cap is unknown (don't lock out
 * on transient errors). Used by callExtractor to skip Claude attempts
 * entirely under the operator's $0 budget.
 */
async function isClaudeBudgetZero(): Promise<boolean> {
  const cap = await readClaudeDailyCap();
  return cap === 0;
}

/**
 * Atomic check + consume on cost_caps. Throws on refusal.
 *
 * For ollama calls cost_usd is always 0 — the helper will no-op the spend
 * but still tick the request_count, giving us free metrics.
 *
 * If the DB is unreachable this call returns silently — the router is still
 * useful when developing against a dev DB that is paused. A production
 * deploy should monitor cost_cap failures separately.
 */
/** Compose a human-readable cap-exceeded message that names the cap, the
 *  current spend (when reachable), and the next reset boundary. Used by
 *  every refusal path so ops sees enough to act without poking the DB. */
async function formatCapExceededMessage(
  service: string,
  costUsd: number,
  supabase: Awaited<ReturnType<typeof createServiceClient>> | null,
): Promise<string> {
  // Next reset is the next UTC midnight (matches cost_caps.date semantics).
  const now = new Date();
  const tomorrow = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0, 0, 0, 0,
  ));
  const resetIso = tomorrow.toISOString();
  const minutesUntilReset = Math.ceil((tomorrow.getTime() - now.getTime()) / 60_000);
  let capInfo = '(cap row unavailable)';
  if (supabase) {
    try {
      const { data } = await supabase
        .from('cost_caps')
        .select('daily_usd_cap, daily_usd_spent, request_count, date')
        .eq('service', service)
        .order('date', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (data) {
        capInfo =
          `cap=$${data.daily_usd_cap}/day, ` +
          `spent=$${data.daily_usd_spent} (${data.request_count} reqs), ` +
          `row.date=${data.date}`;
      }
    } catch {
      // best-effort; fall through to generic info
    }
  }
  return (
    `Cost cap exceeded for service='${service}' (this call cost_usd=${costUsd}). ` +
    `Cap status: ${capInfo}. ` +
    `Next reset: ${resetIso} (~${minutesUntilReset} min from now). ` +
    `Fix: raise daily_usd_cap on the latest cost_caps row for this service, ` +
    `or wait for the UTC-midnight reset.`
  );
}

async function consumeCostCap(service: string, costUsd: number): Promise<void> {
  if (_costCapOverride) {
    const allowed = _costCapOverride(service, costUsd);
    if (!allowed) {
      throw new LlmRouterCapExceededError(
        'cap_exhausted',
        service,
        await formatCapExceededMessage(service, costUsd, null),
      );
    }
    return;
  }
  try {
    const supabase = await createServiceClient();
    const { data, error } = await supabase.rpc('cost_cap_check_and_consume', {
      p_service: service,
      p_cost_usd: costUsd,
    });
    if (error) {
      // Missing function, schema-cache miss, or permissions — surface a
      // clear typed error so the caller can distinguish "transient cap /
      // helper failure (retry next cycle)" from a hard model-output error
      // (mark unresolvable). schema-cache misses are common right after a
      // migration and resolve themselves once PostgREST refreshes.
      throw new LlmRouterCapExceededError(
        'rpc_unreachable',
        service,
        `cost_cap_check_and_consume RPC failed for ${service}: ${error.message}`,
      );
    }
    if (data === false) {
      throw new LlmRouterCapExceededError(
        'cap_exhausted',
        service,
        await formatCapExceededMessage(service, costUsd, supabase),
      );
    }
  } catch (err) {
    if (err instanceof LlmRouterCapExceededError) {
      throw err;
    }
    // Backwards-compat: if older code throws a plain Error with the legacy
    // message shape, re-classify it as a typed cap error so callers don't
    // need two catch branches.
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('Cost cap exceeded')) {
      throw new LlmRouterCapExceededError('cap_exhausted', service, msg);
    }
    if (msg.includes('cost_cap_check_and_consume RPC failed') || msg.includes('schema cache')) {
      throw new LlmRouterCapExceededError('rpc_unreachable', service, msg);
    }
    // Connection-refused / network glitch on the supabase client itself:
    // treat as transient too. Production should monitor cost_cap failures
    // separately, but in dev (paused project) we want to keep local runs
    // going. Swallow only for ECONNREFUSED — anything else is real.
    if (msg.includes('ECONNREFUSED') && !process.env.DATABASE_URL) {
      // local dev without a DB — swallow as before
      return;
    }
    if (msg.includes('ETIMEDOUT') || msg.includes('ECONNRESET') || msg.includes('ECONNREFUSED')) {
      throw new LlmRouterCapExceededError('rpc_unreachable', service, msg);
    }
    // Anything else: re-throw so we don't silently swallow a real bug.
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Ollama backend
// ---------------------------------------------------------------------------

type OllamaChatResponse = {
  model: string;
  message: { role: 'assistant'; content: string };
  total_duration: number;
  prompt_eval_count?: number;
  eval_count?: number;
};

/**
 * Backoff delays for transient Ollama failures (503 server-busy / 429 /
 * connection reset). Single-GPU phi4:14b queues briefly when multiple workers
 * race to the same instance; rather than failing the row immediately and
 * waiting for the next refill cycle, retry a few times so the worker
 * self-heals without a full pipeline round-trip.
 *
 * Tuned for 16GB-VRAM single-GPU: cold-start of phi4 is ~10s, so the
 * first retry waits 5s, then 15s, then 30s. Max wall-clock ~50s — well
 * under LLM_CALL_TIMEOUT_MS (default 60s; increase if these retries push
 * any single call past the timeout).
 */
const OLLAMA_TRANSIENT_RETRY_DELAYS_MS = [5_000, 15_000, 30_000] as const;

function isOllamaTransient(status: number, body: string): boolean {
  if (status === 503 || status === 429) return true;
  // Ollama returns 200 with body "server busy" in some queue-overflow paths;
  // don't trust that — only treat HTTP-level signals as transient.
  void body;
  return false;
}

async function callOllama<T>(opts: LlmRouterOptions<T>): Promise<LlmRouterResult<T>> {
  const start = Date.now();
  const model = opts.ollama?.model ?? OLLAMA_EXTRACT_MODEL;

  // Derive JSON Schema for constrained decoding if caller didn't provide one.
  // Zod 4 has native conversion (see ollama.ts for the full rationale).
  const jsonSchema = opts.ollama?.jsonSchema ?? zodToJsonSchemaForOllama(opts.schema);

  const body = {
    model,
    stream: false,
    messages: [
      { role: 'system', content: opts.systemPrompt },
      { role: 'user', content: opts.userMessage },
    ],
    format: jsonSchema,
    options: {
      temperature: 0,
      num_ctx: opts.ollama?.numCtx ?? 16384,
    },
    keep_alive: '5m',
  };

  const { controller, cleanup } = buildLlmAbort(opts.signal);
  let response: OllamaChatResponse;
  try {
    let attempt = 0;
    // Retry loop bounded by OLLAMA_TRANSIENT_RETRY_DELAYS_MS.length + 1 attempts.
    while (true) {
      const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (res.ok) {
        response = (await res.json()) as OllamaChatResponse;
        break;
      }
      const text = await res.text();
      if (
        isOllamaTransient(res.status, text) &&
        attempt < OLLAMA_TRANSIENT_RETRY_DELAYS_MS.length &&
        !controller.signal.aborted
      ) {
        const delay = OLLAMA_TRANSIENT_RETRY_DELAYS_MS[attempt];
        attempt++;
        await new Promise<void>((resolveDelay, rejectDelay) => {
          const t = setTimeout(resolveDelay, delay);
          if (controller.signal.aborted) {
            clearTimeout(t);
            rejectDelay(new Error('Ollama retry aborted by caller'));
          } else {
            controller.signal.addEventListener(
              'abort',
              () => {
                clearTimeout(t);
                rejectDelay(new Error('Ollama retry aborted by caller'));
              },
              { once: true },
            );
          }
        });
        continue;
      }
      throw new Error(`Ollama HTTP ${res.status}: ${text.slice(0, 400)}`);
    }
  } finally {
    cleanup();
  }
  const rawText = (response.message?.content ?? '').trim();

  // Strip accidental code fences (ollama constrained output should be clean,
  // but some models still wrap).
  const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();

  const parsedJson = JSON.parse(cleaned) as unknown;
  const parsed = opts.schema.parse(parsedJson);
  // NOTE: post-validation is intentionally NOT run here. callExtractor runs
  // it AFTER receiving the result so that on validation failure under
  // attributed_position+auto we can still return the ollama-parsed result
  // when Claude is unreachable due to cost cap (graceful degradation).

  await consumeCostCap('ollama_local', 0);

  return {
    parsed,
    raw: rawText,
    backend: 'ollama',
    model,
    promptVersion: ROUTER_PROMPT_VERSION,
    tokensInput: response.prompt_eval_count,
    tokensOutput: response.eval_count,
    costUsd: 0,
    latencyMs: Date.now() - start,
  };
}

/**
 * Zod → JSON Schema for Ollama constrained decoding. Mirrors the logic in
 * ollama.ts: strip `$schema`. Kept as a private helper so we do not depend
 * on an import from ollama.ts (which is focused on position classification).
 */
function zodToJsonSchemaForOllama(schema: z.ZodType): Record<string, unknown> {
  const js = z.toJSONSchema(schema) as Record<string, unknown>;
  const { $schema: _omit, ...rest } = js;
  void _omit;
  return rest;
}

// ---------------------------------------------------------------------------
// Claude backend
// ---------------------------------------------------------------------------

let _anthropic: Anthropic | null = null;
function anthropicClient(): Anthropic {
  if (!_anthropic) _anthropic = new Anthropic();
  return _anthropic;
}

/**
 * Test hook: override the Anthropic client used by callClaude. Set to `null`
 * to restore the real one. Intentionally not part of the stable API — lives
 * here so unit tests can drive the claude path without a real API key.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _anthropicOverride: { messages: { create: (body: any) => Promise<any> } } | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function _setAnthropicForTests(override: null | { messages: { create: (body: any) => Promise<any> } }): void {
  _anthropicOverride = override;
}

function requireRealAnthropicKey(): void {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || key.startsWith('your-')) {
    throw new Error(
      'ANTHROPIC_API_KEY is missing or a placeholder. Claude backend cannot proceed.',
    );
  }
}

async function callClaude<T>(opts: LlmRouterOptions<T>): Promise<LlmRouterResult<T>> {
  const start = Date.now();
  requireRealAnthropicKey();

  const model = opts.claude?.model ?? CLAUDE_MODEL;
  const maxTokens = opts.claude?.maxTokens ?? 4096;
  const effort = opts.claude?.effort ?? 'medium';
  const cacheControl = opts.claude?.cacheControl ?? true;
  const jsonSchema = opts.claude?.jsonSchema ?? zodToJsonSchemaForOllama(opts.schema);

  const systemBlock = cacheControl
    ? [{ type: 'text' as const, text: opts.systemPrompt, cache_control: { type: 'ephemeral' as const } }]
    : [{ type: 'text' as const, text: opts.systemPrompt }];

  // Estimate cost up-front from a crude token count so we can ask the cost cap
  // for permission BEFORE we make the call. We refine with the real usage on
  // completion, but the up-front check is what prevents runaway cost.
  const estInputTokens = Math.ceil((opts.systemPrompt.length + opts.userMessage.length) / 4);
  const estOutputTokens = maxTokens;
  const estCost =
    estInputTokens * CLAUDE_INPUT_COST_PER_TOKEN + estOutputTokens * CLAUDE_OUTPUT_COST_PER_TOKEN;

  await consumeCostCap('claude_api', estCost);

  // Cast the output_config to `any` — Anthropic's typed SDK doesn't yet
  // expose the json_schema variant we rely on (stable in the REST API as of
  // 2026-04-15 but SDK types trail).
  const clientToUse = _anthropicOverride ?? anthropicClient();
  const { controller, cleanup } = buildLlmAbort(opts.signal);
  let message: unknown;
  try {
    message = await clientToUse.messages.create(
      {
        model,
        max_tokens: maxTokens,
        thinking: { type: 'adaptive' },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        output_config: {
          effort,
          format: {
            type: 'json_schema',
            schema: jsonSchema,
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
        system: systemBlock,
        messages: [{ role: 'user', content: opts.userMessage }],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      // The Anthropic SDK accepts request-level options as a 2nd arg with
      // `signal` for cancellation. The test-mode override (a fake stub) may
      // not consume the 2nd arg — that's fine; it's ignored by JS function
      // calling semantics.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { signal: controller.signal } as any,
    );
  } finally {
    cleanup();
  }

  const rawText = firstTextBlock(
    (message as unknown as { content: readonly { type: string }[] }).content,
  );
  const parsed = opts.schema.parse(JSON.parse(rawText));
  // NOTE: post-validation is run by callExtractor after this returns.

  // Usage for accurate metering — may be missing on some SDK paths.
  const usage = (message as unknown as {
    usage?: { input_tokens?: number; output_tokens?: number };
  }).usage;
  const actualIn = usage?.input_tokens ?? estInputTokens;
  const actualOut = usage?.output_tokens ?? 0;
  const actualCost =
    actualIn * CLAUDE_INPUT_COST_PER_TOKEN + actualOut * CLAUDE_OUTPUT_COST_PER_TOKEN;

  return {
    parsed,
    raw: rawText,
    backend: 'claude',
    model,
    promptVersion: ROUTER_PROMPT_VERSION,
    tokensInput: actualIn,
    tokensOutput: actualOut,
    costUsd: actualCost,
    latencyMs: Date.now() - start,
  };
}

/**
 * Run the caller-supplied post-validator, if any. Throws `PostValidationError`
 * on failure so the router's fallback logic can detect it.
 */
function runPostValidate<T>(
  opts: LlmRouterOptions<T>,
  raw: string,
  parsed: T,
): void {
  if (!opts.postValidate) return;
  let res: void | { ok: true } | { ok: false; reason: string };
  try {
    res = opts.postValidate(raw, parsed);
  } catch (err) {
    throw new PostValidationError(
      err instanceof Error ? err.message : String(err),
    );
  }
  if (res && res.ok === false) {
    throw new PostValidationError(res.reason);
  }
}

function firstTextBlock(content: readonly { type: string }[]): string {
  for (const block of content) {
    if (block.type === 'text') {
      const text = (block as unknown as { text: unknown }).text;
      if (typeof text === 'string') return text;
    }
  }
  throw new Error('Claude response contained no text block.');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Dispatch a schema-validated extraction call to the right backend.
 *
 * Behavior:
 *   - Resolves backend via `resolveBackend(riskClass, opts.backend)`.
 *   - If resolved = 'ollama' AND riskClass='attributed_position', failure
 *     (thrown error from schema.parse / JSON.parse / network / post-validate)
 *     triggers an automatic retry on Claude. `result.fellBackToClaude=true`
 *     on Claude success.
 *   - If resolved = 'ollama' for low_stakes, failure throws (no fallback —
 *     low_stakes extractions are allowed to drop; the caller's existing
 *     validation_status='flagged' path handles it).
 *   - If resolved = 'claude', failure throws (no further fallback).
 *
 * Cap-exceeded graceful degradation (added 2026-04-25):
 *   When ollama returned a parsed result but post-validation failed (so we
 *   would normally fall back to Claude) AND Claude is unreachable due to
 *   `LlmRouterCapExceededError`, we return the ollama result with
 *   `claudeSkippedDueToCap=true`. Callers should record
 *   `validation_status='ollama_only'` on the audit row — the row is not
 *   Claude-verified but is a valid graceful degradation rather than a poison
 *   row.
 *   When ollama itself failed (no parsed result available) AND Claude is
 *   cap-exceeded, the LlmRouterCapExceededError propagates to the caller so
 *   the caller can keep the source row at interpretation_status=0 for the
 *   next cycle.
 */
export async function callExtractor<T>(
  opts: LlmRouterOptions<T>,
): Promise<LlmRouterResult<T>> {
  const resolved = resolveBackend(opts.riskClass, opts.backend);

  // Pre-flight: detect the operator's $0 Claude budget once per UTC day. When the
  // cap row says cap=0, skip every Claude attempt for the rest of the day —
  // saves a round-trip to cost_cap_check_and_consume and avoids spamming
  // ingestion_runs with misleading "Cost cap exceeded" failures. See
  // feedback_no_claude_api_use_plan.md.
  const claudeBudgetZero = await isClaudeBudgetZero();

  // Direct Claude path. Post-validation runs here too.
  if (resolved === 'claude') {
    if (claudeBudgetZero) {
      // No graceful degradation possible — caller asked for Claude (or risk
      // class forced it) and there's no ollama parse to fall back to.
      // Surface a typed cap error so the caller can mark the run
      // 'unproductive' rather than 'failed'.
      throw new LlmRouterCapExceededError(
        'cap_exhausted',
        'claude_api',
        `Claude pre-flight: cost_caps.claude_api.daily_usd_cap=0 for today. ` +
          `Skipping Claude attempt entirely (riskClass=${opts.riskClass}, ` +
          `requested=${opts.backend ?? 'auto'}). Raise the cap to >0 to re-enable.`,
      );
    }
    const claudeResult = await callClaude(opts);
    runPostValidate(opts, claudeResult.raw, claudeResult.parsed);
    return claudeResult;
  }

  // resolved === 'ollama'. Two failure modes to consider:
  //   1. callOllama itself threw (network / JSON / schema)  → no parsed result
  //   2. callOllama returned but post-validation rejected   → we DO have a
  //      parsed result we can fall back to when Claude is unavailable.
  let ollamaResult: LlmRouterResult<T> | null = null;
  let ollamaErr: unknown = null;
  try {
    ollamaResult = await callOllama(opts);
  } catch (err) {
    ollamaErr = err;
  }

  // If we got an ollama result, run post-validation. Capture the validation
  // failure in ollamaErr without discarding ollamaResult — this is the
  // crucial change that lets us return the ollama parse on Claude cap-out.
  if (ollamaResult && !ollamaErr) {
    try {
      runPostValidate(opts, ollamaResult.raw, ollamaResult.parsed);
      // Post-validation passed: success path, return ollama as-is.
      return ollamaResult;
    } catch (err) {
      ollamaErr = err;
      // ollamaResult retained for possible degradation return below.
    }
  }

  // Decide whether to attempt Claude fallback. Same rules as before:
  // explicit ollama override never falls back; only attributed_position
  // with auto routing falls back.
  const requestedExplicit = opts.backend === 'ollama';
  const shouldFallback =
    !requestedExplicit &&
    opts.riskClass === 'attributed_position' &&
    GLOBAL_OVERRIDE !== 'ollama';
  if (!shouldFallback) {
    // No fallback path. Re-throw whatever ollama produced.
    throw ollamaErr ?? new Error('callExtractor: ollama returned no result and no error');
  }

  // Pre-flight cap=0 check — Claude is hard-disabled by configuration. Do
  // not call cost_cap_check_and_consume; do not call the Anthropic SDK; do
  // not log a misleading "Cost cap exceeded" error. Two outcomes:
  //   - ollama produced a parse → degrade gracefully (claudeSkippedDueToCap)
  //   - ollama failed too → throw typed cap error so the adapter can mark
  //     the run 'unproductive' instead of 'failed' (no row poisoning).
  if (claudeBudgetZero) {
    if (ollamaResult) {
      return { ...ollamaResult, claudeSkippedDueToCap: true };
    }
    throw new LlmRouterCapExceededError(
      'cap_exhausted',
      'claude_api',
      `Claude pre-flight: cost_caps.claude_api.daily_usd_cap=0 for today. ` +
        `Ollama also failed (${ollamaErr instanceof Error ? ollamaErr.message : String(ollamaErr)}). ` +
        `Treat as transient: row stays at interpretation_status=0 for next cycle.`,
    );
  }

  // Attempt Claude fallback. If Claude's cost cap is exhausted at call time
  // (race with the daily seed) or the RPC helper is unreachable, gracefully
  // degrade: when we have an ollama parsed result, return it tagged
  // claudeSkippedDueToCap so the caller can mark the audit row 'ollama_only'.
  // When we don't, propagate the cap error so the caller can keep the row
  // at interpretation_status=0.
  try {
    const claudeResult = await callClaude(opts);
    runPostValidate(opts, claudeResult.raw, claudeResult.parsed);
    return { ...claudeResult, fellBackToClaude: true };
  } catch (claudeErr) {
    if (claudeErr instanceof LlmRouterCapExceededError) {
      if (ollamaResult) {
        // Graceful degradation: return ollama parse, flag for audit.
        return { ...ollamaResult, claudeSkippedDueToCap: true };
      }
      // No ollama result either. Surface the cap error so caller defers.
      throw claudeErr;
    }
    throw claudeErr;
  }
}

// ---------------------------------------------------------------------------
// Test hooks (exported for unit tests; not part of the stable API)
// ---------------------------------------------------------------------------

/** Returns the global override as read at module load. */
export function _getGlobalOverride(): ExtractorBackend | null {
  return GLOBAL_OVERRIDE;
}
