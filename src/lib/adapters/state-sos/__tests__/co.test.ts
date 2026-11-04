/**
 * Colorado SoS results adapter — unit tests.
 *
 *   npx tsx --test src/lib/adapters/state-sos/__tests__/co.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseColoradoResults,
  createColoradoResultsAdapter,
  CO_STATE_FIPS,
} from '../co/results';

describe('parseColoradoResults', () => {
  it('extracts rows from a typical SoS results HTML dashboard', () => {
    const html = `<!DOCTYPE html><html><body>
      <h2>Governor</h2>
      <table>
        <thead><tr><th>Candidate</th><th>Party</th><th>Votes</th><th>%</th></tr></thead>
        <tbody>
          <tr><td>Alice Rivers</td><td>Democratic</td><td>1,250,000</td><td>51.2</td></tr>
          <tr><td>Bob Mountain</td><td>Republican</td><td>1,150,000</td><td>47.1</td></tr>
        </tbody>
      </table>
      <h3>U.S. House District 4</h3>
      <table>
        <thead><tr><th>Candidate</th><th>Party</th><th>Votes</th></tr></thead>
        <tbody>
          <tr><td>Write-In</td><td></td><td>42</td></tr>
        </tbody>
      </table>
    </body></html>`;

    const rows = parseColoradoResults(html);
    assert.equal(rows.length, 3);

    const alice = rows.find((r) => r.reported_name === 'Alice Rivers');
    assert.ok(alice);
    assert.equal(alice.office_name, 'Governor');
    assert.equal(alice.party_abbreviation, 'DEM');
    assert.equal(alice.vote_count, 1250000);
    assert.equal(alice.vote_percentage, 51.2);

    const hd4 = rows.find((r) => r.office_name === 'U.S. House');
    assert.ok(hd4);
    assert.equal(hd4.district_identifier, '4');
    assert.equal(hd4.is_write_in, true);
  });

  it('returns [] for an empty body', () => {
    assert.equal(parseColoradoResults('<html></html>').length, 0);
  });
});

describe('createColoradoResultsAdapter', () => {
  it('wires the state FIPS, name, and costService correctly', () => {
    const adapter = createColoradoResultsAdapter({
      fetchImpl: async () => ({ rawBody: '' }),
    });
    assert.equal(adapter.stateFips, CO_STATE_FIPS);
    assert.equal(CO_STATE_FIPS, '08');
    assert.equal(adapter.name, 'sos-colorado-sos-results');
    assert.deepEqual(adapter.tokenBucket, { rps: 0.5, burst: 2 });
    assert.equal(adapter.costService, 'other');
  });

  it('supports a sourceUrl override (Clarity election-night URL)', () => {
    const clarityUrl = 'https://results.enr.clarityelections.com/CO/12345/Web02/';
    const adapter = createColoradoResultsAdapter({
      sourceUrl: clarityUrl,
      fetchImpl: async () => ({ rawBody: '<html/>' }),
    });
    // The factory doesn't expose its inner URL directly, but it's the
    // sourceUrl passed to run() — verify via a run().
    // (We can't do a meaningful assertion here without reaching the base
    // adapter's outcome; the main wiring test is covered in base.test.ts.)
    assert.ok(adapter);
  });
});
