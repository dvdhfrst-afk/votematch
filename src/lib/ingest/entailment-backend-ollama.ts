/**
 * entailment-backend-ollama.ts -- the SECONDARY entailment backend: a structured
 * entailment prompt over a locally-served, PERMISSIVELY-LICENSED Ollama instruct
 * model. This exists only as a fallback for a host that has Ollama running but
 * has NOT installed the transformers.js ONNX dependency (the primary backend).
 *
 * WHY THIS IS THE FALLBACK, NOT THE DEFAULT (2026-07 research)
 * ----------------------------------------------------------------------------
 *  - There is NO dedicated permissive NLI encoder in the Ollama library worth
 *    using. bespoke-minicheck IS in the library but is CC-BY-NC and MUST NOT
 *    ship, so it is HARD-BLOCKED below (available() refuses it).
 *  - A general instruct model doing 3-way entailment is 100-1000x the compute of
 *    a 22M-0.2B NLI encoder, runs in seconds not milliseconds, is
 *    non-deterministic, and re-loads the GPU. This workstation has documented
 *    GPU pressure (sustained Ollama load slows the whole machine), so this path
 *    is deliberately NOT the default and should be used sparingly / overnight.
 *  - It stays here because it needs no extra npm dependency and can run on a host
 *    that already uses Ollama for extraction, so the gate is never dark just
 *    because transformers.js was not installed.
 *
 * Default model: an already-common, PERMISSIVE instruct model. `granite4:7b-a1b-h`
 * (Apache-2.0) is preferred when present; overridable via ENTAILMENT_OLLAMA_MODEL.
 * We NEVER default to phi4 to avoid competing for the extraction model's VRAM, and
 * we NEVER accept bespoke-minicheck.
 *
 * Single TypeScript runtime, no Python. Native fetch (no new npm dependency).
 * No em-dashes / en-dashes; acronyms spelled out on first use.
 */

import type {
  EntailmentBackend,
  EntailmentClaim,
  EntailmentEvidence,
  EntailmentResult,
  EntailmentVerdict,
} from './entailment-gate';
import { buildPremise } from './entailment-backend-onnx';

const DEFAULT_MODEL = 'granite4:7b-a1b-h';
/** Licenses that must never ship. A configured model matching this is refused. */
const BLOCKED_MODEL_RE = /minicheck/i;

function ollamaBase(): string {
  return (process.env.OLLAMA_URL || process.env.OLLAMA_HOST || 'http://localhost:11434').replace(/\/$/, '');
}

/**
 * The entailment prompt. Deliberately narrow: the model returns exactly one of
 * three tokens. We instruct it to judge the CLAIM against the PASSAGE (context),
 * to treat off-topic or non-directional passages as NOT supporting, and to answer
 * UNCLEAR when genuinely ambiguous (abstain-not-guess). Mirrors the golden-set
 * labeling rubric so the two agree.
 */
function buildPrompt(claim: string, premise: string): string {
  return (
    `You are a strict fact-checker judging whether a PASSAGE supports a CLAIM about a political candidate's position.\n` +
    `Judge ONLY from the PASSAGE. The quote is marked with the guillemets when present; read it in its surrounding context.\n` +
    `Rules:\n` +
    `- Answer SUPPORTED only if the passage genuinely evidences the claim's direction on the claim's issue.\n` +
    `- Answer NOT_SUPPORTED if the passage is off-topic for the issue, leans the opposite way, or is a neutral factual statement that expresses no position.\n` +
    `- Answer UNCLEAR if the passage is on-topic but the direction cannot be determined.\n` +
    `Reply with EXACTLY one word: SUPPORTED, NOT_SUPPORTED, or UNCLEAR.\n\n` +
    `PASSAGE:\n${premise}\n\n` +
    `CLAIM:\n${claim}\n\n` +
    `Answer:`
  );
}

function parseVerdict(text: string): { verdict: EntailmentVerdict; score: number } {
  const t = text.trim().toUpperCase();
  if (/NOT[_\s-]?SUPPORT/.test(t)) return { verdict: 'not_supported', score: 0.15 };
  if (/UNCLEAR|UNSURE|AMBIG/.test(t)) return { verdict: 'unclear', score: 0.5 };
  if (/SUPPORT/.test(t)) return { verdict: 'supported', score: 0.85 };
  // Unparseable -> abstain (do not guess supported).
  return { verdict: 'unclear', score: 0.5 };
}

export class OllamaEntailmentBackend implements EntailmentBackend {
  readonly model: string;
  private readonly rawModel: string;

  constructor(modelId?: string) {
    this.rawModel = modelId ?? process.env.ENTAILMENT_OLLAMA_MODEL ?? DEFAULT_MODEL;
    this.model = `ollama:${this.rawModel}`;
  }

  async available(): Promise<boolean> {
    // Hard block: never run a non-commercial-licensed model (bespoke-minicheck).
    if (BLOCKED_MODEL_RE.test(this.rawModel)) return false;
    try {
      const res = await fetch(`${ollamaBase()}/api/tags`, { method: 'GET' });
      if (!res.ok) return false;
      const j = (await res.json()) as { models?: Array<{ name?: string; model?: string }> };
      const names = (j.models ?? []).map((m) => (m.name ?? m.model ?? '').toLowerCase());
      // Available only if the configured (permissive) model is actually pulled.
      const want = this.rawModel.toLowerCase();
      return names.some((n) => n === want || n.startsWith(want.split(':')[0] + ':'));
    } catch {
      return false;
    }
  }

  async check(claim: EntailmentClaim, evidence: EntailmentEvidence): Promise<EntailmentResult> {
    if (BLOCKED_MODEL_RE.test(this.rawModel)) {
      return { verdict: 'unclear', score: 0, model: this.model, checked: false, reason: 'blocked_license_model' };
    }
    const premise = buildPremise(evidence);
    const hypothesis = claim.summary.trim();
    if (!premise || !hypothesis) {
      return { verdict: 'unclear', score: 0, model: this.model, checked: false, reason: 'empty_pair' };
    }
    try {
      const res = await fetch(`${ollamaBase()}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.rawModel,
          prompt: buildPrompt(hypothesis, premise),
          stream: false,
          options: { temperature: 0, num_predict: 6 },
        }),
      });
      const j = (await res.json()) as { response?: string; error?: string };
      if (j.error) {
        return { verdict: 'unclear', score: 0, model: this.model, checked: false, reason: 'ollama_error', raw: j.error.slice(0, 120) };
      }
      const raw = (j.response ?? '').trim();
      const { verdict, score } = parseVerdict(raw);
      return { verdict, score, model: this.model, checked: true, raw: raw.slice(0, 40) };
    } catch (e) {
      return {
        verdict: 'unclear',
        score: 0,
        model: this.model,
        checked: false,
        reason: 'ollama_unreachable',
        raw: e instanceof Error ? e.message.slice(0, 120) : String(e).slice(0, 120),
      };
    }
  }
}

/** Factory used by the gate resolver. */
export function makeOllamaEntailmentBackend(modelId?: string): EntailmentBackend {
  return new OllamaEntailmentBackend(modelId);
}
