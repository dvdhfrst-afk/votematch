import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getSessionUser } from '@/lib/session';
import { resolveSessionRaceIds } from '@/lib/ballot-lookup/ballot-loader';
import { resolveMatchCandidates } from '@/lib/matching/resolve-match-candidates';
import { formatCandidateName } from '@/lib/text/candidate-name';
import { sanitizeDisplayName } from '@/lib/text/sanitize-display';
import { isWellDocumented, computeCandidateQualityCountsBulk } from '@/lib/data-quality';
import {
  POSITIONS_BUNDLE_VERSION,
  type BundleCandidate,
  type BundlePosition,
  type BundleRace,
  type BundleSubDimension,
  type MatchingFlags,
  type PositionsBundle,
} from '@/lib/device/bundle';
import { respectOfficeDimsEnabled } from '@/lib/matching/office-dims';
import { multivariableMatchingEnabled } from '@/lib/matching/algorithm';
import type {
  CandidateWithPositions,
  Position,
  RaceLevel,
  RaceType,
  SubDimension,
} from '@/types/database';

/**
 * GET /api/positions-bundle
 *
 * The PUBLIC per-ballot payload the on-device app downloads on open and scores
 * against locally (work-order 1A deliverable 3).
 *
 * IN:  only the existing anonymous session cookie, used purely to resolve WHICH
 *      races are on this voter's ballot (their address) via the SAME
 *      resolveSessionRaceIds + resolveMatchCandidates path /api/match uses. No
 *      voter opinion is read or accepted here.
 * OUT: races + candidates + LEAN renderable position vectors (sub_dimension_id,
 *      score, confidence, view_type, citation COUNT only, source_tier) + office
 *      relevant_dimensions + sub_dimension metadata. NO citation text, NO voter
 *      data. Target < ~300KB for an 11-race ballot.
 *
 * Cacheable: private (per-session ballot), short max-age. Reusing the server
 * resolver guarantees the client scores the same candidate/position set the
 * server would, so client and server match scores agree by construction.
 */

function normLevel(L: string): RaceLevel {
  if (
    L === 'federal' || L === 'state' || L === 'county' ||
    L === 'municipal' || L === 'judicial' || L === 'school' || L === 'special'
  ) {
    return L as RaceLevel;
  }
  return 'county';
}

/** Project a full DB Position into the lean BundlePosition (drops citation text). */
function toBundlePosition(p: Position): BundlePosition {
  const cites = p.source_citations ?? [];
  return {
    id: p.id,
    sub_dimension_id: p.sub_dimension_id,
    score: p.score,
    view_type: p.view_type,
    confidence: p.confidence,
    source_tier: (p.source_tier as string | null) ?? null,
    created_at: p.created_at,
    citationCount: cites.length,
    hasCitationUrl: cites.some((c) => !!c.url),
  };
}

export async function GET() {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json(
        { error: 'No active session. Please look up your ballot first.' },
        { status: 401 },
      );
    }

    const supabase = await createClient();

    // Resolve the SERVER's matching flags ONCE, from the real server env. These
    // ride along in the bundle so the client matcher scores on the identical
    // office-dims / multivariable branch the production server uses (work-order
    // 1B item 3). respectOfficeDimsEnabled() reads process.env server-side here;
    // in the browser that env is inert, which is exactly the parity gap this
    // closes. multivariableMatchingEnabled() is likewise a pure env read.
    const matchingFlags: MatchingFlags = {
      respectOfficeDims: respectOfficeDimsEnabled(),
      multivariable: multivariableMatchingEnabled(),
    };

    // 1. Resolve the SAME ballot race id set /ballot + /api/match resolve.
    const allRaceIds = await resolveSessionRaceIds(user);
    if (allRaceIds.length === 0) {
      // Honest empty bundle: a valid, scorable-against-nothing payload. The
      // device shows its "no ballot yet / look up your address" state.
      const empty: PositionsBundle = {
        version: POSITIONS_BUNDLE_VERSION,
        generatedAt: new Date().toISOString(),
        races: [],
        subDimensions: [],
        matchingFlags,
      };
      return NextResponse.json(empty, {
        headers: { 'Cache-Control': 'private, max-age=60' },
      });
    }

    // 2. Resolve candidates + positions + office dims via the SAME resolver the
    //    matcher uses. This is what makes client scores == server scores: they
    //    score the identical candidate/position set.
    let resolved: Awaited<ReturnType<typeof resolveMatchCandidates>>;
    try {
      resolved = await resolveMatchCandidates(supabase, allRaceIds);
    } catch {
      return NextResponse.json(
        { error: 'Failed to load candidates.' },
        { status: 500 },
      );
    }
    const { candidates, officeDimsByRace } = resolved;

    // 3. Load the sub-dimension taxonomy once (public-read).
    const { data: subDimData, error: subDimErr } = await supabase
      .from('sub_dimensions')
      .select(
        'id, domain, name, spectrum_low, spectrum_high, display_order, scope_applicability',
      );
    if (subDimErr || !subDimData) {
      return NextResponse.json(
        { error: 'Failed to load policy dimensions.' },
        { status: 500 },
      );
    }
    const subDimensions: BundleSubDimension[] = (subDimData as SubDimension[]).map(
      (sd) => ({
        id: sd.id,
        domain: sd.domain,
        name: sanitizeDisplayName(sd.name),
        spectrum_low: sd.spectrum_low,
        spectrum_high: sd.spectrum_high,
        display_order: sd.display_order,
        scope_applicability: sd.scope_applicability ?? {},
      }),
    );

    // 4. Coverage tier per candidate. A-tier uses the SAME well-documented
    //    triple-check the ballot loader uses (>=10 hi/med positions AND >=5
    //    sources AND >=2 source types), queried by the v_voter_candidates id.
    //    That id is the positions key for legacy candidates; for new-graph
    //    candidacies whose positions are person-native the quality query may
    //    undercount, so A-tier degrades CONSERVATIVELY to B for those (never a
    //    false A). B/C then falls out of the renderable-position count below.
    //    The tier is a display hint only; it never affects the client score.
    const candQualIds = candidates.map((c) => c.id);
    let wellDocumented = new Set<string>();
    try {
      const counts = await computeCandidateQualityCountsBulk(supabase, candQualIds);
      for (const id of candQualIds) {
        const rec = counts.get(id);
        if (rec && isWellDocumented(rec)) wellDocumented.add(id);
      }
    } catch {
      // Non-fatal: tier degrades to B/C off renderable-count if quality read fails.
      wellDocumented = new Set<string>();
    }

    // 5. Group resolved candidates into races and project to the lean bundle.
    const racesById = new Map<string, BundleRace>();
    for (const cwp of candidates as CandidateWithPositions[]) {
      const raceId = cwp.race_id;
      if (!racesById.has(raceId)) {
        const r = cwp.race;
        racesById.set(raceId, {
          id: raceId,
          name: sanitizeDisplayName(r?.name ?? ''),
          level: normLevel(r?.level ?? 'county'),
          district: r?.district ?? null,
          election_date: r?.election_date ?? '',
          type: (r?.type ?? 'general') as RaceType,
          relevant_dimensions: officeDimsByRace.get(raceId) ?? r?.relevant_dimensions ?? null,
          candidates: [],
        });
      }
      const positions = (cwp.positions as Position[]).map(toBundlePosition);
      const renderableCount = positions.length;
      const tier: BundleCandidate['tier'] = wellDocumented.has(cwp.id)
        ? 'A'
        : renderableCount > 0
          ? 'B'
          : 'C';
      racesById.get(raceId)!.candidates.push({
        id: cwp.id,
        name: formatCandidateName(cwp.name),
        party: cwp.party,
        tier,
        positions,
      });
    }

    const bundle: PositionsBundle = {
      version: POSITIONS_BUNDLE_VERSION,
      generatedAt: new Date().toISOString(),
      races: [...racesById.values()],
      subDimensions,
      matchingFlags,
    };

    return NextResponse.json(bundle, {
      headers: {
        // Per-session ballot: private, short-lived. The device also caches the
        // body in its service worker (Phase 1C); this header governs the HTTP
        // layer. 5 min max-age with SWR keeps election-week bursts cheap while
        // staying fresh enough as positions land.
        'Cache-Control': 'private, max-age=300, stale-while-revalidate=600',
      },
    });
  } catch (err) {
    console.error('positions-bundle error:', err);
    return NextResponse.json(
      { error: 'An unexpected error occurred building the ballot bundle.' },
      { status: 500 },
    );
  }
}
