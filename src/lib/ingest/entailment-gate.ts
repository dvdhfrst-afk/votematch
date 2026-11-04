/**
 * entailment-gate.ts -- the SEMANTIC entailment / faithfulness gate for Havesay.
 *
 * WHERE THIS SITS
 * ----------------------------------------------------------------------------
 * The existing deterministic gate (gateSignal in extract-signals.ts) verifies a
 * quote LITERALLY EXISTS in the source bytes. That stops a model inventing a
 * quote, but it does NOT stop the far more common failure the 2026 evaluation and
 * the 2026-07 audit both flagged: a REAL quote that does NOT actually SUPPORT the
 * stance the extractor placed on it. Memory
 * (minicheck_entailment_gap_inferred.md): roughly 80-90% of inferred positions
 * fail entailment of their cited quote when checked. That is the gap this module
 * closes: given a stance CLAIM and the QUOTE read IN ITS CONTEXT window, decide
 * supported / not_supported / unclear (abstain-not-guess).
 *
 * DESIGN POSTURE (founder hard rules)
 * ----------------------------------------------------------------------------
 *  - Single TypeScript runtime, no Python. The gate runs an entailment model
 *    IN-PROCESS via a permissively-licensed ONNX / transformers.js checkpoint
 *    (see entailment-backend-onnx.ts), OR via a locally-served Ollama model
 *    (entailment-backend-ollama.ts) when configured. NEVER MiniCheck /
 *    bespoke-minicheck (CC-BY-NC; must not ship). NEVER a metered API.
 *  - FAIL OPEN TO ABSTAIN. A row the gate cannot check (backend unavailable,
 *    model load failure, empty inputs) is NEVER treated as supported. It is
 *    clamped to low confidence and, in enforce mode, held below the medium+
 *    publish bar. Silence never earns trust.
 *  - Context disambiguates. The gate judges the quote inside its window, not the
 *    lone sentence. "This shooting is a tragedy" in context is not a gun stance;
 *    the golden set carries the «»-marked window for exactly this reason.
 *  - Pluggable backend behind a clean interface, so the recommended model can be
 *    swapped without touching the pipeline call sites.
 *
 * MODE (ENTAILMENT_GATE env): 'enforce' | 'shadow' | 'off'. Default 'shadow'.
 *  - shadow (default): run the check, LOG the verdict, but do NOT change any
 *    confidence. Lets us measure agreement + projected block rate before we
 *    enforce.
 *  - enforce: a not_supported / unclear / uncheckable verdict clamps the row's
 *    confidence to 'low' (never medium+), so an unsupported reading cannot be
 *    published as if trustworthy.
 *  - off: no check, no log, no cost (the gate is a pass-through).
 *
 * No em-dashes / en-dashes; acronyms spelled out on first use.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import {
  loadCalibration,
  calibScore,
  scoreToBand,
  _resetCalibrationCache,
  type RoutingBand,
} from './entailment-calibration';

export type { RoutingBand } from './entailment-calibration';

// ===========================================================================
// Public interface
// ===========================================================================

/** The stance being checked, decomposed into the parts a backend may use. */
export interface EntailmentClaim {
  /**
   * The rendered, human-readable stance sentence (the HYPOTHESIS to entail),
   * e.g. "On taxes, the candidate leans toward: Lower taxes, smaller government
   * revenue". This is what the extractor asserts about the candidate. It is the
   * primary input every backend consumes.
   */
  summary: string;
  /**
   * Optional coarse direction label ('low' | 'high' | 'mixed' | a 0..1 string),
   * for backends or logs that want the pole without re-parsing the summary.
   */
  stance?: string | null;
  /** Optional sub_dimension slug (e.g. 'taxes'), for logging + per-issue metrics. */
  subDimension?: string | null;
}

/** The grounding the claim must be entailed by (the PREMISE). */
export interface EntailmentEvidence {
  /** The verbatim quote the reading rests on. Required. */
  quote: string;
  /**
   * The surrounding context window (the passage the quote sits in). When
   * present it is the PREMISE the claim is checked against, because context
   * disambiguates. When absent, the quote alone is the premise (weaker, and the
   * backend may return 'unclear' more often).
   */
  context?: string | null;
}

export type EntailmentVerdict = 'supported' | 'not_supported' | 'unclear';

export interface EntailmentResult {
  /** supported | not_supported | unclear. 'unclear' is the abstain verdict. */
  verdict: EntailmentVerdict;
  /**
   * 0..1 model score for the SUPPORTED / entailment class (calibrated per
   * backend). For a not_supported verdict this is low; for unclear it is in the
   * ambiguous band. On an uncheckable row it is 0 and checked=false.
   */
  score: number;
  /** The backend model id that produced the verdict (e.g. 'onnx:...', 'ollama:...', 'null'). */
  model: string;
  /** False when the backend could not run (fail-open-to-abstain path). */
  checked: boolean;
  /** Optional machine-stable reason (e.g. 'backend_unavailable', 'empty_quote'). */
  reason?: string;
  /** Optional raw label / logits string for the audit log. */
  raw?: string;
  /**
   * Optional full 3-way Natural Language Inference (NLI) distribution the ONNX
   * backend produces. Present only for backends that report it; lets the
   * calibration layer compute richer score scalars without re-running the model.
   */
  scores?: { entail: number; contradict: number; neutral: number } | null;
  /**
   * The three-way ROUTING band, set ONLY when a calibration is active (a
   * calibration file is loaded or ENTAILMENT_SUPPORTED_MIN / ENTAILMENT_NOTSUP_MAX
   * are set). 'voter_visible' | 'candidate_confirm' | 'abstain'. Absent when the
   * gate is running on the hand-tuned defaults (backward compatible).
   */
  band?: RoutingBand;
}

/**
 * A pluggable entailment backend. `check` takes the PREMISE (context or quote)
 * and the HYPOTHESIS (claim summary) and returns a verdict. Implementations MUST
 * be side-effect-free apart from their own model call, and MUST fail into
 * checked=false rather than throwing, so the gate can abstain rather than crash.
 */
export interface EntailmentBackend {
  readonly model: string;
  /** True once the model is loaded / reachable. availability() may lazily load. */
  available(): Promise<boolean>;
  check(claim: EntailmentClaim, evidence: EntailmentEvidence): Promise<EntailmentResult>;
}

// ===========================================================================
// Verdict thresholds (calibrated against the context-aware golden set)
// ===========================================================================

/**
 * Score bands for turning a backend's 0..1 supported-probability into a verdict.
 * These are the TUNING KNOBS the golden set exists to set. Defaults are
 * deliberately conservative (a wide 'unclear' band) so the gate abstains rather
 * than guesses; the measure step (measure-entailment-gate.ts) reports agreement
 * against the draft labels so the operator can move them before enforcing.
 *
 * Precedence (first present wins, per bound):
 *   1. env ENTAILMENT_SUPPORTED_MIN / ENTAILMENT_NOTSUP_MAX (ad-hoc tuning)
 *   2. the calibrated entailment-calibration.json thresholds (upper / lower),
 *      loaded when the file is present (G1 calibration replacing the constants)
 *   3. the hand-tuned defaults 0.60 / 0.40 (backward compatible: no env, no file)
 *
 *   score >= supportedMin => supported (voter-visible)
 *   score <= notSupMax    => not_supported (abstain)
 *   (between the two       => unclear / candidate-confirm)
 *
 * `source` reports which layer set the thresholds; the gate uses it to decide
 * whether to route a checked result through the calibrated bands.
 */
export function verdictThresholds(): {
  supportedMin: number;
  notSupMax: number;
  source: 'env' | 'calibration' | 'default';
} {
  const envSup = process.env.ENTAILMENT_SUPPORTED_MIN;
  const envNot = process.env.ENTAILMENT_NOTSUP_MAX;
  const hasEnv = envSup != null || envNot != null;
  const calib = loadCalibration();
  const supportedMin = clamp01(
    envSup != null ? Number(envSup) : calib ? calib.thresholds.upper : 0.6,
  );
  const notSupMax = clamp01(
    envNot != null ? Number(envNot) : calib ? calib.thresholds.lower : 0.4,
  );
  const source: 'env' | 'calibration' | 'default' = hasEnv ? 'env' : calib ? 'calibration' : 'default';
  return { supportedMin, notSupMax, source };
}

/** Turn a 0..1 supported-probability into a verdict using the current bands. */
export function scoreToVerdict(score: number): EntailmentVerdict {
  const { supportedMin, notSupMax } = verdictThresholds();
  if (score >= supportedMin) return 'supported';
  if (score <= notSupMax) return 'not_supported';
  return 'unclear';
}

/** Map a gate verdict to the three-way routing band (calibration semantics). */
export function verdictToBand(verdict: EntailmentVerdict): RoutingBand {
  if (verdict === 'supported') return 'voter_visible';
  if (verdict === 'not_supported') return 'abstain';
  return 'candidate_confirm';
}

// ===========================================================================
// Mode
// ===========================================================================

export type GateMode = 'enforce' | 'shadow' | 'off';

/** Read ENTAILMENT_GATE from env. Default 'shadow' (measure before enforcing). */
export function gateMode(): GateMode {
  const v = (process.env.ENTAILMENT_GATE ?? 'shadow').trim().toLowerCase();
  if (v === 'enforce' || v === 'off') return v;
  return 'shadow';
}

// ===========================================================================
// The gate: check + confidence application
// ===========================================================================

/**
 * A confidence enum the pipeline uses everywhere ('high' | 'medium' | 'low').
 * The gate never RAISES confidence; it only clamps down on a failed check.
 */
export type ConfidenceEnum = 'high' | 'medium' | 'low';

let _backend: EntailmentBackend | null = null;

/**
 * Resolve the active backend once (memoized). Selection order:
 *   1. ENTAILMENT_BACKEND=ollama  -> the Ollama-served NLI backend.
 *   2. ENTAILMENT_BACKEND=onnx    -> the in-process ONNX / transformers.js backend.
 *   3. (default)                  -> try ONNX first (in-process, no GPU pressure),
 *                                    fall back to Ollama if ONNX is unavailable,
 *                                    else the NullBackend (always abstains).
 * The concrete backends are imported lazily so a run with the gate OFF never
 * loads a model or an optional dependency.
 */
export async function resolveBackend(): Promise<EntailmentBackend> {
  if (_backend) return _backend;
  const choice = (process.env.ENTAILMENT_BACKEND ?? '').trim().toLowerCase();

  const tryOnnx = async (): Promise<EntailmentBackend | null> => {
    try {
      const mod = await import('./entailment-backend-onnx');
      const b = mod.makeOnnxEntailmentBackend();
      if (await b.available()) return b;
    } catch {
      /* optional dependency not installed; fall through */
    }
    return null;
  };
  const tryOllama = async (): Promise<EntailmentBackend | null> => {
    try {
      const mod = await import('./entailment-backend-ollama');
      const b = mod.makeOllamaEntailmentBackend();
      if (await b.available()) return b;
    } catch {
      /* Ollama unreachable; fall through */
    }
    return null;
  };

  let chosen: EntailmentBackend | null = null;
  if (choice === 'ollama') chosen = await tryOllama();
  else if (choice === 'onnx') chosen = await tryOnnx();
  else chosen = (await tryOnnx()) ?? (await tryOllama());

  _backend = chosen ?? new NullBackend();
  return _backend;
}

/** Reset the memoized backend (tests / config reloads). */
export function _resetBackendForTest(b?: EntailmentBackend | null): void {
  _backend = b ?? null;
}

/** Reset the memoized calibration file cache (tests / config reloads). */
export function _resetCalibrationForTest(): void {
  _resetCalibrationCache();
}

/**
 * check(claim, evidence): run the active backend and return a verdict. NEVER
 * throws: any backend failure resolves to an uncheckable abstain result
 * (verdict='unclear', checked=false), so callers get a decision, not an
 * exception. An empty quote is uncheckable by definition.
 */
export async function check(
  claim: EntailmentClaim,
  evidence: EntailmentEvidence,
): Promise<EntailmentResult> {
  const quote = (evidence.quote ?? '').trim();
  if (!quote) {
    return { verdict: 'unclear', score: 0, model: 'none', checked: false, reason: 'empty_quote' };
  }
  if (!(claim.summary ?? '').trim()) {
    return { verdict: 'unclear', score: 0, model: 'none', checked: false, reason: 'empty_claim' };
  }
  let backend: EntailmentBackend;
  try {
    backend = await resolveBackend();
  } catch {
    return { verdict: 'unclear', score: 0, model: 'none', checked: false, reason: 'backend_resolve_failed' };
  }
  try {
    const result = await backend.check(claim, { quote, context: evidence.context ?? null });
    return applyCalibration(result);
  } catch (e) {
    return {
      verdict: 'unclear',
      score: 0,
      model: backend.model,
      checked: false,
      reason: 'backend_threw',
      raw: e instanceof Error ? e.message.slice(0, 120) : String(e).slice(0, 120),
    };
  }
}

/**
 * applyCalibration(result): when a calibration is active (a calibration file is
 * loaded, or the ENTAILMENT_SUPPORTED_MIN / NOTSUP_MAX env vars are set), RE-DERIVE
 * the verdict from the backend's support score using the CALIBRATED thresholds
 * instead of the backend's own hand-tuned mapping, and stamp the routing band.
 *
 * Backward compatible: with no calibration (source === 'default') the backend's
 * own verdict is returned unchanged. An UNCHECKABLE result (checked === false) is
 * never reinterpreted -- silence never becomes support.
 */
function applyCalibration(result: EntailmentResult): EntailmentResult {
  if (!result.checked) return result;
  const { supportedMin, notSupMax, source } = verdictThresholds();
  if (source === 'default') return result;
  const calib = loadCalibration();
  const s = calibScore(result, calib?.score_kind ?? 'entail');
  const thresholds = { upper: supportedMin, lower: notSupMax };
  const band = scoreToBand(s, thresholds);
  const verdict: EntailmentVerdict =
    band === 'voter_visible' ? 'supported' : band === 'abstain' ? 'not_supported' : 'unclear';
  return { ...result, verdict, band };
}

/**
 * applyVerdictToConfidence(current, result, mode): the ONE place the gate is
 * allowed to change a row's confidence. It NEVER raises confidence.
 *
 *   - mode 'off'    : pass-through (confidence unchanged; no clamp).
 *   - mode 'shadow' : pass-through (measure only; caller logs the verdict).
 *   - mode 'enforce':
 *       - verdict 'supported'      : unchanged (the check passed).
 *       - verdict 'not_supported'  : clamp to 'low' (unsupported reading must
 *                                    not publish as medium+).
 *       - verdict 'unclear'        : clamp to 'low' (abstain-not-guess: an
 *                                    ambiguous reading is not trustworthy enough
 *                                    to publish above low).
 *       - uncheckable (checked=false): clamp to 'low' (fail open to abstain).
 *
 * Returns the (possibly clamped) confidence plus whether it changed and why.
 */
export function applyVerdictToConfidence(
  current: ConfidenceEnum,
  result: EntailmentResult,
  mode: GateMode = gateMode(),
): { confidence: ConfidenceEnum; clamped: boolean; reason: string | null } {
  if (mode !== 'enforce') {
    return { confidence: current, clamped: false, reason: null };
  }
  const passes = result.checked && result.verdict === 'supported';
  if (passes) return { confidence: current, clamped: false, reason: null };

  // Any non-supported or uncheckable verdict clamps to low (never below the
  // existing floor, never above it). If it was already low, nothing changes.
  const reason = !result.checked
    ? `uncheckable:${result.reason ?? 'unknown'}`
    : `verdict:${result.verdict}`;
  if (current === 'low') return { confidence: 'low', clamped: false, reason };
  return { confidence: 'low', clamped: true, reason };
}

// ===========================================================================
// Shadow logging (measure-before-enforce)
// ===========================================================================

export interface ShadowLogRow {
  ts: string;
  mode: GateMode;
  model: string;
  sub_dimension?: string | null;
  claim: string;
  quote: string;
  had_context: boolean;
  verdict: EntailmentVerdict;
  score: number;
  checked: boolean;
  reason?: string | null;
  /** The confidence BEFORE the gate, for measuring projected block rate. */
  confidence_in?: ConfidenceEnum | null;
  /** The confidence AFTER the gate (== in for shadow; possibly clamped in enforce). */
  confidence_out?: ConfidenceEnum | null;
  /** Any extra key the caller wants stamped (position_id, signal_id, person_id...). */
  [k: string]: unknown;
}

/** Default shadow-log path: data/entailment-shadow-<date>.jsonl (append-only). */
export function shadowLogPath(dateIso?: string): string {
  const day = (dateIso ?? new Date().toISOString()).slice(0, 10);
  return join(resolve(process.cwd(), 'data'), `entailment-shadow-${day}.jsonl`);
}

/**
 * logShadow(row, path?): append one JSON Lines record to the shadow log. Best
 * effort: a logging failure never affects the pipeline (the gate is advisory in
 * shadow mode). No-op when mode is 'off', and no-op under a test runner
 * (VITEST or NODE_ENV=test) unless the caller passes an explicit path, so test
 * runs never write into the working tree.
 */
export function logShadow(row: ShadowLogRow, path?: string): void {
  if (row.mode === 'off') return;
  if (!path && (process.env.VITEST || process.env.NODE_ENV === 'test')) return;
  try {
    const p = path ?? shadowLogPath(row.ts);
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, JSON.stringify(row) + '\n');
  } catch {
    /* logging is best-effort; never break the pipeline on a log write */
  }
}

/**
 * gateOne(...): the high-level convenience the call sites use. Runs the check
 * (unless mode is 'off'), logs the shadow row, and returns the confidence the
 * caller should store (clamped only in enforce mode). This is the single shared
 * entry point extract-positions-local / promote-signals / research-write call.
 *
 * When mode is 'off' it is a pure pass-through with no model call and no log.
 */
export async function gateOne(args: {
  claim: EntailmentClaim;
  evidence: EntailmentEvidence;
  confidenceIn: ConfidenceEnum;
  /** Extra fields stamped onto the shadow log row (ids for traceability). */
  logExtra?: Record<string, unknown>;
  mode?: GateMode;
  logPath?: string;
}): Promise<{
  result: EntailmentResult;
  confidenceOut: ConfidenceEnum;
  clamped: boolean;
  clampReason: string | null;
}> {
  const mode = args.mode ?? gateMode();
  if (mode === 'off') {
    return {
      result: { verdict: 'supported', score: 1, model: 'off', checked: false, reason: 'gate_off' },
      confidenceOut: args.confidenceIn,
      clamped: false,
      clampReason: null,
    };
  }

  const result = await check(args.claim, args.evidence);
  const applied = applyVerdictToConfidence(args.confidenceIn, result, mode);

  logShadow(
    {
      ts: new Date().toISOString(),
      mode,
      model: result.model,
      sub_dimension: args.claim.subDimension ?? null,
      claim: args.claim.summary,
      quote: args.evidence.quote.slice(0, 400),
      had_context: !!(args.evidence.context && args.evidence.context.trim()),
      verdict: result.verdict,
      score: result.score,
      checked: result.checked,
      reason: result.reason ?? null,
      routing_band: result.band ?? null,
      confidence_in: args.confidenceIn,
      confidence_out: applied.confidence,
      ...(args.logExtra ?? {}),
    },
    args.logPath,
  );

  return {
    result,
    confidenceOut: applied.confidence,
    clamped: applied.clamped,
    clampReason: applied.reason,
  };
}

// ===========================================================================
// Canonical claim renderer (matches the golden seed's renderClaim)
// ===========================================================================

/**
 * renderClaim(issue, score, low, high): build the stance HYPOTHESIS sentence the
 * gate checks, IDENTICAL to scripts/_golden-seed.ts so the gate judges the exact
 * claim the golden set was labeled against. score is the 0..1 axis position; low
 * / high are the sub_dimension's spectrum poles (nullable). This is the single
 * canonical renderer both call sites and the measure script use.
 */
export function renderClaim(
  issue: string,
  score: number,
  low?: string | null,
  high?: string | null,
): string {
  const t = issue.replace(/_/g, ' ');
  const hi = high || `more / stronger action on ${t}`;
  const lo = low || `less / weaker action on ${t}`;
  if (score >= 0.66) return `On ${t}, the candidate leans toward: ${hi}`;
  if (score <= 0.34) return `On ${t}, the candidate leans toward: ${lo}`;
  return `On ${t}, the candidate holds a mixed or moderate position on ${t}.`;
}

// ===========================================================================
// NullBackend: the always-abstain fallback (fail open to abstain)
// ===========================================================================

/**
 * NullBackend: used when NO entailment backend is available (no ONNX model
 * downloaded, Ollama unreachable). It reports available()=true so resolution
 * terminates, but every check returns an UNCHECKABLE abstain (checked=false).
 * In enforce mode that clamps the row to low; in shadow mode it logs that the
 * row could not be checked. This is the concrete fail-open-to-abstain guarantee.
 */
export class NullBackend implements EntailmentBackend {
  readonly model = 'null';
  async available(): Promise<boolean> {
    return true;
  }
  async check(): Promise<EntailmentResult> {
    return {
      verdict: 'unclear',
      score: 0,
      model: this.model,
      checked: false,
      reason: 'no_backend_available',
    };
  }
}

// ===========================================================================
// helpers
// ===========================================================================

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
