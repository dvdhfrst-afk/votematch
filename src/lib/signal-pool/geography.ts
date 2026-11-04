/**
 * Server-side COARSE GEOGRAPHY resolver for the signal pool (Phase 3B, part 2).
 *
 * The opt-in UI needs the voter's state + congressional district to build a
 * contribution (district fidelity is the product). That geography is resolved
 * SERVER-SIDE from the session's already-resolved ballot point, then passed to
 * the client component as a prop. The device never derives geography from an
 * address itself; it only ever sees the coarse (state, cd) pair.
 *
 * GRACEFUL: returns null whenever geography cannot be resolved (no session, no
 * address point, no containing congressional district, feature flag off). The
 * opt-in UI renders an honest "look up your ballot first" state on null.
 *
 * PRIVACY: this resolves ONLY the coarse (USPS state, congressional district)
 * pair. It does not persist the point, and the pair it returns is the same
 * fidelity that already appears on the voter's ballot.
 *
 * No em-dashes or en-dashes anywhere per the project formatting rule.
 */

import { createServiceClient } from '@/lib/supabase/server';
import { getSessionUser } from '@/lib/session';
import { isSignalPoolEnabled } from './flag';
import {
  lookupDistrictsForPoint,
  numericDistrict,
} from '@/lib/ballot-lookup/district-lookup';
import { STATE_ABBR_TO_FIPS } from '@/lib/ingest/state-fips';
import type { CoarseGeography } from '@/lib/device/pool-contribution';

/** FIPS -> USPS, inverted from the canonical USPS -> FIPS map. */
const FIPS_TO_STATE_ABBR: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(STATE_ABBR_TO_FIPS).map(([abbr, fips]) => [fips, abbr]),
);

/**
 * The session user shape we read for a resolved ballot point. Kept loose because
 * the session snapshot carries an evolving set of fields; we only need a lat/lng
 * if one is present. Returns null on any absence so the caller degrades.
 */
interface PointBearingUser {
  ballot_lat?: number | null;
  ballot_lng?: number | null;
  lat?: number | null;
  lng?: number | null;
  quick_match_answers?: { ballot_lat?: number | null; ballot_lng?: number | null } | null;
}

function extractPoint(user: unknown): { lat: number; lng: number } | null {
  if (!user || typeof user !== 'object') return null;
  const u = user as PointBearingUser;
  const lat = u.ballot_lat ?? u.lat ?? u.quick_match_answers?.ballot_lat ?? null;
  const lng = u.ballot_lng ?? u.lng ?? u.quick_match_answers?.ballot_lng ?? null;
  if (typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng)) {
    return { lat, lng };
  }
  return null;
}

/**
 * Resolve the voter's coarse (state, cd) from the current session. Returns null
 * when the feature is off, there is no session point, or no containing
 * congressional district. Never throws; any failure degrades to null.
 */
export async function resolveCoarseGeography(): Promise<CoarseGeography | null> {
  if (!isSignalPoolEnabled()) return null;
  try {
    const user = await getSessionUser();
    const point = extractPoint(user);
    if (!point) return null;

    const supabase = await createServiceClient();
    const districts = await lookupDistrictsForPoint(point.lat, point.lng, supabase);
    if (districts.length === 0) return null;

    const cong = districts.find((d) => d.district_type === 'us_congressional');
    const stateFips =
      districts.map((d) => d.state_fips).find((f): f is string => !!f) ?? null;
    if (!stateFips) return null;
    const state = FIPS_TO_STATE_ABBR[stateFips] ?? null;
    if (!state) return null;

    // At-large states have a single congressional district; represent it as '00'
    // when a numeric district cannot be parsed. This is the coarse marker the
    // pool keys on, never invented finer than the ballot already resolves.
    const cd = cong ? (numericDistrict(cong.district_number) ?? '00') : '00';

    return { state, cd };
  } catch {
    return null;
  }
}
