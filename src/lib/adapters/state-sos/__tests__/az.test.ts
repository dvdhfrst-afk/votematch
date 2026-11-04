/**
 * Arizona SoS results adapter — unit tests.
 *
 *   npx tsx --test src/lib/adapters/state-sos/__tests__/az.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseArizonaResults,
  createArizonaResultsAdapter,
  AZ_STATE_FIPS,
} from '../az/results';

describe('parseArizonaResults', () => {
  it('extracts rows from a typical HTML dashboard', () => {
    const html = `<!DOCTYPE html><html><body>
      <h2>U.S. Senator</h2>
      <table>
        <thead><tr><th>Candidate</th><th>Party</th><th>Votes</th><th>%</th></tr></thead>
        <tbody>
          <tr><td>Carla Vega</td><td>Democratic</td><td>900,000</td><td>49.8</td></tr>
          <tr><td>Dan Pine</td><td>Republican</td><td>880,000</td><td>48.7</td></tr>
          <tr><td>Ezra Null</td><td>Libertarian</td><td>27,000</td><td>1.5</td></tr>
        </tbody>
      </table>
      <h2>Secretary of State</h2>
      <table>
        <thead><tr><th>Candidate</th><th>Party</th><th>Votes</th></tr></thead>
        <tbody>
          <tr><td>Finn Fox</td><td>Democratic</td><td>850,000</td></tr>
        </tbody>
      </table>
    </body></html>`;

    const rows = parseArizonaResults(html);
    assert.equal(rows.length, 4);

    const vega = rows.find((r) => r.reported_name === 'Carla Vega');
    assert.ok(vega);
    assert.equal(vega.office_name, 'U.S. Senator');
    assert.equal(vega.district_identifier, null);
    assert.equal(vega.party_abbreviation, 'DEM');
    assert.equal(vega.vote_count, 900000);
    assert.equal(vega.vote_percentage, 49.8);

    const lib = rows.find((r) => r.party_abbreviation === 'LIB');
    assert.ok(lib, 'Libertarian normalized to LIB');

    const sos = rows.find((r) => r.office_name === 'Secretary of State');
    assert.ok(sos);
    assert.equal(sos.vote_percentage, null);
  });
});

describe('createArizonaResultsAdapter', () => {
  it('wires FIPS 04 + state_open_records license + other cost service', () => {
    const adapter = createArizonaResultsAdapter({
      fetchImpl: async () => ({ rawBody: '' }),
    });
    assert.equal(adapter.stateFips, AZ_STATE_FIPS);
    assert.equal(AZ_STATE_FIPS, '04');
    assert.equal(adapter.name, 'sos-arizona-sos-results');
    assert.deepEqual(adapter.tokenBucket, { rps: 0.5, burst: 2 });
    assert.equal(adapter.costService, 'other');
  });

  it('run() passes the fetched body into the parser and emits a data_sources descriptor', async () => {
    const html = `<h2>Governor</h2>
      <table><thead><tr><th>Candidate</th><th>Party</th><th>Votes</th></tr></thead>
        <tbody><tr><td>Jane Smith</td><td>Democratic</td><td>100</td></tr></tbody>
      </table>`;
    const adapter = createArizonaResultsAdapter({
      fetchImpl: async () => ({ rawBody: html }),
      electionYear: 2026,
    });
    const ctx = {
      supabase: null as unknown,
      pg: null as unknown,
      dryRun: false,
      gitSha: 'test',
      ingestionRunId: 'ir-test',
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    } as Parameters<typeof adapter.run>[0];
    const outcome = await adapter.run(ctx);
    assert.equal(outcome.rows.length, 1);
    assert.equal(outcome.rows[0].reported_name, 'Jane Smith');
    assert.equal(outcome.source.stateFips, AZ_STATE_FIPS);
    assert.equal(outcome.source.sourceType, 'sos_results_api');
    assert.equal(outcome.source.license, 'state_open_records');
  });
});
