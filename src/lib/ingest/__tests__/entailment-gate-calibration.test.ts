/**
 * Offline unit tests for the GATE's calibration-loading path.
 *
 * Verifies the gate consumes entailment-calibration.json (via
 * ENTAILMENT_CALIBRATION_PATH) instead of the hand-tuned constants, in both the
 * pure threshold accessor and the check() routing, while staying backward
 * compatible when no calibration is present. No model / network / DB: an injected
 * fake backend supplies the score.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  verdictThresholds,
  check,
  _resetBackendForTest,
  _resetCalibrationForTest,
  type EntailmentBackend,
  type EntailmentResult,
} from '../entailment-gate';

const NO_FILE = join(tmpdir(), 'no-such-calibration-gate.json');
const ENV_KEYS = ['ENTAILMENT_SUPPORTED_MIN', 'ENTAILMENT_NOTSUP_MAX', 'ENTAILMENT_CALIBRATION_PATH'];
let saved: Record<string, string | undefined>;
const tmpFiles: string[] = [];

function fakeBackend(result: Partial<EntailmentResult>): EntailmentBackend {
  return {
    model: 'fake',
    async available() {
      return true;
    },
    async check() {
      return { verdict: 'unclear', score: 0.5, model: 'fake', checked: true, ...result };
    },
  };
}

/** Write a calibration fixture and point the loader at it. */
function useCalibration(upper: number, lower: number, score_kind = 'entail'): void {
  const p = join(tmpdir(), `calib-gate-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  tmpFiles.push(p);
  writeFileSync(p, JSON.stringify({ thresholds: { upper, lower }, score_kind, backend_model: 'onnx:test' }));
  process.env.ENTAILMENT_CALIBRATION_PATH = p;
  _resetCalibrationForTest();
}

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.ENTAILMENT_CALIBRATION_PATH = NO_FILE; // default: no calibration
  _resetBackendForTest(null);
  _resetCalibrationForTest();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  for (const p of tmpFiles) {
    try {
      rmSync(p, { force: true });
    } catch {
      /* best effort */
    }
  }
  tmpFiles.length = 0;
  _resetBackendForTest(null);
  _resetCalibrationForTest();
});

// ---------------------------------------------------------------------------
// verdictThresholds precedence
// ---------------------------------------------------------------------------
describe('verdictThresholds precedence', () => {
  it('defaults to 0.60 / 0.40 when neither env nor file is present', () => {
    const t = verdictThresholds();
    expect(t.supportedMin).toBeCloseTo(0.6, 6);
    expect(t.notSupMax).toBeCloseTo(0.4, 6);
    expect(t.source).toBe('default');
  });

  it('uses the calibration file when present', () => {
    useCalibration(0.85, 0.2);
    const t = verdictThresholds();
    expect(t.supportedMin).toBeCloseTo(0.85, 6);
    expect(t.notSupMax).toBeCloseTo(0.2, 6);
    expect(t.source).toBe('calibration');
  });

  it('env overrides the calibration file', () => {
    useCalibration(0.85, 0.2);
    process.env.ENTAILMENT_SUPPORTED_MIN = '0.7';
    process.env.ENTAILMENT_NOTSUP_MAX = '0.3';
    const t = verdictThresholds();
    expect(t.supportedMin).toBeCloseTo(0.7, 6);
    expect(t.notSupMax).toBeCloseTo(0.3, 6);
    expect(t.source).toBe('env');
  });
});

// ---------------------------------------------------------------------------
// check() applies the calibrated routing
// ---------------------------------------------------------------------------
describe('check() with a loaded calibration', () => {
  it('routes a high score to voter_visible / supported', async () => {
    useCalibration(0.9, 0.5);
    _resetBackendForTest(fakeBackend({ score: 0.95, verdict: 'unclear', checked: true }));
    const r = await check({ summary: 'On taxes, lower taxes' }, { quote: 'lower taxes', context: 'we should lower taxes' });
    expect(r.verdict).toBe('supported');
    expect(r.band).toBe('voter_visible');
  });

  it('routes a mid score to candidate_confirm / unclear', async () => {
    useCalibration(0.9, 0.5);
    _resetBackendForTest(fakeBackend({ score: 0.7, verdict: 'supported', checked: true }));
    const r = await check({ summary: 'x' }, { quote: 'q', context: 'q' });
    expect(r.verdict).toBe('unclear');
    expect(r.band).toBe('candidate_confirm');
  });

  it('routes a low score to abstain / not_supported', async () => {
    useCalibration(0.9, 0.5);
    _resetBackendForTest(fakeBackend({ score: 0.3, verdict: 'supported', checked: true }));
    const r = await check({ summary: 'x' }, { quote: 'q', context: 'q' });
    expect(r.verdict).toBe('not_supported');
    expect(r.band).toBe('abstain');
  });

  it('does NOT reinterpret an uncheckable result (silence never becomes support)', async () => {
    useCalibration(0.9, 0.5);
    _resetBackendForTest(fakeBackend({ score: 0, verdict: 'unclear', checked: false, reason: 'no_backend_available' }));
    const r = await check({ summary: 'x' }, { quote: 'q', context: 'q' });
    expect(r.checked).toBe(false);
    expect(r.verdict).toBe('unclear');
    expect(r.band).toBeUndefined();
  });

  it('backward compatible: with no calibration the backend verdict is untouched', async () => {
    // NO_FILE is set in beforeEach -> source 'default' -> no override.
    _resetBackendForTest(fakeBackend({ score: 0.95, verdict: 'not_supported', checked: true }));
    const r = await check({ summary: 'x' }, { quote: 'q', context: 'q' });
    expect(r.verdict).toBe('not_supported'); // preserved despite a high score
    expect(r.band).toBeUndefined();
  });
});
