/**
 * Unit tests for ballot-lookup — the chain that turns an address into a
 * geocoded coordinate then into a precinct via PostGIS.
 *
 * External services (Census, Nominatim, Supabase) are mocked. We never hit a
 * real network in unit tests — the chain is brittle enough that a real
 * service flake would routinely break CI.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

// We import the module fresh in beforeEach so the in-memory caches reset
// between tests (the module-level `ballotCache` would otherwise leak state).
let ballotLookup: typeof import('../index');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FAKE_CENSUS_RESPONSE = {
  result: {
    addressMatches: [
      {
        coordinates: { x: -111.85, y: 41.06 }, // Logan, UT-ish
      },
    ],
  },
};

const FAKE_NOMINATIM_RESPONSE = [{ lat: '40.71', lon: '-74.00' }]; // NYC-ish

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeMockSupabase(opts: {
  precinctRow?: Record<string, unknown> | null;
  precinctError?: { message: string } | null;
}): SupabaseClient {
  return {
    rpc: vi.fn().mockResolvedValue({
      data: opts.precinctRow ?? null,
      error: opts.precinctError ?? null,
    }),
  } as unknown as SupabaseClient;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(async () => {
  // Force-reload the module so the in-memory ballotCache + cachedServiceClient
  // singletons are fresh for each test.
  vi.resetModules();
  // Suppress geocode-cache singleton — tests don't have NEXT_PUBLIC_SUPABASE_URL set.
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  ballotLookup = await import('../index');
  ballotLookup.clearBallotCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ===========================================================================
// detectTerritoryFromAddress
// ===========================================================================

describe('detectTerritoryFromAddress', () => {
  it('detects American Samoa (96799)', () => {
    const r = ballotLookup.detectTerritoryFromAddress('PO Box 1, Pago Pago AS 96799');
    expect(r).toEqual({ state_fips: '60', abbr: 'AS' });
  });

  it('detects Northern Mariana Islands (96950-96952)', () => {
    expect(ballotLookup.detectTerritoryFromAddress('1 St, Saipan MP 96950')?.abbr).toBe('MP');
    expect(ballotLookup.detectTerritoryFromAddress('1 St, Saipan MP 96952')?.abbr).toBe('MP');
  });

  it('detects Guam (96910-96932)', () => {
    expect(ballotLookup.detectTerritoryFromAddress('1 Marine Dr, Hagatna GU 96910')?.abbr).toBe('GU');
    expect(ballotLookup.detectTerritoryFromAddress('1 Marine Dr, Hagatna GU 96932')?.abbr).toBe('GU');
  });

  it('detects USVI (008xx)', () => {
    expect(ballotLookup.detectTerritoryFromAddress('1 Main, Charlotte Amalie VI 00802')?.abbr).toBe('VI');
  });

  it('detects Puerto Rico (006/007/009)', () => {
    expect(ballotLookup.detectTerritoryFromAddress('Calle 1, San Juan PR 00901')?.abbr).toBe('PR');
    expect(ballotLookup.detectTerritoryFromAddress('Calle 1, Bayamon PR 00956')?.abbr).toBe('PR');
  });

  it('returns null for mainland addresses', () => {
    expect(ballotLookup.detectTerritoryFromAddress('123 Main St, Salt Lake City, UT 84101')).toBeNull();
    expect(ballotLookup.detectTerritoryFromAddress('1 Infinite Loop, Cupertino, CA 95014')).toBeNull();
  });

  it('returns null for Hawaii addresses (96701-96898 but NOT 969xx territories)', () => {
    // 96813 = Honolulu, must NOT be flagged as a territory
    expect(ballotLookup.detectTerritoryFromAddress('1 Ala Moana, Honolulu HI 96813')).toBeNull();
  });

  it('handles ZIP+4 format', () => {
    const r = ballotLookup.detectTerritoryFromAddress('Calle 1, San Juan PR 00901-1234');
    expect(r?.abbr).toBe('PR');
  });

  it('returns null when no ZIP-shaped token present', () => {
    expect(ballotLookup.detectTerritoryFromAddress('no zip here')).toBeNull();
  });
});

// ===========================================================================
// geocodeAddress — happy paths + fallback chain
// ===========================================================================

describe('geocodeAddress', () => {
  it('Census happy path → returns coords without hitting Nominatim', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse(FAKE_CENSUS_RESPONSE),
    );

    const r = await ballotLookup.geocodeAddress('123 Main St, Salt Lake City, UT 84101');
    expect(r).toEqual({ lat: 41.06, lng: -111.85 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect((fetchSpy.mock.calls[0]![0] as string)).toContain('census.gov');
  });

  it('Census 503 → falls through to Nominatim', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({}, 503)) // Census fails
      .mockResolvedValueOnce(jsonResponse(FAKE_NOMINATIM_RESPONSE)); // Nominatim succeeds

    const r = await ballotLookup.geocodeAddress('123 Main St, Anywhere, US');
    expect(r).toEqual({ lat: 40.71, lng: -74 });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[1]![0] as string).toContain('nominatim');
  });

  it('Census returns no matches → falls through to Nominatim', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ result: { addressMatches: [] } }))
      .mockResolvedValueOnce(jsonResponse(FAKE_NOMINATIM_RESPONSE));

    const r = await ballotLookup.geocodeAddress('123 Made-up Rd, Nowhere');
    expect(r).toEqual({ lat: 40.71, lng: -74 });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('Both Census and Nominatim fail → returns null', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({}, 500))
      .mockResolvedValueOnce(jsonResponse([]));

    const r = await ballotLookup.geocodeAddress('123 Made-up Rd, Nowhere');
    expect(r).toBeNull();
  });

  it('Nominatim throws → returns null without crashing', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({}, 503))
      .mockRejectedValueOnce(new Error('network down'));

    const r = await ballotLookup.geocodeAddress('123 Made-up Rd, Nowhere');
    expect(r).toBeNull();
  });

  it('Census fetch throws (timeout) → falls through to Nominatim', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce(jsonResponse(FAKE_NOMINATIM_RESPONSE));

    const r = await ballotLookup.geocodeAddress('1 St, Town, US 12345');
    expect(r).toEqual({ lat: 40.71, lng: -74 });
  });

  it('territory address (PR) → skips Census, calls Nominatim only', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse(FAKE_NOMINATIM_RESPONSE),
    );

    const r = await ballotLookup.geocodeAddress('Calle 1, San Juan PR 00901');
    expect(r).toEqual({ lat: 40.71, lng: -74 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect((fetchSpy.mock.calls[0]![0] as string)).toContain('nominatim');
  });

  it('territory address (VI) with Nominatim failure → returns territory error structure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse([]));
    const r = await ballotLookup.geocodeAddress('1 Main, Charlotte Amalie VI 00802');
    expect(r).toEqual({
      error: 'territory_address_unsupported',
      state_fips: '78',
      abbr: 'VI',
    });
  });

  it('territory address (GU) with Nominatim failure → returns GU territory error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse([]));
    const r = await ballotLookup.geocodeAddress('1 Marine Dr, Hagatna GU 96910');
    expect(r).toMatchObject({
      error: 'territory_address_unsupported',
      abbr: 'GU',
    });
  });

  it('Nominatim non-numeric coords → null', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({}, 503))
      .mockResolvedValueOnce(jsonResponse([{ lat: 'NaN', lon: 'oops' }]));

    const r = await ballotLookup.geocodeAddress('123 Main, Town, US');
    expect(r).toBeNull();
  });

  it('Census malformed coords → falls through to Nominatim', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse({
          result: { addressMatches: [{ coordinates: { x: 'bad', y: null } }] },
        }),
      )
      .mockResolvedValueOnce(jsonResponse(FAKE_NOMINATIM_RESPONSE));

    const r = await ballotLookup.geocodeAddress('123 Main, Town, US');
    expect(r).toEqual({ lat: 40.71, lng: -74 });
  });
});

// ===========================================================================
// lookupPrecinct — exercises the Supabase RPC contract
// ===========================================================================

describe('lookupPrecinct', () => {
  it('happy path: RPC returns a precinct row', async () => {
    const supabase = makeMockSupabase({
      precinctRow: { id: 'p-1', race_ids: ['r-1', 'r-2'], district_info: {} },
    });

    const r = await ballotLookup.lookupPrecinct(41.06, -111.85, supabase);
    expect(r).not.toBeNull();
    expect(r!.id).toBe('p-1');

    // Verify we passed lng/lat in the right order to the PostGIS-wrapping RPC.
    const rpcCall = (supabase.rpc as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(rpcCall[0]).toBe('lookup_precinct');
    expect(rpcCall[1]).toEqual({ p_lng: -111.85, p_lat: 41.06 });
  });

  it('RPC returns array → unwraps the first row', async () => {
    const supabase = makeMockSupabase({
      precinctRow: [
        { id: 'p-2', race_ids: [], district_info: {} },
        { id: 'p-3', race_ids: [], district_info: {} },
      ] as unknown as Record<string, unknown>,
    });

    const r = await ballotLookup.lookupPrecinct(41.06, -111.85, supabase);
    expect(r!.id).toBe('p-2');
  });

  it('RPC returns empty array → null', async () => {
    const supabase = makeMockSupabase({
      precinctRow: [] as unknown as Record<string, unknown>,
    });

    const r = await ballotLookup.lookupPrecinct(41.06, -111.85, supabase);
    expect(r).toBeNull();
  });

  it('RPC returns null data → null', async () => {
    const supabase = makeMockSupabase({ precinctRow: null });
    const r = await ballotLookup.lookupPrecinct(41.06, -111.85, supabase);
    expect(r).toBeNull();
  });

  it('RPC returns error → null (no throw)', async () => {
    const supabase = makeMockSupabase({
      precinctRow: null,
      precinctError: { message: 'rpc failed' },
    });
    const r = await ballotLookup.lookupPrecinct(41.06, -111.85, supabase);
    expect(r).toBeNull();
  });

  it('RPC throws → returns null instead of propagating', async () => {
    const supabase = {
      rpc: vi.fn().mockRejectedValue(new Error('connection lost')),
    } as unknown as SupabaseClient;

    const r = await ballotLookup.lookupPrecinct(41.06, -111.85, supabase);
    expect(r).toBeNull();
  });
});

// ===========================================================================
// clearBallotCache — sanity test for the test-helper export
// ===========================================================================

describe('clearBallotCache', () => {
  it('exists and is callable', () => {
    expect(typeof ballotLookup.clearBallotCache).toBe('function');
    expect(() => ballotLookup.clearBallotCache()).not.toThrow();
  });
});
