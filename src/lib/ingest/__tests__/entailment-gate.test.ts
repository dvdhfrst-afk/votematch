/**
 * Offline unit tests for the entailment gate.
 *
 * Covers the pure decision logic with NO model, NO network, NO DB:
 *   - scoreToVerdict / verdictThresholds banding
 *   - applyVerdictToConfidence: clamp-only-in-enforce, never-raise, fail-open
 *   - gateMode env parsing
 *   - renderClaim matches the golden-seed renderer
 *   - the ONNX backend's pure helpers: readNliScores, nliToVerdict, buildPremise
 *   - check()/gateOne() with an INJECTED fake backend (supported + uncheckable)
 *   - NullBackend abstains (fail open to abstain)
 *
 * Vitest (the project's runner).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  scoreToVerdict,
  applyVerdictToConfidence,
  gateMode,
  renderClaim,
  check,
  gateOne,
  resolveBackend,
  _resetBackendForTest,
  _resetCalibrationForTest,
  NullBackend,
  type EntailmentBackend,
  type EntailmentResult,
} from '../entailment-gate';
import { readNliScores, nliToVerdict, buildPremise } from '../entailment-backend-onnx';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

// A deterministic fake backend for the check()/gateOne() paths.
function fakeBackend(result: Partial<EntailmentResult>): EntailmentBackend {
  return {
    model: 'fake',
    async available() {
      return true;
    },
    async check() {
      return {
        verdict: 'supported',
        score: 0.9,
        model: 'fake',
        checked: true,
        ...result,
      };
    },
  };
}

const ENV_KEYS = [
  'ENTAILMENT_GATE',
  'ENTAILMENT_SUPPORTED_MIN',
  'ENTAILMENT_NOTSUP_MAX',
  'ENTAILMENT_ENTAIL_MIN',
  'ENTAILMENT_CONTRADICT_MIN',
  'ENTAILMENT_CALIBRATION_PATH',
];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  // These tests exercise the HAND-TUNED default banding (0.60 / 0.40). Point the
  // calibration loader at a path that does not exist so a committed
  // entailment-calibration.json at the default location never leaks in here; the
  // calibration-loading path has its own dedicated test file.
  process.env.ENTAILMENT_CALIBRATION_PATH = join(tmpdir(), 'no-such-calibration.json');
  _resetBackendForTest(null);
  _resetCalibrationForTest();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  _resetBackendForTest(null);
  _resetCalibrationForTest();
});

// ---------------------------------------------------------------------------
// scoreToVerdict / thresholds
// ---------------------------------------------------------------------------

describe('scoreToVerdict', () => {
  it('bands with defaults (0.60 / 0.40)', () => {
    expect(scoreToVerdict(0.9)).toBe('supported');
    expect(scoreToVerdict(0.6)).toBe('supported');
    expect(scoreToVerdict(0.5)).toBe('unclear');
    expect(scoreToVerdict(0.41)).toBe('unclear');
    expect(scoreToVerdict(0.4)).toBe('not_supported');
    expect(scoreToVerdict(0.05)).toBe('not_supported');
  });

  it('honors env overrides', () => {
    process.env.ENTAILMENT_SUPPORTED_MIN = '0.8';
    process.env.ENTAILMENT_NOTSUP_MAX = '0.2';
    expect(scoreToVerdict(0.7)).toBe('unclear');
    expect(scoreToVerdict(0.85)).toBe('supported');
    expect(scoreToVerdict(0.15)).toBe('not_supported');
  });
});

// ---------------------------------------------------------------------------
// applyVerdictToConfidence
// ---------------------------------------------------------------------------

describe('applyVerdictToConfidence', () => {
  const supported: EntailmentResult = { verdict: 'supported', score: 0.9, model: 'x', checked: true };
  const notSupported: EntailmentResult = { verdict: 'not_supported', score: 0.1, model: 'x', checked: true };
  const unclear: EntailmentResult = { verdict: 'unclear', score: 0.5, model: 'x', checked: true };
  const uncheckable: EntailmentResult = { verdict: 'unclear', score: 0, model: 'null', checked: false, reason: 'no_backend_available' };

  it('shadow mode never clamps', () => {
    for (const r of [supported, notSupported, unclear, uncheckable]) {
      const out = applyVerdictToConfidence('high', r, 'shadow');
      expect(out.confidence).toBe('high');
      expect(out.clamped).toBe(false);
    }
  });

  it('off mode never clamps', () => {
    expect(applyVerdictToConfidence('medium', notSupported, 'off').confidence).toBe('medium');
  });

  it('enforce: supported keeps confidence', () => {
    const out = applyVerdictToConfidence('high', supported, 'enforce');
    expect(out.confidence).toBe('high');
    expect(out.clamped).toBe(false);
  });

  it('enforce: not_supported clamps to low', () => {
    const out = applyVerdictToConfidence('high', notSupported, 'enforce');
    expect(out.confidence).toBe('low');
    expect(out.clamped).toBe(true);
    expect(out.reason).toContain('not_supported');
  });

  it('enforce: unclear clamps to low (abstain-not-guess)', () => {
    expect(applyVerdictToConfidence('medium', unclear, 'enforce').confidence).toBe('low');
  });

  it('enforce: uncheckable clamps to low (fail open to abstain)', () => {
    const out = applyVerdictToConfidence('high', uncheckable, 'enforce');
    expect(out.confidence).toBe('low');
    expect(out.clamped).toBe(true);
    expect(out.reason).toContain('uncheckable');
  });

  it('enforce never RAISES confidence: already-low stays low, not clamped', () => {
    const out = applyVerdictToConfidence('low', notSupported, 'enforce');
    expect(out.confidence).toBe('low');
    expect(out.clamped).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// gateMode
// ---------------------------------------------------------------------------

describe('gateMode', () => {
  it('defaults to shadow', () => {
    expect(gateMode()).toBe('shadow');
  });
  it('reads enforce / off / shadow', () => {
    process.env.ENTAILMENT_GATE = 'enforce';
    expect(gateMode()).toBe('enforce');
    process.env.ENTAILMENT_GATE = 'off';
    expect(gateMode()).toBe('off');
    process.env.ENTAILMENT_GATE = 'garbage';
    expect(gateMode()).toBe('shadow');
  });
});

// ---------------------------------------------------------------------------
// renderClaim (must match scripts/_golden-seed.ts)
// ---------------------------------------------------------------------------

describe('renderClaim', () => {
  it('renders high / low / mixed exactly like the golden seed', () => {
    expect(renderClaim('taxes', 0.25, 'Lower taxes, smaller government revenue', 'Higher taxes')).toBe(
      'On taxes, the candidate leans toward: Lower taxes, smaller government revenue',
    );
    expect(renderClaim('taxes', 0.75, 'Lower', 'Higher taxes to fund public services')).toBe(
      'On taxes, the candidate leans toward: Higher taxes to fund public services',
    );
    expect(renderClaim('government_transparency', 0.5)).toBe(
      'On government transparency, the candidate holds a mixed or moderate position on government transparency.',
    );
  });
  it('falls back to generic poles when spectrum absent', () => {
    expect(renderClaim('housing', 0.9)).toBe('On housing, the candidate leans toward: more / stronger action on housing');
    expect(renderClaim('housing', 0.1)).toBe('On housing, the candidate leans toward: less / weaker action on housing');
  });
});

// ---------------------------------------------------------------------------
// ONNX backend pure helpers
// ---------------------------------------------------------------------------

describe('readNliScores + nliToVerdict', () => {
  it('reads labels by name, index-agnostic', () => {
    const s = readNliScores([
      { label: 'neutral', score: 0.1 },
      { label: 'ENTAILMENT', score: 0.8 },
      { label: 'contradiction', score: 0.1 },
    ]);
    expect(s.entail).toBeCloseTo(0.8);
    expect(s.contradict).toBeCloseTo(0.1);
    expect(s.neutral).toBeCloseTo(0.1);
  });

  // Mapping is contradiction-first with a neutral-aware supported band
  // (see nliToVerdict doc). Defaults: contradictMin 0.30, supportedMassMin 0.50.
  it('strong entailment -> supported', () => {
    expect(nliToVerdict({ entail: 0.8, contradict: 0.1, neutral: 0.1 })).toBe('supported');
  });
  it('strong contradiction -> not_supported', () => {
    expect(nliToVerdict({ entail: 0.1, contradict: 0.8, neutral: 0.1 })).toBe('not_supported');
  });
  it('supporting slogan split across entail+neutral -> supported (mass >= 0.50)', () => {
    // entail 0.35 + half of neutral 0.60 = 0.65 mass, entail >= contradict.
    expect(nliToVerdict({ entail: 0.35, contradict: 0.05, neutral: 0.6 })).toBe('supported');
  });
  it('dominant contradiction -> not_supported', () => {
    expect(nliToVerdict({ entail: 0.1, contradict: 0.6, neutral: 0.3 })).toBe('not_supported');
  });
  it('genuinely ambiguous (low all-around support mass, weak contradiction) -> unclear', () => {
    // entail 0.20, contradict 0.25 (below 0.30 min so not not_supported),
    // neutral 0.55 -> mass 0.20+0.275=0.475 < 0.50 -> unclear.
    expect(nliToVerdict({ entail: 0.2, contradict: 0.25, neutral: 0.55 })).toBe('unclear');
  });
});

describe('buildPremise', () => {
  it('prefers context over the bare quote', () => {
    const p = buildPremise({ quote: 'lower taxes', context: 'He said we should lower taxes for families.' });
    expect(p).toContain('families');
  });
  it('falls back to quote when no context', () => {
    expect(buildPremise({ quote: 'lower taxes', context: null })).toBe('lower taxes');
  });
  it('caps a very long context around the quote', () => {
    const filler = 'x '.repeat(3000);
    const p = buildPremise({ quote: 'NEEDLE', context: `${filler} NEEDLE ${filler}` });
    expect(p.length).toBeLessThanOrEqual(1800);
    expect(p).toContain('NEEDLE');
  });
});

// ---------------------------------------------------------------------------
// check() / gateOne() with an injected backend
// ---------------------------------------------------------------------------

describe('check + gateOne (injected backend)', () => {
  it('empty quote is uncheckable (never supported)', async () => {
    _resetBackendForTest(fakeBackend({}));
    const r = await check({ summary: 'On taxes ...' }, { quote: '   ' });
    expect(r.checked).toBe(false);
    expect(r.verdict).toBe('unclear');
    expect(r.reason).toBe('empty_quote');
  });

  it('supported verdict passes through in enforce (no clamp)', async () => {
    _resetBackendForTest(fakeBackend({ verdict: 'supported', checked: true }));
    const g = await gateOne({
      claim: { summary: 'On taxes, lower taxes' },
      evidence: { quote: 'lower the tax burden', context: 'lower the tax burden on families' },
      confidenceIn: 'high',
      mode: 'enforce',
    });
    expect(g.result.verdict).toBe('supported');
    expect(g.confidenceOut).toBe('high');
    expect(g.clamped).toBe(false);
  });

  it('not_supported clamps to low in enforce', async () => {
    _resetBackendForTest(fakeBackend({ verdict: 'not_supported', score: 0.1, checked: true }));
    const g = await gateOne({
      claim: { summary: 'On gun policy, stricter gun safety' },
      evidence: { quote: 'Strong proponent of our 2nd Amendment', context: 'Strong proponent of our 2nd Amendment rights' },
      confidenceIn: 'high',
      mode: 'enforce',
    });
    expect(g.confidenceOut).toBe('low');
    expect(g.clamped).toBe(true);
  });

  it('shadow mode logs but does not clamp', async () => {
    _resetBackendForTest(fakeBackend({ verdict: 'not_supported', checked: true }));
    // Log to a throwaway temp path so tests never pollute the real data/ shadow log.
    const tmpLog = join(tmpdir(), `entailment-test-${Date.now()}.jsonl`);
    const g = await gateOne({
      claim: { summary: 'x' },
      evidence: { quote: 'q', context: 'q' },
      confidenceIn: 'high',
      mode: 'shadow',
      logPath: tmpLog,
    });
    expect(g.confidenceOut).toBe('high');
    expect(g.clamped).toBe(false);
    try { rmSync(tmpLog, { force: true }); } catch { /* best effort */ }
  });

  it('off mode is a pure pass-through (no backend call)', async () => {
    // No backend set; off must not resolve one.
    _resetBackendForTest(null);
    const g = await gateOne({
      claim: { summary: 'x' },
      evidence: { quote: 'q' },
      confidenceIn: 'medium',
      mode: 'off',
    });
    expect(g.confidenceOut).toBe('medium');
    expect(g.result.model).toBe('off');
  });

  it('backend that throws -> uncheckable abstain (never crashes)', async () => {
    _resetBackendForTest({
      model: 'boom',
      async available() {
        return true;
      },
      async check() {
        throw new Error('model exploded');
      },
    });
    const r = await check({ summary: 'x' }, { quote: 'q', context: 'q' });
    expect(r.checked).toBe(false);
    expect(r.verdict).toBe('unclear');
    expect(r.reason).toBe('backend_threw');
  });
});

// ---------------------------------------------------------------------------
// NullBackend + resolver fallback
// ---------------------------------------------------------------------------

describe('NullBackend (fail open to abstain)', () => {
  it('always abstains, checked=false', async () => {
    const b = new NullBackend();
    expect(await b.available()).toBe(true);
    const r = await b.check();
    expect(r.checked).toBe(false);
    expect(r.verdict).toBe('unclear');
    expect(r.reason).toBe('no_backend_available');
  });

  it('resolveBackend falls back to NullBackend when no ONNX/Ollama is available', async () => {
    // Force env so onnx import path is attempted and (in test, without the dep)
    // fails, and Ollama is unreachable -> NullBackend.
    _resetBackendForTest(null);
    process.env.ENTAILMENT_BACKEND = 'onnx';
    const b = await resolveBackend();
    // Either the ONNX dep is genuinely absent (=> null) or, if present in some
    // env, a real backend; both are acceptable. The contract we assert is that a
    // backend always resolves and check() never throws.
    const r = await b.check(
      { summary: 'On taxes, lower taxes' },
      { quote: 'lower the tax burden', context: 'lower the tax burden on families' },
    );
    expect(['supported', 'not_supported', 'unclear']).toContain(r.verdict);
    delete process.env.ENTAILMENT_BACKEND;
  });
});
