import type { BallotResult, DistrictInfo, Precinct, RaceWithCandidates } from '@/types/database';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import crypto from 'crypto';

// ---------------------------------------------------------------------------
// In-memory cache keyed by precinct_id (hot layer; also persisted to DB)
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const CACHE_MAX_SIZE = 500;

const ballotCache = new Map<string, { result: BallotResult; expiresAt: number }>();

function getCachedBallot(precinctId: string): BallotResult | undefined {
  const entry = ballotCache.get(precinctId);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    ballotCache.delete(precinctId);
    return undefined;
  }
  return entry.result;
}

function setCachedBallot(precinctId: string, result: BallotResult): void {
  if (ballotCache.size >= CACHE_MAX_SIZE) {
    const firstKey = ballotCache.keys().next().value;
    if (firstKey) ballotCache.delete(firstKey);
  }
  ballotCache.set(precinctId, { result, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ---------------------------------------------------------------------------
// Persistent geocode cache (Supabase geocode_cache table)
// ---------------------------------------------------------------------------
// Survives serverless cold starts. Addresses rarely change coordinates.
// ---------------------------------------------------------------------------

function hashAddress(address: string): string {
  return crypto.createHash('sha256').update(address.toLowerCase().trim()).digest('hex');
}

// geocode_cache is service-role only (see migration 20260420000000_geocode_cache_privacy.sql).
// The caller's supabase client is an anon client; we use a lazily-constructed service
// client for cache ops so the cache is always reachable, regardless of request context.
let cachedServiceClient: SupabaseClient | null = null;
function getGeocodeCacheClient(): SupabaseClient | null {
  if (cachedServiceClient) return cachedServiceClient;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  cachedServiceClient = createSupabaseClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cachedServiceClient;
}

async function getCachedGeocode(
  address: string,
): Promise<{ lat: number; lng: number } | undefined> {
  const client = getGeocodeCacheClient();
  if (!client) return undefined;
  try {
    const { data } = await client
      .from('geocode_cache')
      .select('lat, lng')
      .eq('address_hash', hashAddress(address))
      .single();
    if (data) return { lat: data.lat, lng: data.lng };
  } catch {
    // Cache miss — not an error
  }
  return undefined;
}

async function setCachedGeocode(
  address: string,
  lat: number,
  lng: number,
): Promise<void> {
  const client = getGeocodeCacheClient();
  if (!client) return;
  try {
    await client.from('geocode_cache').upsert(
      {
        address_hash: hashAddress(address),
        lat,
        lng,
      },
      { onConflict: 'address_hash' },
    );
  } catch {
    // Non-fatal: cache write failure doesn't block the user
  }
}

// ---------------------------------------------------------------------------
// Territory routing (council finding #9)
// ---------------------------------------------------------------------------
// The Census Bureau Geocoder silently returns no matches for Puerto Rico
// and the 5 territories — there is no error, just an empty addressMatches.
// We detect territory ZIPs up-front and skip Census for those addresses,
// going straight to Nominatim with a country filter, and surface a
// structured error when nothing resolves so the UI can fall back to a
// county/jurisdiction selector instead of a generic "ballot not found".
// ---------------------------------------------------------------------------

/** ZIP-prefix → state_fips for the 5 territories + PR. */
type TerritoryRoute = {
  state_fips: '72' | '78' | '66' | '69' | '60';
  abbr: 'PR' | 'VI' | 'GU' | 'MP' | 'AS';
};

/**
 * Detect a territory address by its ZIP prefix. Returns null for non-
 * territory ZIPs (mainland + HI + AK + DC).
 *
 * Prefix map (USPS / IRS / Census ZIP allocations):
 *   006-009 → PR (Puerto Rico) — note 008xx overlaps PR/VI; 008 is VI.
 *   008     → USVI (U.S. Virgin Islands) — overrides the 006-009 PR span.
 *   969     → GU (Guam) AND MP (Northern Mariana Islands).
 *             969xx is HI's range too; we disambiguate by full prefix:
 *             96910–96932 = GU; 96950–96952 = MP. Anything 96701–96898
 *             that is NOT 969xx is HI and is NOT a territory.
 *   96799   → AS (American Samoa) — only ZIP allocated to AS.
 *
 * The address string we receive may be free-form. We extract the rightmost
 * 5-digit run that looks like a ZIP (with optional ZIP+4) and route on
 * that. Misses (no ZIP found) return null and fall through to the normal
 * Census→Nominatim chain.
 */
export function detectTerritoryFromAddress(
  address: string,
): TerritoryRoute | null {
  // Pull the last 5-digit ZIP-shaped token (handles ZIP+4 like 00901-1234).
  const m = address.match(/(\d{5})(?:-\d{4})?\s*$/);
  if (!m) return null;
  const zip = m[1]!;
  const prefix3 = zip.slice(0, 3);
  const prefix5 = zip.slice(0, 5);

  // American Samoa: single ZIP.
  if (prefix5 === '96799') return { state_fips: '60', abbr: 'AS' };
  // Northern Mariana Islands: 96950-96952.
  if (prefix5 === '96950' || prefix5 === '96951' || prefix5 === '96952') {
    return { state_fips: '69', abbr: 'MP' };
  }
  // Guam: 96910-96932.
  const z = parseInt(prefix5, 10);
  if (z >= 96910 && z <= 96932) return { state_fips: '66', abbr: 'GU' };
  // U.S. Virgin Islands: 008xx.
  if (prefix3 === '008') return { state_fips: '78', abbr: 'VI' };
  // Puerto Rico: 006, 007, 009 (and historical 008 USVI carve-out above
  // already handled).
  if (prefix3 === '006' || prefix3 === '007' || prefix3 === '009') {
    return { state_fips: '72', abbr: 'PR' };
  }
  return null;
}

/**
 * Returned by geocodeAddress / lookupBallot when an address is in a
 * territory the Census geocoder cannot resolve and Nominatim also failed.
 * The UI checks for `error === 'territory_address_unsupported'` and routes
 * to a jurisdiction-selector flow instead of showing "no ballot found".
 */
export type TerritoryUnsupportedError = {
  error: 'territory_address_unsupported';
  state_fips: '72' | '78' | '66' | '69' | '60';
  abbr: 'PR' | 'VI' | 'GU' | 'MP' | 'AS';
};

// ---------------------------------------------------------------------------
// geocodeAddress
// ---------------------------------------------------------------------------
// Tries Census Bureau geocoder first, then falls back to Nominatim (OSM).
// Census has a 500 req/day hard limit and no SLA, AND silently fails for
// every territory — see {@link detectTerritoryFromAddress}, which routes
// territory addresses straight to Nominatim.
// Nominatim is free with a 1 req/sec courtesy limit.
// Results are persisted to DB so each unique address is geocoded at most once.
// ---------------------------------------------------------------------------

async function geocodeCensus(
  address: string,
): Promise<{ lat: number; lng: number } | null> {
  const encoded = encodeURIComponent(address);
  const url =
    `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress` +
    `?address=${encoded}&benchmark=Public_AR_Current&format=json`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;

    const data = await res.json();
    const matches = data?.result?.addressMatches;
    if (!Array.isArray(matches) || matches.length === 0) return null;

    const coords = matches[0]?.coordinates;
    if (!coords || typeof coords.x !== 'number' || typeof coords.y !== 'number') return null;

    return { lat: coords.y, lng: coords.x };
  } catch {
    return null;
  }
}

async function geocodeNominatim(
  address: string,
): Promise<{ lat: number; lng: number } | null> {
  const encoded = encodeURIComponent(address);
  // Nominatim usage policy: 1 req/sec, descriptive User-Agent, no bulk use.
  const url =
    `https://nominatim.openstreetmap.org/search` +
    `?q=${encoded}&format=json&countrycodes=us&limit=1`;

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
      headers: {
        'User-Agent': 'Havesay/1.0 (nonpartisan voter-information project, in development)',
      },
    });
    if (!res.ok) return null;

    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) return null;

    const lat = parseFloat(data[0].lat);
    const lng = parseFloat(data[0].lon);
    if (isNaN(lat) || isNaN(lng)) return null;

    return { lat, lng };
  } catch {
    return null;
  }
}

export async function geocodeAddress(
  address: string,
  _supabase?: SupabaseClient,
): Promise<{ lat: number; lng: number } | TerritoryUnsupportedError | null> {
  // 1. Check persistent DB cache (service role; see getGeocodeCacheClient)
  const cached = await getCachedGeocode(address);
  if (cached) return cached;

  // 2. Territory router (council #9): PR/VI/GU/MP/AS ZIPs skip Census,
  //    which silently returns no matches for every non-mainland address.
  const territory = detectTerritoryFromAddress(address);

  let coords: { lat: number; lng: number } | null = null;

  if (territory) {
    // Skip Census for territory ZIPs — go straight to Nominatim. Census
    // has no data for these addresses and consumes our 500/day quota
    // returning empties.
    coords = await geocodeNominatim(address);
    if (!coords) {
      // Surface a structured error so the UI can route to a county /
      // jurisdiction selector instead of a generic "ballot not found".
      return {
        error: 'territory_address_unsupported',
        state_fips: territory.state_fips,
        abbr: territory.abbr,
      };
    }
  } else {
    // 3. Mainland + HI + AK + DC: try Census Bureau (primary).
    coords = await geocodeCensus(address);

    // 4. Fallback to Nominatim/OSM if Census fails (outage, rate limit, rural)
    if (!coords) {
      coords = await geocodeNominatim(address);
    }
  }

  // 5. Persist to DB cache
  if (coords) {
    await setCachedGeocode(address, coords.lat, coords.lng);
  }

  return coords;
}

// ---------------------------------------------------------------------------
// lookupPrecinct
// ---------------------------------------------------------------------------
// Uses a PostGIS spatial query to find which precinct polygon contains the
// given point.  Returns the precinct row (with district_info) or null.
// ---------------------------------------------------------------------------

export async function lookupPrecinct(
  lat: number,
  lng: number,
  supabase: SupabaseClient,
): Promise<Precinct | null> {
  try {
    // Use an RPC call wrapping the PostGIS query so we don't need raw SQL
    // access from the client.  The Supabase function is expected to be:
    //
    //   CREATE FUNCTION lookup_precinct(p_lng float8, p_lat float8)
    //   RETURNS precincts AS $$
    //     SELECT * FROM precincts
    //     WHERE ST_Contains(geom, ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326))
    //     LIMIT 1;
    //   $$ LANGUAGE sql STABLE;
    //
    const { data, error } = await supabase.rpc('lookup_precinct', {
      p_lng: lng,
      p_lat: lat,
    });

    if (error || !data) return null;

    // RPC may return an array or a single object depending on config
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return null;

    return row as Precinct;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// getRacesForPrecinct
// ---------------------------------------------------------------------------
// Fetches all races (with nested candidates) for a given precinct's race_ids.
// ---------------------------------------------------------------------------

async function getRacesForPrecinct(
  precinct: Precinct,
  supabase: SupabaseClient,
): Promise<RaceWithCandidates[]> {
  if (!precinct.race_ids || precinct.race_ids.length === 0) return [];

  const { data, error } = await supabase
    .from('races')
    .select('*, candidates(*)')
    .in('id', precinct.race_ids);

  if (error || !data) return [];

  return data as RaceWithCandidates[];
}

// ---------------------------------------------------------------------------
// lookupBallot
// ---------------------------------------------------------------------------
// End-to-end: address → geocode → precinct → races with candidates.
// Results are cached in-memory by precinct_id.
// ---------------------------------------------------------------------------

export async function lookupBallot(
  address: string,
  supabase: SupabaseClient,
): Promise<BallotResult | TerritoryUnsupportedError | null> {
  // Step 1: Geocode (with persistent cache + fallback geocoder).
  //         Territory addresses that fail Nominatim return a structured
  //         error the caller can route on (council #9).
  const coords = await geocodeAddress(address, supabase);
  if (!coords) return null;
  if ('error' in coords) return coords; // territory_address_unsupported

  // Step 2: Find precinct
  const precinct = await lookupPrecinct(coords.lat, coords.lng, supabase);
  if (!precinct) return null;

  // Step 3: Check cache
  const cached = getCachedBallot(precinct.id);
  if (cached) return cached;

  // Step 4: Fetch races
  const races = await getRacesForPrecinct(precinct, supabase);

  const result: BallotResult = {
    precinct_id: precinct.id,
    races,
    district_info: precinct.district_info,
  };

  // Cache for future lookups from the same precinct
  setCachedBallot(precinct.id, result);

  return result;
}

// ---------------------------------------------------------------------------
// validateWithGoogleCivic
// ---------------------------------------------------------------------------
// Optional quality-check against the Google Civic Information API.  Used for
// verification, not as the primary lookup path.
// ---------------------------------------------------------------------------

export interface CivicValidationResult {
  matched: boolean;
  /** OCD-ID strings, e.g. "ocd-division/country:us/state:ut/cd:1" */
  divisions: string[];
  /** Human-readable division names keyed by OCD-ID */
  divisionNames: Record<string, string>;
  raw: unknown;
}

/**
 * Validate an address against the Google Civic Information API.
 * Uses the /divisionsByAddress endpoint (the /representatives endpoint
 * was shut down 2025-04-30). Returns OCD-IDs and division names.
 */
export async function validateWithGoogleCivic(
  address: string,
  apiKey: string,
): Promise<CivicValidationResult | null> {
  const encoded = encodeURIComponent(address);
  const url =
    `https://www.googleapis.com/civicinfo/v2/divisionsByAddress` +
    `?address=${encoded}&key=${apiKey}`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;

    const data = await res.json();

    const divisionsMap: Record<string, { name: string }> =
      data.divisions ?? {};

    const divisions = Object.keys(divisionsMap);
    const divisionNames: Record<string, string> = {};
    for (const [ocdId, info] of Object.entries(divisionsMap)) {
      divisionNames[ocdId] = (info as { name: string }).name;
    }

    return {
      matched: divisions.length > 0,
      divisions,
      divisionNames,
      raw: data,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// clearBallotCache (for testing / admin)
// ---------------------------------------------------------------------------

export function clearBallotCache(): void {
  ballotCache.clear();
}
