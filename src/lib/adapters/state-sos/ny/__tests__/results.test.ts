/**
 * Unit tests for the New York results adapter (CSV hot path).
 *
 * Run:
 *   npx tsx --test src/lib/adapters/state-sos/ny/__tests__/results.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseNyCsv, discoverNyResultLinks } from '../results';

describe('NY results — parseNyCsv', () => {
  it('parses a canonical canvass CSV into rows', () => {
    const csv =
      'OfficeName,DistrictNumber,CandidateName,PartyName,VoteTotal\n' +
      'Governor,,Jane Smith,DEM,3500000\n' +
      'Governor,,Bob Jones,REP,3000000\n' +
      '"U.S. House",1,Alice Wong,DEM,210000\n' +
      '"U.S. House",1,"Write-In",,42\n';
    const rows = parseNyCsv(csv, 'unofficial_partial');
    assert.equal(rows.length, 4, `expected 4 rows got ${rows.length}`);

    const smith = rows.find((r) => r.reported_name === 'Jane Smith');
    assert.ok(smith);
    assert.equal(smith.office_name, 'Governor');
    assert.equal(smith.vote_count, 3500000);
    assert.equal(smith.party_abbreviation, 'DEM');

    const alice = rows.find((r) => r.reported_name === 'Alice Wong');
    assert.ok(alice);
    assert.equal(alice.district_identifier, '1');
    assert.equal(alice.office_name, 'U.S. House');

    const writeIn = rows.find((r) => r.is_write_in);
    assert.ok(writeIn, 'write-in row should be flagged');
    assert.equal(writeIn.vote_count, 42);
  });

  it('returns empty for malformed or unknown shape', () => {
    assert.deepEqual(parseNyCsv('', 'unofficial_partial'), []);
    assert.deepEqual(parseNyCsv('just,one,row', 'unofficial_partial'), []);
  });
});

describe('NY results — discoverNyResultLinks', () => {
  it('finds anchor hrefs matching result keywords', () => {
    const html = `
      <html><body>
        <a href="/results-2026">2026 Election Results</a>
        <a href="/certified.pdf">Certified</a>
        <a href="https://example.com/data.csv">Raw CSV</a>
        <a href="/unrelated">About Us</a>
      </body></html>
    `;
    const links = discoverNyResultLinks(html);
    assert.ok(links.length >= 3, `expected 3+ links, got ${links.length}`);
    assert.ok(links.some((l) => l.endsWith('.csv')));
    assert.ok(links.some((l) => l.endsWith('.pdf')));
  });
});
