/**
 * Unit tests for the Rhode Island results adapter (JSON hot path).
 *
 * Run:
 *   npx tsx --test src/lib/adapters/state-sos/ri/__tests__/results.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseRiJson } from '../results';

describe('RI results — parseRiJson', () => {
  it('parses the vote.sos.ri.gov internal JSON into StateResultRow[]', () => {
    const fixture = {
      election: { id: 'p-2026', date: '2026-09-09' },
      contests: [
        {
          office: 'U.S. Senator',
          district: 'STATEWIDE',
          pctReporting: 99.5,
          candidates: [
            {
              name: 'Jane Smith',
              party: 'DEM',
              votes: 250000,
              pct: 55.5,
              isWinner: true,
              isWriteIn: false,
            },
            {
              name: 'Bob Jones',
              party: 'REP',
              votes: 180000,
              pct: 40.0,
              isWinner: false,
              isWriteIn: false,
            },
            {
              name: 'Write-In',
              party: null,
              votes: 50,
              pct: 0.0,
              isWinner: false,
              isWriteIn: true,
            },
          ],
        },
        {
          office: 'State Representative',
          district: '12',
          pctReporting: 100.0,
          candidates: [
            {
              name: 'Alice Wong',
              party: 'DEM',
              votes: 5000,
              pct: 100.0,
              isWinner: true,
            },
          ],
        },
      ],
    };

    const rows = parseRiJson(fixture, 'unofficial_complete');
    assert.equal(rows.length, 4, `expected 4 rows, got ${rows.length}`);

    const smith = rows.find((r) => r.reported_name === 'Jane Smith');
    assert.ok(smith);
    assert.equal(smith.office_name, 'U.S. Senator');
    // STATEWIDE district should collapse to null since it's not an actual number.
    assert.equal(smith.district_identifier, null);
    assert.equal(smith.vote_count, 250000);
    assert.equal(smith.vote_percentage, 55.5);
    assert.equal(smith.pct_precincts_reporting, 99.5);
    assert.equal(smith.is_winner, true);
    assert.equal(smith.party_abbreviation, 'DEM');
    assert.equal(smith.reporting_level, 'unofficial_complete');

    const writeIn = rows.find((r) => r.is_write_in);
    assert.ok(writeIn);
    assert.equal(writeIn.vote_count, 50);

    const alice = rows.find((r) => r.reported_name === 'Alice Wong');
    assert.ok(alice);
    assert.equal(alice.district_identifier, '12');
  });

  it('handles empty / unknown shapes gracefully', () => {
    assert.deepEqual(parseRiJson({}, 'unofficial_partial'), []);
    assert.deepEqual(parseRiJson([], 'unofficial_partial'), []);
    assert.deepEqual(
      parseRiJson({ contests: [{ office: '' }] }, 'unofficial_partial'),
      [],
    );
  });
});
