/**
 * Utah SoS results adapter — unit tests.
 *
 * Priority state. Covers both the CSV path (what Utah historically publishes
 * post-election-night) and the HTML path (the live portal during an
 * election). Runs via node:test with no DB / network.
 *
 *   npx tsx --test src/lib/adapters/state-sos/__tests__/ut.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseUtahCsv,
  parseUtahHtml,
  parseUtahResults,
  splitOfficeDistrict,
  toPercentOrNull,
  createUtahResultsAdapter,
  UT_STATE_FIPS,
} from '../ut/results';

// ---------------------------------------------------------------------------
// 1. CSV parser
// ---------------------------------------------------------------------------

describe('parseUtahCsv', () => {
  it('parses a normalized Utah results CSV into StateResultRow[]', () => {
    const csv = [
      'Race,Candidate,Party,District,Votes,Percentage,Winner,Precincts Reported %',
      'U.S. House District 1,Jane Smith,Republican,1,"12,345",55.20,Yes,72.5',
      'U.S. House District 1,Bob Jones,Democratic,1,"9,876",44.15,No,72.5',
      'Governor,Alice Wong,Democratic,,"500,000",48.10,No,100',
      'Governor,Write-In,Unaffiliated,,"1,234",0.10,No,100',
    ].join('\n');

    const rows = parseUtahCsv(csv, { reportingLevel: 'unofficial_partial' });
    assert.equal(rows.length, 4);

    const smith = rows.find((r) => r.reported_name === 'Jane Smith');
    assert.ok(smith, 'Jane Smith row should exist');
    assert.equal(smith.party_abbreviation, 'REP');
    assert.equal(smith.office_name, 'U.S. House');
    assert.equal(smith.district_identifier, '1');
    assert.equal(smith.vote_count, 12345);
    assert.equal(smith.vote_percentage, 55.2);
    assert.equal(smith.pct_precincts_reporting, 72.5);
    assert.equal(smith.is_winner, true);
    assert.equal(smith.is_write_in, false);
    assert.equal(smith.reporting_level, 'unofficial_partial');

    const writeIn = rows.find((r) => r.is_write_in);
    assert.ok(writeIn, 'write-in row should exist');
    assert.equal(writeIn.reported_name, 'Write-In');
  });

  it('handles CSV with no winner column (election-night partial)', () => {
    const csv = [
      'Race,Candidate,Party,Votes',
      'Governor,Jane Smith,Democratic,"100"',
    ].join('\n');
    const rows = parseUtahCsv(csv);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].is_winner, false);
    assert.equal(rows[0].vote_count, 100);
  });
});

// ---------------------------------------------------------------------------
// 2. HTML parser
// ---------------------------------------------------------------------------

describe('parseUtahHtml', () => {
  it('extracts candidate rows from an election-night HTML dashboard', () => {
    const html = `<!DOCTYPE html><html><body>
      <h2>Governor</h2>
      <table>
        <thead><tr><th>Candidate</th><th>Party</th><th>Votes</th><th>%</th></tr></thead>
        <tbody>
          <tr class="winner"><td>Jane Smith</td><td>Democratic</td><td>100,000</td><td>52.1</td></tr>
          <tr><td>Bob Jones</td><td>Republican</td><td>92,000</td><td>47.9</td></tr>
        </tbody>
      </table>
      <h2>U.S. House District 3</h2>
      <table>
        <thead><tr><th>Candidate</th><th>Party</th><th>Votes</th><th>%</th></tr></thead>
        <tbody>
          <tr><td>Write-In</td><td>Unaffiliated</td><td>42</td><td>0.1</td></tr>
        </tbody>
      </table>
    </body></html>`;

    const rows = parseUtahHtml(html);
    assert.equal(rows.length, 3);

    const smith = rows.find((r) => r.reported_name === 'Jane Smith');
    assert.ok(smith);
    assert.equal(smith.office_name, 'Governor');
    assert.equal(smith.district_identifier, null);
    assert.equal(smith.vote_count, 100000);
    assert.equal(smith.vote_percentage, 52.1);
    assert.equal(smith.is_winner, true);
    assert.equal(smith.party_abbreviation, 'DEM');

    const hd3WriteIn = rows.find((r) => r.office_name === 'U.S. House');
    assert.ok(hd3WriteIn);
    assert.equal(hd3WriteIn.district_identifier, '3');
    assert.equal(hd3WriteIn.is_write_in, true);
  });

  it('ignores headings that are not race names', () => {
    const html = `<h2>About Utah Elections</h2>
      <table><thead><tr><th>Candidate</th><th>Votes</th></tr></thead>
        <tbody><tr><td>Foo</td><td>1</td></tr></tbody>
      </table>`;
    const rows = parseUtahHtml(html);
    assert.equal(rows.length, 0);
  });
});

// ---------------------------------------------------------------------------
// 3. Auto-dispatch
// ---------------------------------------------------------------------------

describe('parseUtahResults (auto-dispatch)', () => {
  it('sniffs CSV vs HTML correctly', () => {
    const csv = 'Race,Candidate,Votes\nGovernor,Jane Smith,100\n';
    const html = '<html><h2>Governor</h2><table><thead><tr><th>Candidate</th><th>Votes</th></tr></thead><tbody><tr><td>Jane</td><td>1</td></tr></tbody></table></html>';

    const csvRows = parseUtahResults(csv);
    const htmlRows = parseUtahResults(html);
    assert.equal(csvRows.length, 1);
    assert.equal(csvRows[0].reported_name, 'Jane Smith');
    assert.equal(htmlRows.length, 1);
    assert.equal(htmlRows[0].reported_name, 'Jane');
  });
});

// ---------------------------------------------------------------------------
// 4. splitOfficeDistrict
// ---------------------------------------------------------------------------

describe('splitOfficeDistrict', () => {
  it('extracts district and strips from office name', () => {
    assert.deepEqual(splitOfficeDistrict('U.S. House District 1'), {
      office_name: 'U.S. House',
      district_identifier: '1',
    });
    assert.deepEqual(splitOfficeDistrict('State Senate, District 23'), {
      office_name: 'State Senate',
      district_identifier: '23',
    });
    assert.deepEqual(splitOfficeDistrict('Governor'), {
      office_name: 'Governor',
      district_identifier: null,
    });
  });
});

// ---------------------------------------------------------------------------
// 5. toPercentOrNull
// ---------------------------------------------------------------------------

describe('toPercentOrNull', () => {
  it('parses strings with/without %, rejects out-of-range', () => {
    assert.equal(toPercentOrNull('55.2'), 55.2);
    assert.equal(toPercentOrNull('55.2%'), 55.2);
    assert.equal(toPercentOrNull(' 100 '), 100);
    assert.equal(toPercentOrNull('0'), 0);
    assert.equal(toPercentOrNull('N/A'), null);
    assert.equal(toPercentOrNull('200'), null);
    assert.equal(toPercentOrNull('-1'), null);
    assert.equal(toPercentOrNull(''), null);
    assert.equal(toPercentOrNull(null), null);
  });
});

// ---------------------------------------------------------------------------
// 6. Adapter factory wiring
// ---------------------------------------------------------------------------

describe('createUtahResultsAdapter', () => {
  it('returns a SourceAdapter with the right name, FIPS, bucket, and costService', () => {
    const adapter = createUtahResultsAdapter({
      fetchImpl: async () => ({ rawBody: '' }),
    });
    assert.equal(adapter.name, 'sos-utah-vote-results');
    assert.equal(adapter.stateFips, UT_STATE_FIPS);
    assert.equal(UT_STATE_FIPS, '49');
    assert.deepEqual(adapter.tokenBucket, { rps: 0.5, burst: 2 });
    assert.equal(adapter.costService, 'other');
  });

  it('can run() end-to-end with an injected fetch fixture (no network)', async () => {
    const adapter = createUtahResultsAdapter({
      electionYear: 2026,
      fetchImpl: async () => ({
        rawBody:
          'Race,Candidate,Party,Votes,Percentage\nGovernor,Jane Smith,Democratic,100,50',
        resolvedUrl: 'https://test.example/utah.csv',
      }),
    });

    // Minimal AdapterContext — run() only uses logger + the fetch impl.
    const ctx = {
      supabase: null as unknown,
      pg: null as unknown,
      dryRun: false,
      gitSha: 'test-sha',
      ingestionRunId: 'ir-test',
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    } as Parameters<typeof adapter.run>[0];

    const outcome = await adapter.run(ctx);
    assert.equal(outcome.rows.length, 1);
    assert.equal(outcome.rows[0].reported_name, 'Jane Smith');
    assert.equal(outcome.source.stateFips, UT_STATE_FIPS);
    assert.equal(outcome.source.sourceType, 'sos_results_api');
    assert.equal(outcome.source.license, 'state_open_records');
    assert.ok(outcome.source.contentHash, 'contentHash derived');
  });
});
