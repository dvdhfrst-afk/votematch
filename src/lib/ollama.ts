/**
 * Local LLM backend for Havesay via Ollama.
 *
 * Why this exists: the Anthropic API path in `claude.ts` costs real money per
 * call. For development iteration, research experiments, and Tier 2/3 workloads
 * where quality is less critical, we run a local LLM (Qwen 3, Phi-4, Llama 3.3)
 * on the user's GPU via Ollama. Free, fast, private, no rate limits.
 *
 * This module mirrors the `claude.ts` export shape so callers can route between
 * backends via a config flag without changing call-sites.
 *
 * Ollama server: http://localhost:11434 (default). Starts automatically on Win
 * install; on Mac/Linux run `ollama serve`.
 *
 * Structured outputs: Ollama v0.5+ supports JSON schema constrained decoding
 * via the `format` parameter on /api/chat. We pass a schema derived from our
 * Zod types. See: https://docs.ollama.com/capabilities/structured-outputs
 */
import { z } from 'zod';
import type { SubDimension } from '@/types/database';
import { loadEnvLocal } from '@/lib/load-env';

loadEnvLocal();

const OLLAMA_HOST = process.env.OLLAMA_HOST ?? 'http://localhost:11434';

// Default model per use-case. Override via env:
//   OLLAMA_MODEL (global default)
//   OLLAMA_CLASSIFY_MODEL (classification specifically)
//   OLLAMA_SUMMARY_MODEL (summary generation specifically)
//   OLLAMA_EXTRACT_MODEL (free-text extraction specifically)
// phi4:14b outperformed qwen3:14b on the Havesay 19-dim A/B against
// Claude Opus 4.7 (74% vs 63% score-agreement, 79% vs 68% direction-match)
// and runs ~3 s/classification on the RTX 5070 Ti. See 11-local-llm/02-phi4-vs-qwen3.md
const DEFAULT_MODEL = process.env.OLLAMA_MODEL ?? 'phi4:14b';
const CLASSIFY_MODEL = process.env.OLLAMA_CLASSIFY_MODEL ?? DEFAULT_MODEL;
const SUMMARY_MODEL = process.env.OLLAMA_SUMMARY_MODEL ?? DEFAULT_MODEL;
const EXTRACT_MODEL = process.env.OLLAMA_EXTRACT_MODEL ?? DEFAULT_MODEL;

const SYSTEM_PROMPT = `You are a nonpartisan political analyst for Havesay, a voter-candidate matching platform. Your role is to objectively classify candidate positions based on evidence. You must:
- Be strictly neutral and evidence-based
- Cite specific sources for every claim
- Acknowledge uncertainty when evidence is limited
- Never inject personal bias or editorial commentary
- Use precise language that voters of all backgrounds can understand
- Return ONLY valid JSON matching the schema provided — no prose before or after.`;

// ---------------------------------------------------------------------------
// Shared schemas (identical shape to claude.ts so DB writes are interchangeable)
// ---------------------------------------------------------------------------

const PositionClassificationSchema = z.object({
  score: z.number().min(0).max(1),
  confidence: z.enum(['high', 'medium', 'low']),
  nuance: z.string(),
});
export type PositionClassification = z.infer<typeof PositionClassificationSchema>;

const PositionExtractionSchema = z.array(
  z.object({
    topic: z.string(),
    statement: z.string(),
  }),
);
export type PositionExtraction = z.infer<typeof PositionExtractionSchema>;

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

interface OllamaChatOptions {
  model: string;
  system?: string;
  user: string;
  format?: Record<string, unknown>; // JSON schema for structured output
  temperature?: number;
  num_ctx?: number; // context window; default 4096 per Ollama
  keep_alive?: string; // e.g. "5m" — keeps model loaded in GPU
  /**
   * Thinking models (qwen3, deepseek-r1) run hidden chain-of-thought before the
   * final answer. `think: false` disables it for ~2× throughput at some quality
   * cost. Ignored by non-thinking models.
   */
  think?: boolean;
}

interface OllamaChatResponse {
  model: string;
  created_at: string;
  message: {
    role: 'assistant';
    content: string;
  };
  done: boolean;
  total_duration: number; // nanoseconds
  prompt_eval_count: number;
  eval_count: number;
  eval_duration: number;
}

async function ollamaChat(opts: OllamaChatOptions): Promise<OllamaChatResponse> {
  const body: Record<string, unknown> = {
    model: opts.model,
    stream: false,
    messages: [
      ...(opts.system ? [{ role: 'system', content: opts.system }] : []),
      { role: 'user', content: opts.user },
    ],
    options: {
      temperature: opts.temperature ?? 0, // deterministic by default
      num_ctx: opts.num_ctx ?? 8192, // Havesay source text can be 3-10 KB
    },
    keep_alive: opts.keep_alive ?? '5m',
  };
  if (opts.format) body.format = opts.format;
  if (opts.think !== undefined) body.think = opts.think;

  const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ollama HTTP ${res.status}: ${text.slice(0, 400)}`);
  }
  return (await res.json()) as OllamaChatResponse;
}

/**
 * Convert a Zod schema to a JSON schema Ollama can use for constrained
 * decoding. Zod 4 has native JSON Schema generation via `z.toJSONSchema()`.
 *
 * The older `zod-to-json-schema` library silently returns an empty schema on
 * Zod 4 inputs (it only introspects Zod 3's internal shape), which Ollama
 * rejects as "invalid JSON schema in format". We use the native method and
 * strip the `$schema` meta field which some validators mishandle.
 */
function zodToOllamaFormat(schema: z.ZodType): Record<string, unknown> {
  const jsonSchema = z.toJSONSchema(schema) as Record<string, unknown>;
  // Strip the $schema meta-field — Ollama's validator doesn't need it and
  // some versions trip on unknown draft URIs.
  const { $schema: _omit, ...rest } = jsonSchema;
  void _omit;
  return rest;
}

// ---------------------------------------------------------------------------
// Exports — same shape as claude.ts so callers can swap backends
// ---------------------------------------------------------------------------

/**
 * A labeled example used as a few-shot exemplar or RAG retrieval result. The
 * test harness reads these from `11-local-llm/baseline-dataset.json` and
 * injects them into the prompt at classification time.
 */
export interface ClassificationExemplar {
  candidate_name: string;
  sub_dimension_name: string;
  spectrum_low: string;
  spectrum_high: string;
  source_excerpt: string; // truncated source, 500-1500 chars
  score: number;
  confidence: 'high' | 'medium' | 'low';
  nuance: string;
}

export async function classifyPosition(
  candidateData: string,
  subDimension: SubDimension,
  opts: { think?: boolean; exemplars?: ClassificationExemplar[]; model?: string } = {},
): Promise<PositionClassification> {
  const exemplarBlock =
    opts.exemplars && opts.exemplars.length > 0
      ? `Here are ${opts.exemplars.length} reference classifications from other candidates, hand-verified for accuracy. Use them to calibrate your scoring:

${opts.exemplars
  .map(
    (ex, i) =>
      `--- Reference ${i + 1} ---
Candidate: ${ex.candidate_name}
Sub-dimension: ${ex.sub_dimension_name}
Spectrum: 0.0="${ex.spectrum_low}" ↔ 1.0="${ex.spectrum_high}"
Source excerpt:
${ex.source_excerpt}

Correct classification: { "score": ${ex.score}, "confidence": "${ex.confidence}", "nuance": "${ex.nuance.replace(/"/g, "'").slice(0, 300)}" }`,
  )
  .join('\n\n')}

--- Now classify this candidate ---
`
      : '';

  const prompt = `${exemplarBlock}Given the following source data about a political candidate, classify their position on the sub-dimension "${subDimension.name}" (domain: ${subDimension.domain}).

Use a 0-1 scale where:
- 0.0 = "${subDimension.spectrum_low}"
- 1.0 = "${subDimension.spectrum_high}"

Source data:
${candidateData}

Respond with a JSON object: { "score": <0..1>, "confidence": "high" | "medium" | "low", "nuance": "<1-2 sentences>" }`;

  const response = await ollamaChat({
    model: opts.model ?? CLASSIFY_MODEL,
    system: SYSTEM_PROMPT,
    user: prompt,
    format: zodToOllamaFormat(PositionClassificationSchema),
    temperature: 0,
    num_ctx: 16384, // bigger to hold exemplars + source text comfortably
    think: opts.think,
  });

  const content = response.message.content.trim();
  // Ollama with constrained decoding returns strict JSON, but defensively
  // strip any accidental code fences
  const cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  return PositionClassificationSchema.parse(JSON.parse(cleaned));
}

export async function generatePositionSummary(
  candidateName: string,
  subDimensionName: string,
  score: number,
  spectrumLow: string,
  spectrumHigh: string,
): Promise<string> {
  const prompt = `Write a single neutral, factual sentence summarizing this candidate's position.

Candidate: ${candidateName}
Issue: ${subDimensionName}
Score: ${score} on a 0-1 scale where 0="${spectrumLow}" and 1="${spectrumHigh}"

Respond with ONLY the summary sentence — no quotes, no extra formatting, no JSON wrapping. Plain text sentence ending in a period.`;

  const response = await ollamaChat({
    model: SUMMARY_MODEL,
    system: SYSTEM_PROMPT,
    user: prompt,
    temperature: 0,
    num_ctx: 4096,
  });

  // Summary is plain text; trim whitespace
  return response.message.content.trim().replace(/^["'`]|["'`]$/g, '');
}

export async function extractPositionsFromText(
  text: string,
  candidateName: string,
): Promise<PositionExtraction> {
  const truncated = text.slice(0, 50_000);

  const prompt = `Extract all political position statements from the following text about candidate ${candidateName}. For each position, identify the topic and the candidate's stated position.

Text:
${truncated}

Respond as a JSON array: [{"topic": "<issue>", "statement": "<position>"}]. Empty array if nothing found.`;

  const response = await ollamaChat({
    model: EXTRACT_MODEL,
    system: SYSTEM_PROMPT,
    user: prompt,
    format: zodToOllamaFormat(PositionExtractionSchema),
    temperature: 0,
    num_ctx: 16384, // larger context for extraction from long articles
  });

  const content = response.message.content.trim();
  const cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  try {
    return PositionExtractionSchema.parse(JSON.parse(cleaned));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Health check — useful in CI / setup scripts
// ---------------------------------------------------------------------------

export async function checkOllamaHealth(): Promise<{
  ok: boolean;
  version?: string;
  models?: string[];
  error?: string;
}> {
  try {
    const versionRes = await fetch(`${OLLAMA_HOST}/api/version`);
    if (!versionRes.ok) {
      return { ok: false, error: `HTTP ${versionRes.status}` };
    }
    const version = ((await versionRes.json()) as { version: string }).version;

    const tagsRes = await fetch(`${OLLAMA_HOST}/api/tags`);
    const tags = (await tagsRes.json()) as { models: { name: string }[] };
    const models = tags.models.map((m) => m.name);

    return { ok: true, version, models };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Record timing + token stats for cost/speed comparisons against Claude.
 */
export interface OllamaUsage {
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_duration_ms: number;
  eval_duration_ms: number;
  tokens_per_second: number;
}

export function extractUsage(response: OllamaChatResponse): OllamaUsage {
  return {
    model: response.model,
    prompt_tokens: response.prompt_eval_count,
    completion_tokens: response.eval_count,
    total_duration_ms: response.total_duration / 1_000_000,
    eval_duration_ms: response.eval_duration / 1_000_000,
    tokens_per_second:
      response.eval_count / (response.eval_duration / 1_000_000_000),
  };
}
