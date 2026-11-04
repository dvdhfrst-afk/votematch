/**
 * Unit tests for the Michigan results adapter.
 *
 * Exercises both parser paths — MiTN JSON shape and fallback HTML table
 * scrape. No network.
 *
 * Run:
 *   npx tsx --test src/lib/adapters/state-sos/mi/__tests__/results.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createMiResultsAdapter,
  parseMiJson,
  parseMiHtml,
} from '../results';

const MITN_JSON_FIXTURE = {
  contests: [
    {
      name: 'Governor',
      district: null,
      percent_reporting: 87.5,
      candidates: [
        {
          name: 'Jane Smith',
          party: 'DEM',
          votes: 555000,
          percent: 51.2,
          winner: true,
        },
        {
          name: 'Bob Jones',
          party: 'REP',
          votes: 500000,
          percent: 46.1,
          winner: false,
        },
      ],
    },
    {
      name: 'U.S. House of Representatives',
      district: '7',
      percent_reporting: 92.3,
      candidates: [
        {
          name: 'Alice Wong',
          party: 'DEM',
          votes: 200000,
          percent: 55.0,
        },
        {
          name: 'Write-In',
          party: null,
          votes: 10,
          write_in: true,
        },
      ],
    },
  ],
};

const HTML_WITH_TABLE = `<!doctype html>
<html>
<body>
  <h3>Governor</h3>
  <table>
    <tr><th>Candidate</th><th>Party</th><th>Votes</th><th>%</th></tr>
    <tr><td>Jane Smith</td><td>DEM</td><td>100,000</td><td>52%</td></tr>
    <tr><td>Bob Jones</td><td>REP</td><td>90,000</td><td>47%</td></tr>
  </table>
</body>
</html>`;

describe('MI results — parseMiJson', () => {
  it('parses a MiTN-style election-night JSON into populated rows', () => {
    const rows = parseMiJson(MITN_JSON_FIXTURE, 'unofficial_partial');
    // 2 governor candidates + 2 US House candidates = 4
    assert.equal(rows.length, 4);

    const smith = rows.find((r) => r.reported_name === 'Jane Smith');
    assert.ok(smith);
    assert.equal(smith.party_abbreviation, 'DEM');
    assert.equal(smith.vote_count, 555000);
    assert.equal(smith.vote_percentage, 51.2);
    assert.equal(smith.is_winner, true);
    assert.equal(smith.pct_precincts_reporting, 87.5);
    assert.equal(smith.office_name, 'Governor');

    const alice = rows.find((r) => r.reported_name === 'Alice Wong');
    assert.ok(alice);
    assert.equal(alice.office_name, 'U.S. House of Representatives');
    assert.equal(alice.district_identifier, '7');

    const write = rows.find((r) => r.is_write_in);
    assert.ok(write, 'write-in row detected');
    assert.equal(write.vote_count, 10);
  });

  it('tolerates flat-array fixture shape (older dashboard)', () => {
    const flat = MITN_JSON_FIXTURE.contests;
    const rows = parseMiJson(flat, 'unofficial_partial');
    assert.equal(rows.length, 4);
  });

  it('returns [] on unknown JSON shape', () => {
    assert.equal(parseMiJson({ foo: 'bar' }, 'unofficial_partial').length, 0);
    assert.equal(parseMiJson(null, 'unofficial_partial').length, 0);
  });
});

describe('MI results — parseMiHtml', () => {
  it('parses an HTML table into populated rows', () => {
    const rows = parseMiHtml(HTML_WITH_TABLE, 'unofficial_partial');
    assert.equal(rows.length, 2);

    const smith = rows[0];
    assert.equal(smith.reported_name, 'Jane Smith');
    assert.equal(smith.party_abbreviation, 'DEM');
    assert.equal(smith.vote_count, 100000);
    assert.equal(smith.vote_percentage, 52);
    assert.equal(smith.office_name, 'Governor');
  });

  it('returns [] for body without result tables', () => {
    const rows = parseMiHtml('<html><body>empty</body></html>', 'unofficial_partial');
    assert.equal(rows.length, 0);
  });
});

describe('MI results — adapter composition', () => {
  it('declares the right FIPS, tokenBucket, costService, name', () => {
    const adapter = createMiResultsAdapter();
    assert.equal(adapter.stateFips, '26');
    assert.deepEqual(adapter.tokenBucket, { rps: 0.5, burst: 2 });
    assert.equal(adapter.costService, 'other');
    assert.equal(adapter.name, 'sos-michigan-sos-results');
  });
});
