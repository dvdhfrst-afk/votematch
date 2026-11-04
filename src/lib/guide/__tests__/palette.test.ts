/**
 * Nonpartisan color-law tests (WAVE-1).
 *
 * The design bundle's #1 hard constraint: match-score visualizations use a
 * single-hue slate-indigo scale and NEVER a red-to-green ramp; red and blue
 * never denote candidates, parties, or agreement. This test makes that rule
 * enforceable in CI so a future edit that reintroduces a green "good match" or
 * red "bad match" fill fails the build.
 */
import { describe, it, expect } from 'vitest';
import {
  SCORE_FILL_HEX,
  CANDIDATE_MARKER_HEX,
  RESTRICTED_ACCENT_HEX,
  hueOf,
  isPartisanHue,
  assertScoreFillsNonpartisan,
} from '../palette';

describe('nonpartisan color law', () => {
  it('every score fill is a non-red, non-green hue', () => {
    for (const [tier, hex] of Object.entries(SCORE_FILL_HEX)) {
      expect(isPartisanHue(hex), `${tier} fill ${hex} must not be red/green`).toBe(false);
    }
  });

  it('score fills all sit in the slate-indigo band (blue-violet hue)', () => {
    // slate-indigo lives roughly 210-260 degrees. Assert the scale is one hue
    // family, not a rainbow ramp.
    for (const [tier, hex] of Object.entries(SCORE_FILL_HEX)) {
      const h = hueOf(hex);
      expect(h, `${tier} fill ${hex} should be chromatic`).not.toBeNull();
      expect(h!, `${tier} fill ${hex} hue ${h} should be slate-indigo`).toBeGreaterThanOrEqual(200);
      expect(h!, `${tier} fill ${hex} hue ${h} should be slate-indigo`).toBeLessThanOrEqual(265);
    }
  });

  it('assertScoreFillsNonpartisan passes for the canonical scale', () => {
    expect(() => assertScoreFillsNonpartisan()).not.toThrow();
  });

  it('assertScoreFillsNonpartisan rejects a red-to-green ramp', () => {
    expect(() =>
      assertScoreFillsNonpartisan({ high: '#1e6b3f', mid: '#c68a1e', low: '#8b2e2e' }),
    ).toThrow(/color law violation/i);
  });

  it('candidate markers are disambiguated by ink, not party color', () => {
    // voter navy outline + candidate near-black ink: neither is a partisan red/green.
    expect(isPartisanHue(CANDIDATE_MARKER_HEX.voterOutline)).toBe(false);
    expect(isPartisanHue(CANDIDATE_MARKER_HEX.candidateInk)).toBe(false);
  });

  it('the restricted accent is a red hue (allowed ONLY for errors/destructive/header)', () => {
    // This documents that red is intentionally reserved — it IS a red hue, and
    // the palette module is the only place that blesses its use.
    expect(isPartisanHue(RESTRICTED_ACCENT_HEX)).toBe(true);
  });
});

describe('hue utilities', () => {
  it('classifies pure red and pure green as partisan', () => {
    expect(isPartisanHue('#ff0000')).toBe(true);
    expect(isPartisanHue('#00ff00')).toBe(true);
  });

  it('treats greys as safe (no hue)', () => {
    expect(hueOf('#808080')).toBeNull();
    expect(isPartisanHue('#fafaf9')).toBe(false);
    expect(isPartisanHue('#0e0d0c')).toBe(false);
  });

  it('returns null for malformed input rather than throwing', () => {
    expect(hueOf('not-a-color')).toBeNull();
    expect(hueOf('var(--score-high-bar)')).toBeNull();
  });
});
