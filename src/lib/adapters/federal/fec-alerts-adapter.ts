/**
 * FEC alerts source adapter.
 *
 * Pilot #3 of the SourceAdapter framework. Replaces the hand-written fetch
 * / insert loop in `src/lib/inngest/functions/ingest-fec.ts` with the
 * common adapter lifecycle. The Inngest function now constructs the
 * adapter (scoped to the set of currently-followed federal members) and
 * calls `runAdapter()`.
 *
 * Why per-invocation construction: the "followed federal members" set
 * changes constantly, so we materialize it at dispatch time and pass it
 * into `createFecAlertsAdapter()`. The adapter is stateless beyond that.
 *
 * Uses the newly-fixed `findFecCandidateByName` which requires state +
 * office corroboration to avoid silent wrong-name attachment (see
 * `src/lib/federal/fec.ts`).
 *
 * Schema gap (2026-04-23): `fec_alerts` does not carry `data_source_id`
 * or `ingestion_run_id` columns. Lineage is captured on `ingestion_runs`
 * only until a follow-up migration adds them.
 */

import { createHash } from 'node:crypto';
import type {
  AdapterContext,
  AdapterOutcome,
  InsertRefs,
  InsertStats,
  SourceAdapter,
} from '../types';
import { createTokenBucket } from '../rate-limit';
import {
  findFecCandidateByName,
  fetchRecentFilings,
  fetchLargeContributions,
  type FecOffice,
} from '@/lib/federal/fec';

export type FecFollowedMember = {
  bioguide_id: string;
  full_name: string;
  state: string | null;
  chamber: string | null;
  party: string | null;
};

/** One row == one fec_alerts row pending insert. */
export type FecAlertRow = {
  event_type: 'filing' | 'large_contribution';
  fec_candidate_id: string;
  fec_committee_id: string | null;
  bioguide_id: string;
  amount: number | null;
  counterparty: string | null;
  event_date: string | null;
  description: string | null;
  url: string | null;
};

export type FecAlertsAdapterOptions = {
  /** Followed federal members to check. Empty → adapter no-ops (still writes audit row). */
  followed: FecFollowedMember[];
  /** How many days back to look. Default 7. */
  lookbackDays?: number;
  /** Minimum contribution dollar threshold. Default $2,500. */
  minContribution?: number;
};

export function createFecAlertsAdapter(
  opts: FecAlertsAdapterOptions,
): SourceAdapter<FecAlertRow> {
  const lookbackDays = opts.lookbackDays ?? 7;
  const minContribution = opts.minContribution ?? 2500;
  const bucket = createTokenBucket({ rps: 2, burst: 5 });
  const url = 'https://api.open.fec.gov/v1';

  return {
    name: 'fec-alerts',
    tokenBucket: { rps: 2, burst: 5 },
    costService: 'openfec',
    estimatedCostUsd: 0,

    async run(ctx: AdapterContext): Promise<AdapterOutcome<FecAlertRow>> {
      ctx.logger.info('fec-alerts: starting fetch', {
        followed: opts.followed.length,
        lookback_days: lookbackDays,
      });

      const sinceDate = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);

      const rows: FecAlertRow[] = [];
      // Capture a rolling sample for the content-hash fingerprint.
      const rawSamples: unknown[] = [];

      for (const m of opts.followed) {
        const office: FecOffice | undefined =
          m.chamber === 'house' ? 'H' : m.chamber === 'senate' ? 'S' : undefined;

        await bucket.acquire();
        const candidate = await findFecCandidateByName(m.full_name, {
          stateFips: m.state ?? undefined,
          office,
          party: m.party ?? undefined,
        }).catch((err: unknown) => {
          ctx.logger.warn('fec-alerts: candidate lookup failed', {
            bioguide_id: m.bioguide_id,
            error: err instanceof Error ? err.message : String(err),
          });
          return null;
        });
        if (!candidate) continue;

        // Filings
        await bucket.acquire();
        const filings = await fetchRecentFilings(candidate.candidate_id, sinceDate).catch(
          (err: unknown) => {
            ctx.logger.warn('fec-alerts: filings fetch failed', {
              bioguide_id: m.bioguide_id,
              error: err instanceof Error ? err.message : String(err),
            });
            return [] as Awaited<ReturnType<typeof fetchRecentFilings>>;
          },
        );
        for (const f of filings) {
          rows.push({
            event_type: 'filing',
            fec_candidate_id: candidate.candidate_id,
            fec_committee_id: f.committee_id ?? null,
            bioguide_id: m.bioguide_id,
            amount: f.total_receipts ?? null,
            counterparty: null,
            event_date: f.receipt_date?.slice(0, 10) ?? null,
            description: f.document_description ?? f.form_type ?? null,
            url: f.pdf_url ?? null,
          });
          if (rawSamples.length < 200) rawSamples.push(f);
        }

        // Large contributions
        await bucket.acquire();
        const contribs = await fetchLargeContributions(candidate.candidate_id, {
          minAmount: minContribution,
          sinceDate,
        }).catch((err: unknown) => {
          ctx.logger.warn('fec-alerts: contributions fetch failed', {
            bioguide_id: m.bioguide_id,
            error: err instanceof Error ? err.message : String(err),
          });
          return [] as Awaited<ReturnType<typeof fetchLargeContributions>>;
        });
        for (const c of contribs) {
          rows.push({
            event_type: 'large_contribution',
            fec_candidate_id: candidate.candidate_id,
            fec_committee_id: c.committee?.committee_id ?? null,
            bioguide_id: m.bioguide_id,
            amount: c.contribution_receipt_amount ?? null,
            counterparty: c.contributor_name ?? null,
            event_date: c.contribution_receipt_date?.slice(0, 10) ?? null,
            description: null,
            url: null,
          });
          if (rawSamples.length < 200) rawSamples.push(c);
        }
      }

      ctx.logger.info('fec-alerts: fetch complete', { rows: rows.length });

      const hash = createHash('sha256')
        .update(
          JSON.stringify({
            since: sinceDate,
            follows: opts.followed.length,
            samples: rawSamples,
          }),
        )
        .digest('hex');

      return {
        rows,
        // FEC pulls are often empty — a no-filings / no-contrib day is
        // legitimate. Floor of 0 keeps the run classified 'success' rather
        // than 'partial' when there's nothing to report.
        expectedMinRows: 0,
        source: {
          sourceType: 'federal_api',
          name: 'FEC OpenFEC alerts ingest',
          url,
          contentHash: hash,
          license: 'public_domain',
          meta: {
            followed_count: opts.followed.length,
            since_date: sinceDate,
            min_contribution: minContribution,
          },
        },
      };
    },

    validateRow(row) {
      if (!row.event_type) return 'missing event_type';
      if (!row.fec_candidate_id) return 'missing fec_candidate_id';
      if (!row.bioguide_id) return 'missing bioguide_id';
      return null;
    },

    async insert(
      rows: FecAlertRow[],
      refs: InsertRefs,
      ctx: AdapterContext,
    ): Promise<InsertStats> {
      // Schema gap: fec_alerts does not carry data_source_id / ingestion_run_id.
      void refs;

      const stats: InsertStats = {
        rowsInserted: 0,
        rowsUpdated: 0,
        rowsSkipped: 0,
        rowsFailed: 0,
        errors: [],
      };

      if (rows.length === 0) return stats;

      // Split by event_type: filings get upserted (there's no natural
      // dedup key on fec_alerts beyond id, so fall back to plain insert —
      // duplicates are tolerable at the scale this runs at). Contributions
      // are insert-only like the legacy implementation.
      const BATCH = 500;
      for (let i = 0; i < rows.length; i += BATCH) {
        const chunk = rows.slice(i, i + BATCH);
        const { data, error } = await ctx.supabase
          .from('fec_alerts')
          .insert(chunk)
          .select('id');
        if (error) {
          stats.rowsFailed += chunk.length;
          stats.errors.push({
            type: 'other',
            message: `fec_alerts insert batch ${i}: ${error.message}`,
          });
          continue;
        }
        stats.rowsInserted += data?.length ?? 0;
      }

      return stats;
    },
  };
}
