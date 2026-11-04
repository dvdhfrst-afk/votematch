/**
 * Unit tests for the Ohio live-results adapter.
 *
 * Covers:
 *   1. Adapter metadata (FIPS, tokenBucket, costService, sourceType).
 *   2. Parser happy path: a synthetic OH-flavored NIST (1622/D1) document
 *      produces one row per CandidateSelection with statewide vote
 *      counts, party lookups, and district identifiers intact.
 *   3. Empty/off-cycle body: non-XML responses return [] (so the runner
 *      flags `partial` against expectedMinRows=15).
 *   4. Malformed XML: `parseOhNistXml` throws so runAdapter records
 *      `failed` on ingestion_runs.
 *
 * No network.
 *
 * Run:
 *   npx tsx --test src/lib/adapters/state-sos/oh/__tests__/live-results.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  createOhLiveResultsAdapter,
  parseOhNistXml,
} from '../live-results';
import type { AdapterContext } from '../../../types';

// Small synthetic OH-ENR 1.0.02 style document (fictional candidates,
// invented vote counts) using the real <Election>-wrapped shape.
const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'oh-liveresults-2026-04-24.xml',
);

// ---------------------------------------------------------------------------
// Synthetic fixture — Ohio 1622/D1 dialect. Two contests:
//   - "Governor and Lieutenant Governor" (no district)
//   - "U.S. House" (district 7, extracted from GpUnit name)
// Each has two candidates (one Republican, one Democrat), one write-in.
// ---------------------------------------------------------------------------
const OH_SYNTHETIC_XML = `<?xml version="1.0"?>
<ElectionReport xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns="http://grouper.ieee.org/groups/1622/groups/2/V1/1622_2-election_results_reporting.xsd" GeneratedDate="2026-05-05T20:00:00Z" IsTest="false" Status="UnofficialPartial" VendorApplicationId="Ohio-ENR 1.0.02">
  <Code Type="Fips" Value="39"/>
  <GpUnitCollection>
    <GpUnit xsi:type="ReportingUnit" ObjectId="gp-state" Name="Statewide" IsElectoralDistrict="true" Type="State"/>
    <GpUnit xsi:type="ReportingUnit" ObjectId="gp-cd7" Name="Congressional District 7" IsElectoralDistrict="true" Type="Congressional"/>
    <GpUnit xsi:type="ReportingUnit" ObjectId="gp-adams" Name="Adams" Type="County"/>
  </GpUnitCollection>
  <PartyCollection>
    <Party ObjectId="party-dem" Abbreviation="DEM">
      <Name><LanguageString Language="en">Democratic</LanguageString></Name>
    </Party>
    <Party ObjectId="party-rep" Abbreviation="REP">
      <Name><LanguageString Language="en">Republican</LanguageString></Name>
    </Party>
  </PartyCollection>
  <PersonCollection>
    <Person ObjectId="per-alice">
      <FirstName>Alice</FirstName>
      <LastName>Example</LastName>
      <PartyId>party-dem</PartyId>
    </Person>
    <Person ObjectId="per-bob">
      <FirstName>Bob</FirstName>
      <LastName>Example</LastName>
      <PartyId>party-rep</PartyId>
    </Person>
  </PersonCollection>
  <CandidateCollection>
    <Candidate ObjectId="cand-alice">
      <BallotName><LanguageString Language="en">Alice Example</LanguageString></BallotName>
      <PartyId>party-dem</PartyId>
      <PersonId>per-alice</PersonId>
    </Candidate>
    <Candidate ObjectId="cand-bob">
      <BallotName><LanguageString Language="en">Bob Example</LanguageString></BallotName>
      <PartyId>party-rep</PartyId>
      <PersonId>per-bob</PersonId>
    </Candidate>
    <Candidate ObjectId="cand-wi" IsWriteIn="true">
      <BallotName><LanguageString Language="en">Carol Writein</LanguageString></BallotName>
    </Candidate>
    <Candidate ObjectId="cand-house-d">
      <BallotName><LanguageString Language="en">Dave House</LanguageString></BallotName>
      <PartyId>party-dem</PartyId>
    </Candidate>
    <Candidate ObjectId="cand-house-r">
      <BallotName><LanguageString Language="en">Eve House</LanguageString></BallotName>
      <PartyId>party-rep</PartyId>
    </Candidate>
  </CandidateCollection>
  <ContestCollection>
    <Contest xsi:type="CandidateContest" ObjectId="contest-gov" Name="Governor and Lieutenant Governor" VoteVariationType="NofM" NumberElected="1">
      <BallotSelection xsi:type="CandidateSelection" ObjectId="sel-gov-a" IsWriteIn="false">
        <VoteCountsCollection>
          <VoteCounts Type="Total" Count="120000">
            <GpUnitId>gp-state</GpUnitId>
          </VoteCounts>
          <VoteCounts Type="Total" Count="3500">
            <GpUnitId>gp-adams</GpUnitId>
          </VoteCounts>
        </VoteCountsCollection>
        <CandidateId>cand-alice</CandidateId>
      </BallotSelection>
      <BallotSelection xsi:type="CandidateSelection" ObjectId="sel-gov-b" IsWriteIn="false">
        <VoteCountsCollection>
          <VoteCounts Type="Total" Count="100000">
            <GpUnitId>gp-state</GpUnitId>
          </VoteCounts>
          <VoteCounts Type="Total" Count="4200">
            <GpUnitId>gp-adams</GpUnitId>
          </VoteCounts>
        </VoteCountsCollection>
        <CandidateId>cand-bob</CandidateId>
      </BallotSelection>
      <BallotSelection xsi:type="CandidateSelection" ObjectId="sel-gov-wi" IsWriteIn="true">
        <VoteCountsCollection>
          <VoteCounts Type="Total" Count="250">
            <GpUnitId>gp-state</GpUnitId>
          </VoteCounts>
        </VoteCountsCollection>
        <CandidateId>cand-wi</CandidateId>
      </BallotSelection>
      <OfficeId>off-gov</OfficeId>
    </Contest>
    <Contest xsi:type="CandidateContest" ObjectId="contest-cd7" Name="U.S. House of Representatives">
      <ElectoralDistrictId>gp-cd7</ElectoralDistrictId>
      <BallotSelection xsi:type="CandidateSelection" ObjectId="sel-house-d" IsWriteIn="false">
        <VoteCountsCollection>
          <VoteCounts Type="Total" Count="42000">
            <GpUnitId>gp-state</GpUnitId>
          </VoteCounts>
        </VoteCountsCollection>
        <CandidateId>cand-house-d</CandidateId>
      </BallotSelection>
      <BallotSelection xsi:type="CandidateSelection" ObjectId="sel-house-r" IsWriteIn="false">
        <VoteCountsCollection>
          <VoteCounts Type="Total" Count="51000">
            <GpUnitId>gp-state</GpUnitId>
          </VoteCounts>
        </VoteCountsCollection>
        <CandidateId>cand-house-r</CandidateId>
      </BallotSelection>
    </Contest>
  </ContestCollection>
</ElectionReport>`;

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

describe('OH live-results adapter — metadata', () => {
  it('declares the right FIPS / tokenBucket / costService / name', () => {
    const adapter = createOhLiveResultsAdapter();
    assert.equal(adapter.stateFips, '39');
    assert.deepEqual(adapter.tokenBucket, { rps: 0.5, burst: 2 });
    assert.equal(adapter.costService, 'other');
    assert.equal(adapter.name, 'sos-ohio-sos-liveresults-xml');
  });

  it('carries the live XML endpoint as sourceUrl via the source descriptor', async () => {
    const adapter = createOhLiveResultsAdapter();
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(OH_SYNTHETIC_XML, {
        status: 200,
        headers: { 'Content-Type': 'application/xml' },
      }) as Response;
    try {
      const outcome = await adapter.run(mockCtx());
      assert.equal(outcome.source.sourceType, 'sos_results_api');
      assert.equal(outcome.source.stateFips, '39');
      assert.match(
        outcome.source.url,
        /liveresults\.ohiosos\.gov\/Api\/v1\/download/,
      );
      assert.equal(outcome.source.license, 'state_open_records');
      assert.equal(outcome.expectedMinRows, 15);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('OH live-results adapter — parser happy path', () => {
  it('parses statewide vote counts, party abbreviations, and district ids', () => {
    const rows = parseOhNistXml(
      OH_SYNTHETIC_XML,
      { reportingLevel: 'unofficial_partial', includeWriteIns: true },
    );
    // 3 gov rows (two candidates + one write-in) + 2 house rows = 5.
    assert.equal(rows.length, 5);

    const alice = rows.find((r) => r.reported_name === 'Alice Example');
    assert.ok(alice, 'Alice row present');
    assert.equal(alice!.party_abbreviation, 'DEM');
    assert.equal(alice!.office_name, 'Governor and Lieutenant Governor');
    assert.equal(alice!.district_identifier, null);
    assert.equal(alice!.vote_count, 120000); // statewide, NOT county
    assert.equal(alice!.is_write_in, false);
    assert.equal(alice!.reporting_level, 'unofficial_partial');

    const bob = rows.find((r) => r.reported_name === 'Bob Example');
    assert.ok(bob, 'Bob row present');
    assert.equal(bob!.vote_count, 100000);
    assert.equal(bob!.party_abbreviation, 'REP');

    const carol = rows.find((r) => r.reported_name === 'Carol Writein');
    assert.ok(carol, 'write-in row present');
    assert.equal(carol!.is_write_in, true);
    assert.equal(carol!.party_abbreviation, null);

    const dave = rows.find((r) => r.reported_name === 'Dave House');
    assert.ok(dave, 'US House D candidate present');
    assert.equal(dave!.district_identifier, '7', 'district extracted from GpUnit');
    assert.equal(dave!.vote_count, 42000);
    assert.equal(dave!.office_name, 'U.S. House of Representatives');
  });

  it('suppresses write-ins when includeWriteIns=false', () => {
    const rows = parseOhNistXml(
      OH_SYNTHETIC_XML,
      { reportingLevel: 'unofficial_partial', includeWriteIns: false },
    );
    assert.equal(rows.length, 4);
    assert.ok(!rows.some((r) => r.is_write_in));
  });

  it('emits reporting_level per options', () => {
    const rows = parseOhNistXml(
      OH_SYNTHETIC_XML,
      { reportingLevel: 'state_certified', includeWriteIns: true },
    );
    assert.ok(rows.length > 0);
    for (const r of rows) assert.equal(r.reporting_level, 'state_certified');
  });
});

describe('OH live-results adapter — degenerate inputs', () => {
  it('returns [] on empty body', () => {
    const rows = parseOhNistXml(
      '',
      { reportingLevel: 'unofficial_partial', includeWriteIns: true },
    );
    assert.deepEqual(rows, []);
  });

  it('returns [] on HTML body (off-cycle landing page / CF wall)', () => {
    const rows = parseOhNistXml(
      '<!doctype html><html><body>not xml</body></html>',
      { reportingLevel: 'unofficial_partial', includeWriteIns: true },
    );
    assert.deepEqual(rows, []);
  });

  it('returns [] when no Type="State" GpUnit exists', () => {
    const noStateGpUnit = OH_SYNTHETIC_XML.replace(
      'Type="State"',
      'Type="SomethingElse"',
    );
    const rows = parseOhNistXml(
      noStateGpUnit,
      { reportingLevel: 'unofficial_partial', includeWriteIns: true },
    );
    assert.deepEqual(rows, []);
  });

  it('throws on malformed XML (so runner records failed)', () => {
    // Must be > 64 chars or the short-body guard silently returns [].
    const malformed =
      '<?xml version="1.0"?><ElectionReport xmlns="foo"><UNCLOSED_TAG_HERE_abcdef' +
      ' plenty of text to cross the short-body guard</ElectionReport>';
    assert.throws(
      () =>
        parseOhNistXml(
          malformed,
          { reportingLevel: 'unofficial_partial', includeWriteIns: true },
        ),
      /parseOhNistXml: XML parse failed/,
    );
  });

  it('adapter.run() surfaces HTTP 5xx as a thrown error', async () => {
    const adapter = createOhLiveResultsAdapter();
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response('oops', { status: 503 }) as Response;
    try {
      await assert.rejects(
        () => adapter.run(mockCtx()),
        /OH live fetch failed/,
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('adapter.run() returns rows=[] for HTML body so runAdapter flags partial', async () => {
    const adapter = createOhLiveResultsAdapter();
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response('<!doctype html><html></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      }) as Response;
    try {
      const outcome = await adapter.run(mockCtx());
      assert.equal(outcome.rows.length, 0);
      assert.equal(outcome.expectedMinRows, 15);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

// Fixture-file test: exercises the <Election>-wrapped shape that the real
// OH-ENR 1.0.02 feed uses, against a small synthetic file with fictional
// candidates. Guards against regressions in the Election-wrapper handling.
describe('OH live-results adapter — synthetic fixture file', () => {
  const hasFixture = existsSync(FIXTURE_PATH);
  (hasFixture ? it : it.skip)(
    'parses the synthetic Election-wrapped dataset',
    () => {
      const xml = readFileSync(FIXTURE_PATH, 'utf8');
      const rows = parseOhNistXml(
        xml,
        { reportingLevel: 'unofficial_partial', includeWriteIns: true },
      );
      // 6 candidate contests, 14 selections; the ballot-measure contest
      // is skipped.
      assert.equal(rows.length, 14);

      // Spot-check office coverage.
      const offices = new Set(rows.map((r) => r.office_name));
      assert.ok(
        offices.has('Governor and Lieutenant Governor'),
        'governor contest present',
      );
      assert.ok(
        offices.has('Attorney General'),
        'attorney general contest present',
      );
      assert.ok(!offices.has('State Issue 1'), 'ballot measure skipped');

      // Every row must have non-empty reported_name + office_name.
      for (const r of rows) {
        assert.ok(r.reported_name.length > 0);
        assert.ok(r.office_name.length > 0);
        assert.ok(
          r.vote_count === null || r.vote_count >= 0,
          `non-negative vote_count: ${r.vote_count}`,
        );
      }

      // Statewide count is used, not the county count.
      const first = rows.find((r) => r.reported_name === 'Alex Testcandidate');
      assert.ok(first, 'first fictional candidate present');
      assert.equal(first!.vote_count, 4000);

      // District identifiers come from the GpUnit name.
      const districts = new Set(
        rows.map((r) => r.district_identifier).filter((d) => d !== null),
      );
      assert.deepEqual([...districts].sort(), ['1', '2', '3']);

      const parties = new Set(rows.map((r) => r.party_abbreviation));
      assert.ok(
        parties.has('DEM') && parties.has('REP') && parties.has('LIB'),
        `expected DEM+REP+LIB in party set, got: ${[...parties].join(',')}`,
      );
    },
  );
});
