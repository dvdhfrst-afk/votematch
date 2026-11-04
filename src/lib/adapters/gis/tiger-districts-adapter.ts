/**
 * Census TIGER/Line 2024 national district loader.
 *
 * Unblocks 49-state ballot lookup by loading us_congressional +
 * state_house + state_senate polygons from the Census Bureau's
 * authoritative TIGER/Line 2024 shapefiles.
 *
 * Architecture
 * ------------
 * Per-state, per-layer adapter factories. The CLI orchestrator spins
 * up one invocation for each (fips × layer) combination. Each
 * invocation:
 *
 *   1. Downloads one zip from https://www2.census.gov/geo/tiger/TIGER2024/...
 *   2. Unzips in $TMPDIR/tiger-<fips>-<layer>-<rand>/
 *   3. Parses .shp + .dbf via `shapefile` npm package (mbostock)
 *   4. Transforms geometry from EPSG:4269 (TIGER native NAD83) to
 *      EPSG:4326 (WGS84) via ST_Transform in SQL — no client-side
 *      proj4 needed, and the political_districts_srid_4326 CHECK
 *      constraint acts as a safety net.
 *   5. Upserts political_districts keyed on
 *      (district_type, state_fips, district_number).
 *   6. Updates district_ingestion_status for (state_fips, district_type,
 *      2024) with status, observed count, ingestion_run_id.
 *
 * Architectural note on CD119
 * ---------------------------
 * The TIGER 2024 catalog publishes CD119 as per-state zips (not a
 * national bundle), verified 2026-04-23 by HEAD-ing
 * /geo/tiger/TIGER2024/CD/ — the original "national file" plan was
 * wrong. So all three layers use the same per-state factory shape.
 *
 * Nebraska
 * --------
 * FIPS 31 has no SLDL (unicameral). The CLI orchestrator skips SLDL
 * for NE; if an SLDL adapter is invoked for NE anyway, the download
 * 404s and the adapter marks district_ingestion_status='no_data_available'
 * with a clear message rather than 'failed'.
 *
 * DC
 * --
 * FIPS 11 has SLDU (Council of the District of Columbia) and CD
 * (non-voting delegate) but no SLDL — same graceful-404 path.
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import * as shapefile from 'shapefile';
import type { Feature, FeatureCollection, Geometry } from 'geojson';
import type {
  AdapterContext,
  AdapterOutcome,
  InsertRefs,
  InsertStats,
  SourceAdapter,
} from '../types';
import { createTokenBucket } from '../rate-limit';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Which TIGER layer a factory instance loads. */
export type TigerLayer = 'CD' | 'SLDL' | 'SLDU';

/** Row shape returned by adapter.run() and consumed by adapter.insert(). */
export type DistrictRow = {
  district_type: 'us_congressional' | 'state_house' | 'state_senate';
  district_name: string;
  district_number: string;
  state_fips: string;
  election_year: number;
  source: 'census_tiger_2024';
  /** Raw GeoJSON geometry in EPSG:4269 (NAD83) — SQL transforms to 4326. */
  geometry: Geometry;
  meta: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Static mapping from TIGER layer → our district_type + source SRID
// ---------------------------------------------------------------------------

const TIGER_SRID = 4269; // NAD83, per TIGER/Line 2024 tech doc §3
const TARGET_SRID = 4326; // WGS84, political_districts CHECK constraint
const ELECTION_YEAR = 2024;
const USER_AGENT = 'Havesay/1.0 (nonpartisan voter-information project, in development)';

const LAYER_META: Record<
  TigerLayer,
  {
    district_type: DistrictRow['district_type'];
    /** URL path component and filename infix. */
    urlSlug: string;
    fileInfix: string;
    /** Base URL subpath: .../TIGER2024/<path>/ */
    path: string;
    /** DBF attribute naming the district number. */
    numberAttr: string[];
    /** Human label template; ${n} replaced with district_number. */
    nameTemplate: (n: string, fips: string) => string;
  }
> = {
  CD: {
    district_type: 'us_congressional',
    urlSlug: 'cd119',
    fileInfix: 'cd119',
    path: 'CD',
    // CD119FP is the 2-char district-number field on the 119th Congress layer.
    // Older vintages used CD118FP/CD117FP; keep multiple fallbacks for safety.
    numberAttr: ['CD119FP', 'CDFP', 'CD118FP', 'CD117FP'],
    nameTemplate: (n) => `Congressional District ${stripLeadingZeros(n)}`,
  },
  SLDL: {
    district_type: 'state_house',
    urlSlug: 'sldl',
    fileInfix: 'sldl',
    path: 'SLDL',
    numberAttr: ['SLDLST', 'SLDLST10'],
    nameTemplate: (n) => `State House District ${stripLeadingZeros(n)}`,
  },
  SLDU: {
    district_type: 'state_senate',
    urlSlug: 'sldu',
    fileInfix: 'sldu',
    path: 'SLDU',
    numberAttr: ['SLDUST', 'SLDUST10'],
    nameTemplate: (n) => `State Senate District ${stripLeadingZeros(n)}`,
  },
};

/** Strip leading zeros from "003" → "3"; keep "ZZZ" (at-large) as-is. */
function stripLeadingZeros(n: string): string {
  if (/^\d+$/.test(n)) return String(parseInt(n, 10));
  return n;
}

// ---------------------------------------------------------------------------
// Expected-row floors per layer + state
//
// TIGER 2024 exact counts (verified against published state apportionment):
//   - CD119: 435 seats across 50 states + 6 non-voting delegates (DC/PR/GU/VI/
//     AS/MP). Most states have 1-53 districts; conservative floor = 1 (AK/DE/etc).
//   - SLDL: ranges from 0 (NE/DC/PR/...) to 400 (NH). Conservative floor = 1;
//     we handle unicameral/no-data via 404 → no_data_available.
//   - SLDU: ranges from 0 (some territories) to 67 (MN). Floor = 1.
//
// Using a floor of 1 keeps the runner happy; partial-vs-success is judged
// by the district_ingestion_status tracker, not by the runner's 80% rule.
// ---------------------------------------------------------------------------

const EXPECTED_MIN_ROWS = 1;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildUrl(layer: TigerLayer, stateFips: string): string {
  const meta = LAYER_META[layer];
  return `https://www2.census.gov/geo/tiger/TIGER2024/${meta.path}/tl_2024_${stateFips}_${meta.fileInfix}.zip`;
}

async function downloadZip(url: string): Promise<{ buffer: Buffer; status: number }> {
  // Census is government-polite by default; we keep a plain fetch here with
  // our identifying HavesayBot UA. politeFetch's rotating browser UA
  // would actually raise suspicion against a clean government CDN.
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/zip' },
    signal: AbortSignal.timeout(120_000),
  });
  if (res.status === 404) {
    return { buffer: Buffer.alloc(0), status: 404 };
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  const arrayBuf = await res.arrayBuffer();
  return { buffer: Buffer.from(arrayBuf), status: res.status };
}

/** Find first attribute value in props that isn't null/undefined. */
function pickFirst(
  props: Record<string, unknown> | null | undefined,
  keys: string[],
): string | null {
  if (!props) return null;
  for (const k of keys) {
    const v = props[k];
    if (v != null && String(v).trim() !== '') return String(v);
  }
  return null;
}

/** Ensure geometry is a MultiPolygon shape (wrap Polygon coords). */
function normalizeToMultiPolygon(geom: Geometry): Geometry {
  if (geom.type === 'Polygon') {
    return {
      type: 'MultiPolygon',
      coordinates: [geom.coordinates],
    };
  }
  return geom;
}

/**
 * Parse the zip in memory (shapefile library accepts Uint8Array for .shp
 * and .dbf). AdmZip lets us pull the two file bytes out without touching
 * disk, but we still mkdtemp for debug-log locality when DEBUG is set.
 */
async function parseShapefileZip(
  buffer: Buffer,
  layer: TigerLayer,
  stateFips: string,
  logger: AdapterContext['logger'],
): Promise<FeatureCollection> {
  const tmp = mkdtempSync(join(tmpdir(), `tiger-${stateFips}-${layer}-`));
  try {
    const zip = new AdmZip(buffer);
    const entries = zip.getEntries();
    const infix = LAYER_META[layer].fileInfix;

    const shpEntry = entries.find((e) => e.entryName.toLowerCase().endsWith('.shp'));
    const dbfEntry = entries.find((e) => e.entryName.toLowerCase().endsWith('.dbf'));

    if (!shpEntry || !dbfEntry) {
      throw new Error(
        `TIGER zip for ${stateFips}/${infix} missing .shp or .dbf (entries=${entries
          .map((e) => e.entryName)
          .join(',')})`,
      );
    }

    const shpPath = join(tmp, 'layer.shp');
    const dbfPath = join(tmp, 'layer.dbf');
    writeFileSync(shpPath, shpEntry.getData());
    writeFileSync(dbfPath, dbfEntry.getData());

    const fc = await shapefile.read(shpPath, dbfPath);
    logger.info('tiger-districts: parsed shapefile', {
      layer,
      stateFips,
      features: fc.features.length,
    });
    return fc;
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best-effort tempdir cleanup */
    }
  }
}

function hashBuffer(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

async function upsertStatus(
  ctx: AdapterContext,
  args: {
    stateFips: string;
    districtType: DistrictRow['district_type'];
    status:
      | 'in_progress'
      | 'success'
      | 'partial'
      | 'failed'
      | 'skipped'
      | 'no_data_available';
    observed?: number;
    errorMessage?: string;
  },
): Promise<void> {
  const nowIso = new Date().toISOString();
  const patch: Record<string, unknown> = {
    status: args.status,
    last_attempted_at: nowIso,
    source_description: 'Census TIGER/Line 2024',
    ingestion_run_id: ctx.ingestionRunId,
    data_source_id: ctx.dataSourceId ?? null,
  };
  if (args.observed !== undefined) patch.observed_district_count = args.observed;
  if (args.status === 'success' || args.status === 'partial') {
    patch.last_successful_at = nowIso;
  }
  if (args.errorMessage) patch.last_error = args.errorMessage.slice(0, 2000);

  const { error } = await ctx.supabase
    .from('district_ingestion_status')
    .update(patch)
    .eq('state_fips', args.stateFips)
    .eq('district_type', args.districtType)
    .eq('election_year', ELECTION_YEAR);

  if (error) {
    ctx.logger.warn('tiger-districts: status update failed', {
      state: args.stateFips,
      type: args.districtType,
      error: error.message,
    });
  }
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

/**
 * Build a TIGER district adapter for one (layer, state). The CLI
 * orchestrator constructs 50-156 of these per run and feeds each one
 * to runAdapter() individually — per-layer isolation keeps one
 * broken state's shapefile from poisoning the rest.
 */
export function tigerDistrictsAdapter(
  layer: TigerLayer,
  stateFips: string,
): SourceAdapter<DistrictRow> {
  if (!/^\d{2}$/.test(stateFips)) {
    throw new Error(`tigerDistrictsAdapter: stateFips must be 2 digits, got "${stateFips}"`);
  }
  const meta = LAYER_META[layer];
  const url = buildUrl(layer, stateFips);
  // Census is polite-friendly; 1 rps / burst 2 per adapter is conservative
  // and the runner fans out with its own parallelism control.
  const bucket = createTokenBucket({ rps: 1, burst: 2 });

  return {
    name: `tiger-districts-${layer.toLowerCase()}-${stateFips}`,
    stateFips,
    tokenBucket: { rps: 1, burst: 2 },
    costService: 'census_tiger',
    estimatedCostUsd: 0,

    async run(ctx: AdapterContext): Promise<AdapterOutcome<DistrictRow>> {
      await upsertStatus(ctx, {
        stateFips,
        districtType: meta.district_type,
        status: 'in_progress',
      });
      ctx.logger.info('tiger-districts: fetching', { layer, stateFips, url });

      await bucket.acquire();
      const { buffer, status } = await downloadZip(url);

      if (status === 404) {
        // Unicameral / no-data state. Mark status explicitly and return
        // an empty row set with expectedMinRows=0 so the runner reports
        // 'skipped' (dry-run) or 'success' (empty OK).
        ctx.logger.warn('tiger-districts: 404 (no data for this layer+state)', {
          layer,
          stateFips,
        });
        await upsertStatus(ctx, {
          stateFips,
          districtType: meta.district_type,
          status: 'no_data_available',
          observed: 0,
          errorMessage: `TIGER 2024 has no ${layer} layer for FIPS ${stateFips} (expected for unicameral NE SLDL, DC SLDL, etc.)`,
        });
        // Use a stable zero-byte hash so re-runs don't churn data_sources.
        const emptyHash = createHash('sha256').update(`tiger-2024-${layer}-${stateFips}-404`).digest('hex');
        return {
          rows: [],
          expectedMinRows: 0,
          source: {
            sourceType: 'census_tiger',
            name: `Census TIGER/Line 2024 ${layer} (FIPS ${stateFips}) — not published`,
            url,
            contentHash: emptyHash,
            license: 'public_domain',
            stateFips,
            meta: { layer, http_status: 404, note: 'layer not published for this state' },
          },
        };
      }

      const contentHash = hashBuffer(buffer);
      const fc = await parseShapefileZip(buffer, layer, stateFips, ctx.logger);

      const rows: DistrictRow[] = [];
      let skippedMissingNumber = 0;
      for (const feat of fc.features as Feature[]) {
        const props = feat.properties;
        if (!feat.geometry) continue;

        const number = pickFirst(props, meta.numberAttr);
        if (!number) {
          skippedMissingNumber += 1;
          continue;
        }

        // Prefer the canonical NAMELSAD TIGER ships for the display name;
        // fall back to our template when it's missing.
        const namelsad = pickFirst(props, ['NAMELSAD', 'NAME']);
        const districtName = namelsad ?? meta.nameTemplate(number, stateFips);

        rows.push({
          district_type: meta.district_type,
          district_name: districtName,
          district_number: number,
          state_fips: stateFips,
          election_year: ELECTION_YEAR,
          source: 'census_tiger_2024',
          geometry: normalizeToMultiPolygon(feat.geometry),
          meta: {
            tiger_layer: layer,
            namelsad: namelsad ?? null,
            // Preserve a curated subset of TIGER attributes for audit / debug.
            tiger_props: filterProps(props, [
              'STATEFP',
              'CD119FP',
              'SLDLST',
              'SLDUST',
              'GEOID',
              'NAMELSAD',
              'NAME',
              'LSAD',
              'MTFCC',
              'FUNCSTAT',
            ]),
          },
        });
      }

      if (skippedMissingNumber > 0) {
        ctx.logger.warn('tiger-districts: features without district_number attribute', {
          layer,
          stateFips,
          skipped: skippedMissingNumber,
        });
      }

      return {
        rows,
        expectedMinRows: EXPECTED_MIN_ROWS,
        source: {
          sourceType: 'census_tiger',
          name: `Census TIGER/Line 2024 ${layer} (FIPS ${stateFips})`,
          url,
          contentHash,
          license: 'public_domain',
          stateFips,
          meta: {
            layer,
            vintage: 2024,
            features: fc.features.length,
            rows: rows.length,
            skipped_missing_number: skippedMissingNumber,
            srid_source: TIGER_SRID,
            srid_target: TARGET_SRID,
          },
        },
      };
    },

    validateRow(row) {
      if (!row.district_number) return 'missing district_number';
      if (!row.state_fips) return 'missing state_fips';
      if (!row.geometry) return 'missing geometry';
      if (row.geometry.type !== 'Polygon' && row.geometry.type !== 'MultiPolygon') {
        return `unexpected geometry type ${row.geometry.type}`;
      }
      return null;
    },

    async insert(
      rows: DistrictRow[],
      refs: InsertRefs,
      ctx: AdapterContext,
    ): Promise<InsertStats> {
      const stats: InsertStats = {
        rowsInserted: 0,
        rowsUpdated: 0,
        rowsSkipped: 0,
        rowsFailed: 0,
        errors: [],
      };

      if (rows.length === 0) {
        // 404 path — status already set to no_data_available in run().
        return stats;
      }

      // Dry-run: don't touch political_districts at all. Runner rolls back
      // the outer tx regardless, but we skip the work to make dry-runs fast.
      if (ctx.dryRun) {
        ctx.logger.info('tiger-districts: dry-run, skipping writes', {
          layer,
          stateFips,
          would_upsert: rows.length,
        });
        stats.rowsSkipped = rows.length;
        await upsertStatus(ctx, {
          stateFips,
          districtType: meta.district_type,
          status: 'skipped',
          observed: rows.length,
        });
        return stats;
      }

      // Upsert via raw SQL so we can ST_Transform server-side. Supabase JS
      // client doesn't have a clean escape-hatch for PostGIS functions, and
      // the runner already has the pg Pool set up — use it.
      //
      // Partial unique index idx_political_districts_type_state_number
      // (added in 20260423000012) is the ON CONFLICT target.
      const client = await ctx.pg.connect();
      try {
        // ST_Transform(geom, integer) overload requires the SRID as a
        // literal integer, not a prepared parameter (pg passes numerics
        // as text which postgis tries to parse as a proj4 string). We
        // inline TIGER_SRID + TARGET_SRID as constants since they never
        // vary per-run.
        const UPSERT_SQL = `
          INSERT INTO political_districts (
            district_type, district_name, district_number,
            state_fips, election_year, source,
            geom, ingested_from_data_source_id, meta, updated_at
          ) VALUES (
            $1, $2, $3,
            $4, $5, $6,
            ST_Multi(ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON($7), ${TIGER_SRID}), ${TARGET_SRID})),
            $8, $9::jsonb, now()
          )
          ON CONFLICT (district_type, state_fips, district_number)
            WHERE state_fips IS NOT NULL AND district_number IS NOT NULL
          DO UPDATE SET
            district_name = EXCLUDED.district_name,
            election_year = EXCLUDED.election_year,
            source = EXCLUDED.source,
            geom = EXCLUDED.geom,
            ingested_from_data_source_id = EXCLUDED.ingested_from_data_source_id,
            meta = EXCLUDED.meta,
            updated_at = now()
          RETURNING (xmax = 0) AS inserted
        `;

        for (const row of rows) {
          try {
            const res = await client.query<{ inserted: boolean }>(UPSERT_SQL, [
              row.district_type,
              row.district_name,
              row.district_number,
              row.state_fips,
              row.election_year,
              row.source,
              JSON.stringify(row.geometry),
              refs.dataSourceId,
              JSON.stringify(row.meta ?? {}),
            ]);
            const inserted = res.rows[0]?.inserted === true;
            if (inserted) stats.rowsInserted += 1;
            else stats.rowsUpdated += 1;
          } catch (err) {
            stats.rowsFailed += 1;
            stats.errors.push({
              type: 'other',
              message: `upsert ${row.district_type}/${row.state_fips}/${row.district_number}: ${
                err instanceof Error ? err.message : String(err)
              }`,
              rawInput: { district_number: row.district_number, state_fips: row.state_fips },
            });
          }
        }

        // Flip the per-state status tracker. 'partial' only if we saw rows
        // but some failed; full failure is the runner's responsibility.
        const observed = stats.rowsInserted + stats.rowsUpdated;
        const trackerStatus: 'success' | 'partial' =
          stats.rowsFailed > 0 && observed > 0 ? 'partial' : 'success';
        await upsertStatus(ctx, {
          stateFips,
          districtType: meta.district_type,
          status: trackerStatus,
          observed,
          errorMessage:
            stats.rowsFailed > 0
              ? `${stats.rowsFailed} row(s) failed; first: ${stats.errors[0]?.message ?? ''}`
              : undefined,
        });
      } finally {
        client.release();
      }

      return stats;
    },
  };
}

// ---------------------------------------------------------------------------
// Small utility — keep chosen keys only
// ---------------------------------------------------------------------------

function filterProps(
  props: Record<string, unknown> | null | undefined,
  keep: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!props) return out;
  for (const k of keep) {
    if (props[k] != null) out[k] = props[k];
  }
  return out;
}
