/**
 * Lightweight ollama HTTP client for the body-research + council pipelines.
 *
 * Sister module to model-routing.ts. The router decides the model; this
 * module does the call. Stays deliberately small — for heavyweight
 * zod-schema-constrained extraction use src/lib/llm-router.ts instead.
 *
 * # Why this exists separately from src/lib/ollama.ts
 *
 * `src/lib/ollama.ts` is structured around the positions-extraction use case
 * (zod schemas, JSON constrained decoding, position-specific helpers).
 * The body-research engine just wants "send this prompt, get text back" for
 * things like council triage classification. This module is that.
 *
 * # Usage
 *
 *   const decision = routeModel('council_triage');
 *   if (decision.backend === 'ollama') {
 *     const text = await callOllamaText({
 *       model: decision.model,
 *       prompt: '...',
 *       think: decision.think,
 *     });
 *     // parse text
 *   }
 */

const OLLAMA_HOST = process.env.OLLAMA_HOST ?? 'http://localhost:11434';
/** Default per-call timeout. Generous because some 70B models cold-load. */
const OLLAMA_TIMEOUT_MS = parseInt(process.env.OLLAMA_INGESTION_TIMEOUT_MS ?? '90000', 10);
/** Keep models warm so the next call doesn't pay cold-load cost. */
const KEEP_ALIVE_DEFAULT = process.env.OLLAMA_KEEP_ALIVE ?? '10m';

interface OllamaChatResponse {
  model: string;
  message: { role: 'assistant'; content: string };
  total_duration?: number; // ns
  prompt_eval_count?: number;
  eval_count?: number;
}

export interface CallOllamaInput {
  /** Ollama model id, e.g. 'phi4:14b' or 'llama3.3:70b'. */
  model: string;
  /** The user prompt. */
  prompt: string;
  /** Optional system instruction. */
  system?: string;
  /** Lower = more deterministic. Default 0 (deterministic for classification). */
  temperature?: number;
  /** Context-window tokens. Default 8192. Bump to 32768 for prompts with
   *  pre-fetched primary-source content. */
  numCtx?: number;
  /** Keep-alive duration. Use '0' to unload immediately after, '10m' (default)
   *  to keep the model in GPU. */
  keepAlive?: string;
  /** For thinking models (qwen3, deepseek-r1): false disables CoT for ~2x speed. */
  think?: boolean;
  /** Optional JSON-schema for constrained decoding. Pass when you need
   *  guaranteed-parseable JSON output. */
  jsonSchema?: Record<string, unknown>;
  /** Caller-supplied abort signal (overrides the default timeout). */
  signal?: AbortSignal;
}

export interface CallOllamaResult {
  text: string;
  model: string;
  /** Tokens of the prompt (per ollama's eval count). */
  inputTokens: number;
  /** Tokens of the response. */
  outputTokens: number;
  /** Total wall-clock duration in ms. */
  durationMs: number;
  /** True if the call timed out (text will be empty). */
  timedOut: boolean;
}

/**
 * Send a single completion to ollama. No retries, no schema validation —
 * the caller owns parsing. Use this for council triage, structured
 * extraction subtasks, source-tier classification.
 *
 * Returns the response text plus metering. On timeout returns
 * `{ text: '', timedOut: true }` rather than throwing — callers can
 * decide whether to fall back to a Claude path or fail soft.
 */
export async function callOllamaText(input: CallOllamaInput): Promise<CallOllamaResult> {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('ollama timeout')), OLLAMA_TIMEOUT_MS);
  if (input.signal) {
    if (input.signal.aborted) controller.abort(input.signal.reason ?? new Error('aborted'));
    else input.signal.addEventListener('abort', () => controller.abort(input.signal!.reason ?? new Error('aborted')), { once: true });
  }

  const messages: Array<{ role: string; content: string }> = [];
  if (input.system) messages.push({ role: 'system', content: input.system });
  messages.push({ role: 'user', content: input.prompt });

  const body: Record<string, unknown> = {
    model: input.model,
    stream: false,
    messages,
    options: {
      temperature: input.temperature ?? 0,
      num_ctx: input.numCtx ?? 8192,
    },
    keep_alive: input.keepAlive ?? KEEP_ALIVE_DEFAULT,
  };
  if (input.think !== undefined) body.think = input.think;
  if (input.jsonSchema) body.format = input.jsonSchema;

  try {
    const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '(unreadable)');
      return {
        text: '',
        model: input.model,
        inputTokens: 0,
        outputTokens: 0,
        durationMs: Date.now() - start,
        timedOut: false,
        // Wrap the error in the empty-text contract; callers can detect
        // failure via timedOut || text === ''.
      } as CallOllamaResult;
    }
    const json = (await res.json()) as OllamaChatResponse;
    return {
      text: (json.message?.content ?? '').trim(),
      model: json.model ?? input.model,
      inputTokens: json.prompt_eval_count ?? 0,
      outputTokens: json.eval_count ?? 0,
      durationMs: Date.now() - start,
      timedOut: false,
    };
  } catch (err) {
    const isAbort = err instanceof Error && (err.name === 'AbortError' || err.message?.includes('aborted'));
    return {
      text: '',
      model: input.model,
      inputTokens: 0,
      outputTokens: 0,
      durationMs: Date.now() - start,
      timedOut: isAbort,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Convenience for log lines.
 *   "[ollama] phi4:14b 2.1s in=234 out=87"
 */
export function formatOllamaResult(r: CallOllamaResult): string {
  const dur = (r.durationMs / 1000).toFixed(1);
  return `[ollama] ${r.model} ${dur}s in=${r.inputTokens} out=${r.outputTokens}${r.timedOut ? ' TIMEOUT' : ''}`;
}
