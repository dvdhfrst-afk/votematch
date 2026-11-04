/**
 * Score-parity proof for the client match engine (work-order 1A).
 *
 * The fixture in ./fixtures/match-parity.json is SYNTHETIC: an 11-race ballot
 * of fictional offices and fictional candidates with generated position
 * scores, shaped exactly like a production PositionsBundle. Its serverResults
 * are the canonical matcher's output (computeMatchesForUser) for that bundle
 * and the recorded device profile.
 *
 * This test runs the CLIENT engine (computeMatchesFromBundle) over that bundle
 * and asserts it reproduces those scores/ranks/counts EXACTLY. Because the
 * client engine delegates to the same computeMatchesForUser, parity is
 * structural; this locks it so a future refactor cannot silently diverge.
 *
 * The fixture records the matcher's env flags at capture time; we pin them here
 * so both paths evaluate the identical code branch.
 *
 * FLAG PARITY (work-order 1B item 3): the fixture is now captured under the
 * PRODUCTION flag posture — office-dims ON (MATCHING_RESPECT_OFFICE_DIMS=true),
 * multivariable OFF. Every race scores on the office-scoped dim set
 * (dims_source='office_scoped'), which is what the production server does. The
 * bundle carries matchingFlags.respectOfficeDims=true; the client matcher applies
 * it via setOfficeDimsOverride (see match-client.ts) so it does NOT under-score by
 * falling back to the browser's production-OFF process.env default. The earlier
 * fixture was captured office-dims OFF (level_fallback) and therefore did not
 * guard the production reality; this one does.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fixture from './fixtures/match-parity.json';
import { computeMatchesFromBundle } from '../match-client';
import type { PositionsBundle } from '../bundle';
import type { VoterProfile } from '../types';

const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const [k, v] of Object.entries(fixture.env)) {
    savedEnv[k] = process.env[k];
    if (v === null || v === undefined) delete process.env[k];
    else process.env[k] = String(v);
  }
});

afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('client match engine — score parity with the server', () => {
  const bundle = fixture.bundle as unknown as PositionsBundle;
  const profile = fixture.deviceProfile as unknown as VoterProfile;

  it('fixture is non-trivial (full ballot, some scores)', () => {
    expect(bundle.races.length).toBeGreaterThanOrEqual(10);
    const scored = fixture.serverResults.flatMap((r) =>
      r.candidates.filter((c) => c.score !== null),
    );
    expect(scored.length).toBeGreaterThan(0);
  });

  it('bundle carries the production flag posture (office-dims ON)', () => {
    // Work-order 1B item 3: the fixture is captured under the production reality,
    // MATCHING_RESPECT_OFFICE_DIMS=true. The bundle must carry that resolved flag
    // so the client matcher scores on the office-scoped branch (not the browser's
    // production-OFF process.env default). This is the assertion that would have
    // caught the pre-1B parity gap, where the bundle had no matchingFlags and the
    // client silently under-scored vs the office-dims-ON server.
    expect(bundle.matchingFlags).toBeDefined();
    expect(bundle.matchingFlags?.respectOfficeDims).toBe(true);
    expect(bundle.matchingFlags?.multivariable).toBe(false);
    // Cross-check: the env the fixture pins agrees with the flag it carries.
    expect(fixture.env.MATCHING_RESPECT_OFFICE_DIMS).toBe('true');
    // And every race was actually scored on the office-scoped dim set, proving
    // the ON branch was exercised end-to-end (not a level-fallback in disguise).
    for (const r of fixture.serverResults) {
      expect(r.dims_source).toBe('office_scoped');
    }
  });

  it('reproduces the server MatchResult[] exactly', () => {
    const clientResults = computeMatchesFromBundle(profile, bundle);

    // Index client results by race for comparison.
    const clientByRace = new Map(clientResults.map((r) => [r.race.id, r]));

    // Same set of races.
    const serverRaceIds = new Set(fixture.serverResults.map((r) => r.raceId));
    const clientRaceIds = new Set(clientResults.map((r) => r.race.id));
    expect([...clientRaceIds].sort()).toEqual([...serverRaceIds].sort());

    for (const sr of fixture.serverResults) {
      const cr = clientByRace.get(sr.raceId);
      expect(cr, `missing race ${sr.raceId}`).toBeTruthy();
      if (!cr) continue;

      // dims_source flag must agree (office-scoped vs level-fallback).
      expect(cr.dims_source).toBe(sr.dims_source);

      const clientByCand = new Map(
        cr.candidates.map((c) => [c.candidate.id, c]),
      );

      // Same candidates.
      expect([...clientByCand.keys()].sort()).toEqual(
        sr.candidates.map((c) => c.candidateId).sort(),
      );

      for (const sc of sr.candidates) {
        const cc = clientByCand.get(sc.candidateId);
        expect(cc, `missing candidate ${sc.candidateId}`).toBeTruthy();
        if (!cc) continue;
        expect(cc.score, `score ${sc.candidateId}`).toBe(sc.score);
        expect(cc.rank, `rank ${sc.candidateId}`).toBe(sc.rank);
        expect(cc.tied_with_top, `tied ${sc.candidateId}`).toBe(sc.tied_with_top);
        expect(cc.answered_both_count, `abc ${sc.candidateId}`).toBe(
          sc.answered_both_count,
        );
        expect(cc.applicable_count, `apc ${sc.candidateId}`).toBe(
          sc.applicable_count,
        );
        expect(cc.confidence, `conf ${sc.candidateId}`).toBe(sc.confidence);
        expect(cc.match_view_used, `view ${sc.candidateId}`).toBe(
          sc.match_view_used,
        );
      }
    }
  });

  it('bundle payload is under the 300KB budget for the 11-race ballot', () => {
    const bytes = Buffer.byteLength(JSON.stringify(bundle), 'utf8');
    expect(bytes).toBeLessThan(300 * 1024);
  });
});
