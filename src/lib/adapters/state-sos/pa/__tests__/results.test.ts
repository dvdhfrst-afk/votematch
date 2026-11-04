/**
 * Unit tests for the Pennsylvania results adapter.
 *
 * No network. Drives parsePaJson() + parsePaResultTables() with synthetic
 * fixtures shaped like the election-night XML/JSON/HTML we expect.
 *
 * Run:
 *   npx tsx --test src/lib/adapters/state-sos/pa/__tests__/results.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parsePaJson, parsePaResultTables } from '../results';

describe('PA results — parsePaJson', () => {
  it('parses a multi-race election-night payload into populated rows', () => {
    const fixture = {
      Elections: [
        {
          Races: [
            {
              RaceName: 'Governor',
              District: '',
              PrecinctsReporting: 85.0,
              Candidates: [
                {
                  CandidateName: 'Jane Smith',
                  PartyCode: 'DEM',
                  TotalVotes: 1234567,
                  PercentVote: 53.4,
                  IsWinner: true,
                  IsWriteIn: false,
                },
                {
                  CandidateName: 'Bob Jones',
                  PartyCode: 'REP',
                  TotalVotes: 1000000,
                  PercentVote: 43.2,
                  IsWinner: false,
                  IsWriteIn: false,
                },
                {
                  CandidateName: 'Write-In',
                  PartyCode: null,
                  TotalVotes: 42,
                  PercentVote: 0.0,
                  IsWinner: false,
                  IsWriteIn: true,
                },
              ],
            },
            {
              RaceName: 'U.S. House',
              District: '1',
              PrecinctsReporting: 90.0,
              Candidates: [
                {
                  CandidateName: 'Alice Wong',
                  PartyCode: 'DEM',
                  TotalVotes: 210000,
                  PercentVote: 60.0,
                  IsWinner: true,
                  IsWriteIn: false,
                },
              ],
            },
          ],
        },
      ],
    };

    const rows = parsePaJson(fixture, 'unofficial_partial');

    assert.equal(rows.length, 4, `expected 4 rows, got ${rows.length}`);

    const smith = rows.find((r) => r.reported_name === 'Jane Smith');
    assert.ok(smith, 'Jane Smith row');
    assert.equal(smith.office_name, 'Governor');
    assert.equal(smith.party_abbreviation, 'DEM');
    assert.equal(smith.vote_count, 1234567);
    assert.equal(smith.vote_percentage, 53.4);
    assert.equal(smith.pct_precincts_reporting, 85.0);
    assert.equal(smith.is_winner, true);
    assert.equal(smith.is_write_in, false);
    assert.equal(smith.reporting_level, 'unofficial_partial');

    const writeIn = rows.find((r) => r.is_write_in);
    assert.ok(writeIn, 'write-in row');
    assert.equal(writeIn.vote_count, 42);

    const alice = rows.find((r) => r.reported_name === 'Alice Wong');
    assert.ok(alice, 'Alice row');
    assert.equal(alice.district_identifier, '1');
  });

  it('returns empty array for an empty payload', () => {
    assert.deepEqual(parsePaJson({}, 'unofficial_partial'), []);
    assert.deepEqual(parsePaJson([], 'unofficial_partial'), []);
    assert.deepEqual(
      parsePaJson({ Elections: [{ Races: [] }] }, 'unofficial_partial'),
      [],
    );
  });
});

describe('PA results — parsePaResultTables', () => {
  it('parses an HTML table under a heading into rows', () => {
    const html = `
      <html><body>
        <h2>Governor</h2>
        <table>
          <thead>
            <tr><th>Candidate</th><th>Party</th><th>Votes</th></tr>
          </thead>
          <tbody>
            <tr><td>Jane Smith</td><td>DEM</td><td>1,234,567</td></tr>
            <tr><td>Bob Jones</td><td>REP</td><td>1,000,000</td></tr>
          </tbody>
        </table>
      </body></html>
    `;
    const rows = parsePaResultTables(html, 'state_certified');
    assert.equal(rows.length, 2);
    assert.equal(rows[0].office_name, 'Governor');
    assert.equal(rows[0].reported_name, 'Jane Smith');
    assert.equal(rows[0].vote_count, 1234567);
    assert.equal(rows[0].party_abbreviation, 'DEM');
    assert.equal(rows[0].reporting_level, 'state_certified');
  });

  it('returns empty array for HTML without a recognizable results table', () => {
    const html = '<html><body><p>No elections today.</p></body></html>';
    assert.deepEqual(parsePaResultTables(html, 'unofficial_partial'), []);
  });
});
