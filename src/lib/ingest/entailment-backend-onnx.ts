/**
 * entailment-backend-onnx.ts -- the PRIMARY entailment backend: a permissively
 * licensed Natural Language Inference (NLI) cross-encoder run IN-PROCESS via
 * transformers.js (@huggingface/transformers) on onnxruntime-node (CPU).
 *
 * WHY THIS MODEL (2026-07 integration research)
 * ----------------------------------------------------------------------------
 * LettuceDetect (MIT) has no published ONNX export and is token-classification
 * with custom span aggregation, so wiring it in-process is high effort. An NLI
 * cross-encoder takes exactly the shape this gate needs:
 *
 *   premise    = QUOTE + surrounding CONTEXT window
 *   hypothesis = the stance CLAIM
 *   -> {contradiction, entailment, neutral}
 *
 * which maps directly onto our verdicts:
 *
 *   entailment  (>= threshold)  -> 'supported'
 *   contradiction(>= threshold) -> 'not_supported'
 *   neutral / low-confidence    -> 'unclear'   (abstain-not-guess)
 *
 * Model: `Xenova/nli-deberta-v3-base` (microsoft/deberta-v3-base backbone, cross-
 * encoder NLI head). License lineage is permissive (Apache-2.0 NLI head, MIT
 * DeBERTa-v3 base); NOTHING CC-BY-NC ships. ~0.2B params, quantized ONNX runs on
 * CPU at tens-of-ms per check, well inside an offline/batch ingestion budget. A
 * smaller fallback (`Xenova/nli-deberta-v3-small` / `-xsmall`) is one env var
 * away if base latency/memory is too heavy under batch load.
 *
 * The transformers.js package is `@huggingface/transformers` (v4, the renamed
 * successor to `@xenova/transformers`); it runs on onnxruntime-node on CPU by
 * default, so the gate stays a single TypeScript runtime, no Python.
 *
 * OPTIONAL DEPENDENCY. @huggingface/transformers is NOT a hard dependency of the
 * app (the gate defaults to shadow and fails open to abstain). This module
 * imports it DYNAMICALLY so a build/run without it never crashes: available()
 * returns false and the gate resolver falls back to Ollama or the NullBackend.
 * Install it only when you intend to run the gate:  npm run gate:entailment:setup
 *
 * CONTEXT-LENGTH DISCIPLINE. DeBERTa-v3 handles ~512 tokens; a QUOTE + tight
 * window is normally well under that. We still window the premise around the
 * quote (the golden set already carries the «»-marked window) and hard-cap the
 * premise characters so a runaway page never blows the model's context.
 *
 * No em-dashes / en-dashes; acronyms spelled out on first use.
 */

import type {
  EntailmentBackend,
  EntailmentClaim,
  EntailmentEvidence,
  EntailmentResult,
  EntailmentVerdict,
} from './entailment-gate';

/** Default model id. Overridable via ENTAILMENT_ONNX_MODEL for the small/xsmall fallback. */
const DEFAULT_MODEL = 'Xenova/nli-deberta-v3-base';

/**
 * Max characters of PREMISE (quote + context) fed to the model. DeBERTa-v3 caps
 * at ~512 tokens; ~1800 chars is a safe budget (roughly 450 tokens for English
 * prose) that comfortably holds a quote plus its surrounding window. The window
 * is centered on the quote so the entailment judgment sees the disambiguating
 * context, not a truncated page head.
 */
const MAX_PREMISE_CHARS = 1800;

/**
 * The NLI label set order can vary by checkpoint. We resolve labels by NAME from
 * the pipeline output (the model returns {label, score} objects), so we never
 * hard-code an index. These regexes classify a returned label string.
 */
const ENTAIL_RE = /entail/i;
const CONTRADICT_RE = /contradict/i;
const NEUTRAL_RE = /neutral/i;

/**
 * Build the PREMISE from evidence: prefer the context window (it disambiguates),
 * fall back to the bare quote. Centered + capped so a long page does not exceed
 * the model context. The context already marks the quote with guillemets («»);
 * we keep those markers so the model's attention is anchored on the quote.
 */
export function buildPremise(evidence: EntailmentEvidence): string {
  const context = (evidence.context ?? '').trim();
  const quote = (evidence.quote ?? '').trim();
  if (!context) return capAround(quote, quote, MAX_PREMISE_CHARS);
  return capAround(context, quote, MAX_PREMISE_CHARS);
}

/**
 * capAround(text, anchor, max): return at most `max` chars of `text`, centered on
 * the first occurrence of `anchor` (the quote). If the anchor is not found, take
 * the head. Keeps the disambiguating window around the quote instead of a blind
 * head-truncation that could drop the quote entirely.
 */
function capAround(text: string, anchor: string, max: number): string {
  if (text.length <= max) return text;
  const probe = anchor.slice(0, 40).toLowerCase();
  const idx = probe ? text.toLowerCase().indexOf(probe) : -1;
  if (idx < 0) return text.slice(0, max);
  const half = Math.floor((max - Math.min(anchor.length, max)) / 2);
  const start = Math.max(0, idx - half);
  const end = Math.min(text.length, start + max);
  return text.slice(start, end);
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * The ONNX NLI backend. Lazily loads the transformers.js tokenizer + sequence-
 * classification model on first use.
 *
 * WHY NOT THE text-classification PIPELINE. transformers.js's
 * `pipeline('text-classification')` silently IGNORES the `text_pair` argument
 * (verified 2026-07-02: it returned an identical constant for every different
 * pair), so it can NOT do cross-encoder NLI. We therefore drive the tokenizer's
 * native `text_pair` support and the model directly, then softmax the logits.
 * This is the correct cross-encoder sentence-pair path.
 *
 * A load failure (dependency missing, download blocked) leaves the model null and
 * available() false, so the resolver falls back to Ollama / NullBackend.
 */
export class OnnxEntailmentBackend implements EntailmentBackend {
  readonly model: string;
  private tokenizer: any = null;
  private nliModel: any = null;
  private id2label: Record<string, string> | null = null;
  private loadTried = false;
  private loadOk = false;

  constructor(modelId?: string) {
    this.model = `onnx:${modelId ?? process.env.ENTAILMENT_ONNX_MODEL ?? DEFAULT_MODEL}`;
  }

  private modelId(): string {
    return this.model.replace(/^onnx:/, '');
  }

  /** Lazily load the tokenizer + model. Idempotent; safe to call repeatedly. */
  private async ensureLoaded(): Promise<boolean> {
    if (this.loadTried) return this.loadOk;
    this.loadTried = true;
    try {
      // Dynamic import so the app builds/runs without the OPTIONAL dependency
      // (it is installed on demand by `npm run gate:entailment:setup`, not saved
      // to package.json). The specifier is computed + the module typed `any` so
      // this file typechecks IDENTICALLY whether or not the package is present:
      // a bare `import('@huggingface/transformers')` would error "cannot find
      // module" on a fresh clone, and a @ts-expect-error would then flip to
      // "unused directive" once it IS installed. Computed specifier avoids both.
      const spec = '@huggingface/transformers';
      const tf: any = await import(/* @vite-ignore */ spec);
      const dtype = (process.env.ENTAILMENT_ONNX_DTYPE ?? 'q8').trim();
      this.tokenizer = await tf.AutoTokenizer.from_pretrained(this.modelId());
      this.nliModel = await tf.AutoModelForSequenceClassification.from_pretrained(this.modelId(), { dtype });
      this.id2label = (this.nliModel?.config?.id2label ?? null) as Record<string, string> | null;
      this.loadOk = !!this.tokenizer && !!this.nliModel;
    } catch {
      this.tokenizer = null;
      this.nliModel = null;
      this.loadOk = false;
    }
    return this.loadOk;
  }

  async available(): Promise<boolean> {
    return this.ensureLoaded();
  }

  async check(claim: EntailmentClaim, evidence: EntailmentEvidence): Promise<EntailmentResult> {
    const ok = await this.ensureLoaded();
    if (!ok || !this.tokenizer || !this.nliModel) {
      return { verdict: 'unclear', score: 0, model: this.model, checked: false, reason: 'onnx_load_failed' };
    }
    const premise = buildPremise(evidence);
    const hypothesis = claim.summary.trim();
    if (!premise || !hypothesis) {
      return { verdict: 'unclear', score: 0, model: this.model, checked: false, reason: 'empty_pair' };
    }

    let scores: { entail: number; contradict: number; neutral: number };
    try {
      // NLI cross-encoder: PREMISE = quote+context, HYPOTHESIS = claim. The
      // tokenizer's text_pair support builds the [CLS] premise [SEP] hypothesis
      // [SEP] pair the model was trained on (the pipeline path drops text_pair).
      const inputs = this.tokenizer(premise, { text_pair: hypothesis, truncation: true });
      const output = await this.nliModel(inputs);
      const logits: number[] = output.logits.tolist()[0];
      scores = logitsToNli(logits, this.id2label);
    } catch (e) {
      return {
        verdict: 'unclear',
        score: 0,
        model: this.model,
        checked: false,
        reason: 'onnx_infer_failed',
        raw: e instanceof Error ? e.message.slice(0, 120) : String(e).slice(0, 120),
      };
    }

    const verdict = nliToVerdict(scores);
    // The reported score is the SUPPORTED-class probability (entailment), so the
    // gate's score bands + logs read consistently across backends.
    return {
      verdict,
      score: scores.entail,
      model: this.model,
      checked: true,
      raw: `e=${scores.entail.toFixed(3)} c=${scores.contradict.toFixed(3)} n=${scores.neutral.toFixed(3)}`,
      // Expose the full distribution so the calibration layer can compute richer
      // score scalars (support_mass, support_margin) without re-running the model.
      scores: { entail: scores.entail, contradict: scores.contradict, neutral: scores.neutral },
    };
  }
}

/** Numerically-stable softmax. */
function softmax(arr: number[]): number[] {
  const m = Math.max(...arr);
  const ex = arr.map((x) => Math.exp(x - m));
  const s = ex.reduce((a, b) => a + b, 0) || 1;
  return ex.map((x) => x / s);
}

/**
 * Map raw model logits + the model's id2label to the three NLI probabilities.
 * Resolves classes BY LABEL NAME so it is robust to label ordering differences
 * across checkpoints (nli-deberta-v3 is {0:contradiction,1:entailment,2:neutral},
 * but we never hard-code that). Falls back to positional order
 * (contradiction, entailment, neutral) when id2label is absent.
 */
export function logitsToNli(
  logits: number[],
  id2label: Record<string, string> | null,
): { entail: number; contradict: number; neutral: number } {
  const probs = softmax(logits);
  let entail = 0;
  let contradict = 0;
  let neutral = 0;
  if (id2label) {
    for (let i = 0; i < probs.length; i++) {
      const label = String(id2label[String(i)] ?? '');
      if (ENTAIL_RE.test(label)) entail = probs[i];
      else if (CONTRADICT_RE.test(label)) contradict = probs[i];
      else if (NEUTRAL_RE.test(label)) neutral = probs[i];
    }
  } else {
    // Positional fallback for the common {contradiction, entailment, neutral} order.
    [contradict, entail, neutral] = [probs[0] ?? 0, probs[1] ?? 0, probs[2] ?? 0];
  }
  return { entail, contradict, neutral };
}

/** Extract the three NLI class probabilities by label name (index-agnostic). */
export function readNliScores(
  out: Array<{ label: string; score: number }>,
): { entail: number; contradict: number; neutral: number } {
  let entail = 0;
  let contradict = 0;
  let neutral = 0;
  for (const o of out) {
    const label = String(o.label ?? '');
    const s = Number(o.score ?? 0);
    if (ENTAIL_RE.test(label)) entail = s;
    else if (CONTRADICT_RE.test(label)) contradict = s;
    else if (NEUTRAL_RE.test(label)) neutral = s;
  }
  return { entail, contradict, neutral };
}

/**
 * Map the 3-way NLI distribution to a verdict.
 *
 * WHY NOT PLAIN ARGMAX. On this civic-claim task, an OFF-TOPIC or slogan quote
 * reads as high NEUTRAL (not contradiction), and a genuinely supporting slogan
 * often reads neutral-leaning too (a campaign slogan does not strictly logically
 * entail a formal claim sentence). So a naive "argmax entailment >= 0.5 ->
 * supported, else unclear" abstains on almost everything and never fires
 * not_supported. Calibrated against the context-aware golden set (see
 * scripts/measure-entailment-gate.ts), the mapping that best separates the three
 * human labels is CONTRADICTION-FIRST with a neutral-aware supported band:
 *
 *   - contradiction is the strongest class (c > entail) AND clears
 *     ENTAILMENT_CONTRADICT_MIN (default 0.30) -> not_supported (the quote leans
 *     against, or is off-topic enough that the model reads active contradiction).
 *   - else entailment mass, counting HALF the neutral mass (a supporting slogan
 *     splits its probability across entail+neutral), clears
 *     ENTAILMENT_SUPPORTED_MASS_MIN (default 0.50) AND entail >= contradict
 *     -> supported.
 *   - else -> unclear (abstain-not-guess).
 *
 * All thresholds are env-overridable so the golden set can retune WITHOUT a code
 * change. NOTE (2026-07-02): even tuned, base NLI agreement with the draft labels
 * is materially below what a task-framed judge reaches; see the run report. This
 * mapping is the best-available DEFAULT, not a claim of enforce-readiness.
 */
export function nliToVerdict(scores: {
  entail: number;
  contradict: number;
  neutral: number;
}): EntailmentVerdict {
  const contradictMin = num(process.env.ENTAILMENT_CONTRADICT_MIN, 0.3);
  const supportedMassMin = num(process.env.ENTAILMENT_SUPPORTED_MASS_MIN, 0.5);
  if (scores.contradict > scores.entail && scores.contradict >= contradictMin) {
    return 'not_supported';
  }
  const supportMass = scores.entail + 0.5 * scores.neutral;
  if (supportMass >= supportedMassMin && scores.entail >= scores.contradict) {
    return 'supported';
  }
  return 'unclear';
}

function num(v: string | undefined, d: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

/** Factory used by the gate resolver. */
export function makeOnnxEntailmentBackend(modelId?: string): EntailmentBackend {
  return new OnnxEntailmentBackend(modelId);
}
