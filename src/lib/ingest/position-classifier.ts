/**
 * position-classifier.ts -- the REAL, taxonomy-bound PositionClassifier for
 * Havesay. Drops into the PositionClassifier seam defined in
 * extract-signals.ts, replacing the StubClassifier, with ZERO change to the
 * extraction pipeline (extractSignals / insertSignal / the ledger bookkeeping).
 *
 * WHAT IT DOES
 * ----------------------------------------------------------------------------
 * Given the cleaned text of ONE raw_evidence unit plus its ClassifyContext, it
 * asks a LOCAL large language model (LLM) via Ollama to read the candidate's
 * actual positioning out of the text and place it, per sub_dimension the text
 * ACTUALLY addresses, on that sub_dimension's spectrum_low -> spectrum_high axis.
 * It then maps each reading to a RawSignal (the per-signal record from doc 07
 * section 1.6) bound to sub_dimension_key = sub_dimensions.name, proposition_key
 * = null (the multivariable proposition/backbone layer is NOT migrated yet, so we
 * bind to sub_dimensions only, per doc 09).
 *
 * THE HARD RULES IT ENFORCES (founder spec + doc 07 v2)
 * ----------------------------------------------------------------------------
 *  - NO FABRICATION. It emits a signal ONLY for a sub_dimension the text speaks
 *    to. Silence is not a position. Every graded signal must carry a VERBATIM
 *    quote that is a substring of the source; the Build-6 gateSignal verifies
 *    this in code (a model cannot invent a quote past the gate).
 *  - position_kind discipline (doc 07 C1): 'graded' carries a numeric direction;
 *    'balanced' is EXPLICIT balance with direction = 0.5; 'abstains_governing'
 *    ("personally X but will not legislate") carries direction = NULL, NEVER 0.5.
 *  - intensity_band derived from direction per doc 07 bands. 'strong' REQUIRES a
 *    maximalism marker (always/never/ban/abolish/mandate/no-exceptions ...) in
 *    the quote; otherwise it is downgraded to 'support'. (The classifier checks
 *    this itself, and gateSignal re-checks it -- belt and suspenders.)
 *  - HIGH-CONFIDENCE STRONG-BAND GATE: a 'strong'-band reading on a high-salience
 *    sub_dimension is re-verified with the flat-rate Claude account before the
 *    'strong' band is kept. If Claude disagrees, or the account is unavailable,
 *    the band fails CLOSED -> downgraded to 'support' with lowered confidence
 *    (doc 07 section 1.5 cap-exhaustion rule: never publish an unverified extreme
 *    from the local model). The Claude verifier is injectable so the offline test
 *    stubs it; the live default uses the Claude Code command-line interface (CLI)
 *    via src/lib/claude-cli.ts (the subscription path), NOT the metered Anthropic
 *    Software Development Kit (SDK) key in src/lib/claude.ts (that key has a $0
 *    credit balance). Set BB_STRONG_BAND_GATE=off to disable the gate entirely.
 *
 * PURITY + TESTABILITY
 * ----------------------------------------------------------------------------
 * classify() is side-effect-free except for the injected LLM call. Both the LLM
 * (Ollama) call and the Claude strong-band verifier are constructor-injectable
 * functions, so the OFFLINE test (scripts/_test-position-classifier.ts) injects a
 * FAKE LLM that returns a fixed JSON array and a FAKE verifier, and exercises the
 * full mapping + band derivation + the verbatim-quote gate with no network, no
 * Ollama, and no Claude account.
 *
 * Single TypeScript runtime, no Python. Native fetch for Ollama (no new npm dep).
 * No em-dashes / en-dashes; acronyms spelled out on first use.
 */

import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type {
  PositionClassifier,
  RawSignal,
  ClassifyContext,
  PositionKind,
  SignalActor,
} from './extract-signals';
import { quoteAppearsInSource } from './extract-signals';

// ===========================================================================
// The active sub_dimension shape the classifier is bound to
// ===========================================================================

/**
 * The minimal sub_dimension fields the classifier needs. Loaded at runtime from
 * the live DB (only active=true rows) and passed into the constructor. We do NOT
 * hardcode the 19 rows; the runner loads them and injects them, so adding /
 * retiring a sub_dimension is a data change, not a code change.
 *
 *   - name: the slug (e.g. 'immigration', 'school_choice', 'water_rights'). This
 *     is what we store as RawSignal.sub_dimension_key.
 *   - spectrum_low / spectrum_high: the 0.0 / 1.0 poles of the axis. These are
 *     fed to the model verbatim so direction is calibrated to the real axis.
 *   - editorial_salience: 0..1, 0.5 neutral. Drives the high-salience gate (a
 *     strong-band reading on a high-salience issue gets the Claude re-check).
 */
export interface ActiveSubDimension {
  id: string;
  domain: string;
  name: string;
  spectrum_low: string;
  spectrum_high: string;
  editorial_salience?: number | null;
  /**
   * OPTIONAL calibrated 5-point anchored rubric for this issue, loaded from
   * app/data/positioning/sub-dimension-anchors.json (keyed by `name`). When
   * present, the prompt presents ALL FIVE anchors (value + plain-language policy
   * description) so the model can place a MODERATE stance ("reduce regulation")
   * at the calibrated intermediate value (~0.25) instead of rounding it to the
   * 0.0 pole. When ABSENT, the classifier falls back to the two-pole
   * spectrum_low/spectrum_high prompt (no behavior change for issues not yet in
   * the file). The runner may inject this; if it does not, the classifier loads
   * the JSON itself and attaches the matching scale by `name`.
   *
   * Only `direction` (where on the spectrum) is chosen from these anchors;
   * `intensity_band` (how forcefully stated) is derived SEPARATELY from the
   * rhetorical strength of the language (doc 07), never from how extreme the
   * anchor is. A forcefully stated moderate ("we must REDUCE regulation now") is
   * direction ~0.25 from the anchors AND intensity 'strong' from the language.
   */
  anchors?: AnchorPoint[] | null;
}

/** One calibrated anchor on a sub_dimension's 0.0 -> 1.0 axis (doc 07 rubric). */
export interface AnchorPoint {
  value: number;
  label: string;
}

// ===========================================================================
// Calibrated anchor rubric loader (the founder's calibration fix)
// ===========================================================================

/**
 * The on-disk shape of app/data/positioning/sub-dimension-anchors.json. Keyed by
 * sub_dimension `name`. Each entry carries the 5-point calibrated `scale`. Extra
 * fields (domain, spectrum_low/high, $schema_note) are ignored by the loader.
 */
interface AnchorsFile {
  calibration_version?: string;
  anchors: Record<
    string,
    { scale?: Array<{ value?: unknown; label?: unknown }> } | undefined
  >;
}

/**
 * Default path to the anchors JSON, resolved relative to THIS module so it works
 * whether tsx runs from app/ or elsewhere. Overridable with
 * BB_SUBDIM_ANCHORS_PATH for tests / alternate data locations.
 */
function defaultAnchorsPath(): string {
  if (process.env.BB_SUBDIM_ANCHORS_PATH) return process.env.BB_SUBDIM_ANCHORS_PATH;
  // src/lib/ingest/position-classifier.ts -> ../../../data/positioning/...
  // i.e. app/src/lib/ingest -> app/data/positioning. fileURLToPath handles the
  // Windows file:// -> drive-path conversion correctly (a bare URL.pathname would
  // leave a leading-slash "/C:/..." that readFileSync rejects on Windows).
  const url = new URL('../../../data/positioning/sub-dimension-anchors.json', import.meta.url);
  return fileURLToPath(url);
}

/** Process-lifetime cache so we read + parse the JSON at most once per path. */
const _anchorsCache = new Map<string, Map<string, AnchorPoint[]>>();

/**
 * loadSubDimensionAnchors(path?): read the calibrated anchors JSON and return a
 * Map from sub_dimension name -> ascending AnchorPoint[] (validated). Returns an
 * EMPTY map (never throws) when the file is missing or malformed, so the
 * classifier silently falls back to the two-pole prompt -- the file is an
 * enhancement, not a hard dependency. A scale is accepted only when it has at
 * least two finite, in-range, strictly-ascending values; otherwise that one
 * issue is skipped (falls back to two poles) without poisoning the rest.
 *
 * Synchronous + cached so the constructor can attach anchors without async.
 */
export function loadSubDimensionAnchors(path?: string): Map<string, AnchorPoint[]> {
  const p = path ?? defaultAnchorsPath();
  const cached = _anchorsCache.get(p);
  if (cached) return cached;

  const out = new Map<string, AnchorPoint[]>();
  try {
    // Native fs read, no new npm dependency. readFileSync is statically imported
    // (ESM) so the loader works from a synchronous constructor under any runtime.
    const raw = readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw) as AnchorsFile;
    const anchors = parsed?.anchors ?? {};
    for (const [name, entry] of Object.entries(anchors)) {
      const scale = entry?.scale;
      if (!Array.isArray(scale)) continue;
      const points: AnchorPoint[] = [];
      for (const s of scale) {
        const v = typeof s?.value === 'number' ? s.value : Number(s?.value);
        const label = typeof s?.label === 'string' ? s.label.trim() : '';
        if (!Number.isFinite(v) || v < 0 || v > 1 || !label) continue;
        points.push({ value: v, label });
      }
      // Require >= 2 strictly ascending values for the scale to be usable.
      let ascending = points.length >= 2;
      for (let i = 1; i < points.length && ascending; i++) {
        if (!(points[i].value > points[i - 1].value)) ascending = false;
      }
      if (ascending) out.set(name, points);
    }
  } catch {
    // Missing / unreadable / malformed file -> empty map -> two-pole fallback.
  }
  _anchorsCache.set(p, out);
  return out;
}

// ===========================================================================
// The LLM call seam (Ollama by default, injectable for the offline test)
// ===========================================================================

/**
 * The shape of one model reading, as the LLM is asked to emit it. The model
 * returns a JSON ARRAY of these; we validate each with Zod and drop malformed
 * entries. Field names match doc 07 section 1.6 (sub_dimension, direction,
 * position_kind, quote, confidence).
 */
const ModelReadingSchema = z.object({
  /** The sub_dimension slug the reading is for. Must match an active name. */
  sub_dimension: z.string(),
  /**
   * 0..1 on the spectrum_low -> spectrum_high axis, OR null. Per doc 07 C1,
   * direction is null for abstains_governing and 0.5 for balanced. We accept
   * null here and reconcile against position_kind in mapping.
   */
  direction: z.number().min(0).max(1).nullable(),
  /** graded | balanced | abstains_governing (doc 07 C1). */
  position_kind: z.enum(['graded', 'balanced', 'abstains_governing']),
  /**
   * Verbatim substring of the source supporting the reading. Required for a
   * graded/balanced reading; may be empty for abstains_governing (the gate does
   * not require a quote for non-graded, but we prefer one). Validated against the
   * source by the gate; a non-substring quote is rejected downstream.
   */
  quote: z.string(),
  /** 0..1 model confidence in THIS reading (data-quality, not strength). */
  confidence: z.number().min(0).max(1),
  /**
   * OPTIONAL grounding scratchpad the model fills BEFORE committing to a reading
   * (the reason -> context -> structure flow / abstention fix, 2026-06-23). It is
   * a SCRATCHPAD ONLY: not stored, not part of the RawSignal output schema, never
   * surfaced. `z.object` strips unknown keys, but we declare these as optional so
   * a model that DOES emit them is not dropped as malformed. The classifier reads
   * `addresses_subdimension`: when the model has reasoned over the surrounding
   * context and concluded the passage does NOT actually state a position on this
   * sub_dimension, it sets this to false and the reading is dropped (abstain),
   * even if a quote was supplied. Default true preserves prior behavior for a
   * model that omits the field entirely. `topic_reasoning` is the one-sentence
   * justification (kept only for counters / debugging).
   */
  addresses_subdimension: z.boolean().optional(),
  topic_reasoning: z.string().optional(),
});
export type ModelReading = z.infer<typeof ModelReadingSchema>;

/** The JSON schema (draft) we hand Ollama's `format` for constrained decoding. */
function readingArrayJsonSchema(): Record<string, unknown> {
  // Built by hand (rather than z.toJSONSchema on an array) so the shape is
  // explicit and stable for Ollama's validator: a top-level array of objects.
  // Field ORDER matters for constrained decoding: the model emits keys in the
  // order listed, so we put the reasoning scratchpad (topic_reasoning,
  // addresses_subdimension) FIRST. That forces the model to reason about whether
  // the passage actually addresses the sub_dimension BEFORE it commits to a
  // direction/quote (reason -> context -> structure). The scratchpad fields are
  // NOT in `required`, so a model that ignores them still produces a valid object.
  return {
    type: 'array',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sub_dimension: { type: 'string' },
        topic_reasoning: { type: 'string' },
        addresses_subdimension: { type: 'boolean' },
        direction: { type: ['number', 'null'] },
        position_kind: {
          type: 'string',
          enum: ['graded', 'balanced', 'abstains_governing'],
        },
        quote: { type: 'string' },
        confidence: { type: 'number' },
      },
      required: ['sub_dimension', 'direction', 'position_kind', 'quote', 'confidence'],
    },
  };
}

/**
 * The injected LLM function. Given a fully-built prompt (system + user) and the
 * JSON schema, it returns the model's RAW string response (expected to be a JSON
 * array). The classifier owns parsing + validation; the LLM function owns only
 * the transport. This is the seam the offline test stubs.
 */
export type LlmCallFn = (args: {
  system: string;
  user: string;
  jsonSchema: Record<string, unknown>;
  model: string;
}) => Promise<string>;

/**
 * The default Ollama LLM caller. POSTs to {OLLAMA_URL}/api/chat with
 * stream:false and format=<json schema> for constrained decoding (Ollama v0.5+).
 * Native fetch only; no npm dependency. Honors OLLAMA_URL (default
 * http://localhost:11434) and a per-call timeout via BB_CLASSIFIER_TIMEOUT_MS.
 *
 * Ollama /api/chat request shape used here:
 *   {
 *     "model": "<model>",
 *     "stream": false,
 *     "messages": [
 *       { "role": "system", "content": "<system>" },
 *       { "role": "user",   "content": "<user>" }
 *     ],
 *     "format": { ...json schema... },          // constrained decoding
 *     "options": { "temperature": 0, "num_ctx": 16384 },
 *     "keep_alive": "10m"
 *   }
 * Response: { "message": { "role": "assistant", "content": "<json string>" }, ... }
 */
export function makeOllamaLlmCall(opts: { baseUrl?: string; timeoutMs?: number } = {}): LlmCallFn {
  const baseUrl =
    opts.baseUrl ??
    process.env.OLLAMA_URL ??
    process.env.OLLAMA_HOST ??
    'http://localhost:11434';
  const timeoutMs =
    opts.timeoutMs ?? (Number(process.env.BB_CLASSIFIER_TIMEOUT_MS ?? '120000') || 120000);

  return async ({ system, user, jsonSchema, model }): Promise<string> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('ollama timeout')), timeoutMs);
    try {
      const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model,
          stream: false,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          format: jsonSchema,
          options: { temperature: 0, num_ctx: 16384 },
          keep_alive: process.env.OLLAMA_KEEP_ALIVE ?? '10m',
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '(unreadable)');
        throw new Error(`Ollama HTTP ${res.status}: ${body.slice(0, 400)}`);
      }
      const json = (await res.json()) as { message?: { content?: string } };
      return (json.message?.content ?? '').trim();
    } finally {
      clearTimeout(timer);
    }
  };
}

// ===========================================================================
// The Claude strong-band verifier seam (flat-rate account, injectable)
// ===========================================================================

/**
 * Verdict from the strong-band re-check. `agree` keeps the 'strong' band;
 * `disagree` fails closed (downgrade to 'support'); `unavailable` (rate window
 * exhausted / no key) ALSO fails closed per doc 07 section 1.5 cap-exhaustion.
 */
export type StrongBandVerdict = 'agree' | 'disagree' | 'unavailable';

/**
 * The injected Claude verifier. Given the source text, the reading, and the
 * sub_dimension axis, returns whether the 'strong' band is warranted. Injectable
 * so the offline test stubs it and so the live default (the Claude Code CLI via
 * src/lib/claude-cli.ts) is not loaded when not needed. Returns 'unavailable'
 * rather than throwing when the account cannot serve the call, so the classifier
 * can fail closed.
 */
export type StrongBandVerifyFn = (args: {
  sourceText: string;
  subDimension: ActiveSubDimension;
  direction: number;
  quote: string;
}) => Promise<StrongBandVerdict>;

/**
 * The default Claude strong-band verifier, using the FLAT-RATE Claude account via
 * the Claude Code command-line interface (CLI) (src/lib/claude-cli.ts), NOT the
 * metered Anthropic Software Development Kit (SDK) key in src/lib/claude.ts (that
 * key has a $0 credit balance and returns HTTP 400 "credit balance too low"). The
 * CLI authenticates with the operator's subscription and never touches API credits.
 *
 * Lazily imports the CLI wrapper so importing this module (e.g. in the offline
 * test) never spawns a process. A single, narrow yes/no re-check: "does this
 * quote, on this axis, warrant the maximal 'strong' band, on the SAME pole as the
 * local read?" We ask the CLI for a tiny JSON object {score, confidence} placing
 * the SAME axis, then apply the SAME agree/disagree logic as before (Claude must
 * land in the strong band AND on the same pole to AGREE). Any failure (CLI missing,
 * timeout, non-zero exit, parse, credit/auth) returns 'unavailable' so the caller
 * fails closed (doc 07 section 1.5 cap-exhaustion rule).
 */
export function makeClaudeStrongBandVerifier(): StrongBandVerifyFn {
  return async ({ sourceText, subDimension, direction, quote }): Promise<StrongBandVerdict> => {
    try {
      // Lazy import: only loaded on the live path. runClaudeJson shells out to the
      // `claude` CLI on the subscription; any error throws, which we convert to
      // 'unavailable' (fail closed) in the catch below.
      const { runClaudeJson } = await import('@/lib/claude-cli');

      const prompt =
        `You are a nonpartisan political analyst. Place this candidate statement on the ` +
        `named 0.0-1.0 spectrum, using ONLY the statement and surrounding context.\n\n` +
        `Spectrum "${subDimension.name}" (domain: ${subDimension.domain}):\n` +
        `- 0.0 = "${subDimension.spectrum_low}"\n` +
        `- 1.0 = "${subDimension.spectrum_high}"\n\n` +
        `Candidate statement (verbatim): "${quote}"\n\n` +
        `Surrounding source context:\n${sourceText.slice(0, 4000)}\n\n` +
        `Respond with ONLY a JSON object, no prose: ` +
        `{ "score": <0.0-1.0 or null if the statement does not address this spectrum>, ` +
        `"confidence": "high" | "medium" | "low" | "no_data" }`;

      const parsed = (await runClaudeJson(prompt, {
        model: process.env.BB_STRONG_BAND_CLAUDE_MODEL ?? process.env.BB_CLAUDE_CLI_MODEL ?? 'sonnet',
        timeoutMs: Number(process.env.BB_STRONG_BAND_TIMEOUT_MS ?? '60000') || 60000,
      })) as { score?: number | null } | null;

      const score = parsed && typeof parsed.score === 'number' ? parsed.score : null;
      if (score == null) return 'disagree'; // no placement => do not keep strong
      const claudeStrong = score <= STRONG_LOW_MAX || score >= STRONG_HIGH_MIN;
      const samePole =
        (direction <= 0.5 && score <= 0.5) || (direction >= 0.5 && score >= 0.5);
      return claudeStrong && samePole ? 'agree' : 'disagree';
    } catch {
      // CLI missing / timeout / non-zero exit / parse / credit-auth: fail closed.
      return 'unavailable';
    }
  };
}

// ===========================================================================
// Band derivation (doc 07 section 2.2) + maximalism markers
// ===========================================================================

/** Doc 07 band cutoffs (initial hypotheses; the only cutoffs in code today). */
export const STRONG_LOW_MAX = 0.15; // direction <= 0.15 => strong (toward low pole)
export const SUPPORT_LOW_MAX = 0.35; // (0.15, 0.35] => support
export const LEAN_LOW_MAX = 0.5; // (0.35, 0.5) => lean
export const LEAN_HIGH_MIN = 0.5; // (0.5, 0.65) => lean
export const SUPPORT_HIGH_MIN = 0.65; // [0.65, 0.85) => support
export const STRONG_HIGH_MIN = 0.85; // >= 0.85 => strong (toward high pole)
/** Dead-band around 0.5 reported as neutral (doc 07 round_to_band). */
export const NEUTRAL_DEADBAND = 0.02;

export type IntensityBand = 'neutral' | 'lean' | 'support' | 'strong';

/**
 * deriveBand(direction): map a calibrated 0..1 direction to a doc-07 band.
 * Symmetric around 0.5. Returns 'neutral' inside the dead-band. This is the RAW
 * band from the number alone; the 'strong' band is only KEPT if a maximalism
 * marker is present in the quote (see deriveBandGated).
 */
export function deriveBand(direction: number): IntensityBand {
  if (Math.abs(direction - 0.5) <= NEUTRAL_DEADBAND) return 'neutral';
  if (direction <= STRONG_LOW_MAX || direction >= STRONG_HIGH_MIN) return 'strong';
  if (direction <= SUPPORT_LOW_MAX || direction >= SUPPORT_HIGH_MIN) return 'support';
  return 'lean';
}

/**
 * Maximalism markers that license a 'strong' band (doc 07 section 2.2 "strong =
 * rhetorical maximalism, symmetric"). Mirrors the set used by gateSignal so the
 * classifier and the gate agree on what 'strong' requires. Symmetric, no
 * partisan valence.
 */
const MAXIMALISM_MARKERS: RegExp[] = [
  /\b(?:ban|abolish|eliminate|outlaw|prohibit|criminaliz\w*|confiscat\w*)\b/i,
  /\b(?:guarantee|mandate|compel)\b/i,
  // Absolute quantifiers ONLY in their policy-absolute constructions. Bare
  // "all"/"every"/"none" are deliberately EXCLUDED -- they appear in benign
  // phrasing ("every family", "all voters") and are not intensity markers per
  // doc 07. We keep the unconditional constructions that genuinely signal a
  // maximal policy stance.
  /\b(?:always|never)\b/i,
  /\bno\s+exceptions?\b/i,
  /\bunder\s+no\s+circumstances\b/i,
  /\bfor\s+(?:everyone|all)\b/i,
  /\b(?:completely|entirely|absolutely|totally|unconditional\w*)\b/i,
  /\bwithout\s+(?:restriction|exception|limit)\b/i,
  /\b(?:immediately|at\s+once|without\s+delay)\b/i,
  /\brepeal\s+(?:entirely|all)\b/i,
];

export function hasMaximalismMarker(quote: string): boolean {
  return MAXIMALISM_MARKERS.some((re) => re.test(quote));
}

/**
 * deriveBandGated(direction, quote): the band actually assigned. A raw 'strong'
 * band is DOWNGRADED to 'support' when the quote carries no maximalism marker, so
 * a model cannot assert maximal intensity without textual support (the band is
 * the only place intensity lives, doc 07). All other bands pass through.
 */
export function deriveBandGated(direction: number, quote: string): IntensityBand {
  const raw = deriveBand(direction);
  if (raw === 'strong' && !hasMaximalismMarker(quote)) return 'support';
  return raw;
}

/** 0..1 numeric confidence -> the coarse enum the RawSignal also carries. */
function confidenceEnum(n: number): 'high' | 'medium' | 'low' {
  if (n >= 0.75) return 'high';
  if (n >= 0.5) return 'medium';
  return 'low';
}

/** Registrable-ish domain from a URL, for RawSignal.source_domain. Best-effort. */
function registrableDomain(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

/** Map a source_family + tier to the RawSignal.actor attribution (doc 07 1.6). */
function actorFor(ctx: ClassifyContext): SignalActor {
  const fam = (ctx.source_family ?? '').toLowerCase();
  if (
    fam.includes('candidate') ||
    fam.includes('questionnaire') ||
    ctx.authenticity_tier === 1
  ) {
    return 'candidate_self';
  }
  if (fam.includes('vote') || fam.includes('gov') || fam.includes('record')) {
    return 'gov_record';
  }
  if (fam) return `named_outlet:${fam}`;
  return 'candidate_self';
}

// ===========================================================================
// Prompt building
// ===========================================================================

const SYSTEM_PROMPT = `You are a nonpartisan political analyst for Havesay, a voter-candidate matching platform. You read one source document about ONE candidate and identify, for each policy sub-dimension the document ACTUALLY addresses, the candidate's position on that sub-dimension's spectrum.

ABSTAIN-NOT-GUESS IS THE GOVERNING RULE. Havesay is a trust-first civic product. A WRONG position attributed to a candidate is far worse than a MISSING one. When in doubt, emit nothing. A sentence pulled out of context can be made to mean almost anything; what a passage actually means is carried by the SURROUNDING CONTEXT, not by a lone sentence. Your job is to read the context, not to mine sentences for keywords.

For EVERY candidate reading you are tempted to emit, work through these steps IN ORDER before you commit to it:
  1. REASON OVER CONTEXT. Read the sentences AROUND the candidate's words, not just one line. What is the passage as a whole actually talking about? A quote about "tragedy hitting our state" inside a passage about political violence is ABOUT political violence, not about criminal-justice reform. A line praising teacher transparency is ABOUT education transparency, not gun policy. The topic of a quote is the topic of its PASSAGE.
  2. ASK WHETHER THE PASSAGE ACTUALLY ADDRESSES THIS SUB-DIMENSION AT ALL. Does the candidate, in this context, actually state a governing position on THIS specific sub-dimension's spectrum? Merely mentioning a related word, an adjacent issue, or an emotion is NOT addressing the sub-dimension. The passage must take a stance a voter could place on the named spectrum.
  3. ABSTAIN WHEN IT DOES NOT. If the passage does not clearly state a position on this sub-dimension, DO NOT emit a reading for it. Silence is not a position. A loosely-related, adjacent, or off-topic passage is silence. Do not stretch a quote to fit a sub-dimension it does not squarely address.
  4. ONLY IF the passage squarely addresses the sub-dimension and states a placeable position, emit the reading.

Each reading object you DO emit must carry, FIRST, your grounding:
  - "topic_reasoning": one short sentence on what the surrounding passage is actually about and why it genuinely addresses THIS sub-dimension.
  - "addresses_subdimension": true ONLY if, after reasoning over context, the passage squarely states a position on this sub-dimension. Set it false (and the reading will be discarded) the moment you are inferring, stretching, or relying on a loose topical association. Defaulting to false is the safe choice.

Hard rules you must follow:
- Only emit a reading for a sub-dimension the text DIRECTLY addresses, in context, in the candidate's own words or actions. If the text says nothing about a sub-dimension, DO NOT include it. Never infer a position the text does not support. Never attribute a quote to a sub-dimension the quote's surrounding passage is not about.
- Every reading MUST include a "quote": a VERBATIM substring copied exactly from the source text (same words, same order). Do not paraphrase, summarize, or invent the quote. The quote must be the actual passage that states the position, not a nearby sentence borrowed to justify a stance the candidate did not take. If you cannot find a verbatim quote that itself addresses this sub-dimension, do not emit the reading.
- direction is 0.0 to 1.0 on the named spectrum. Each sub-dimension below lists a CALIBRATED SCALE of anchor points (a value and a plain-language policy description). Choose the anchor value whose policy description best matches the candidate's STATED policy. A value BETWEEN two anchors is allowed and encouraged when the stance sits between them (for example 0.35 when it is firmer than the 0.25 anchor but not as far as the 0.5 anchor).
- DO NOT round a moderate stance to the extremes. The 0.0 and 1.0 anchors are the TRUE extremes (eliminate / abolish / maximal). A stance like "reduce X" or "cut X somewhat" matches the 0.25 anchor (around 0.25), NOT the 0.0 anchor. A stance like "expand X somewhat" matches the 0.75 anchor (around 0.75), NOT the 1.0 anchor. "Keep current / it is about right" matches the 0.5 anchor.
- DIRECTION (where on the spectrum) is SEPARATE from how forcefully the candidate speaks. Do NOT push a moderate stance toward an extreme just because it is stated emphatically. A candidate who emphatically says "we MUST reduce regulation now" is still a 0.25-style direction (reduce, not eliminate); the forcefulness is handled separately and is not your job. Score direction purely from WHAT policy they want, not HOW strongly they say it.
- position_kind:
  - "graded": a placeable governing position. direction is a real number 0.0-1.0.
  - "balanced": the candidate explicitly says current law / the status quo is about right, or takes an explicitly balanced both-sides governing position. direction = 0.5.
  - "abstains_governing": the candidate states a personal belief but explicitly declines to legislate or change the law ("personally X but I would not vote to change it", "not the role of this office"). direction = null. This is NOT 0.5.
- Be strictly neutral and evidence-based. Use the candidate's own framing. Do not inject editorial commentary.
- Return ONLY a valid JSON array matching the schema. No prose before or after. An empty array [] when the text addresses none of the sub-dimensions. Returning [] is the correct, expected answer for a passage that is off-topic, biographical, emotional, or only loosely related to the listed sub-dimensions.`;

/**
 * Render one sub_dimension's scale block for the prompt. When the sub_dimension
 * carries a calibrated 5-point `anchors` scale (loaded from the anchors JSON),
 * list ALL anchor points (value = description) so the model has intermediate
 * targets and a "reduce X" stance lands on the 0.25 anchor instead of the 0.0
 * pole (the founder's calibration fix). When no anchors exist, fall back to the
 * original two-pole spectrum_low/spectrum_high line (no behavior change).
 */
function renderScaleBlock(d: ActiveSubDimension): string {
  const anchors = d.anchors;
  if (anchors && anchors.length >= 2) {
    const lines = anchors
      .map((a) => `    ${a.value.toFixed(2)} = "${a.label}"`)
      .join('\n');
    return `- "${d.name}" (domain: ${d.domain}) -- choose the anchor value that best matches the stated policy (a value between anchors is allowed):\n${lines}`;
  }
  // Two-pole fallback: this issue is not yet in the anchors file.
  return `- "${d.name}" (domain: ${d.domain}): 0.0 = "${d.spectrum_low}"  ...  1.0 = "${d.spectrum_high}"`;
}

/** Build the per-document user prompt listing the active sub_dimensions. */
function buildUserPrompt(text: string, subDims: ActiveSubDimension[], maxChars: number): string {
  const dimList = subDims.map((d) => renderScaleBlock(d)).join('\n');

  const truncated = text.length > maxChars ? text.slice(0, maxChars) : text;

  return `SUB-DIMENSIONS you may classify against (use the exact slug in quotes as "sub_dimension"). For each, place the candidate on the CALIBRATED SCALE shown -- pick the anchor value whose policy description fits best, or a value between anchors; do not collapse a moderate stance to an extreme:
${dimList}

SOURCE DOCUMENT (one candidate; copy quotes VERBATIM from this exact text):
"""
${truncated}
"""

Before emitting ANY object, reason over the SURROUNDING CONTEXT of the document, decide what each passage is actually about, and check whether it squarely states a position on a listed sub-dimension. ABSTAIN (omit the object) when it does not. A wrong position is worse than a missing one. Do not attach a quote to a sub-dimension whose topic the quote's passage is not actually about.

For EACH sub-dimension the document actually addresses, output one object with the reasoning FIRST:
{ "sub_dimension": "<exact slug>", "topic_reasoning": "<one sentence: what the surrounding passage is about and why it genuinely addresses this sub-dimension>", "addresses_subdimension": <true only if the passage squarely states a position on this sub-dimension; false if you are inferring or stretching>, "direction": <0.0-1.0 or null>, "position_kind": "graded" | "balanced" | "abstains_governing", "quote": "<verbatim substring of the document that itself states this position>", "confidence": <0.0-1.0> }

direction = the calibrated scale value that best matches the candidate's stated policy (an intermediate value is fine; a "reduce / cut somewhat" stance is around the 0.25 anchor, an "expand somewhat" stance is around the 0.75 anchor, "keep current" is 0.5). Score direction from WHAT policy they want, not how forcefully they say it.

Output a JSON ARRAY of these objects. Output [] if the document addresses none of them. Do not output any sub-dimension the document does not address, and do not output an object whose "addresses_subdimension" you would set false -- simply omit it.`;
}

// ===========================================================================
// Document chunking (recall fix)
// ===========================================================================

/**
 * chunkText(text, maxChars, overlap): split a long document into overlapping
 * chunks that respect natural boundaries, so the classifier sees ALL of a long
 * page rather than only the first maxSourceChars (the truncation bug that killed
 * recall on a 57KB page).
 *
 * Rules:
 *  - Short text (<= maxChars) stays a SINGLE chunk -- byte-identical to the input,
 *    so short docs are unchanged (no behavior change).
 *  - We split on paragraph boundaries (one or more blank lines) and pack whole
 *    paragraphs into a chunk up to maxChars. A paragraph longer than maxChars on
 *    its own is hard-split on sentence/whitespace boundaries (best-effort) so no
 *    single chunk blows past the cap.
 *  - Each chunk after the first carries the last `overlap` characters of the
 *    previous chunk's text prepended (snapped to a word boundary), so a statement
 *    straddling a boundary appears intact in at least one chunk. The verbatim-quote
 *    gate later validates each quote against the FULL original text, so the overlap
 *    is purely about giving the model a complete sentence to read.
 *
 * Pure, deterministic, no I/O.
 */
export function chunkText(text: string, maxChars: number, overlap: number): string[] {
  const src = text ?? '';
  if (src.length <= maxChars) return [src];

  const cap = Math.max(1, maxChars);
  const ov = Math.max(0, Math.min(overlap, Math.floor(cap / 2)));

  // 1. Split into paragraph-ish blocks on blank-line boundaries, keeping the
  //    separators so reassembly is faithful. A "paragraph" is a run of non-blank
  //    lines; the blank-line gap between them is the natural break point.
  const paras = src.split(/\n\s*\n/);

  // 2. Hard-split any single paragraph that is itself larger than the cap, on
  //    sentence boundaries first, then whitespace, then a raw character cut.
  const units: string[] = [];
  for (const para of paras) {
    if (para.length <= cap) {
      units.push(para);
      continue;
    }
    let rest = para;
    while (rest.length > cap) {
      // Prefer a sentence boundary within the last 30% of the cap window.
      const window = rest.slice(0, cap);
      let cut = -1;
      const sentenceMatch = window.match(/[.!?]["')\]]?\s+(?=[^\s])/g);
      if (sentenceMatch) {
        // last sentence break inside the window
        const idx = window.lastIndexOf(sentenceMatch[sentenceMatch.length - 1]);
        if (idx >= cap * 0.5) cut = idx + sentenceMatch[sentenceMatch.length - 1].length;
      }
      if (cut < 0) {
        const ws = window.lastIndexOf(' ');
        cut = ws >= cap * 0.5 ? ws + 1 : cap; // fall back to a raw cut at the cap
      }
      units.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    if (rest.length) units.push(rest);
  }

  // 3. Greedily pack units into chunks up to the cap, joining with the paragraph
  //    separator we split on. Prepend the previous chunk's overlap tail to each
  //    new chunk (snapped to a word boundary on the left so we don't start mid-word).
  const chunks: string[] = [];
  let buf = '';
  const flush = (): void => {
    if (!buf.length) return;
    if (chunks.length === 0 || ov === 0) {
      chunks.push(buf);
    } else {
      const prev = chunks[chunks.length - 1];
      let tail = prev.slice(Math.max(0, prev.length - ov));
      const sp = tail.indexOf(' ');
      if (sp > 0 && sp < tail.length - 1) tail = tail.slice(sp + 1); // snap to word start
      const sep = tail.endsWith('\n') || tail.length === 0 ? '' : '\n\n';
      chunks.push(tail + sep + buf);
    }
    buf = '';
  };
  for (const unit of units) {
    if (!buf.length) {
      buf = unit;
    } else if (buf.length + 2 + unit.length <= cap) {
      buf = `${buf}\n\n${unit}`;
    } else {
      flush();
      buf = unit;
    }
  }
  flush();

  // Defensive: never return an empty set for non-empty input.
  return chunks.length ? chunks : [src.slice(0, cap)];
}

// ===========================================================================
// RealPositionClassifier
// ===========================================================================

export interface RealClassifierOptions {
  /** The active sub_dimensions to classify against (loaded from the DB). */
  subDimensions: ActiveSubDimension[];
  /** The local model id. Default env BB_CLASSIFIER_MODEL or 'phi4:14b'. */
  model?: string;
  /** Inject the LLM call (Ollama by default). The offline test stubs this. */
  llmCall?: LlmCallFn;
  /**
   * Inject the Claude strong-band verifier. Default is the flat-rate-account
   * verifier (lazy src/lib/claude.ts). The offline test stubs this. Set
   * enableStrongBandGate=false to skip it entirely (e.g. local-only batch).
   */
  strongBandVerify?: StrongBandVerifyFn;
  /** Whether to run the Claude strong-band re-check at all. Default true. */
  enableStrongBandGate?: boolean;
  /**
   * editorial_salience at or above which a 'strong'-band reading triggers the
   * Claude re-check. Default 0.6 (above the 0.5 neutral). Lower to gate more.
   */
  highSalienceThreshold?: number;
  /** Max chars of source text fed to the model. Default 24000. */
  maxSourceChars?: number;
  /**
   * Chunk-size cap: text longer than this is split into overlapping chunks, each
   * classified separately, then merged (see chunkText). Default env
   * BB_CLASSIFIER_MAX_CHARS or 6000. Each chunk is still capped by maxSourceChars
   * when fed to buildUserPrompt, but chunks are sized to maxChunkChars so a single
   * chunk fits comfortably inside phi4:14b's ~16K-token context.
   */
  maxChunkChars?: number;
  /**
   * Overlap (in characters) carried between adjacent chunks so a statement that
   * straddles a chunk boundary is not lost. Default env BB_CLASSIFIER_CHUNK_OVERLAP
   * or 400.
   */
  chunkOverlap?: number;
  /**
   * Calibrated anchor scales by sub_dimension name. When omitted, the classifier
   * loads them from app/data/positioning/sub-dimension-anchors.json (overridable
   * via BB_SUBDIM_ANCHORS_PATH). Inject a Map here in tests to control the scale
   * exactly; pass an EMPTY Map to force the two-pole fallback for every issue.
   * A sub_dimension whose ActiveSubDimension already carries `anchors` keeps its
   * own; the map only fills issues that have none attached.
   */
  anchorsByName?: Map<string, AnchorPoint[]>;
}

/**
 * RealPositionClassifier -- the taxonomy-bound classifier. Implements the exact
 * PositionClassifier interface from extract-signals.ts (readonly model;
 * classify(text, ctx) => Promise<RawSignal[]>), so swapping it in is the one-line
 * change at the runner call site the seam was designed for.
 */
export class RealPositionClassifier implements PositionClassifier {
  readonly model: string;

  private readonly subDimensions: ActiveSubDimension[];
  private readonly byName: Map<string, ActiveSubDimension>;
  private readonly llmCall: LlmCallFn;
  private readonly strongBandVerify: StrongBandVerifyFn | null;
  private readonly enableStrongBandGate: boolean;
  private readonly highSalienceThreshold: number;
  private readonly maxSourceChars: number;
  private readonly maxChunkChars: number;
  private readonly chunkOverlap: number;
  private readonly perChunkTimeoutMs: number;

  /** Counters the runner reads for its summary (strong-band re-checks etc.). */
  readonly stats = {
    readings_returned: 0,
    malformed_dropped: 0,
    unknown_subdim_dropped: 0,
    // Reason-over-context abstention (2026-06-23): the model reasoned about the
    // surrounding context and self-reported that the passage does NOT actually
    // address this sub_dimension (addresses_subdimension=false). Dropped here.
    abstained_off_topic: 0,
    quote_gate_dropped: 0,
    strong_downgraded_no_marker: 0,
    strong_reverified_claude: 0,
    strong_kept_by_claude: 0,
    strong_downgraded_by_claude: 0,
    strong_downgraded_unavailable: 0,
    // Chunking (recall fix) counters.
    chunks_total: 0,
    chunks_skipped: 0,
    chunk_merge_collapsed: 0,
    // Calibration: how many active issues got a calibrated anchor scale vs fell
    // back to the two-pole prompt. Lets the runner confirm the JSON loaded.
    issues_with_anchors: 0,
    issues_two_pole_fallback: 0,
  };

  constructor(opts: RealClassifierOptions) {
    const base = (opts.subDimensions ?? []).filter((d) => d && d.name);

    // Attach the calibrated 5-point anchor scale to each issue (the founder's
    // calibration fix). Precedence: an ActiveSubDimension that already carries
    // `anchors` keeps its own; otherwise we fill from the injected anchorsByName
    // map; otherwise we lazily load app/data/positioning/sub-dimension-anchors.json
    // (overridable via BB_SUBDIM_ANCHORS_PATH). An issue with no scale anywhere
    // keeps anchors null and the prompt falls back to spectrum_low/high (no
    // behavior change for issues not yet in the file). The loader never throws.
    const injected = opts.anchorsByName;
    const fromFile =
      injected === undefined ? loadSubDimensionAnchors() : new Map<string, AnchorPoint[]>();
    this.subDimensions = base.map((d) => {
      const existing = d.anchors && d.anchors.length >= 2 ? d.anchors : null;
      const scale = existing ?? injected?.get(d.name) ?? fromFile.get(d.name) ?? null;
      if (scale && scale.length >= 2) {
        this.stats.issues_with_anchors += 1;
        return { ...d, anchors: scale };
      }
      this.stats.issues_two_pole_fallback += 1;
      return { ...d, anchors: null };
    });
    this.byName = new Map(this.subDimensions.map((d) => [d.name, d]));
    this.model = opts.model ?? process.env.BB_CLASSIFIER_MODEL ?? 'phi4:14b';
    this.llmCall = opts.llmCall ?? makeOllamaLlmCall();
    this.enableStrongBandGate = opts.enableStrongBandGate ?? true;
    this.strongBandVerify = this.enableStrongBandGate
      ? (opts.strongBandVerify ?? makeClaudeStrongBandVerifier())
      : null;
    this.highSalienceThreshold = opts.highSalienceThreshold ?? 0.6;
    this.maxSourceChars = opts.maxSourceChars ?? 24000;
    this.maxChunkChars =
      opts.maxChunkChars ??
      (Number(process.env.BB_CLASSIFIER_MAX_CHARS ?? '6000') || 6000);
    this.chunkOverlap =
      opts.chunkOverlap ??
      (Number(process.env.BB_CLASSIFIER_CHUNK_OVERLAP ?? '400') || 400);
    this.perChunkTimeoutMs =
      Number(process.env.BB_CLASSIFIER_TIMEOUT_MS ?? '120000') || 120000;
  }

  /**
   * Invoke the injected LLM call bounded by BB_CLASSIFIER_TIMEOUT_MS. The default
   * Ollama caller already aborts on its own timer; this wrapper additionally
   * bounds an injected llmCall (e.g. a hanging fake/test or an alternate
   * transport) so one slow chunk cannot stall the whole evidence unit. Rejects
   * with a 'chunk timeout' error the caller catches to skip the chunk.
   */
  private async llmCallBounded(args: {
    system: string;
    user: string;
    jsonSchema: Record<string, unknown>;
    model: string;
  }): Promise<string> {
    const ms = this.perChunkTimeoutMs;
    if (!(ms > 0)) return this.llmCall(args);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('chunk timeout')), ms);
    });
    try {
      return await Promise.race([this.llmCall(args), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * One LLM pass over a piece of text (a full short doc, or one chunk of a long
   * doc): returns validated, sub_dimension-known ModelReadings. Malformed entries
   * and unknown sub_dimensions are dropped (no fabrication), counted in stats.
   * Pure-ish: only side effect is the injected LLM call.
   */
  private async runOnePass(text: string): Promise<ModelReading[]> {
    const user = buildUserPrompt(text, this.subDimensions, this.maxSourceChars);
    const raw = await this.llmCallBounded({
      system: SYSTEM_PROMPT,
      user,
      jsonSchema: readingArrayJsonSchema(),
      model: this.model,
    });

    // Parse the JSON array. Constrained decoding should give clean JSON; defend
    // against accidental code fences and non-array roots.
    let parsedUnknown: unknown;
    try {
      const cleaned = raw
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/```\s*$/i, '')
        .trim();
      parsedUnknown = JSON.parse(cleaned);
    } catch {
      // A single malformed blob counts as the whole pass being unparseable.
      this.stats.malformed_dropped += 1;
      return [];
    }
    const arr = Array.isArray(parsedUnknown) ? parsedUnknown : [];

    const out: ModelReading[] = [];
    for (const entry of arr) {
      const res = ModelReadingSchema.safeParse(entry);
      if (!res.success) {
        this.stats.malformed_dropped += 1;
        continue;
      }
      this.stats.readings_returned += 1;
      if (!this.byName.has(res.data.sub_dimension)) {
        this.stats.unknown_subdim_dropped += 1;
        continue;
      }
      // REASON-OVER-CONTEXT ABSTENTION: the model filled the grounding scratchpad
      // and concluded this passage does NOT actually state a position on this
      // sub_dimension (addresses_subdimension === false). Honor the abstention and
      // drop the reading -- abstain-not-guess. A model that omits the field
      // entirely leaves it undefined, which we treat as "addresses" (prior
      // behavior), so existing fakes / models that never emit it are unaffected.
      if (res.data.addresses_subdimension === false) {
        this.stats.abstained_off_topic += 1;
        continue;
      }
      out.push(res.data);
    }
    return out;
  }

  /**
   * Reconcile a reading's direction with its position_kind per doc 07 C1, and
   * derive the gated band. Returns null when the reading is internally
   * inconsistent in a way we will not auto-fix (e.g. graded with null direction).
   */
  private resolveDirectionAndBand(
    r: ModelReading,
  ): { direction: number | null; position_kind: PositionKind; band: IntensityBand | null } | null {
    if (r.position_kind === 'abstains_governing') {
      // Hard rule: abstains_governing has direction === null, NEVER 0.5.
      return { direction: null, position_kind: 'abstains_governing', band: null };
    }
    if (r.position_kind === 'balanced') {
      // Explicit balance is exactly 0.5, band neutral.
      return { direction: 0.5, position_kind: 'balanced', band: 'neutral' };
    }
    // graded: must have a real direction.
    if (r.direction == null) {
      // Model said graded but gave no number; we cannot place it. Drop it rather
      // than invent a number (no fabrication).
      return null;
    }
    const band = deriveBandGated(r.direction, r.quote);
    return { direction: r.direction, position_kind: 'graded', band };
  }

  /**
   * Map one resolved reading to a RawSignal, then apply the in-classifier guards
   * (verbatim-quote gate via gateSignal's quote check, strong-band Claude
   * re-check). Returns the RawSignal to emit, or null if a guard rejected it.
   */
  private async toSignal(
    r: ModelReading,
    ctx: ClassifyContext,
    sourceText: string,
  ): Promise<RawSignal | null> {
    const resolved = this.resolveDirectionAndBand(r);
    if (!resolved) return null;

    let { band } = resolved;
    const { direction, position_kind } = resolved;
    let numericConfidence = r.confidence;

    // VERBATIM-QUOTE GATE (Build 6): a graded/balanced reading's quote MUST be a
    // substring of the source. Reuse extract-signals.quoteAppearsInSource (the
    // same normalized substring check gateSignal uses), so a hallucinated quote
    // never becomes a signal. abstains_governing without a quote is allowed.
    const needsQuote = position_kind === 'graded' || position_kind === 'balanced';
    if (needsQuote) {
      if (!r.quote || !r.quote.trim()) {
        this.stats.quote_gate_dropped += 1;
        return null;
      }
      if (!quoteAppearsInSource(r.quote, sourceText)) {
        this.stats.quote_gate_dropped += 1;
        return null;
      }
    } else if (r.quote && r.quote.trim() && !quoteAppearsInSource(r.quote, sourceText)) {
      // An abstains reading supplied a quote that is not in source: drop the
      // quote rather than the whole signal (the abstention itself can stand).
      r.quote = '';
    }

    const subDim = this.byName.get(r.sub_dimension)!;

    // STRONG-BAND CLAUDE GATE: a 'strong' band on a high-salience sub_dimension
    // is re-verified with the flat-rate Claude account. Fail closed: disagree OR
    // unavailable => downgrade to 'support' and lower confidence (doc 07 1.5).
    if (
      band === 'strong' &&
      this.strongBandVerify &&
      direction != null &&
      (subDim.editorial_salience ?? 0.5) >= this.highSalienceThreshold
    ) {
      this.stats.strong_reverified_claude += 1;
      const verdict = await this.strongBandVerify({
        sourceText,
        subDimension: subDim,
        direction,
        quote: r.quote,
      });
      if (verdict === 'agree') {
        this.stats.strong_kept_by_claude += 1;
      } else {
        band = 'support';
        numericConfidence = Math.min(numericConfidence, 0.55); // lower confidence on fail-closed
        if (verdict === 'disagree') this.stats.strong_downgraded_by_claude += 1;
        else this.stats.strong_downgraded_unavailable += 1;
      }
    } else if (band === 'strong' && direction != null && !hasMaximalismMarker(r.quote)) {
      // Defensive: deriveBandGated already downgrades a marker-less strong; this
      // branch only fires if band was set strong externally. Count it.
      band = 'support';
      this.stats.strong_downgraded_no_marker += 1;
    }

    const signal: RawSignal = {
      proposition_key: null, // proposition layer not migrated yet (doc 09)
      sub_dimension_key: r.sub_dimension,
      direction,
      intensity_band: band,
      confidence: confidenceEnum(numericConfidence),
      authenticity_tier: ctx.authenticity_tier === 1 || ctx.authenticity_tier === 2 ? ctx.authenticity_tier : 3,
      source_url: ctx.source_url,
      quote: r.quote && r.quote.trim() ? r.quote : null,
      note: undefined,
      position_kind,
      is_action: false, // statements; action signals (votes/sponsorships) are a separate path
      source_domain: registrableDomain(ctx.source_url),
      actor: actorFor(ctx),
      recency: null, // set by the runner from raw_evidence.fetched_at if desired
      signal_confidence: numericConfidence,
    };
    return signal;
  }

  /**
   * classify(text, ctx): the PositionClassifier contract. Runs the local model
   * over the text, maps each reading the text supports to a RawSignal, applies
   * the verbatim-quote gate and the strong-band Claude re-check, and returns the
   * surviving signals. Optionally runs BB_CLASSIFIER_PASSES (>1) local passes and
   * fuses them via consensus before mapping (reuses consensus.ts).
   *
   * RECALL FIX: a long document is split into overlapping chunks (chunkText) so
   * issue content past the first maxChunkChars is no longer silently truncated.
   * Each chunk is classified independently (bounded by BB_CLASSIFIER_TIMEOUT_MS;
   * a chunk that times out or errors is skipped, not fatal), and the per-chunk
   * ModelReadings are MERGED by sub_dimension to one reading per sub_dimension for
   * this evidence unit (mergeChunkReadings). The verbatim-quote gate in toSignal
   * still validates every quote against the FULL original text, so a quote found
   * in one chunk validates against the whole document. A short doc stays one chunk
   * (no behavior change).
   *
   * Returns [] when the text addresses no active sub_dimension (silence is not a
   * position) -- exactly the no-fabrication contract the pipeline relies on.
   */
  async classify(text: string, ctx: ClassifyContext): Promise<RawSignal[]> {
    const src = text ?? '';
    if (!src.trim()) return [];

    const passes = Math.max(1, Number(process.env.BB_CLASSIFIER_PASSES ?? '1') || 1);

    const chunks = chunkText(src, this.maxChunkChars, this.chunkOverlap);
    this.stats.chunks_total += chunks.length;

    // Classify every chunk, skipping any that time out or error. Each chunk runs
    // the configured pass strategy (single pass or consensus over N passes).
    const perChunkReadings: ModelReading[][] = [];
    for (const chunk of chunks) {
      try {
        const readings =
          passes <= 1
            ? await this.runOnePass(chunk)
            : await this.runConsensusPasses(chunk, passes);
        perChunkReadings.push(readings);
      } catch {
        // One bad chunk (timeout, transport error, unparseable) does NOT fail the
        // whole evidence unit. Skip it, count it, keep going.
        this.stats.chunks_skipped += 1;
      }
    }

    // PRE-MERGE QUOTE FILTER: drop readings that cannot pass the verbatim-quote
    // gate (a graded/balanced reading whose quote is empty or is NOT a substring
    // of the FULL source) BEFORE the merge competes them. Without this, a
    // fabricated-quote reading could out-compete a valid reading for the same
    // sub_dimension on confidence, win the merge, and then be dropped by the gate
    // in toSignal -- silently losing a real signal and HURTING recall. By filtering
    // first, the merge only ever picks among gate-passing readings. The quote check
    // is the SAME quoteAppearsInSource gate toSignal applies, run here against the
    // full document (so a quote found in one chunk validates against the whole).
    // abstains_governing readings carry no required quote, so they always pass.
    const gatedPerChunk: ModelReading[][] = perChunkReadings.map((readings) =>
      readings.filter((r) => {
        if (r.position_kind === 'abstains_governing') return true;
        if (!r.quote || !r.quote.trim()) {
          this.stats.quote_gate_dropped += 1;
          return false;
        }
        if (!quoteAppearsInSource(r.quote, src)) {
          this.stats.quote_gate_dropped += 1;
          return false;
        }
        return true;
      }),
    );

    // MERGE across chunks: at most one reading per sub_dimension for this unit.
    const merged = this.mergeChunkReadings(gatedPerChunk);

    const signals: RawSignal[] = [];
    for (const r of merged) {
      // The quote gate inside toSignal re-validates against the FULL src (belt and
      // suspenders); a quote surfaced in one chunk still validates against the
      // whole document. The pre-merge filter above already removed quote failures,
      // so toSignal's gate is a no-op for survivors but keeps the single guarantee.
      const sig = await this.toSignal(r, ctx, src);
      if (sig) signals.push(sig);
    }
    return signals;
  }

  /**
   * mergeChunkReadings: collapse the readings from all chunks of ONE evidence unit
   * to at most ONE reading per sub_dimension. This is intra-evidence-unit dedup,
   * NOT cross-evidence aggregation (a separate resolver sums/averages signals
   * across evidence units; we must not pre-aggregate here).
   *
   * Tie-break, in order, when two chunks yield the same sub_dimension:
   *   1. higher confidence wins;
   *   2. on a confidence tie, the more DECISIVE direction wins (farther from 0.5);
   *      a null direction (abstains) is treated as the least decisive;
   *   3. still tied: prefer a graded reading over balanced/abstains_governing.
   * The chosen reading keeps its own verbatim quote (preserved end-to-end).
   */
  private mergeChunkReadings(perChunk: ModelReading[][]): ModelReading[] {
    const best = new Map<string, ModelReading>();
    const decisiveness = (r: ModelReading): number =>
      r.direction == null ? -1 : Math.abs(r.direction - 0.5);
    const kindRank = (k: PositionKind): number => (k === 'graded' ? 2 : 1);

    for (const readings of perChunk) {
      for (const r of readings) {
        const prev = best.get(r.sub_dimension);
        if (!prev) {
          best.set(r.sub_dimension, r);
          continue;
        }
        // A second reading for an already-seen sub_dimension -> we will collapse.
        this.stats.chunk_merge_collapsed += 1;

        let keepNew = false;
        if (r.confidence > prev.confidence) {
          keepNew = true;
        } else if (r.confidence === prev.confidence) {
          const dNew = decisiveness(r);
          const dPrev = decisiveness(prev);
          if (dNew > dPrev) {
            keepNew = true;
          } else if (dNew === dPrev) {
            keepNew = kindRank(r.position_kind) > kindRank(prev.position_kind);
          }
        }
        if (keepNew) best.set(r.sub_dimension, r);
      }
    }
    return [...best.values()];
  }

  /**
   * Run N local passes and fuse via the Build-6 runConsensus, then re-materialize
   * the fused signals as ModelReadings for the shared mapping path. Only readings
   * that two or more passes agreed on survive (single-pass artifacts dropped).
   * Reuses consensus.ts so the same majority logic governs both the legacy stub
   * and the real classifier.
   */
  private async runConsensusPasses(src: string, passes: number): Promise<ModelReading[]> {
    // Lazy import keeps consensus out of the single-pass hot path's module graph.
    const { runConsensus } = await import('./consensus');

    // Each pass's readings, mapped to lightweight RawSignal-shaped objects so
    // runConsensus (which votes over RawSignal fields) can group them. We key the
    // group on sub_dimension_key (+ a stable source_url) so the same sub_dimension
    // read across passes votes together.
    const perPass: RawSignal[][] = [];
    for (let i = 0; i < passes; i++) {
      const rs = await this.runOnePass(src);
      perPass.push(
        rs.map((r) => ({
          proposition_key: null,
          sub_dimension_key: r.sub_dimension,
          direction: r.direction,
          intensity_band: r.direction != null ? deriveBand(r.direction) : null,
          position_kind: r.position_kind as PositionKind,
          confidence: confidenceEnum(r.confidence),
          authenticity_tier: 1 as const,
          source_url: 'pass', // constant so same-subdim readings group across passes
          quote: r.quote,
          signal_confidence: r.confidence,
        })),
      );
    }

    const result = runConsensus(perPass, { minGroupSupport: 2, minFieldSupport: 2 });

    // Re-materialize fused signals as ModelReadings for the shared mapping path.
    const out: ModelReading[] = [];
    for (const f of result.fused) {
      if (!f.sub_dimension_key || !this.byName.has(f.sub_dimension_key)) continue;
      const pk = (f.position_kind ?? 'graded') as PositionKind;
      out.push({
        sub_dimension: f.sub_dimension_key,
        direction: f.direction ?? null,
        position_kind: pk,
        quote: f.quote ?? '',
        confidence: typeof f.signal_confidence === 'number' ? f.signal_confidence : 0.6,
      });
    }
    return out;
  }
}
// end RealPositionClassifier
