/**
 * Unit tests for the Ohio candidate-filings adapter.
 *
 * Covers the 5-case pattern shared with the IN candidacies adapter:
 *   1. Adapter metadata (FIPS, tokenBucket, costService, sourceType, name).
 *   2. Parser happy path — structured <table> HTML + press-release paragraph
 *      shape both produce OhCandidacyRows with name/party/office/district.
 *   3. Degenerate inputs — empty body and non-HTML body return [].
 *   4. Cloudflare-like 403 is detected gracefully: adapter.run() returns
 *      rows=[] with cloudflare_walled=true in meta rather than throwing
 *      (politeFetch-friendly behavior; the ingestion run records partial,
 *      not failed).
 *   5. parseOverride + fetchOverride harness end-to-end so a test fixture
 *      HTML feeds through adapter.run() without hitting the network.
 *
 * No network.
 *
 * Run:
 *   npx tsx --test src/lib/adapters/state-sos/oh/__tests__/candidacies.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createOhCandidaciesAdapter,
  parseCandidateList,
  isCloudflareChallenge,
} from '../candidacies';
import type { AdapterContext } from '../../../types';

function mockCtx(): AdapterContext {
  const logger = {
    info: () => {},
    warn: () => {},
    error: () => {},
  };
  return {
    supabase: {} as AdapterContext['supabase'],
    pg: {} as AdapterContext['pg'],
    dryRun: true,
    gitSha: 'test',
    ingestionRunId: 'ir-test',
    logger,
  };
}

// ---------------------------------------------------------------------------
// Fixtures — synthetic OH SoS candidate list shapes.
// ---------------------------------------------------------------------------

/**
 * Shape 1 — a structured candidate table with office as the preceding <h2>.
 * This mirrors how OH SoS publishes per-race certified lists when they ship
 * XLSX/PDF equivalents; when rendered as HTML it's a flat <table>.
 */
const OH_TABLE_HTML = `
<!doctype html>
<html>
<body>
  <h1>2026 Primary Candidate Filings</h1>

  <h2>Governor and Lieutenant Governor</h2>
  <table>
    <tr><th>Name</th><th>Party</th><th>District</th></tr>
    <tr><td>Alex Testcandidate</td><td>D</td><td></td></tr>
    <tr><td>Jordan Placeholder</td><td>R</td><td></td></tr>
    <tr><td>Taylor Samplename</td><td>R</td><td></td></tr>
  </table>

  <h2>U.S. House of Representatives</h2>
  <table>
    <tr><th>Candidate</th><th>Party</th><th>District</th></tr>
    <tr><td>Jane Federal</td><td>D</td><td>7</td></tr>
    <tr><td>John GOP</td><td>R</td><td>7</td></tr>
    <tr><td>Libby Liberty</td><td>L</td><td>3</td></tr>
  </table>

  <h2>State Representative</h2>
  <table>
    <tr><th>Name</th><th>Party</th><th>District</th></tr>
    <tr><td>Sandy State</td><td>D</td><td>42</td></tr>
    <tr><td>Steve Statehouse</td><td>R</td><td>42</td></tr>
  </table>
</body>
</html>
`;

/**
 * Shape 2 — press-release paragraph text. Mirrors the Feb 19, 2026 OH SoS
 * release: one paragraph per office, semicolon-separated entries.
 */
const OH_PRESS_RELEASE_HTML = `
<!doctype html>
<html>
<body>
  <article>
    <h1>Statewide Candidates Qualified for the 2026 Primary Ballot</h1>
    <p>U.S. Senate: Pat Example (D); Robin Sample (R); Casey Fictional (L).</p>
    <p>Governor and Lieutenant Governor: Alex Testcandidate and Dana Runningmate (D); Jordan Placeholder and Lee Runningmate (R); Morgan Mockperson and Riley Notreal (L).</p>
    <p>Attorney General: Quinn Testperson (R); Sam Placeholderson (D).</p>
    <p>Supreme Court Justice: Drew Examplar (R); Jamie Fakename (D).</p>
    <p>State Representative, District 42: Sandy State (D); Steve Statehouse (R).</p>
  </article>
</body>
</html>
`;

/** Cloudflare 403 challenge body skeleton. */
const OH_CF_CHALLENGE =
  '<!DOCTYPE html><html><head><title>Just a moment...</title></head>' +
  '<body><div class="cf-browser-verification cf-chl-verification">' +
  'Please wait while we verify your browser... __cf_chl_tk abcdef' +
  '</div></body></html>';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OH candidacies adapter — metadata', () => {
  it('declares the right FIPS / tokenBucket / costService / name / sourceType', async () => {
    const adapter = createOhCandidaciesAdapter({
      fetchOverride: async () => ({ status: 200, body: OH_TABLE_HTML }),
    });
    assert.equal(adapter.stateFips, '39');
    assert.deepEqual(adapter.tokenBucket, { rps: 0.5, burst: 2 });
    assert.equal(adapter.costService, 'other');
    assert.equal(adapter.name, 'sos-ohio-sos-candidate-filings');

    const outcome = await adapter.run(mockCtx());
    assert.equal(outcome.source.sourceType, 'sos_candidate_filing');
    assert.equal(outcome.source.stateFips, '39');
    assert.equal(outcome.source.license, 'state_open_records');
    assert.equal(outcome.expectedMinRows, 50);
    assert.match(
      outcome.source.url,
      /ohiosos\.gov.*candidate-information/,
    );
  });
});

describe('OH candidacies adapter — parser happy path (table shape)', () => {
  it('extracts name + party + district + office from structured tables', () => {
    const rows = parseCandidateList(OH_TABLE_HTML);
    // 3 Gov + 3 US House + 2 State Rep = 8.
    assert.equal(rows.length, 8);

    const alice = rows.find((r) => r.reported_name === 'Alex Testcandidate');
    assert.ok(alice, 'Alex Testcandidate row present');
    assert.equal(alice!.party_abbreviation, 'D');
    assert.equal(alice!.office_name, 'Governor and Lieutenant Governor');
    assert.equal(alice!.district_identifier, null);
    assert.equal(alice!.is_write_in, false);

    const jane = rows.find((r) => r.reported_name === 'Jane Federal');
    assert.ok(jane, 'Jane Federal row present');
    assert.equal(jane!.district_identifier, '7');
    assert.equal(jane!.office_name, 'U.S. House of Representatives');

    const sandy = rows.find((r) => r.reported_name === 'Sandy State');
    assert.ok(sandy, 'Sandy State row present');
    assert.equal(sandy!.office_name, 'State Representative');
    assert.equal(sandy!.district_identifier, '42');
    assert.equal(sandy!.party_abbreviation, 'D');

    // Source row IDs are unique within the run.
    const ids = new Set(rows.map((r) => r.source_row_id));
    assert.equal(ids.size, rows.length, 'source_row_ids unique');
  });
});

describe('OH candidacies adapter — parser happy path (press-release shape)', () => {
  it('extracts candidates from semicolon-separated paragraph entries', () => {
    const rows = parseCandidateList(OH_PRESS_RELEASE_HTML);
    // 3 Senate + 3 Gov tickets + 2 AG + 2 Justice + 2 State Rep = 12.
    assert.equal(rows.length, 12);

    const brown = rows.find((r) => r.reported_name === 'Pat Example');
    assert.ok(brown, 'Pat Example row present');
    assert.equal(brown!.party_abbreviation, 'D');
    assert.equal(brown!.office_name, 'U.S. Senate');
    assert.equal(brown!.district_identifier, null);

    // Joint tickets collapse to top-of-ticket name.
    const acton = rows.find((r) => r.reported_name === 'Alex Testcandidate');
    assert.ok(acton, 'Alex Testcandidate row present (top of joint ticket)');
    assert.equal(acton!.party_abbreviation, 'D');
    // Running mate is NOT emitted as a separate row.
    assert.ok(
      !rows.some((r) => r.reported_name === 'Dana Runningmate'),
      'joint ticket running mate not duplicated',
    );

    // District extracted from paragraph office line.
    const sandy = rows.find((r) => r.reported_name === 'Sandy State');
    assert.ok(sandy, 'Sandy State row present');
    assert.equal(sandy!.district_identifier, '42');

    // Supreme Court Justice is picked up via the office-keyword gate.
    const justice = rows.find((r) => r.reported_name === 'Drew Examplar');
    assert.ok(justice, 'Drew Examplar (Justice) row present');
    assert.equal(justice!.party_abbreviation, 'R');
    assert.match(justice!.office_name, /Supreme Court Justice/);
  });
});

describe('OH candidacies adapter — degenerate inputs', () => {
  it('returns [] on empty body', () => {
    assert.deepEqual(parseCandidateList(''), []);
  });

  it('returns [] on non-HTML body (e.g. JSON payload by mistake)', () => {
    assert.deepEqual(
      parseCandidateList('{"candidates":[{"name":"x"}]}'),
      [],
    );
  });

  it('returns [] on short body below the 64-byte guard', () => {
    assert.deepEqual(parseCandidateList('<p>too short</p>'), []);
  });

  it('returns [] on Cloudflare challenge HTML', () => {
    assert.deepEqual(parseCandidateList(OH_CF_CHALLENGE), []);
  });
});

describe('OH candidacies adapter — Cloudflare-like 403 handled gracefully', () => {
  it('isCloudflareChallenge detects status + body markers', () => {
    assert.equal(isCloudflareChallenge(403, 'anything'), true);
    assert.equal(isCloudflareChallenge(503, 'anything'), true);
    assert.equal(isCloudflareChallenge(200, OH_CF_CHALLENGE), true);
    assert.equal(
      isCloudflareChallenge(200, '<html><body>real content</body></html>'),
      false,
    );
    assert.equal(isCloudflareChallenge(200, ''), false);
  });

  it('adapter.run() returns rows=[] with cloudflare_walled=true when fetch 403s', async () => {
    const adapter = createOhCandidaciesAdapter({
      fetchOverride: async () => ({ status: 403, body: OH_CF_CHALLENGE }),
    });
    const outcome = await adapter.run(mockCtx());
    assert.equal(outcome.rows.length, 0);
    assert.equal(outcome.expectedMinRows, 50);
    assert.equal(
      (outcome.source.meta as { cloudflare_walled?: boolean }).cloudflare_walled,
      true,
    );
    assert.equal(
      (outcome.source.meta as { http_status?: number }).http_status,
      403,
    );
  });

  it('adapter.run() throws on non-CF HTTP 5xx (so runner records failed)', async () => {
    const adapter = createOhCandidaciesAdapter({
      fetchOverride: async () => ({ status: 500, body: 'oops' }),
    });
    await assert.rejects(
      () => adapter.run(mockCtx()),
      /HTTP 500/,
    );
  });
});

describe('OH candidacies adapter — fetch/parse override harness', () => {
  it('pipes synthetic HTML through adapter.run() to produce real rows', async () => {
    const adapter = createOhCandidaciesAdapter({
      fetchOverride: async () => ({ status: 200, body: OH_TABLE_HTML }),
    });
    const outcome = await adapter.run(mockCtx());
    assert.equal(outcome.rows.length, 8);

    // Every row should carry the five required fields. validateRow
    // is on the adapter so we test it via the adapter handle.
    for (const row of outcome.rows) {
      assert.equal(adapter.validateRow!(row), null);
      assert.ok(row.reported_name.length > 0);
      assert.ok(row.office_name.length > 0);
    }

    // Meta carries provenance for data_sources.
    const meta = outcome.source.meta as {
      election_year?: number;
      cloudflare_walled?: boolean;
      http_status?: number;
    };
    assert.equal(meta.cloudflare_walled, false);
    assert.equal(meta.http_status, 200);
    assert.ok(typeof meta.election_year === 'number');
  });

  it('accepts a parseOverride to isolate the fetch layer in tests', async () => {
    const adapter = createOhCandidaciesAdapter({
      fetchOverride: async () => ({ status: 200, body: '<html></html>' }),
      parseOverride: () => [
        {
          reported_name: 'Override Candidate',
          party_abbreviation: 'D',
          office_name: 'U.S. Senate',
          district_identifier: null,
          is_write_in: false,
          source_row_id: 'override-1',
        },
      ],
    });
    const outcome = await adapter.run(mockCtx());
    assert.equal(outcome.rows.length, 1);
    assert.equal(outcome.rows[0].reported_name, 'Override Candidate');
  });
});
