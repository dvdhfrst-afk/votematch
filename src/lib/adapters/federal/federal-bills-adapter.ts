/**
 * Federal bills source adapter.
 *
 * Pilot #1 of the SourceAdapter framework. Fetches recent bills from the
 * 119th Congress via Congress.gov v3 API (`iterRecentBills`) and upserts
 * into `federal_bills` on the composite PK (congress, bill_type, bill_number).
 *
 * Backwards-compatible with the previous `scripts/ingest-federal-bills.ts`
 * behavior — same upsert shape, same policy-area fill, same fields. The
 * only functional change is that every run now produces an `ingestion_runs`
 * row with `data_source_id` wired in.
 *
 * Schema gap (2026-04-23): `federal_bills` does not currently carry
 * `data_source_id` or `ingestion_run_id` columns. Those references are
 * recorded on `ingestion_runs` / `data_sources` lineage rows instead.
 * TODO: add `data_source_id UUID REFERENCES data_sources(id)` to
 * `federal_bills` in a follow-up migration so per-row provenance can be
 * queried directly (see data_sources.sql council review).
 */

import { createHash } from 'node:crypto';
import type {
  AdapterContext,
  AdapterOutcome,
  InsertRefs,
  InsertStats,
  SourceAdapter,
} from '../types';
import { iterRecentBills, type CongressBill } from '@/lib/federal/congress';

const CURRENT_CONGRESS = 119;
// 2026-04-26 fix: reduced from 20 → 4 pages (1000 bills @ 250/page).
// Continuous-ingest enforces a 180s per-task timeout, and the bills endpoint
// returns sorted-by-updateDate-desc, so the most recent 1000 bills cover any
// realistic delta between runs (continuous-ingest cycles every ~3 min).
// Manual catch-up runs can override with `--pages 20`.
const DEFAULT_MAX_PAGES = 4;

/** What the adapter yields from run() and hands into insert(). */
export type FederalBillRow = {
  congress: number;
  bill_type: string;
  bill_number: number;
  title: string | null;
  summary: string | null;
  sponsor_bioguide_id: string | null;
  introduced_date: string | null;
  latest_action_date: string | null;
  latest_action_text: string | null;
  policy_area: string | null;
  subjects: string[];
  topic_tags: string[];
  url: string | null;
};

/** Configuration for a single run. Exposed so the CLI + Inngest paths share it. */
export type FederalBillsAdapterOptions = {
  congress?: number;
  maxPages?: number;
  /** Optional delta floor; forwarded to Congress.gov fromDateTime. */
  sinceDate?: string;
};

export function createFederalBillsAdapter(
  opts: FederalBillsAdapterOptions = {},
): SourceAdapter<FederalBillRow> {
  const congress = opts.congress ?? CURRENT_CONGRESS;
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  // 2026-04-26 fix: removed per-yielded-row tokenBucket.acquire(). The bucket
  // was firing once per *iterated bill*, not per *API page fetch*, so it was
  // throttling in-memory iteration rather than network calls. Net effect:
  // 5000 yielded bills × 5 rps = 1000+s minimum wall time, well over the
  // continuous-ingest 180s task timeout. Real per-host rate limiting now
  // happens inside congress.ts via politeFetch + host_rate_limits.
  const url = `https://api.congress.gov/v3/bill/${congress}`;

  return {
    name: 'federal-bills',
    // stateFips intentionally omitted — federal.
    tokenBucket: { rps: 5, burst: 10 },
    costService: 'congress_gov',
    estimatedCostUsd: 0,

    async run(ctx: AdapterContext): Promise<AdapterOutcome<FederalBillRow>> {
      ctx.logger.info('federal-bills: starting fetch', {
        congress,
        maxPages,
        sinceDate: opts.sinceDate,
      });

      const rows: FederalBillRow[] = [];
      const rawSamples: CongressBill[] = [];
      let count = 0;

      for await (const b of iterRecentBills({
        congress,
        maxPages,
        sinceDate: opts.sinceDate,
      })) {
        // No per-yield throttle. politeFetch enforces per-host spacing on
        // the actual page fetches inside iterRecentBills.

        const billNumber =
          typeof b.number === 'number' ? b.number : parseInt(String(b.number), 10);
        if (!Number.isFinite(billNumber)) continue;

        rows.push({
          congress: b.congress,
          bill_type: (b.type ?? '').toLowerCase(),
          bill_number: billNumber,
          title: b.title ?? null,
          summary: null,
          sponsor_bioguide_id: null,
          introduced_date: b.introducedDate ?? null,
          latest_action_date: b.latestAction?.actionDate ?? null,
          latest_action_text: b.latestAction?.text ?? null,
          policy_area: b.policyArea?.name ?? null,
          subjects: [],
          topic_tags: [],
          url: b.url ?? null,
        });
        // Keep a bounded sample of raw responses for the content hash. We
        // avoid retaining every bill to keep memory bounded on full-page
        // runs; first N is a stable-enough fingerprint to dedup identical
        // pulls.
        if (rawSamples.length < 500) rawSamples.push(b);
        count += 1;
      }

      ctx.logger.info('federal-bills: fetch complete', { fetched: count });

      const hash = createHash('sha256')
        .update(JSON.stringify(rawSamples))
        .digest('hex');

      return {
        rows,
        expectedMinRows: 50,
        source: {
          sourceType: 'federal_api',
          name: 'Congress.gov v3 bills ingest',
          url,
          contentHash: hash,
          license: 'public_domain',
          meta: {
            congress,
            max_pages: maxPages,
            since_date: opts.sinceDate ?? null,
            sample_count: rawSamples.length,
          },
        },
      };
    },

    validateRow(row) {
      if (!row.congress) return 'missing congress';
      if (!row.bill_type) return 'missing bill_type';
      if (!Number.isFinite(row.bill_number)) return 'missing/invalid bill_number';
      return null;
    },

    async insert(
      rows: FederalBillRow[],
      refs: InsertRefs,
      ctx: AdapterContext,
    ): Promise<InsertStats> {
      // 20260423000012_federal_provenance.sql added data_source_id +
      // ingestion_run_id to federal_bills. Wire them onto every row so the
      // /corrections workflow can prove provenance back to the canonical
      // Congress.gov source. (The 2026-04-25 backfill migration retrofitted
      // existing NULL rows; this prevents the next ingest from re-NULLing.)

      const stats: InsertStats = {
        rowsInserted: 0,
        rowsUpdated: 0,
        rowsSkipped: 0,
        rowsFailed: 0,
        errors: [],
      };

      if (rows.length === 0) return stats;

      // We mirror the legacy script's upsert: onConflict composite PK,
      // ingested_at stamped via column default trigger or omitted (DB
      // default is now()). We pass ingested_at explicitly to preserve the
      // prior behavior.
      const payload = rows.map((r) => ({
        ...r,
        ingested_at: new Date().toISOString(),
        data_source_id: refs.dataSourceId,
        ingestion_run_id: refs.ingestionRunId,
      }));

      const BATCH = 500;
      for (let i = 0; i < payload.length; i += BATCH) {
        const chunk = payload.slice(i, i + BATCH);
        const { data, error } = await ctx.supabase
          .from('federal_bills')
          .upsert(chunk, { onConflict: 'congress,bill_type,bill_number' })
          .select('congress, bill_type, bill_number');
        if (error) {
          stats.rowsFailed += chunk.length;
          stats.errors.push({
            type: 'other',
            message: `upsert batch ${i}: ${error.message}`,
          });
          ctx.logger.warn('federal-bills: upsert batch failed', {
            offset: i,
            error: error.message,
          });
          continue;
        }
        // Supabase upsert doesn't distinguish insert-vs-update in the
        // return; we count the whole chunk as "inserted" for stats. This
        // matches the legacy script's behavior.
        stats.rowsInserted += data?.length ?? chunk.length;
      }

      return stats;
    },
  };
}

/** Default adapter instance for CLI / Inngest use. */
export const federalBillsAdapter: SourceAdapter<FederalBillRow> =
  createFederalBillsAdapter();
