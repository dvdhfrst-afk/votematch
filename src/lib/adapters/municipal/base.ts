/**
 * Shared base for every per-city municipal-meetings adapter.
 *
 * Problem this solves
 * -------------------
 * The top 20 US cities publish council / committee / board meetings on
 * wildly different portals. Fortunately a handful of *platforms* (Legistar,
 * Granicus, plus a long tail of custom CMSs) absorb almost all of the
 * variance — each platform has a standard data shape. createMunicipalMeetingsAdapter()
 * lets a single factory dispatch to the right platform fetch+parse pair so
 * the framework concerns (rate limits, provenance, cost caps, DB upsert,
 * dry-run) live in one place.
 *
 * Row → DB mapping
 * ----------------
 *   meeting_row.title             → municipal_meetings.title
 *   meeting_row.meeting_datetime  → municipal_meetings.meeting_datetime
 *   meeting_row.jurisdiction_type → municipal_meetings.jurisdiction_type
 *   meeting_row.agenda_url        → municipal_meetings.agenda_url
 *   city.stateCode                → municipal_meetings.state
 *   city.cityName                 → municipal_meetings.jurisdiction
 *   platform                      → municipal_meetings.platform
 *   (computed)                    → municipal_meetings.source_url, topic_tags, ...
 *
 * The retention migration (20260418000002) does NOT currently carry a
 * `city_fips_place` column on municipal_meetings. We stash the seed's
 * fips_place on the data_sources row's meta so provenance is preserved
 * without requiring a schema change.
 *
 * Design notes
 * ------------
 * - The factory accepts an injectable fetchOverride() so tests drive
 *   synthetic bodies without network calls.
 * - Validation is deliberately strict on required fields (title, datetime,
 *   source_url) but lenient on everything else — the generic Granicus
 *   scraper is best-effort.
 * - topic_tags are left empty here. The optional {@link extractMunicipalMeetings}
 *   pass (lazily imported so the core adapter doesn't require a Claude key)
 *   can backfill them later for a chosen subset of agendas.
 */

import { createHash } from 'node:crypto';
import type {
  AdapterContext,
  AdapterOutcome,
  DataSourceDescriptor,
  InsertRefs,
  InsertStats,
  SourceAdapter,
} from '../types';
import { createTokenBucket } from '../rate-limit';
import { findCity, type MunicipalCitySeed, type MunicipalPlatform } from './cities-seed';
import { politeFetch } from '../fetch-polite';
import {
  fetchLegistarEvents,
  parseLegistarEvents,
  type LegistarMeetingRow,
} from './platform-legistar';
import {
  parseGranicusCalendar,
  type GranicusMeetingRow,
} from './platform-granicus';

// ---------------------------------------------------------------------------
// Row shape — what the adapter hands to insert()
// ---------------------------------------------------------------------------

export type MunicipalMeetingRow = {
  state: string;
  jurisdiction: string;
  jurisdiction_type: 'city_council' | 'planning' | 'school_board' | 'other';
  title: string;
  /** ISO 8601 (naive timezone is OK — downstream digest formatter normalizes). */
  meeting_datetime: string;
  agenda_url: string | null;
  minutes_url: string | null;
  source_url: string;
  platform: 'legistar' | 'granicus' | 'other' | 'direct';
  topic_tags: string[];
  /** 0..1 — 1.0 for structured API sources, lower for HTML scrapes. */
  confidence_score: number;
  /** Stable identifier from the upstream system for idempotency. */
  source_row_id: string;
};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export type MunicipalFetchOverride = (url: string) => Promise<{
  status: number;
  body: string;
}>;

export type CreateMunicipalAdapterOptions = {
  /** One of the keys in MUNICIPAL_CITIES. */
  cityKey: string;
  /**
   * Lookahead window in days. Default 30. The Legistar API accepts a single
   * date range; for Granicus we simply emit every row the calendar HTML
   * contains and filter post-parse.
   */
  daysAhead?: number;
  /**
   * Optional fetch override. When omitted, we build a platform-appropriate
   * default (global fetch, 15s timeout, 1 retry on transport errors). Unit
   * tests always supply this.
   */
  fetchOverride?: MunicipalFetchOverride;
  /**
   * Optional Legistar API key; attached to requests for cities that have a
   * per-client token. No-op for Granicus cities.
   */
  legistarApiKey?: string;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createMunicipalMeetingsAdapter(
  opts: CreateMunicipalAdapterOptions,
): SourceAdapter<MunicipalMeetingRow> {
  const city = findCity(opts.cityKey);
  if (!city) {
    throw new Error(`createMunicipalMeetingsAdapter: unknown cityKey "${opts.cityKey}"`);
  }
  if (city.platform === 'todo') {
    throw new Error(
      `createMunicipalMeetingsAdapter: city "${opts.cityKey}" is marked 'todo' (platform not yet verified). See cities-seed.ts.`,
    );
  }
  if (!city.endpoint) {
    throw new Error(
      `createMunicipalMeetingsAdapter: city "${opts.cityKey}" has platform=${city.platform} but no endpoint.`,
    );
  }

  const bucket = createTokenBucket({ rps: 0.5, burst: 2 });
  const daysAhead = opts.daysAhead ?? 30;
  const fetchFn = opts.fetchOverride ?? defaultFetch;
  // After the validation above, endpoint is guaranteed present. Pin a
  // narrowed local so TypeScript flow analysis can carry the non-null
  // assertion into the async callbacks below.
  const endpoint: string = city.endpoint;

  const adapter: SourceAdapter<MunicipalMeetingRow> = {
    name: `municipal-${city.cityKey}`,
    // stateFips used for the advisory-lock key; this keeps two parallel city
    // runs in the same state from colliding on the same Supabase session.
    stateFips: city.stateFips,
    tokenBucket: { rps: 0.5, burst: 2 },
    costService: 'other',
    estimatedCostUsd: 0,

    async run(ctx: AdapterContext): Promise<AdapterOutcome<MunicipalMeetingRow>> {
      await bucket.acquire();

      const now = new Date();
      const sinceIso = now.toISOString();
      const untilIso = new Date(
        now.getTime() + daysAhead * 24 * 60 * 60 * 1000,
      ).toISOString();

      ctx.logger.info(`${adapter.name}: fetching`, {
        platform: city.platform,
        endpoint: city.endpoint,
        sinceIso,
        untilIso,
      });

      let rows: MunicipalMeetingRow[] = [];
      let rawBodyForHash = '';
      let resolvedUrl: string = endpoint;

      if (city.platform === 'legistar' || (city.platform === 'custom' && isLegistarLike(city))) {
        const client = legistarClient(city);
        // Wrap the transport in a two-step shim so the Legistar module can
        // call fetchFn(url) and we can keep a copy of the body for hashing.
        let bodyCapture = '';
        const events = await fetchLegistarEvents({
          client,
          sinceIso,
          untilIso,
          apiKey: opts.legistarApiKey,
          fetchFn: async (url) => {
            resolvedUrl = url;
            const r = await fetchFn(url);
            bodyCapture = r.body;
            return r;
          },
        });
        rawBodyForHash = bodyCapture;
        const parsed = parseLegistarEvents(events, client);
        rows = parsed.map((r) => legistarRowToMunicipal(r, city));
      } else if (city.platform === 'granicus') {
        const r = await fetchFn(endpoint);
        if (r.status < 200 || r.status >= 300) {
          throw new Error(`granicus: HTTP ${r.status} on ${endpoint}`);
        }
        rawBodyForHash = r.body;
        resolvedUrl = endpoint;
        const parsed = parseGranicusCalendar(r.body, { baseUrl: endpoint });
        rows = parsed.map((p) => granicusRowToMunicipal(p, city));
      } else {
        throw new Error(
          `municipal: no inline parser for custom city ${city.cityKey} (endpoint ${endpoint}). Extend base.ts.`,
        );
      }

      // Trim Granicus rows outside the configured window (Legistar already
      // filtered server-side).
      if (city.platform === 'granicus') {
        rows = rows.filter((r) => {
          const t = Date.parse(r.meeting_datetime);
          if (Number.isNaN(t)) return true;
          return t >= now.getTime() && t <= now.getTime() + daysAhead * 86_400_000;
        });
      }

      const contentHash = createHash('sha256').update(rawBodyForHash).digest('hex');

      const source: DataSourceDescriptor = {
        sourceType: 'municipal_meetings_portal',
        name: `municipal-${city.cityKey}`,
        url: resolvedUrl,
        contentHash,
        license: 'public_domain',
        stateFips: city.stateFips,
        meta: {
          city_key: city.cityKey,
          city_name: city.cityName,
          platform: city.platform,
          fips_place: city.fipsPlace ?? null,
          days_ahead: daysAhead,
          byte_size: rawBodyForHash.length,
          row_count: rows.length,
        },
      };

      ctx.logger.info(`${adapter.name}: parsed`, {
        rowCount: rows.length,
      });

      return {
        rows,
        expectedMinRows: 0, // civic calendars legitimately return 0 in quiet weeks
        source,
      };
    },

    validateRow(row) {
      if (!row.title || row.title.trim().length === 0) return 'missing title';
      if (!row.meeting_datetime) return 'missing meeting_datetime';
      if (Number.isNaN(Date.parse(row.meeting_datetime))) {
        return `unparseable meeting_datetime: ${row.meeting_datetime}`;
      }
      if (!row.source_url) return 'missing source_url';
      if (row.confidence_score < 0 || row.confidence_score > 1) {
        return `confidence_score out of [0,1]: ${row.confidence_score}`;
      }
      return null;
    },

    async insert(
      rows: MunicipalMeetingRow[],
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
      if (rows.length === 0) return stats;

      const payload = rows.map((r) => ({
        state: r.state,
        jurisdiction: r.jurisdiction,
        jurisdiction_type: r.jurisdiction_type,
        title: r.title,
        meeting_datetime: r.meeting_datetime,
        agenda_url: r.agenda_url,
        topic_tags: r.topic_tags,
        source_url: r.source_url,
        platform: r.platform,
        confidence_score: r.confidence_score,
        // Structured civic-tech sources are verified-by-design; free-text
        // extractor output stays behind the verified=false gate.
        verified: r.platform === 'legistar' || r.platform === 'granicus',
        extraction_audit_id: null,
      }));

      const BATCH = 500;
      for (let i = 0; i < payload.length; i += BATCH) {
        const chunk = payload.slice(i, i + BATCH);
        const { data, error } = await ctx.supabase
          .from('municipal_meetings')
          .upsert(chunk, {
            // Matches the UNIQUE (source_url, meeting_datetime) constraint
            // on municipal_meetings.
            onConflict: 'source_url,meeting_datetime',
          })
          .select('id');
        if (error) {
          stats.rowsFailed += chunk.length;
          stats.errors.push({
            type: 'other',
            message: `upsert batch ${i}: ${error.message}`,
          });
          ctx.logger.warn(`${adapter.name}: upsert batch failed`, {
            offset: i,
            error: error.message,
          });
          continue;
        }
        stats.rowsInserted += data?.length ?? chunk.length;
      }
      // Silence unused-warning on refs — the municipal_meetings schema
      // doesn't carry ingestion_run_id columns (yet); audit-lineage is on
      // ingestion_runs / data_sources only.
      void refs;
      return stats;
    },
  };

  return adapter;
}

// ---------------------------------------------------------------------------
// Platform adapters — private helpers
// ---------------------------------------------------------------------------

/**
 * Cities like NYC run their own Legistar install under a non-standard
 * domain but the REST API still follows the Legistar client convention.
 * We flag 'custom' cities as legistar-like only when we've verified the
 * API path works.
 */
function isLegistarLike(city: MunicipalCitySeed): boolean {
  return city.cityKey === 'nyc';
}

function legistarClient(city: MunicipalCitySeed): string {
  if (city.platform === 'legistar') return city.endpoint ?? city.cityKey;
  // NYC's Legistar client is 'nyc'.
  if (city.cityKey === 'nyc') return 'nyc';
  return city.cityKey;
}

function legistarRowToMunicipal(
  row: LegistarMeetingRow,
  city: MunicipalCitySeed,
): MunicipalMeetingRow {
  return {
    state: city.stateCode,
    jurisdiction: city.cityName,
    jurisdiction_type: row.jurisdiction_type,
    title: row.title,
    meeting_datetime: row.meeting_datetime,
    agenda_url: row.agenda_url,
    minutes_url: row.minutes_url,
    source_url: row.source_url,
    platform: 'legistar',
    topic_tags: [],
    confidence_score: 1.0,
    source_row_id: `legistar:${city.cityKey}:${row.event_id}`,
  };
}

function granicusRowToMunicipal(
  row: GranicusMeetingRow,
  city: MunicipalCitySeed,
): MunicipalMeetingRow {
  return {
    state: city.stateCode,
    jurisdiction: city.cityName,
    jurisdiction_type: row.jurisdiction_type,
    title: row.title,
    meeting_datetime: row.meeting_datetime,
    agenda_url: row.agenda_url,
    minutes_url: row.minutes_url,
    source_url: row.source_url,
    platform: 'granicus',
    topic_tags: [],
    // Slightly lower confidence — HTML scraping can drift when city
    // rethemes their calendar page.
    confidence_score: 0.85,
    source_row_id: `granicus:${city.cityKey}:${row.meeting_datetime}:${row.title.slice(0, 40)}`,
  };
}

/**
 * Default fetch wrapper — 15s timeout, one retry on transport failure.
 * Uses global `fetch` (Node 18+); we avoid pulling in cross-fetch to keep
 * the dep tree lean.
 */
async function defaultFetch(url: string): Promise<{ status: number; body: string }> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await politeFetch(url, {
        signal: controller.signal,
        headers: {
          // Some Granicus installs 403 unidentified requests.
          Accept: 'application/json, text/html;q=0.9',
        },
      });
      clearTimeout(timer);
      const body = await res.text();
      return { status: res.status, body };
    } catch (err) {
      clearTimeout(timer);
      if (attempt >= 1) {
        throw err instanceof Error ? err : new Error(String(err));
      }
    }
  }
  // Unreachable — loop either returns or throws.
  throw new Error('defaultFetch: exhausted retries');
}
