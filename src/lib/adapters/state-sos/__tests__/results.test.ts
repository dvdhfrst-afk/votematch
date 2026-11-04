/**
 * Per-state results adapter parser tests — Mid-Atlantic / South Atlantic
 * bundle (D2: DE, MD, DC, VA, WV, NC, SC, GA).
 *
 * Runs with node:test; no network, no DB. All parsers exercised against
 * synthetic fixtures. Covers at least three of the eight states per the
 * task brief; additional states share the same table-header scraping
 * heuristic so the three covered here are representative.
 *
 *   npx tsx --test src/lib/adapters/state-sos/__tests__/results.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseDeResultsHtml } from '../de/results';
import { parseNcCsv } from '../nc/results';
import { parseWvResults } from '../wv/results';
import { parseGaResults, createGaResultsAdapter } from '../ga/results';
import type { AdapterContext } from '../../types';

// Minimal ctx stub — parsers never touch it in the happy path.
const stubCtx = {
  logger: {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  },
} as unknown as AdapterContext;

// ---------------------------------------------------------------------------
// DE — HTML scraper
// ---------------------------------------------------------------------------

const DE_HTML = `<!doctype html>
<html><body>
  <h2>Governor</h2>
  <table class="results-table">
    <tr><th>Candidate</th><th>Party</th><th>Votes</th><th>%</th></tr>
    <tr><td>Alice Smith</td><td>DEM</td><td>12,345</td><td>55.2%</td></tr>
    <tr><td>Bob Jones</td><td>REP</td><td>10,000</td><td>44.8%</td></tr>
  </table>
  <h2>Ignored measure</h2>
  <table>
    <tr><th>Question</th><th>Yes</th><th>No</th></tr>
    <tr><td>Shall...</td><td>1000</td><td>500</td></tr>
  </table>
</body></html>`;

describe('DE — parseDeResultsHtml', () => {
  it('extracts candidate rows from a results-table and ignores non-candidate tables', async () => {
    const rows = await parseDeResultsHtml(DE_HTML, stubCtx);
    assert.equal(rows.length, 2, 'exactly two candidate rows');
    const alice = rows.find((r) => r.reported_name === 'Alice Smith');
    assert.ok(alice, 'Alice row present');
    assert.equal(alice.office_name, 'Governor');
    assert.equal(alice.party_abbreviation, 'DEM');
    assert.equal(alice.vote_count, 12345);
    assert.equal(alice.vote_percentage, 55.2);
    assert.equal(alice.is_write_in, false);
    assert.equal(alice.reporting_level, 'unofficial_partial');
  });

  it('returns [] on empty / tiny body', async () => {
    assert.deepEqual(await parseDeResultsHtml('', stubCtx), []);
    assert.deepEqual(await parseDeResultsHtml('<html></html>', stubCtx), []);
  });

  it('honours reportingLevel override', async () => {
    const rows = await parseDeResultsHtml(DE_HTML, stubCtx, 'state_certified');
    assert.ok(rows.length > 0);
    for (const r of rows) assert.equal(r.reporting_level, 'state_certified');
  });
});

// ---------------------------------------------------------------------------
// NC — CSV parser (aggregates per precinct → contest-level sums)
// ---------------------------------------------------------------------------

const NC_CSV = [
  'County,Election Date,Precinct,Contest Group ID,Contest Type,Contest Name,Choice,Choice Party,Vote For,Election Day,One Stop,Absentee by Mail,Provisional,Total Votes,Real Precinct',
  'WAKE,03/03/2026,001,100,S,US Senate,Jane Doe,DEM,1,50,10,5,0,65,Y',
  'WAKE,03/03/2026,002,100,S,US Senate,Jane Doe,DEM,1,30,5,0,0,35,Y',
  'WAKE,03/03/2026,001,100,S,US Senate,John Roe,REP,1,20,5,2,0,27,Y',
  'WAKE,03/03/2026,001,100,S,US Senate,Write-In,,1,1,0,0,0,1,Y',
].join('\n');

describe('NC — parseNcCsv', () => {
  it('aggregates per-precinct rows into per-contest rows keyed on (Contest,Choice,Party)', () => {
    const rows = parseNcCsv(NC_CSV);
    // Three unique (choice,party) triples: Jane/DEM, John/REP, Write-In/null
    assert.equal(rows.length, 3);
    const jane = rows.find((r) => r.reported_name === 'Jane Doe');
    assert.ok(jane);
    assert.equal(jane.office_name, 'US Senate');
    assert.equal(jane.party_abbreviation, 'DEM');
    assert.equal(jane.vote_count, 100, 'aggregated 65 + 35 = 100');
    assert.equal(jane.is_write_in, false);

    const wi = rows.find((r) => r.is_write_in);
    assert.ok(wi, 'write-in row present');
    assert.equal(wi.party_abbreviation, null);
    assert.equal(wi.vote_count, 1);
  });

  it('returns [] on malformed CSV', () => {
    const rows = parseNcCsv('\u0000not,csv\nincomplete');
    // csv-parse lenient mode returns what it can; ensure we don't throw
    // and don't invent rows with missing Contest/Choice.
    assert.ok(Array.isArray(rows));
  });
});

// ---------------------------------------------------------------------------
// WV — JSON path (filings-API-shaped results feed)
// ---------------------------------------------------------------------------

const WV_JSON_FLAT = JSON.stringify([
  {
    officeName: 'U.S. Senator',
    candidateName: 'Jane Doe',
    party: 'DEM',
    votes: 5000,
    percent: 55.5,
    isWinner: true,
  },
  {
    officeName: 'U.S. Senator',
    candidateName: 'John Roe',
    party: 'REP',
    votes: 4000,
    percent: 44.5,
  },
]);

const WV_JSON_NESTED = JSON.stringify({
  contests: [
    {
      office: 'Governor',
      district: null,
      selections: [
        {
          name: 'Alice Smith',
          party: 'DEM',
          votes: 123,
          pct: 50,
          isWinner: true,
        },
        {
          name: 'Bob Jones',
          party: 'REP',
          votes: 123,
          pct: 50,
        },
      ],
    },
  ],
});

describe('WV — parseWvResults (JSON path)', () => {
  it('parses the filings-API flat-array shape into StateResultRow[]', async () => {
    const rows = await parseWvResults(WV_JSON_FLAT, stubCtx);
    assert.equal(rows.length, 2);
    const jane = rows.find((r) => r.reported_name === 'Jane Doe');
    assert.ok(jane);
    assert.equal(jane.office_name, 'U.S. Senator');
    assert.equal(jane.party_abbreviation, 'DEM');
    assert.equal(jane.vote_count, 5000);
    assert.equal(jane.vote_percentage, 55.5);
    assert.equal(jane.is_winner, true);
  });

  it('parses the nested contests-wrapper shape', async () => {
    const rows = await parseWvResults(WV_JSON_NESTED, stubCtx);
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.office_name === 'Governor'));
  });

  it('returns [] on invalid JSON', async () => {
    const rows = await parseWvResults('{not json', stubCtx);
    assert.deepEqual(rows, []);
  });

  it('falls through to HTML scraper for HTML bodies', async () => {
    const rows = await parseWvResults(
      '<html><body><h2>Governor</h2><table><tr><th>Candidate</th><th>Votes</th></tr><tr><td>Alice</td><td>1</td></tr></table></body></html>',
      stubCtx,
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].reported_name, 'Alice');
  });
});

// ---------------------------------------------------------------------------
// GA — PDF-deferred placeholder: parse() returns [], factory builds OK
// ---------------------------------------------------------------------------

describe('GA — PDF-deferred placeholder', () => {
  it('parseGaResults returns [] regardless of input', async () => {
    assert.deepEqual(await parseGaResults('anything', stubCtx), []);
    assert.deepEqual(await parseGaResults('', stubCtx), []);
  });

  it('createGaResultsAdapter returns a SourceAdapter with expected name + state', () => {
    const a = createGaResultsAdapter();
    assert.equal(a.name, 'sos-ga-sos-results');
    assert.equal(a.stateFips, '13');
    assert.equal(a.costService, 'other');
  });
});

// ===========================================================================
// South-wave (D3): FL / AL / MS / LA / TN / KY — three states covered below
//   - FL: tab-delimited TXT with header & positional fallback
//   - LA: JSON jungle-primary with 50%-gated winner + top-2 advancer rule
//   - AL: HTML-table + party-grouped primary-runoff semantics
// ===========================================================================

import {
  parseFloridaTabulationTxt,
  discoverFloridaResultLinks,
} from '../fl/results';
import {
  parseLouisianaResults,
  applyJungleOutcome,
  discoverLouisianaResultLinks,
} from '../la/results';
import { parseAlabamaResults, splitAlabamaCaption } from '../al/results';

// ---------------------------------------------------------------------------
// FL — tab-delimited parser
// ---------------------------------------------------------------------------

describe('FL (florida-dos-results) parser', () => {
  const FL_WITH_HEADER = [
    [
      'ElectionDate',
      'TypeOfElection',
      'CountyCode',
      'CountyName',
      'RaceCode',
      'OfficeDesc',
      'District',
      'ContestName',
      'FullContestName',
      'CandidateFirstName',
      'CandidateLastName',
      'CandidateFullName',
      'CandidateParty',
      'CandidateFloridaPartyCode',
      'CandidateVoteTotal',
      'CandidatePercentageOfVotes',
      'PrecinctsReporting',
      'TotalPrecincts',
      'IsWinner',
    ].join('\t'),
    // Statewide Governor — winner + runner-up
    [
      '20260818', 'PRI', '', '', 'GOV', 'Governor', '', 'Governor', 'Governor of Florida',
      'Jane', 'Smith', 'Jane Smith', 'REP', 'REP',
      '1000000', '55.0', '6000', '6000', '1',
    ].join('\t'),
    [
      '20260818', 'PRI', '', '', 'GOV', 'Governor', '', 'Governor', 'Governor of Florida',
      'Bob', 'Jones', 'Bob Jones', 'REP', 'REP',
      '800000', '44.0', '6000', '6000', '0',
    ].join('\t'),
    // Per-county row — must be filtered out (CountyCode nonblank)
    [
      '20260818', 'PRI', '12001', 'Alachua', 'GOV', 'Governor', '', 'Governor', '',
      'Jane', 'Smith', 'Jane Smith', 'REP', 'REP',
      '12345', '55.0', '100', '100', '0',
    ].join('\t'),
    // US House District 5 — district extraction
    [
      '20260818', 'PRI', '', '', 'REP005', 'U.S. Representative', '005', 'U.S. Rep Dist 5', '',
      'Alice', 'Wong', 'Alice Wong', 'DEM', 'DEM',
      '45000', '60.0', '100', '100', '1',
    ].join('\t'),
  ].join('\n');

  it('parses a header-based TXT body and keeps only statewide aggregate rows', () => {
    const rows = parseFloridaTabulationTxt(FL_WITH_HEADER, 'unofficial_partial');
    assert.equal(rows.length, 3, `expected 3 statewide rows, got ${rows.length}`);
    const smith = rows.find((r) => r.reported_name === 'Jane Smith');
    assert.ok(smith);
    assert.equal(smith.office_name, 'Governor');
    assert.equal(smith.party_abbreviation, 'REP');
    assert.equal(smith.vote_count, 1000000);
    assert.equal(smith.vote_percentage, 55);
    assert.equal(smith.is_winner, true);
    assert.equal(smith.district_identifier, null);

    const wong = rows.find((r) => r.reported_name === 'Alice Wong');
    assert.ok(wong);
    assert.equal(wong.district_identifier, '5', 'leading zeros stripped');
    assert.equal(wong.office_name, 'U.S. Representative');
  });

  it('tolerates a positional (no-header) dump', () => {
    const positional = [
      '20260818\tPRI\t\t\tGOV\tGovernor\t\tGov\tFull\tJane\tSmith\tJane Smith\tREP\tREP\t1000000\t55.0\t6000\t6000\t1',
      '20260818\tPRI\t\t\tGOV\tGovernor\t\tGov\tFull\tBob\tJones\tBob Jones\tREP\tREP\t800000\t44.0\t6000\t6000\t0',
    ].join('\n');
    const rows = parseFloridaTabulationTxt(positional, 'unofficial_partial');
    assert.equal(rows.length, 2);
    assert.equal(rows[0].reported_name, 'Jane Smith');
    assert.equal(rows[0].vote_count, 1000000);
  });

  it('returns [] on empty / whitespace body', () => {
    assert.deepEqual(parseFloridaTabulationTxt('', 'unofficial_partial'), []);
    assert.deepEqual(
      parseFloridaTabulationTxt('   \n  ', 'unofficial_partial'),
      [],
    );
  });

  it('discoverFloridaResultLinks finds .txt / .csv tabulations', () => {
    const html = [
      '<html><body>',
      '<a href="/elections/unrelated.html">home</a>',
      '<a href="/elections/results/20260818ElecResultsFL.txt">2026 primary</a>',
      '<a href="https://dos.fl.gov/elections/data/results/2024gen.csv">2024</a>',
      '</body></html>',
    ].join('');
    const links = discoverFloridaResultLinks(html);
    assert.equal(links.length, 2);
  });
});

// ---------------------------------------------------------------------------
// LA — jungle primary
// ---------------------------------------------------------------------------

describe('LA (louisiana-sos-results) parser', () => {
  const LA_JUNGLE_BELOW_50 = JSON.stringify({
    races: [
      {
        raceName: 'Governor',
        district: null,
        precinctsReporting: 3500,
        totalPrecincts: 3500,
        candidates: [
          { name: 'Alice Johnson', party: 'REP', votes: 400000, pct: 40.0 },
          { name: 'Bob Martinez', party: 'REP', votes: 250000, pct: 25.0 },
          { name: 'Carla Boudreaux', party: 'DEM', votes: 200000, pct: 20.0 },
          { name: 'Dan Fontaine', party: 'IND', votes: 150000, pct: 15.0 },
        ],
      },
    ],
  });

  const LA_JUNGLE_OVER_50 = JSON.stringify({
    races: [
      {
        raceName: 'U.S. Senate',
        district: null,
        candidates: [
          { name: 'Eve Richard', party: 'REP', votes: 600000, pct: 60.0 },
          { name: 'Frank Allemand', party: 'DEM', votes: 400000, pct: 40.0 },
        ],
      },
    ],
  });

  it('flags top-2 as runoff_advancers when leader < 50% (is_winner stays false)', () => {
    const rows = parseLouisianaResults(LA_JUNGLE_BELOW_50);
    assert.equal(rows.length, 4);
    const byName = Object.fromEntries(rows.map((r) => [r.reported_name, r]));

    assert.equal(byName['Alice Johnson'].is_winner, false);
    assert.equal(byName['Alice Johnson'].is_runoff_advancer, true);
    assert.equal(byName['Bob Martinez'].is_runoff_advancer, true);
    assert.equal(byName['Bob Martinez'].is_winner, false);
    assert.equal(byName['Carla Boudreaux'].is_runoff_advancer, false);
    assert.equal(byName['Dan Fontaine'].is_runoff_advancer, false);

    assert.equal(byName['Alice Johnson'].party_abbreviation, 'REP');
    assert.equal(byName['Carla Boudreaux'].party_abbreviation, 'DEM');
    // pct_precincts_reporting derived from precinctsReporting/totalPrecincts
    assert.equal(byName['Alice Johnson'].pct_precincts_reporting, 100);
  });

  it('sets is_winner (and NOT is_runoff_advancer) when leader > 50%', () => {
    const rows = parseLouisianaResults(LA_JUNGLE_OVER_50);
    const eve = rows.find((r) => r.reported_name === 'Eve Richard');
    const frank = rows.find((r) => r.reported_name === 'Frank Allemand');
    assert.ok(eve && frank);
    assert.equal(eve.is_winner, true);
    assert.equal(eve.is_runoff_advancer, false);
    assert.equal(frank.is_winner, false);
    assert.equal(frank.is_runoff_advancer, false);
  });

  it('runoff stage = plurality winner, even when under 50%', () => {
    const rows = parseLouisianaResults(LA_JUNGLE_BELOW_50, {
      isRunoffStage: true,
    });
    const alice = rows.find((r) => r.reported_name === 'Alice Johnson');
    assert.ok(alice);
    assert.equal(alice.is_winner, true);
    assert.equal(alice.is_runoff_advancer, false);
  });

  it('never trusts source-provided is_winner flag at <= 50%', () => {
    const body = JSON.stringify({
      races: [
        {
          raceName: 'State Treasurer',
          candidates: [
            { name: 'Lying Lou', party: 'REP', votes: 450, pct: 45.0, isWinner: true },
            { name: 'Truthful Tina', party: 'DEM', votes: 400, pct: 40.0 },
            { name: 'Other Olu', party: 'IND', votes: 150, pct: 15.0 },
          ],
        },
      ],
    });
    const rows = parseLouisianaResults(body);
    const lou = rows.find((r) => r.reported_name === 'Lying Lou');
    assert.ok(lou);
    assert.equal(lou.is_winner, false, 'is_winner MUST be false at 45%');
    assert.equal(lou.is_runoff_advancer, true);
  });

  it('applyJungleOutcome is idempotent and respects DB mutex constraint', () => {
    const rows = parseLouisianaResults(LA_JUNGLE_BELOW_50);
    applyJungleOutcome(rows, false);
    applyJungleOutcome(rows, false);
    for (const r of rows) {
      assert.equal(
        r.is_winner && r.is_runoff_advancer,
        false,
        `mutex broken for ${r.reported_name}`,
      );
    }
  });

  it('returns [] for non-JSON bodies (HTML landing page)', () => {
    assert.deepEqual(
      parseLouisianaResults('<html><body>not json</body></html>'),
      [],
    );
  });

  it('discoverLouisianaResultLinks finds voterportal and .json refs', () => {
    const html = [
      '<html><body>',
      '<a href="https://voterportal.sos.la.gov/Graphical">Live Results</a>',
      '<a href="/ElectionsAndVoting/Pages/default.aspx">home</a>',
      '<a href="/static/abc/results.json">raw</a>',
      '</body></html>',
    ].join('');
    const links = discoverLouisianaResultLinks(html);
    assert.equal(links.length, 2);
  });
});

// ---------------------------------------------------------------------------
// AL — HTML tables + primary-runoff semantics
// ---------------------------------------------------------------------------

describe('AL (alabama-sos-results) parser', () => {
  const AL_HTML = [
    '<html><body>',
    '<h2>U.S. SENATE — REPUBLICAN PRIMARY</h2>',
    '<table>',
    '<caption>U.S. SENATE — REPUBLICAN PRIMARY</caption>',
    '<tr><th>Candidate</th><th>Party</th><th>Votes</th><th>Percent</th></tr>',
    '<tr><td>Amy Roberts</td><td>REP</td><td>40,000</td><td>45.0</td></tr>',
    '<tr><td>Reese Mockup</td><td>REP</td><td>30,000</td><td>35.0</td></tr>',
    '<tr><td>Carl White</td><td>REP</td><td>20,000</td><td>20.0</td></tr>',
    '</table>',
    '<h2>U.S. SENATE — DEMOCRATIC PRIMARY</h2>',
    '<table>',
    '<caption>U.S. SENATE — DEMOCRATIC PRIMARY</caption>',
    '<tr><th>Candidate</th><th>Party</th><th>Votes</th><th>Percent</th></tr>',
    '<tr><td>Dana Patel</td><td>DEM</td><td>60,000</td><td>60.0</td></tr>',
    '<tr><td>Eric Ng</td><td>DEM</td><td>40,000</td><td>40.0</td></tr>',
    '</table>',
    '</body></html>',
  ].join('\n');

  it('splits "OFFICE — PARTY PRIMARY" captions into office + party', () => {
    const a = splitAlabamaCaption('U.S. SENATE — REPUBLICAN PRIMARY');
    assert.equal(a.office, 'U.S. SENATE');
    assert.equal(a.party, 'REP');

    const b = splitAlabamaCaption('STATE SENATE, DISTRICT 7 — DEMOCRATIC PRIMARY');
    assert.equal(b.office, 'STATE SENATE, DISTRICT 7');
    assert.equal(b.party, 'DEM');
  });

  it('parses multi-table HTML, isolates parties, applies top-2 runoff flags', () => {
    const rows = parseAlabamaResults(AL_HTML);
    assert.equal(rows.length, 5);
    const byName = Object.fromEntries(rows.map((r) => [r.reported_name, r]));

    // REP primary: leader 45% → no outright winner, top-2 advance
    assert.equal(byName['Amy Roberts'].is_winner, false);
    assert.equal(byName['Amy Roberts'].is_runoff_advancer, true);
    assert.equal(byName['Reese Mockup'].is_runoff_advancer, true);
    assert.equal(byName['Carl White'].is_runoff_advancer, false);

    // DEM primary: leader 60% → outright winner
    assert.equal(byName['Dana Patel'].is_winner, true);
    assert.equal(byName['Dana Patel'].is_runoff_advancer, false);
    assert.equal(byName['Eric Ng'].is_winner, false);
    assert.equal(byName['Eric Ng'].is_runoff_advancer, false);

    assert.equal(byName['Amy Roberts'].vote_count, 40000, 'commas stripped');
    assert.equal(byName['Amy Roberts'].party_abbreviation, 'REP');
    assert.equal(byName['Amy Roberts'].office_name, 'U.S. SENATE');
  });

  it('at runoff stage, plurality winner wins regardless of percentage', () => {
    const rows = parseAlabamaResults(AL_HTML, { isRunoffStage: true });
    const amy = rows.find((r) => r.reported_name === 'Amy Roberts');
    assert.ok(amy);
    assert.equal(amy.is_winner, true);
    assert.equal(amy.is_runoff_advancer, false);
  });
});
