/**
 * Claude API integration for Havesay.
 *
 * Design decisions (grounded in the blueprint + claude-api skill):
 * - **Model:** `claude-opus-4-7` by default, overridable via CLAUDE_MODEL.
 * - **Thinking:** adaptive — Claude decides depth per request.
 *   `budget_tokens`, `temperature`, `top_p`, `top_k` are REMOVED on Opus 4.7
 *   (sending them returns 400). Adaptive thinking replaces them.
 * - **Effort:** `medium` by default — classification is structured and
 *   doesn't need `max`. Worth raising to `high` for final published batches.
 * - **Prompt caching:** the system prompt + sub_dimension spectrum list is
 *   stable across a batch, so we cache it. On a 50-candidate × 19-dimension
 *   run that's ~950 requests that all share the same cached prefix.
 * - **Batch API:** live classification is never in the user flow (per
 *   blueprint). All classification goes through `messages.batches.create`
 *   for 50% cost savings and multi-hour async processing.
 * - **Structured output:** responses are parsed via Zod schemas, never
 *   ad-hoc JSON string matching.
 * - **No mock mode.** Previously this module returned deterministic hash-based
 *   scores when ANTHROPIC_API_KEY was a placeholder. Council round-2 review
 *   (2026-04-17) concluded this violated the never-impute rule in spirit:
 *   any score attached to a real source citation sells the citation's
 *   credibility regardless of what the banner says. When the key is missing,
 *   every classification call throws. Pipelines that need to exercise
 *   end-to-end flow without spending real tokens should use explicit fixtures
 *   or skip to the UI-only rendering path.
 */
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { SubDimension } from '@/types/database';
import { loadEnvLocal } from '@/lib/load-env';

// Defensive: Node's --env-file has been observed to silently skip ANTHROPIC_API_KEY
// on some hosts; this fills in anything the built-in parser missed.
loadEnvLocal();

const CLAUDE_MODEL = process.env.CLAUDE_MODEL ?? 'claude-opus-4-7';

/**
 * Require a real API key. Returns void if set; throws otherwise. Never
 * returns a fake result — this is the hard boundary that prevents mock
 * positions from entering the DB.
 */
function requireRealApiKey(): void {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || key.startsWith('your-')) {
    throw new Error(
      'ANTHROPIC_API_KEY is missing or a placeholder. Set a real key; ' +
        'classification cannot proceed without one. (Mock mode was removed ' +
        'after council round-2 review — see 09-playbook/claude-research-playbook.)',
    );
  }
}

// Lazy so importing this module doesn't throw when no key is set (e.g. next
// build time, tests, static routes that never call into Claude).
let _client: Anthropic | null = null;
function client(): Anthropic {
  if (!_client) _client = new Anthropic();
  return _client;
}

const SYSTEM_PROMPT = `You are a nonpartisan political analyst for Havesay, a voter-candidate matching platform. Your role is to objectively classify candidate positions based on evidence. You must:
- Be strictly neutral and evidence-based
- Cite specific sources for every claim
- Acknowledge uncertainty when evidence is limited
- Never inject personal bias or editorial commentary
- Use precise language that voters of all backgrounds can understand`;

// ---------------------------------------------------------------------------
// Structured-output schemas
// ---------------------------------------------------------------------------

const PositionClassificationSchema = z.object({
  // Stated-view (council 007 §3) can return null when the candidate has not
  // addressed the sub-dimension in their own words. Single-view + inferred-
  // view always produce a numeric score.
  score: z.number().min(0).max(1).nullable(),
  confidence: z.enum(['high', 'medium', 'low', 'no_data']),
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
// Prompt builders
// ---------------------------------------------------------------------------

function classifyUserPrompt(candidateData: string, subDim: SubDimension): string {
  return `Given the following source data about a political candidate, classify their position on the sub-dimension "${subDim.name}" (domain: ${subDim.domain}).

Use a 0-1 scale where:
- 0.0 = "${subDim.spectrum_low}"
- 1.0 = "${subDim.spectrum_high}"

Source data:
${candidateData}

Respond with a JSON object: { "score": <0..1>, "confidence": "high" | "medium" | "low", "nuance": "<1-2 sentences>" }`;
}

/**
 * Stated-view user prompt (council decision 007 §3).
 *
 * Feeds ONLY authenticity_tier=1 source material — the candidate's own words
 * from their campaign website, questionnaire, op-eds, press releases,
 * speeches, interviews, social. The model must return `no_data` when the
 * candidate has not directly addressed the sub-dimension; never impute.
 *
 * The system prompt (SYSTEM_PROMPT) is left unchanged so Anthropic prompt-
 * cache hits stay hot across stated + inferred requests in the same batch
 * (plan 007 line 110).
 */
export function classifyStatedUserPrompt(
  tier1SourceText: string,
  subDim: SubDimension,
): string {
  return `Given ONLY the candidate's own words below, classify their stated position on "${subDim.name}". If the candidate has not directly addressed this issue in their own words, return {"score": null, "confidence": "no_data", ...}.

Do not infer. Do not combine across sources to produce an implied position. If the candidate says "I support X," score per X. If they say nothing relevant, return no_data with a one-sentence explanation of what material you reviewed.

Use a 0-1 scale where:
- 0.0 = "${subDim.spectrum_low}"
- 1.0 = "${subDim.spectrum_high}"

Candidate's own words:
${tier1SourceText}

Respond with a JSON object: { "score": <0..1 or null>, "confidence": "high" | "medium" | "low" | "no_data", "nuance": "<1-2 sentences>" }`;
}

/**
 * Inferred-view user prompt (council decision 007 §3).
 *
 * Feeds all tiers, tier-labeled so the model can weight. Synthesizes a
 * likely position across the full record (own statements + voting record +
 * reported quotes + secondary analysis). If stated and behavioral evidence
 * conflict, the nuance field should report the conflict.
 */
export function classifyInferredUserPrompt(
  tierLabeledSourceText: string,
  subDim: SubDimension,
): string {
  return `Given the following evidence about a candidate — their own statements, voting record, reported quotes, advocacy ratings, and secondary analysis — synthesize their likely position on "${subDim.name}". Weight primary sources highest, voting records next, reported-with-quote third, paraphrased lowest.

If stated and behavioral evidence conflict, report the conflict in nuance and pick the score that best reflects the full record.

Label each source block by tier (PRIMARY / REPORTED / SECONDARY / VOTE).

Use a 0-1 scale where:
- 0.0 = "${subDim.spectrum_low}"
- 1.0 = "${subDim.spectrum_high}"

Evidence (by tier):
${tierLabeledSourceText}

Respond with a JSON object: { "score": <0..1>, "confidence": "high" | "medium" | "low", "nuance": "<1-2 sentences>" }`;
}

function summaryUserPrompt(
  candidateName: string,
  subDimensionName: string,
  score: number,
  spectrumLow: string,
  spectrumHigh: string,
): string {
  return `Write a single neutral, factual sentence summarizing this candidate's position.

Candidate: ${candidateName}
Issue: ${subDimensionName}
Score: ${score} on a 0-1 scale where 0="${spectrumLow}" and 1="${spectrumHigh}"

Respond with ONLY the summary sentence, no quotes or extra formatting.`;
}

// ---------------------------------------------------------------------------
// Live (non-batch) helpers — used for single-shot testing and small calls.
// ---------------------------------------------------------------------------

/**
 * Classify a candidate's position on one sub-dimension via a live Claude call.
 * Prefer `submitClassificationBatch` for bulk work (50% cheaper, async).
 */
export async function classifyPosition(
  candidateData: string,
  subDimension: SubDimension,
): Promise<PositionClassification> {
  requireRealApiKey();

  const message = await client().messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 1024,
    thinking: { type: 'adaptive' },
    output_config: {
      effort: 'medium',
      format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            score: { type: 'number' },
            confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
            nuance: { type: 'string' },
          },
          required: ['score', 'confidence', 'nuance'],
        },
      },
    },
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      { role: 'user', content: classifyUserPrompt(candidateData, subDimension) },
    ],
  });

  const text = firstTextBlock(message.content);
  return PositionClassificationSchema.parse(JSON.parse(text));
}

/**
 * Generate a 1-sentence neutral summary of a candidate's position.
 * Small and fast — called at position-write time. Kept as a live call.
 */
export async function generatePositionSummary(
  candidateName: string,
  subDimensionName: string,
  score: number,
  spectrumLow: string,
  spectrumHigh: string,
): Promise<string> {
  requireRealApiKey();

  const message = await client().messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 256,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'low' }, // one sentence — minimal reasoning
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      {
        role: 'user',
        content: summaryUserPrompt(
          candidateName,
          subDimensionName,
          score,
          spectrumLow,
          spectrumHigh,
        ),
      },
    ],
  });

  return firstTextBlock(message.content).trim();
}

/**
 * Extract position statements from raw text (e.g. a scraped campaign page).
 * Used by `scrape-candidate` to pre-process free-form prose before the batch
 * classification step. Live call by design — input varies per source.
 */
export async function extractPositionsFromText(
  text: string,
  candidateName: string,
): Promise<PositionExtraction> {
  requireRealApiKey();

  const truncated = text.slice(0, 50_000);

  const message = await client().messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 4096,
    thinking: { type: 'adaptive' },
    output_config: {
      effort: 'medium',
      format: {
        type: 'json_schema',
        schema: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              topic: { type: 'string' },
              statement: { type: 'string' },
            },
            required: ['topic', 'statement'],
          },
        },
      },
    },
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      {
        role: 'user',
        content: `Extract all political position statements from the following text about candidate ${candidateName}. For each position, identify the topic and the candidate's stated position.

Text:
${truncated}

Respond as a JSON array: [{"topic": "<issue>", "statement": "<position>"}]. Empty array if nothing found.`,
      },
    ],
  });

  const responseText = firstTextBlock(message.content);
  try {
    return PositionExtractionSchema.parse(JSON.parse(responseText));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Batch API — the primary classification path.
// ---------------------------------------------------------------------------

export type BatchClassificationRequest = {
  /** Stable ID the caller uses to route each result back to a DB row. */
  custom_id: string;
  /** Aggregated source text for one candidate. */
  candidate_data: string;
  /** The sub_dimension to classify against. */
  sub_dimension: SubDimension;
  /**
   * Two-view routing (council decision 007 §3). When set, the batch submitter
   * picks the corresponding user-prompt builder:
   *   - 'stated'   -> classifyStatedUserPrompt  (tier-1 only, may return no_data)
   *   - 'inferred' -> classifyInferredUserPrompt (tier-labeled full evidence)
   * When omitted, the legacy single-view `classifyUserPrompt` is used so
   * flag-off batch runs keep writing `view_type='inferred'` rows (plan §7).
   */
  view_type?: 'stated' | 'inferred';
};

/**
 * Submit a batch of candidate × sub_dimension classification requests.
 * Returns the batch id; poll via `getClassificationBatch` and retrieve
 * results via `streamClassificationBatchResults`.
 *
 * Typical shape for Phase A: 50 candidates × 19 sub_dimensions = 950 requests
 * in a single batch. All share the cached system prompt.
 */
export async function submitClassificationBatch(
  requests: BatchClassificationRequest[],
): Promise<string> {
  requireRealApiKey();
  if (requests.length === 0) {
    throw new Error('submitClassificationBatch: empty request list.');
  }

  const batch = await client().messages.batches.create({
    requests: requests.map((r) => ({
      custom_id: r.custom_id,
      params: {
        model: CLAUDE_MODEL,
        max_tokens: 1024,
        thinking: { type: 'adaptive' },
        output_config: {
          effort: 'medium',
          format: {
            type: 'json_schema',
            // Stated-view (007 §3) may return {score: null, confidence:
            // 'no_data'} when the candidate has not addressed the sub-dim in
            // their own words. Single-view / inferred always score.
            schema:
              r.view_type === 'stated'
                ? {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      score: { type: ['number', 'null'] },
                      confidence: {
                        type: 'string',
                        enum: ['high', 'medium', 'low', 'no_data'],
                      },
                      nuance: { type: 'string' },
                    },
                    required: ['score', 'confidence', 'nuance'],
                  }
                : {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      score: { type: 'number' },
                      confidence: {
                        type: 'string',
                        enum: ['high', 'medium', 'low'],
                      },
                      nuance: { type: 'string' },
                    },
                    required: ['score', 'confidence', 'nuance'],
                  },
          },
        },
        // Cache the stable prefix so 950 requests share one cache write.
        system: [
          {
            type: 'text',
            text: SYSTEM_PROMPT,
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: [
          {
            role: 'user',
            content:
              r.view_type === 'stated'
                ? classifyStatedUserPrompt(r.candidate_data, r.sub_dimension)
                : r.view_type === 'inferred'
                  ? classifyInferredUserPrompt(r.candidate_data, r.sub_dimension)
                  : classifyUserPrompt(r.candidate_data, r.sub_dimension),
          },
        ],
      },
    })),
  });

  return batch.id;
}

export type BatchStatus = {
  id: string;
  processing_status: string; // 'in_progress' | 'ended' | 'canceling' | 'canceled'
  counts: {
    processing: number;
    succeeded: number;
    errored: number;
    expired: number;
    canceled: number;
  };
};

export async function getClassificationBatch(batchId: string): Promise<BatchStatus> {
  requireRealApiKey();
  const batch = await client().messages.batches.retrieve(batchId);
  return {
    id: batch.id,
    processing_status: batch.processing_status,
    counts: {
      processing: batch.request_counts.processing,
      succeeded: batch.request_counts.succeeded,
      errored: batch.request_counts.errored,
      expired: batch.request_counts.expired,
      canceled: batch.request_counts.canceled,
    },
  };
}

export type BatchClassificationResult =
  | { custom_id: string; status: 'succeeded'; classification: PositionClassification }
  | { custom_id: string; status: 'errored' | 'canceled' | 'expired'; error: string };

/**
 * Iterate results from a completed batch. Each entry is keyed by the
 * `custom_id` the caller supplied at submit time — use it to route the
 * classification back to the right candidate + sub_dimension.
 */
export async function* iterateClassificationBatchResults(
  batchId: string,
): AsyncGenerator<BatchClassificationResult> {
  requireRealApiKey();

  for await (const entry of await client().messages.batches.results(batchId)) {
    const customId = entry.custom_id;
    switch (entry.result.type) {
      case 'succeeded': {
        try {
          const text = firstTextBlock(entry.result.message.content);
          const parsed = PositionClassificationSchema.parse(JSON.parse(text));
          yield { custom_id: customId, status: 'succeeded', classification: parsed };
        } catch (err) {
          yield {
            custom_id: customId,
            status: 'errored',
            error: `parse failed: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
        break;
      }
      case 'errored':
        yield {
          custom_id: customId,
          status: 'errored',
          error: entry.result.error?.error?.message ?? 'unknown error',
        };
        break;
      case 'canceled':
        yield { custom_id: customId, status: 'canceled', error: 'canceled' };
        break;
      case 'expired':
        yield { custom_id: customId, status: 'expired', error: 'expired' };
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function firstTextBlock(content: readonly { type: string }[]): string {
  for (const block of content) {
    if (block.type === 'text') {
      const text = (block as unknown as { text: unknown }).text;
      if (typeof text === 'string') return text;
    }
  }
  throw new Error('Claude response contained no text block.');
}

// Mock mode removed 2026-04-17 after council round-2 review. See module
// docstring top-of-file for rationale. Classification is a real-API-only
// operation; if the key isn't set, every exported function throws.
