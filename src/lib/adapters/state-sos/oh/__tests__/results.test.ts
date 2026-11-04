/**
 * Unit tests for the Ohio results adapter.
 *
 * Ohio is the trivial case: the SoS portal publishes NIST 1500-100 XML
 * which flows through parseNistXml() with no OH-specific parsing. We
 * verify the adapter:
 *   - composes via createOhResultsAdapter()
 *   - declares the right FIPS + costService + tokenBucket
 *   - feeds NIST XML through parseNistXml (end-to-end via injected fetch)
 *   - tolerates off-cycle / non-NIST bodies (returns [])
 *
 * No network.
 *
 * Run:
 *   npx tsx --test src/lib/adapters/state-sos/oh/__tests__/results.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createOhResultsAdapter } from '../results';
import type { AdapterContext } from '../../../types';

const SYNTHETIC_OH_NIST = `<?xml version="1.0" encoding="UTF-8"?>
<ElectionReport xmlns="http://itl.nist.gov/ns/voting/1500-100/v2">
  <Party ObjectId="party-dem">
    <Abbreviation>DEM</Abbreviation>
    <Name>Democratic Party</Name>
  </Party>
  <Party ObjectId="party-rep">
    <Abbreviation>REP</Abbreviation>
    <Name>Republican Party</Name>
  </Party>
  <GpUnit ObjectId="gp-state">
    <Name>Ohio</Name>
    <Type>state</Type>
  </GpUnit>
  <Election>
    <Candidate ObjectId="cand-a">
      <BallotName>Alice Example</BallotName>
      <PartyId>party-dem</PartyId>
    </Candidate>
    <Candidate ObjectId="cand-b">
      <BallotName>Bob Example</BallotName>
      <PartyId>party-rep</PartyId>
    </Candidate>
    <Contest ObjectId="contest-gov" type="CandidateContest">
      <Name>Governor</Name>
      <ElectoralDistrictId>gp-state</ElectoralDistrictId>
      <PctReporting>80</PctReporting>
      <ContestSelection ObjectId="sel-a" type="CandidateSelection">
        <CandidateIds>cand-a</CandidateIds>
        <IsWinner>true</IsWinner>
        <VoteCounts>
          <Count>100000</Count>
          <Type>total</Type>
        </VoteCounts>
      </ContestSelection>
      <ContestSelection ObjectId="sel-b" type="CandidateSelection">
        <CandidateIds>cand-b</CandidateIds>
        <VoteCounts>
          <Count>80000</Count>
          <Type>total</Type>
        </VoteCounts>
      </ContestSelection>
    </Contest>
  </Election>
</ElectionReport>`;

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

describe('OH results adapter', () => {
  it('declares the right FIPS, tokenBucket, costService', () => {
    const adapter = createOhResultsAdapter();
    assert.equal(adapter.stateFips, '39');
    assert.deepEqual(adapter.tokenBucket, { rps: 0.5, burst: 2 });
    assert.equal(adapter.costService, 'other');
    assert.equal(adapter.name, 'sos-ohio-sos-liveresults');
  });

  it('parses NIST XML end-to-end via injected fetch', async () => {
    let fetched = false;
    const adapter = createOhResultsAdapter({
      // Override the base fetch via adapter.run monkey-patch.
    });
    // Swap parse/fetch by recreating with a synthetic body: use the
    // global fetch mock. We can invoke the adapter's run() with a
    // manually constructed StateFetchResult by bypassing fetch entirely
    // — the simplest way is to call parseNistXml directly via the
    // factory's exposed parse. Here we just verify createOhResultsAdapter
    // composition produces rows when NIST XML is fed in.
    //
    // Simulate a run by calling the factory's behavior: constructors
    // from base.ts call options.parse() inside adapter.run(). We inject
    // a fake fetch through global.fetch substitution for the duration of
    // this assertion.
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(SYNTHETIC_OH_NIST, {
        status: 200,
        headers: { 'Content-Type': 'application/xml' },
      }) as Response;
    try {
      const outcome = await adapter.run(mockCtx());
      fetched = true;
      assert.equal(outcome.rows.length, 2);
      const alice = outcome.rows.find((r) => r.reported_name === 'Alice Example');
      assert.ok(alice, 'Alice row present');
      assert.equal(alice.party_abbreviation, 'DEM');
      assert.equal(alice.vote_count, 100000);
      assert.equal(alice.is_winner, true);
      assert.equal(alice.office_name, 'Governor');
      assert.equal(alice.pct_precincts_reporting, 80);
      assert.equal(outcome.source.sourceType, 'sos_results_api');
      assert.equal(outcome.source.stateFips, '39');
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.ok(fetched, 'adapter.run() completed');
  });

  it('returns [] for non-NIST body (off-cycle HTML landing page)', async () => {
    const adapter = createOhResultsAdapter();
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response('<!doctype html><html><body>Ohio SoS home</body></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      }) as Response;
    try {
      const outcome = await adapter.run(mockCtx());
      assert.equal(outcome.rows.length, 0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('throws on upstream HTTP 5xx', async () => {
    const adapter = createOhResultsAdapter();
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response('oops', { status: 503 }) as Response;
    try {
      await assert.rejects(() => adapter.run(mockCtx()), /OH fetch failed/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
