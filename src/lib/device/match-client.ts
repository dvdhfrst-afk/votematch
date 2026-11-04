/**
 * Client match engine (work-order 1A deliverable 2).
 *
 * Given the on-device VoterProfile + a PublicPositionsBundle, produce the same
 * MatchResult[] the server produces, by REUSING the one canonical matcher:
 * `computeMatchesForUser` from src/lib/matching/algorithm.ts. We do NOT fork the
 * weighted-L1 math, the scope filter, the office-dims intersection, the
 * dims_source flag, or the MIN_OVERLAP_FOR_SCORE honesty rule. This module's
 * only job is to ADAPT the lean bundle shape into the `CandidateWithPositions[]`
 * + `SubDimension[]` + `User` inputs the matcher already consumes, then hand off.
 *
 * algorithm.ts is a pure TS module (no `server-only`, no fs, type-only supabase
 * imports). Its one runtime env read is `process.env.MATCHING_MULTIVARIABLE`,
 * which is undefined in the browser bundle and therefore evaluates to the
 * production default (OFF). So importing + running it client-side is safe and
 * produces the SAME arithmetic the production server runs. (No extraction into a
 * separate core.ts was required: the deny rule only blocks EDITING algorithm.ts,
 * and we only import from it. See the build report for detail.)
 *
 * Score parity is proved by a fixture test: a server-side computeMatchesForUser
 * run captured to JSON, then reproduced here from the bundle, asserted equal.
 */

import type {
  Candidate,
  CandidateWithPositions,
  MatchResult,
  Position,
  SourceCitation,
  SubDimension,
  User,
} from '@/types/database';
import { computeMatchesForUser } from '@/lib/matching/algorithm';
import { setOfficeDimsOverride } from '@/lib/matching/office-dims';
import { deriveWeights } from '@/lib/matching/weights';
import type { VoterProfile } from './types';
import type {
  BundleCandidate,
  BundlePosition,
  BundleRace,
  BundleSubDimension,
  PositionsBundle,
} from './bundle';

// ---------------------------------------------------------------------------
// Bundle position -> DB Position (the shape selectPositionsForView consumes)
// ---------------------------------------------------------------------------
// selectPositionsForView filters on:
//   - source_citations.some(c => !!c.url)   (drop empty-URL placeholder rows)
//   - view_type='stated' rows' source_tier  (STATED_OK_TIERS guard)
//   - created_at (most-recent-wins per view)
//   - axis_kind / axis_id (multivariable ON path only; absent here -> OFF path)
// We synthesize a minimal source_citations array from hasCitationUrl so that
// filter behaves IDENTICALLY to the server, without shipping citation prose.

function bundlePositionToDbPosition(
  candidateId: string,
  bp: BundlePosition,
): Position {
  // One synthetic citation carrying only a url flag. The matcher's guard is
  // `.some(c => !!c.url)`, so a single url-bearing citation reproduces the
  // "has a real citation" branch; hasCitationUrl=false reproduces the
  // placeholder-drop branch exactly.
  const source_citations: SourceCitation[] = bp.hasCitationUrl
    ? [{ url: 'about:bundle', title: 'source' }]
    : bp.citationCount > 0
      ? [{ url: '', title: 'placeholder' }]
      : [];

  return {
    id: bp.id,
    candidate_id: candidateId,
    sub_dimension_id: bp.sub_dimension_id,
    view_type: bp.view_type,
    score: bp.score,
    confidence: bp.confidence,
    source_citations,
    nuance_notes: null,
    ai_summary: null,
    extraction_audit_id: null,
    created_at: bp.created_at,
    source_tier: bp.source_tier,
  };
}

// ---------------------------------------------------------------------------
// Bundle race+candidate -> CandidateWithPositions (matcher input)
// ---------------------------------------------------------------------------

function bundleToCandidatesWithPositions(
  race: BundleRace,
  bc: BundleCandidate,
): CandidateWithPositions {
  const positions = bc.positions.map((bp) =>
    bundlePositionToDbPosition(bc.id, bp),
  );

  const candidate: Candidate = {
    id: bc.id,
    name: bc.name,
    party: bc.party,
    race_id: race.id,
    bio: null,
    photo_url: null,
    website_url: null,
    questionnaire_status: 'not_invited',
    published: true,
    created_at: '',
    updated_at: '',
  };

  return {
    ...candidate,
    positions,
    race: {
      id: race.id,
      name: race.name,
      level: race.level,
      district: race.district,
      election_date: race.election_date,
      type: race.type,
      relevant_dimensions: race.relevant_dimensions,
    },
  };
}

// ---------------------------------------------------------------------------
// Bundle sub-dimension -> DB SubDimension
// ---------------------------------------------------------------------------

function bundleSubDimToDb(bsd: BundleSubDimension): SubDimension {
  return {
    id: bsd.id,
    domain: bsd.domain,
    name: bsd.name,
    spectrum_low: bsd.spectrum_low,
    spectrum_high: bsd.spectrum_high,
    display_order: bsd.display_order,
    scope_applicability: bsd.scope_applicability,
  };
}

// ---------------------------------------------------------------------------
// VoterProfile -> User (matcher input)
// ---------------------------------------------------------------------------
// The matcher reads only user.quick_match_answers (domains + positions +
// match_view) and user.weights. We rebuild both from the device profile using
// the SAME deriveWeights() the server uses, so the emphasis vector is identical.

function deviceProfileToUser(profile: VoterProfile): User {
  const domains = profile.emphasis?.chosenDomains ?? [];
  const positions = Object.values(profile.answers).map((a) => ({
    sub_dimension_id: a.subDimensionId,
    score: a.score,
  }));
  const quick_match_answers = {
    domains,
    positions,
    match_view: profile.matchView,
  };
  const weights =
    profile.emphasis?.domainWeights ??
    deriveWeights({ domains, positions: [] });

  return {
    id: profile.localId,
    session_token: '',
    address_text: null,
    precinct_id: null,
    quick_match_answers,
    weights,
    email: null,
    spi_consent_at: null,
    match_view: profile.matchView,
    created_at: profile.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Score every race in the bundle for the on-device voter. Returns the SAME
 * MatchResult[] the server's `/api/match` computes (OFF-flag, production
 * default), because it delegates to the SAME `computeMatchesForUser`.
 *
 * Honest degradation is inherited from the matcher: a candidate with no
 * overlapping positions scores null (insufficient overlap); a voter who hasn't
 * answered yields empty userPositions and every candidate scores null.
 */
export function computeMatchesFromBundle(
  profile: VoterProfile,
  bundle: PositionsBundle,
): MatchResult[] {
  const user = deviceProfileToUser(profile);
  const subDimensions = bundle.subDimensions.map(bundleSubDimToDb);

  const candidates: CandidateWithPositions[] = [];
  for (const race of bundle.races) {
    for (const bc of race.candidates) {
      candidates.push(bundleToCandidatesWithPositions(race, bc));
    }
  }

  // FLAG PARITY (work-order 1B item 3). The matcher reads
  // MATCHING_RESPECT_OFFICE_DIMS via respectOfficeDimsEnabled(), which in the
  // browser has no server env to read and would fall back to the production-OFF
  // default — under-scoring vs the real server (office-dims ON in production).
  // The bundle carries the server-resolved flag; we apply it through the
  // office-dims module's documented override (NOT by mutating process.env,
  // which is inert in the browser) for the duration of this call, then restore.
  //
  // multivariable: the client only reproduces the OFF (production-default) axis
  // branch — the multivariable path needs per-race axis weights that are not in
  // the public bundle. If the server ever flips MATCHING_MULTIVARIABLE ON, the
  // bundle's flag records it; we still score the OFF branch and the parity
  // fixture (captured with the server's flags) is the guard that this stays in
  // sync. Applying only the office-dims override keeps the two paths aligned in
  // the production reality (office-dims ON, multivariable OFF).
  const flags = bundle.matchingFlags;
  const prevOverride =
    flags !== undefined ? setOfficeDimsOverride(flags.respectOfficeDims) : null;
  try {
    // Delegate to the ONE canonical matcher. matchView flows through
    // quick_match_answers.match_view (deviceProfileToUser sets it).
    return computeMatchesForUser(
      user,
      candidates,
      subDimensions,
      profile.matchView,
    );
  } finally {
    // Restore the prior override so we never leak client flag state (matters in
    // tests + any SSR path that imports this module).
    if (flags !== undefined) setOfficeDimsOverride(prevOverride);
  }
}

/**
 * Convenience: the top scorable pick per race, mirroring the guide's
 * getBallotPlan() logic (a race whose candidates are all insufficient-overlap
 * surfaces candidateId null = "decide at the booth"). Used by 1B to seed the
 * device plan from a fresh match without re-implementing the selection rule.
 */
export function topPicksFromMatches(
  results: MatchResult[],
): Array<{ raceId: string; candidateId: string | null; score: number | null }> {
  return results.map((r) => {
    // candidates are already rank-sorted (nulls last) by the matcher.
    const top = r.candidates.find((c) => c.score !== null) ?? null;
    return {
      raceId: r.race.id,
      candidateId: top?.candidate.id ?? null,
      score: top?.score ?? null,
    };
  });
}
