/**
 * Shared types for the source-adapter framework.
 *
 * Every state / federal / third-party data ingestion in Havesay
 * implements the {@link SourceAdapter} interface and runs through
 * {@link runAdapter}. This gives us one place to enforce:
 *
 *   - Provenance (every row → data_sources row)
 *   - Concurrency safety (pg_try_advisory_xact_lock per adapter+state)
 *   - Cost ceilings (cost_cap_check_and_consume)
 *   - Audit trail (ingestion_runs + ingestion_errors)
 *   - Dry-run semantics (rollback with skipped audit row)
 *   - Rate limiting (token bucket helper used inside run())
 *
 * See:
 *   - supabase/migrations/20260423000000_data_sources.sql (schema)
 *   - supabase/migrations/20260423000009_council_foundation.sql (cost_caps)
 *   - supabase/migrations/20260420000002_pipeline_runs.sql (sentinel precedent)
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Pool } from 'pg';

// ---------------------------------------------------------------------------
// Source descriptors / stats
// ---------------------------------------------------------------------------

/** Matches data_sources.license CHECK constraint (council_foundation migration). */
export type DataSourceLicense =
  | 'public_domain'
  | 'cc_by'
  | 'cc_by_nc'
  | 'cc_by_sa'
  | 'cc_by_nc_sa'
  | 'mit'
  | 'state_open_records'
  | 'fair_use_excerpt'
  | 'proprietary_licensed'
  | 'unknown';

/**
 * What the adapter hands back to the runner so it can upsert a data_sources row.
 * One DataSourceDescriptor per adapter.run() call — if an adapter fetches
 * multiple URLs, the descriptor should cover the canonical one and list the
 * others in meta.
 */
export type DataSourceDescriptor = {
  /** Matches data_sources.source_type CHECK constraint. */
  sourceType: string;
  name: string;
  url: string;
  /** sha256 of raw body. Enables cross-run dedup without re-parsing. */
  contentHash: string;
  license: DataSourceLicense;
  /** Two-character FIPS code; omit for federal sources. */
  stateFips?: string;
  /** Wayback Machine / memento URL if captured. */
  archiveUrl?: string;
  meta?: Record<string, unknown>;
};

/**
 * Handed to {@link SourceAdapter.insert} so it can attach data_source_id +
 * ingestion_run_id to every row it writes.
 */
export type InsertRefs = {
  dataSourceId: string;
  ingestionRunId: string;
};

/** Error record for ingestion_errors; wraps raw input for later inspection. */
export type AdapterError = {
  /** Matches ingestion_errors.error_type: 'parse'|'fk_violation'|'check_violation'|'network'|'rate_limit'|'validation'|'other'. */
  type: string;
  message: string;
  rawInput?: unknown;
};

export type InsertStats = {
  rowsInserted: number;
  rowsUpdated: number;
  rowsSkipped: number;
  rowsFailed: number;
  errors: AdapterError[];
};

/**
 * Signal from the parser about whether the response had the expected
 * structure. Lets the runner distinguish "URL is wrong / parser couldn't
 * find the table" from "page parsed cleanly but had no rows" — the
 * former should mark the run 'unproductive', the latter 'success'+0.
 *
 * Council 2026-04-25 DE#1 / SRE#1: zero-row "successes" were silent
 * failures. Adapters that don't set this default to 'ok' so existing
 * callers keep working.
 */
export type ParserSignal = 'ok' | 'no_table' | 'table_empty' | 'parse_failed';

/**
 * What adapter.run() returns — the full row set plus a floor + provenance.
 * Rows are flowed into validateRow() and then insert() by the runner.
 */
export type AdapterOutcome<Row> = {
  rows: Row[];
  /**
   * Below this row count the run is marked 'partial'. Forces adapters to
   * declare a floor rather than silently returning zero. Set to 0 only when
   * an empty response is legitimately expected (e.g. nightly poll with no
   * new data).
   */
  expectedMinRows: number;
  source: DataSourceDescriptor;
  /**
   * Optional. When omitted, runner assumes 'ok' (parser found expected
   * structure). State-CF parsers and other format-validating parsers set
   * this so the runner can mark zero-row runs 'unproductive' instead of
   * lying with status='success'.
   */
  parserSignal?: ParserSignal;
};

// ---------------------------------------------------------------------------
// Runner context + logger
// ---------------------------------------------------------------------------

export type AdapterLogger = {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
};

/**
 * Context the runner passes into adapter.run() and adapter.insert(). Use
 * {@link AdapterContext.supabase} for typical Supabase reads/writes and
 * {@link AdapterContext.pg} when you need transaction / advisory-lock
 * semantics the Supabase JS client doesn't expose.
 */
export type AdapterContext = {
  supabase: SupabaseClient;
  /** node-postgres Pool; needed for advisory locks + pg-native functions. */
  pg: Pool;
  /** If true, adapter.insert() should still run but the outer tx is rolled back. */
  dryRun: boolean;
  /** git rev-parse HEAD at run start; stored on ingestion_runs.git_sha. */
  gitSha: string;
  /** UUID of the ingestion_runs row for this call. */
  ingestionRunId: string;
  /** Populated after the runner upserts data_sources; undefined inside adapter.run(). */
  dataSourceId?: string;
  /** Mirror of adapter.costService for helpers that need it. */
  costService?: string;
  logger: AdapterLogger;
};

// ---------------------------------------------------------------------------
// The adapter interface
// ---------------------------------------------------------------------------

export interface SourceAdapter<Row> {
  /** Kebab-case identifier: 'sos-ohio-results', 'fec-candidates', etc. */
  name: string;
  /** Optional FIPS scoping — combined with name to form the advisory-lock key. */
  stateFips?: string;
  /**
   * Rate-limit profile for outbound requests the adapter makes in run().
   *
   * **Deprecation candidate (Swarm 2 + Swarm 3 audit, 2026-04-25):** the
   * canonical per-host pacing layer is now `host_rate_limits` (consulted by
   * `politeFetch()`). Adapter-local token buckets remain useful for
   * quota-limited APIs with a fixed key budget (FEC 1000/hr, Congress.gov,
   * etc.) — but for unauthenticated SoS portals this field duplicates what
   * politeFetch already does. Flagged for council review before removal;
   * keep in place for now so existing adapters compile unchanged.
   *
   * Anti-pattern reminder: if you call `bucket.acquire()`, do it ONCE per
   * outbound HTTP call, not once per row yielded. Per-row acquires throttle
   * iteration speed without throttling network and burn the 180s task
   * budget for nothing. See Swarm 2's federal-bills/votes fix for the
   * canonical correction.
   */
  tokenBucket?: { rps: number; burst: number };
  /** Must match cost_caps.service for cost-reservation to work. */
  costService?: string;
  /** Reserved at run start; refunded to the cap on success if unused. */
  estimatedCostUsd?: number;
  run(ctx: AdapterContext): Promise<AdapterOutcome<Row>>;
  /** Return null for valid, a string (error message) for invalid. */
  validateRow?(row: Row): string | null;
  insert(rows: Row[], refs: InsertRefs, ctx: AdapterContext): Promise<InsertStats>;
}

// ---------------------------------------------------------------------------
// Runner output
// ---------------------------------------------------------------------------

export type AdapterStatus =
  | 'success'
  | 'partial'
  | 'failed'
  | 'skipped'
  | 'unproductive'        // Parser signaled non-ok (no_table / parse_failed) AND 0 rows.
  | 'unchanged'           // content_hash matched a recent successful run; no work done.
  | 'rejected_concurrent'
  | 'rejected_cost_cap';

export type AdapterRunResult = {
  status: AdapterStatus;
  /** Populated whenever the ingestion_runs row was created (everything except rejected_concurrent). */
  ingestionRunId?: string;
  /** Populated after data_sources upsert; absent on failure before upsert. */
  dataSourceId?: string;
  /** Human-readable reason for rejected_* or failed. */
  reason?: string;
  stats?: InsertStats;
  expectedMinRows?: number;
};

export type RunAdapterOptions = {
  /** Pre-built Supabase service client. If omitted, one is constructed. */
  supabase?: SupabaseClient;
  /** Pre-built pg Pool. If omitted, one is constructed from DATABASE_URL. */
  pg?: Pool;
  /** Don't persist adapter output; still emit the audit row. */
  dryRun?: boolean;
  /** Override git sha capture (tests). */
  gitSha?: string;
  logger?: AdapterLogger;
};
