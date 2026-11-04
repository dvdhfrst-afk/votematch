/**
 * Offline unit tests for position-write-guards.ts (2026-07-01 audit fixes #2).
 *
 * Two pure guards every scored position WRITE path must run:
 *   (a) ABSENCE GUARD           -- never publish a scored medium/high row whose
 *                                  own notes state it found NO position.
 *   (b) EXTREME-VALUE GUARD     -- an extreme score (<=0.1 or >=0.9) needs >=2
 *                                  DISTINCT corroborating quotes to keep medium/
 *                                  high; else clamp to low.
 *
 * Vitest (the project's runner). No network, no database, no model call.
 */
import { describe, it, expect } from 'vitest';
import {
  hasAbsenceLanguage,
  absenceGuardConfidence,
  isExtremeScore,
  countDistinctQuotes,
  extremeValueGuardConfidence,
  applyWriteGuards,
  ABSENCE_LANGUAGE_PATTERNS,
} from '../position-write-guards';

// ---------------------------------------------------------------------------
// (a) ABSENCE GUARD
// ---------------------------------------------------------------------------

describe('hasAbsenceLanguage', () => {
  it('is false for empty / null / undefined notes (silence is not absence-language)', () => {
    expect(hasAbsenceLanguage('')).toBe(false);
    expect(hasAbsenceLanguage(null)).toBe(false);
    expect(hasAbsenceLanguage(undefined)).toBe(false);
  });

  it('is false for a real stated position with no absence phrasing', () => {
    expect(
      hasAbsenceLanguage(
        "Kingston's issues page states 'A nation without borders is not a sovereign nation' and calls for increased border enforcement.",
      ),
    ).toBe(false);
  });

  it('detects the governing-absence phrasings seen in the live data', () => {
    // Exact phrasings pulled from flagged positions.nuance_notes (audit probe).
    expect(
      hasAbsenceLanguage(
        "The candidate's position on school choice is not explicitly detailed in the provided sources.",
      ),
    ).toBe(true);
    expect(
      hasAbsenceLanguage('There is no explicit mention of opposition to dam removal.'),
    ).toBe(true);
    expect(
      hasAbsenceLanguage(
        'This lack of explicit position makes it difficult to accurately classify his stance.',
      ),
    ).toBe(true);
    expect(
      hasAbsenceLanguage('The source data does not explicitly address gun policy.'),
    ).toBe(true);
    expect(
      hasAbsenceLanguage('It is difficult to ascertain his stance directly.'),
    ).toBe(true);
    expect(hasAbsenceLanguage('Insufficient evidence to place the candidate.')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(hasAbsenceLanguage('NO EXPLICIT MENTION of the topic')).toBe(true);
  });

  it('every pattern in the exported list actually matches itself (list is well-formed)', () => {
    for (const p of ABSENCE_LANGUAGE_PATTERNS) {
      expect(hasAbsenceLanguage(`prefix ${p} suffix`)).toBe(true);
    }
  });
});

describe('absenceGuardConfidence', () => {
  it('forces a medium/high scored row with absence notes down to low', () => {
    expect(absenceGuardConfidence('high', 'no explicit mention of this issue')).toBe('low');
    expect(absenceGuardConfidence('medium', 'does not address transportation')).toBe('low');
  });

  it('leaves a medium/high row with a REAL stated position untouched', () => {
    const note = "Higgins pledges to be 'a strong advocate of our 2nd Amendment rights'.";
    expect(absenceGuardConfidence('high', note)).toBe('high');
    expect(absenceGuardConfidence('medium', note)).toBe('medium');
  });

  it('never touches an already-low or no_data row', () => {
    expect(absenceGuardConfidence('low', 'no explicit mention')).toBe('low');
    expect(absenceGuardConfidence('no_data', 'no explicit mention')).toBe('no_data');
  });
});

// ---------------------------------------------------------------------------
// (b) EXTREME-VALUE GUARD
// ---------------------------------------------------------------------------

describe('isExtremeScore', () => {
  it('flags scores at or beyond the poles', () => {
    expect(isExtremeScore(0.0)).toBe(true);
    expect(isExtremeScore(0.1)).toBe(true);
    expect(isExtremeScore(0.9)).toBe(true);
    expect(isExtremeScore(1.0)).toBe(true);
  });
  it('does not flag mid-axis scores', () => {
    expect(isExtremeScore(0.11)).toBe(false);
    expect(isExtremeScore(0.5)).toBe(false);
    expect(isExtremeScore(0.89)).toBe(false);
  });
  it('is false for null / NaN', () => {
    expect(isExtremeScore(null)).toBe(false);
    expect(isExtremeScore(undefined)).toBe(false);
    expect(isExtremeScore(Number.NaN)).toBe(false);
  });
});

describe('countDistinctQuotes', () => {
  it('counts distinct non-empty quotes', () => {
    expect(countDistinctQuotes(['a', 'b', 'c'])).toBe(3);
  });
  it('dedupes on whitespace/case-normalized text', () => {
    expect(countDistinctQuotes(['Ban all guns', 'ban all guns', '  Ban   all guns  '])).toBe(1);
  });
  it('ignores empty / null / undefined', () => {
    expect(countDistinctQuotes(['', null, undefined, '   ', 'real'])).toBe(1);
  });
});

describe('extremeValueGuardConfidence', () => {
  it('clamps an extreme high score with a single quote to low', () => {
    expect(extremeValueGuardConfidence(0.95, 'high', ['only one quote'])).toBe('low');
  });
  it('clamps an extreme low score with zero quotes to low', () => {
    expect(extremeValueGuardConfidence(0.05, 'medium', [])).toBe('low');
  });
  it('KEEPS an extreme score backed by >=2 distinct quotes', () => {
    expect(
      extremeValueGuardConfidence(0.95, 'high', ['would abolish the agency', 'end it entirely']),
    ).toBe('high');
  });
  it('treats duplicate quotes as a single corroboration (still clamps)', () => {
    expect(
      extremeValueGuardConfidence(0.95, 'high', ['same claim', 'same claim']),
    ).toBe('low');
  });
  it('leaves a non-extreme score untouched regardless of quote count', () => {
    expect(extremeValueGuardConfidence(0.5, 'high', [])).toBe('high');
    expect(extremeValueGuardConfidence(0.7, 'medium', ['one'])).toBe('medium');
  });
  it('never touches an already-low or no_data row', () => {
    expect(extremeValueGuardConfidence(0.95, 'low', [])).toBe('low');
    expect(extremeValueGuardConfidence(0.95, 'no_data', [])).toBe('no_data');
  });
});

// ---------------------------------------------------------------------------
// Combined
// ---------------------------------------------------------------------------

describe('applyWriteGuards', () => {
  it('lowers to low if EITHER guard fires (absence)', () => {
    expect(
      applyWriteGuards({
        score: 0.5,
        confidence: 'high',
        notes: 'no explicit mention',
        quotes: ['a', 'b'],
      }),
    ).toBe('low');
  });

  it('lowers to low if EITHER guard fires (extreme, single quote)', () => {
    expect(
      applyWriteGuards({
        score: 0.95,
        confidence: 'high',
        notes: "supports a hard cap; states 'ban it'",
        quotes: ['ban it'],
      }),
    ).toBe('low');
  });

  it('keeps medium/high when both guards pass (mid-axis, real position)', () => {
    expect(
      applyWriteGuards({
        score: 0.7,
        confidence: 'high',
        notes: "candidate states 'I support expanding access'",
        quotes: ['I support expanding access'],
      }),
    ).toBe('high');
  });

  it('keeps an extreme score with real corroboration and no absence prose', () => {
    expect(
      applyWriteGuards({
        score: 0.95,
        confidence: 'high',
        notes: "candidate pledges to 'abolish the department entirely'",
        quotes: ['abolish the department entirely', 'end it on day one'],
      }),
    ).toBe('high');
  });
});
