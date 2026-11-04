/**
 * Unit tests for shared CF HTML parsers — focused on parseDate locale
 * handling + parseDateTimeWithTZ (council finding #10).
 *
 * Run via: npx tsx --test src/lib/adapters/state-cf/shared/__tests__/html-parsers.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseDate, parseDateTimeWithTZ } from '../html-parsers';

describe('parseDate', () => {
  it('parses ISO yyyy-mm-dd unchanged', () => {
    assert.equal(parseDate('2026-04-25'), '2026-04-25');
    assert.equal(parseDate('2026-4-5'), '2026-04-05');
  });

  it('parses en-US mm/dd/yyyy by default', () => {
    assert.equal(parseDate('04/25/2026'), '2026-04-25');
    assert.equal(parseDate('1/5/26'), '2026-01-05');
  });

  it('parses es-PR dd/mm/yyyy when locale=es-PR', () => {
    // 25/04/2026 in es-PR is April 25, not parse-failure.
    assert.equal(parseDate('25/04/2026', { locale: 'es-PR' }), '2026-04-25');
    // Same digits, different locale → different result.
    assert.equal(parseDate('05/04/2026', { locale: 'es-PR' }), '2026-04-05');
    assert.equal(parseDate('05/04/2026', { locale: 'en-US' }), '2026-05-04');
  });

  it('disambiguates auto when day > 12', () => {
    // 25/04 — 25 can't be a month → must be dd/mm.
    assert.equal(parseDate('25/04/2026', { locale: 'auto' }), '2026-04-25');
  });

  it('disambiguates auto when month-position > 12', () => {
    // 04/25 — second field 25 can't be a day-of-month for that to be dd/mm
    // (it would need 25 as month). Forces mm/dd.
    assert.equal(parseDate('04/25/2026', { locale: 'auto' }), '2026-04-25');
  });

  it('preserves full ISO-8601 timestamps with timezone (council #10)', () => {
    const utc = '2026-04-25T14:30:00Z';
    assert.equal(parseDate(utc), utc);
    const offset = '2026-04-25T14:30:00-04:00';
    assert.equal(parseDate(offset), offset);
    const subSec = '2026-04-25T14:30:00.123Z';
    assert.equal(parseDate(subSec), subSec);
  });

  it('returns null for unparseable input', () => {
    assert.equal(parseDate('not a date'), null);
    assert.equal(parseDate(''), null);
    assert.equal(parseDate(null), null);
    assert.equal(parseDate(undefined), null);
    // Both fields > 12 — unambiguous failure.
    assert.equal(parseDate('13/13/2026', { locale: 'auto' }), null);
  });
});

describe('parseDateTimeWithTZ', () => {
  it('returns ISO with offset for a wall-clock + ianaTz pair', () => {
    // 2026-04-25 14:30 in America/Puerto_Rico (UTC-04, no DST in PR).
    const out = parseDateTimeWithTZ('2026-04-25 14:30:00', 'America/Puerto_Rico');
    assert.equal(out, '2026-04-25T14:30:00-04:00');
  });

  it('handles ISO date+time without offset, attaches offset from TZ', () => {
    const out = parseDateTimeWithTZ('2026-04-25T09:00:00', 'America/Denver');
    // Denver in late April is on MDT (UTC-06).
    assert.equal(out, '2026-04-25T09:00:00-06:00');
  });

  it('passes through input that already has an offset', () => {
    const inp = '2026-04-25T14:30:00-04:00';
    assert.equal(parseDateTimeWithTZ(inp, 'America/New_York'), inp);
  });

  it('parses es-PR localized date+time', () => {
    const out = parseDateTimeWithTZ('25/04/2026 14:30', 'America/Puerto_Rico', {
      locale: 'es-PR',
    });
    assert.equal(out, '2026-04-25T14:30:00-04:00');
  });

  it('returns null on unparseable input', () => {
    assert.equal(parseDateTimeWithTZ('garbage', 'America/Puerto_Rico'), null);
    assert.equal(parseDateTimeWithTZ(null, 'UTC'), null);
  });
});
