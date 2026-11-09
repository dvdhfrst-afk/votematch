/**
 * Unit tests for the Pacific + Territories wave SoS results adapters.
 *
 * Focused on the three jurisdictions with voting-rule nuance:
 *   - CA (FIPS 06): top-two nonpartisan primary
 *   - WA (FIPS 53): top-two nonpartisan primary + NIST + CSV fallbacks
 *   - AK (FIPS 02): top-four nonpartisan primary + RCV general
 *
 * No network, no DB. We exercise the parsers directly and the adapter
 * composition via globalThis.fetch monkey-patching.
 *
 * Run:
 *   npx tsx --test src/lib/adapters/state-sos/__tests__/pacific.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createCaResultsAdapter,
  parseCaliforniaResults,
} from '../ca/results';
import {
  createWaResultsAdapter,
  parseWashingtonResults,
} from '../wa/results';
import {
  createAkResultsAdapter,
  parseAlaskaResults,
} from '../ak/results';
import type { AdapterContext } from '../../types';

function mockCtx(): AdapterContext {
  const logs: Array<{ level: string; msg: string }> = [];
  const logger = {
    info: (msg: string) => logs.push({ level: 'info', msg }),
    warn: (msg: string) => logs.push({ level: 'warn', msg }),
    error: (msg: string) => logs.push({ level: 'error', msg }),
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
// Synthetic fixtures
// ---------------------------------------------------------------------------

/** CA — a single Governor contest with 4 candidates; test top-two semantics. */
const CA_GOVERNOR_HTML = `<!doctype html><html><body>
  <h2>Governor</h2>
  <table>
    <tr><th>Candidate</th><th>Party</th><th>Votes</th><th>Percent</th></tr>
    <tr><td>Alice Zhang</td><td>DEM</td><td>3,200,000</td><td>42.1%</td></tr>
    <tr><td>Bob Rivera</td><td>REP</td><td>2,900,000</td><td>38.1%</td></tr>
    <tr><td>Carla Kim</td><td>DEM</td><td>1,000,000</td><td>13.1%</td></tr>
    <tr><td>Dan Ortiz</td><td>NPP</td><td>500,000</td><td>6.7%</td></tr>
  </table>
</body></html>`;

/** WA — a single US House D-9 contest with 4 candidates; test top-two. */
const WA_HOUSE_HTML = `<!doctype html><html><body>
  <h2>U.S. Representative, 9th Congressional District</h2>
  <table>
    <tr><th>Candidate</th><th>Party Preference</th><th>Votes</th><th>Percent</th></tr>
    <tr><td>Jim Sampleford</td><td>Dem</td><td>120,000</td><td>45.0%</td></tr>
    <tr><td>Kate Lee</td><td>Rep</td><td>95,000</td><td>35.5%</td></tr>
    <tr><td>Morgan Park</td><td>Dem</td><td>35,000</td><td>13.1%</td></tr>
    <tr><td>Nora Stone</td><td>Ind</td><td>17,000</td><td>6.4%</td></tr>
  </table>
</body></html>`;

/** WA — CSV fallback. */
const WA_CSV = `Race,BallotName,PartyPreference,Votes
State Senate District 5,Alan Black,Dem,50000
State Senate District 5,Brenda Cole,Rep,47000
State Senate District 5,Carlos Diaz,Dem,12000
State Senate District 5,Dan Exampleton,Lib,5000`;

/** AK — top-four primary fixture (US Senate, 5 candidates). */
const AK_SENATE_HTML = `<!doctype html><html><body>
  <h2>United States Senator</h2>
  <table>
    <tr><th>Candidate</th><th>Party</th><th>Votes</th><th>Percent</th></tr>
    <tr><td>Sarah N.</td><td>REP</td><td>44000</td><td>32%</td></tr>
    <tr><td>Peter H.</td><td>DEM</td><td>35000</td><td>25%</td></tr>
    <tr><td>Joe W.</td><td>IND</td><td>30000</td><td>21%</td></tr>
    <tr><td>Mary T.</td><td>REP</td><td>20000</td><td>14%</td></tr>
    <tr><td>Chris L.</td><td>LIB</td><td>10000</td><td>8%</td></tr>
  </table>
</body></html>`;

// ---------------------------------------------------------------------------
// California
// ---------------------------------------------------------------------------

describe('CA results adapter (top-two)', () => {
  it('declares FIPS 06 + tokenBucket + costService=other', () => {
    const adapter = createCaResultsAdapter();
    assert.equal(adapter.stateFips, '06');
    assert.deepEqual(adapter.tokenBucket, { rps: 0.5, burst: 2 });
    assert.equal(adapter.costService, 'other');
    assert.equal(adapter.name, 'sos-ca-sos-results');
  });

  it('parses 4 candidate rows with party + votes + pct', () => {
    const rows = parseCaliforniaResults(CA_GOVERNOR_HTML, {
      reportingLevel: 'unofficial_partial',
    });
    assert.equal(rows.length, 4);
    const alice = rows.find((r) => r.reported_name === 'Alice Zhang');
    assert.ok(alice);
    assert.equal(alice.party_abbreviation, 'DEM');
    assert.equal(alice.vote_count, 3200000);
    assert.ok(alice.vote_percentage! > 42 && alice.vote_percentage! < 43);
    assert.equal(alice.office_name, 'Governor');
  });

  it('top_two_nonpartisan_primary: top-2 OVERALL get is_winner=true (not per-party)', () => {
    const rows = parseCaliforniaResults(CA_GOVERNOR_HTML, {
      votingRule: 'top_two_nonpartisan_primary',
    });
    const winners = rows.filter((r) => r.is_winner);
    assert.equal(winners.length, 2);
    const names = winners.map((r) => r.reported_name).sort();
    assert.deepEqual(names, ['Alice Zhang', 'Bob Rivera']);
    // Carla (the 2nd DEM) is NOT a winner even though she's the 2nd highest
    // Democrat — the top-two rule doesn't care about party.
    const carla = rows.find((r) => r.reported_name === 'Carla Kim');
    assert.equal(carla?.is_winner, false);
  });

  it('partisan_general voting rule marks only the single highest row', () => {
    const rows = parseCaliforniaResults(CA_GOVERNOR_HTML, {
      votingRule: 'partisan_general',
    });
    const winners = rows.filter((r) => r.is_winner);
    assert.equal(winners.length, 1);
    assert.equal(winners[0].reported_name, 'Alice Zhang');
  });

  it('returns [] for off-cycle body (short / empty)', () => {
    assert.equal(parseCaliforniaResults('').length, 0);
    assert.equal(parseCaliforniaResults('<!doctype html><p>empty</p>').length, 0);
  });

  it('adapter throws on HTTP 5xx', async () => {
    const adapter = createCaResultsAdapter();
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response('oops', { status: 503 }) as Response;
    try {
      await assert.rejects(() => adapter.run(mockCtx()), /CA fetch failed/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('extracts district number from office name', () => {
    const fixture = `<h2>U.S. House of Representatives, District 12</h2>
      <table>
        <tr><th>Candidate</th><th>Votes</th></tr>
        <tr><td>Test Cand</td><td>100</td></tr>
      </table>`;
    const rows = parseCaliforniaResults(fixture);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].district_identifier, '12');
  });
});

// ---------------------------------------------------------------------------
// Washington
// ---------------------------------------------------------------------------

describe('WA results adapter (top-two + multi-format)', () => {
  it('declares FIPS 53 + tokenBucket + costService=other', () => {
    const adapter = createWaResultsAdapter();
    assert.equal(adapter.stateFips, '53');
    assert.deepEqual(adapter.tokenBucket, { rps: 0.5, burst: 2 });
    assert.equal(adapter.costService, 'other');
  });

  it('HTML: top_two_nonpartisan_primary marks top-2 rows (regardless of party)', () => {
    const rows = parseWashingtonResults(WA_HOUSE_HTML, {
      votingRule: 'top_two_nonpartisan_primary',
    });
    assert.equal(rows.length, 4);
    const winners = rows.filter((r) => r.is_winner).map((r) => r.reported_name);
    assert.deepEqual(winners.sort(), ['Jim Sampleford', 'Kate Lee']);
    // Morgan (2nd Democrat) should NOT be a winner.
    const morgan = rows.find((r) => r.reported_name === 'Morgan Park');
    assert.equal(morgan?.is_winner, false);
  });

  it('HTML: district number extracted from office header', () => {
    const rows = parseWashingtonResults(WA_HOUSE_HTML);
    assert.equal(rows[0].district_identifier, '9');
  });

  it('CSV: top-two primary semantics apply to CSV bodies too', () => {
    const rows = parseWashingtonResults(WA_CSV, {
      votingRule: 'top_two_nonpartisan_primary',
    });
    assert.equal(rows.length, 4);
    const winners = rows.filter((r) => r.is_winner).map((r) => r.reported_name);
    assert.deepEqual(winners.sort(), ['Alan Black', 'Brenda Cole']);
  });

  it('NIST XML body routes to parseNistXml branch', () => {
    const xml = `<?xml version="1.0"?>
<ElectionReport xmlns="http://itl.nist.gov/ns/voting/1500-100/v2">
  <Party ObjectId="p1"><Abbreviation>DEM</Abbreviation><Name>Dem</Name></Party>
  <GpUnit ObjectId="g1"><Name>Washington</Name><Type>state</Type></GpUnit>
  <Election>
    <Candidate ObjectId="c1"><BallotName>NIST Cand</BallotName><PartyId>p1</PartyId></Candidate>
    <Contest ObjectId="cg" type="CandidateContest">
      <Name>Governor</Name>
      <ElectoralDistrictId>g1</ElectoralDistrictId>
      <ContestSelection ObjectId="s1" type="CandidateSelection">
        <CandidateIds>c1</CandidateIds>
        <VoteCounts><Count>999</Count><Type>total</Type></VoteCounts>
      </ContestSelection>
    </Contest>
  </Election>
</ElectionReport>`;
    const rows = parseWashingtonResults(xml);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].reported_name, 'NIST Cand');
    assert.equal(rows[0].vote_count, 999);
  });

  it('unknown voting rule leaves is_winner=false on every row', () => {
    const rows = parseWashingtonResults(WA_HOUSE_HTML, { votingRule: 'unknown' });
    assert.equal(rows.filter((r) => r.is_winner).length, 0);
  });

  it('empty body -> []', () => {
    assert.equal(parseWashingtonResults('').length, 0);
  });
});

// ---------------------------------------------------------------------------
// Alaska
// ---------------------------------------------------------------------------

describe('AK results adapter (top-four + RCV)', () => {
  it('declares FIPS 02 + tokenBucket + costService=other', () => {
    const adapter = createAkResultsAdapter();
    assert.equal(adapter.stateFips, '02');
    assert.deepEqual(adapter.tokenBucket, { rps: 0.5, burst: 2 });
    assert.equal(adapter.costService, 'other');
    assert.equal(adapter.name, 'sos-ak-doe-results');
  });

  it('top_four_nonpartisan_primary: top-4 OVERALL get is_winner=true', () => {
    const rows = parseAlaskaResults(AK_SENATE_HTML, {
      votingRule: 'top_four_nonpartisan_primary',
    });
    assert.equal(rows.length, 5);
    const winners = rows.filter((r) => r.is_winner);
    assert.equal(winners.length, 4);
    // The 5th-place finisher should NOT be flagged.
    const chris = rows.find((r) => r.reported_name === 'Chris L.');
    assert.equal(chris?.is_winner, false);
  });

  it('rcv_general: only the single highest row wins (final round)', () => {
    const rows = parseAlaskaResults(AK_SENATE_HTML, {
      votingRule: 'rcv_general',
    });
    const winners = rows.filter((r) => r.is_winner);
    assert.equal(winners.length, 1);
    assert.equal(winners[0].reported_name, 'Sarah N.');
  });

  it('unknown voting rule: no row marked winner (safer than guessing)', () => {
    const rows = parseAlaskaResults(AK_SENATE_HTML, { votingRule: 'unknown' });
    assert.equal(rows.filter((r) => r.is_winner).length, 0);
  });

  it('is_winner + is_runoff_advancer are mutually exclusive (CHECK invariant)', () => {
    const rows = parseAlaskaResults(AK_SENATE_HTML, {
      votingRule: 'top_four_nonpartisan_primary',
    });
    for (const r of rows) {
      assert.ok(
        !(r.is_winner && r.is_runoff_advancer),
        'is_winner and is_runoff_advancer mutually exclusive',
      );
    }
  });

  it('empty body -> []', () => {
    assert.equal(parseAlaskaResults('').length, 0);
  });

  it('adapter throws on HTTP 5xx', async () => {
    const adapter = createAkResultsAdapter();
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response('oops', { status: 503 }) as Response;
    try {
      await assert.rejects(() => adapter.run(mockCtx()), /AK fetch failed/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
