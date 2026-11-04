/**
 * Unit tests for the Indiana results adapter.
 *
 * Drives parseIndianaHtml() + discoverInResultLinks() with synthetic HTML
 * fixtures. No network.
 *
 * Run:
 *   npx tsx --test src/lib/adapters/state-sos/in/__tests__/results.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createInResultsAdapter,
  parseIndianaHtml,
  discoverInResultLinks,
} from '../results';

const HTML_WITH_TABLE = `<!doctype html>
<html>
<body>
  <h2>Governor</h2>
  <table>
    <tr><th>Candidate</th><th>Party</th><th>Votes</th><th>Percent</th></tr>
    <tr><td>Jane Smith</td><td>DEM</td><td>123,456</td><td>53.4%</td></tr>
    <tr><td>Bob Jones</td><td>REP</td><td>100,000</td><td>43.2%</td></tr>
    <tr><td>Write-In</td><td></td><td>42</td><td>0.0%</td></tr>
  </table>
  <h2>U.S. Senate</h2>
  <table>
    <tr><th>Name</th><th>Party</th><th>Total</th></tr>
    <tr><td>Alice Example</td><td>LIB</td><td>9,001</td></tr>
  </table>
</body>
</html>`;

const HTML_WITH_LINKS_NO_TABLE = `<!doctype html>
<html><body>
  <a href="/elections/2026-primary-results.pdf">2026 Primary Results</a>
  <a href="/elections/canvass-2024.pdf">Post-election Canvass</a>
  <a href="/voter-registration">Voter Registration</a>
</body></html>`;

const HTML_OFF_CYCLE = `<!doctype html>
<html><body><h1>Indiana SoS</h1><p>No current elections.</p></body></html>`;

describe('IN results — parseIndianaHtml', () => {
  it('parses a two-table fixture into populated rows', () => {
    const rows = parseIndianaHtml(HTML_WITH_TABLE, 'unofficial_partial');
    assert.equal(rows.length, 4);

    const smith = rows.find((r) => r.reported_name === 'Jane Smith');
    assert.ok(smith, 'Smith row');
    assert.equal(smith.office_name, 'Governor');
    assert.equal(smith.party_abbreviation, 'DEM');
    assert.equal(smith.vote_count, 123456);
    assert.equal(smith.vote_percentage, 53.4);
    assert.equal(smith.is_write_in, false);

    const write = rows.find((r) => r.reported_name === 'Write-In');
    assert.ok(write);
    assert.equal(write.is_write_in, true);
    assert.equal(write.vote_count, 42);

    const alice = rows.find((r) => r.reported_name === 'Alice Example');
    assert.ok(alice);
    assert.equal(alice.office_name, 'U.S. Senate');
    assert.equal(alice.party_abbreviation, 'LIB');
    assert.equal(alice.vote_count, 9001);
  });

  it('returns [] for off-cycle page with no tables', () => {
    const rows = parseIndianaHtml(HTML_OFF_CYCLE, 'unofficial_partial');
    assert.equal(rows.length, 0);
  });

  it('returns [] for empty / too-short body', () => {
    assert.equal(parseIndianaHtml('', 'unofficial_partial').length, 0);
    assert.equal(parseIndianaHtml('<html/>', 'unofficial_partial').length, 0);
  });
});

describe('IN results — discoverInResultLinks', () => {
  it('finds anchors whose text or href mentions results/tabulation/canvass', () => {
    const links = discoverInResultLinks(HTML_WITH_LINKS_NO_TABLE);
    assert.ok(
      links.includes('/elections/2026-primary-results.pdf'),
      'primary results link found',
    );
    assert.ok(
      links.includes('/elections/canvass-2024.pdf'),
      'canvass link found',
    );
    assert.ok(
      !links.includes('/voter-registration'),
      'voter-registration link excluded',
    );
  });
});

describe('IN results — adapter composition', () => {
  it('declares the right FIPS, tokenBucket, costService, name', () => {
    const adapter = createInResultsAdapter();
    assert.equal(adapter.stateFips, '18');
    assert.deepEqual(adapter.tokenBucket, { rps: 0.5, burst: 2 });
    assert.equal(adapter.costService, 'other');
    assert.equal(adapter.name, 'sos-indiana-sos-enr');
  });
});
