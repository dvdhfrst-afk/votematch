/**
 * Oregon Secretary of State — 2026 candidate-filings adapter (FIPS 41).
 *
 * Status: BLOCKED — empty-but-correct stub.
 *
 * 2026 OR primary date: 2026-05-19. General: 2026-11-03.
 *
 * Source endpoints attempted (web-verified 2026-04-25):
 *
 *   1. https://oregonvotes.gov/elections/candidates/  → HTTP 404
 *      (the path the tasking referenced does not exist; the page lives
 *      under sos.oregon.gov/elections/Pages/Candidate-Filings-Local-Measures.aspx
 *      which is a SharePoint navigation page, not a dataset).
 *
 *   2. https://secure.sos.state.or.us/orestar/CFSearchPage.do  → HTTP 200,
 *      a multi-step ASP.NET form. Posting a wide search to the action
 *      URL (with cfyearActive=2026 and an empty cfName) returns the
 *      ORESTAR cybersecurity gate:
 *        "Oregon Secretary of State applications are currently
 *         AVAILABLE, however, our cyber-security service ... has
 *         identified a problem that prevents us from completing your
 *         request."
 *      The gate is keyed off automated POST submissions, so this source
 *      is not fetched automatically.
 *
 *   3. https://oregonvotes.gov/voters-guide/english/votersguide.html
 *      → returns the latest published voters' pamphlet, but the
 *      content at fetch time was the previous cycle (2024). The 2026
 *      primary pamphlet is not posted yet; even when it arrives, the
 *      pamphlet is editorial markup (candidate statements + photos),
 *      not a structured filing roster.
 *
 * Plan (post-blocker):
 *   - Request a quarterly bulk export from the Oregon Elections Division
 *     per ORS 246.110.
 *
 * Until then this adapter returns [] with parserSignal='no_table' so
 * the dispatcher records the run as 'unproductive' (not 'failed') and
 * the operator dashboard surfaces it as a blocked source.
 */

import { createHash } from 'node:crypto';
import type {
  AdapterContext,
  AdapterOutcome,
  DataSourceLicense,
  InsertRefs,
  InsertStats,
  SourceAdapter,
} from '../../types';
import { createTokenBucket } from '../../rate-limit';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATE_FIPS = '41';
const ELECTION_YEAR = 2026;
const PRIMARY_DATE = '2026-05-19';

const SOURCE_URL =
  'https://secure.sos.state.or.us/orestar/CFSearchPage.do';

const BLOCKER_SUMMARY =
  'OR ORESTAR rejects automated POSTs with a cybersecurity gate; no automated fetch path';

// ---------------------------------------------------------------------------
// Row shape (matches general candidacy adapter shape so a future
// implementation can flip from stub → live without migration)
// ---------------------------------------------------------------------------

export type OrCandidacyRow = {
  reported_name: string;
  party_raw: string;
  office_raw: string;
  office_type_slug: string;
  district_identifier: string | null;
  date_filed: string | null;
  source_row_id: string;
};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export type OrCandidaciesAdapterOptions = {
  sourceUrl?: string;
  license?: DataSourceLicense;
  tokenBucket?: { rps: number; burst: number };
  /** Test injection point — a future live fetch can satisfy this
   *  signature without changes downstream. */
  fetch?: (ctx: AdapterContext) => Promise<{
    rows: OrCandidacyRow[];
    contentHash: string;
  }>;
  expectedMinRows?: number;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createOrCandidaciesAdapter(
  options: OrCandidaciesAdapterOptions = {},
): SourceAdapter<OrCandidacyRow> {
  const license: DataSourceLicense = options.license ?? 'state_open_records';
  const tokenBucketCfg = options.tokenBucket ?? { rps: 0.5, burst: 2 };
  const bucket = createTokenBucket(tokenBucketCfg);
  // Set to 0 so the empty stub doesn't classify as 'partial' — the
  // dispatcher will record this run as zero-rows-produced + parserSignal
  // 'no_table' which the runner maps to 'unproductive'.
  const expectedMinRows = options.expectedMinRows ?? 0;
  const sourceUrl = options.sourceUrl ?? SOURCE_URL;

  const adapter: SourceAdapter<OrCandidacyRow> = {
    name: 'sos-oregon-candidacies',
    stateFips: STATE_FIPS,
    tokenBucket: tokenBucketCfg,
    costService: 'other',

    async run(ctx: AdapterContext): Promise<AdapterOutcome<OrCandidacyRow>> {
      await bucket.acquire();
      ctx.logger.info(`${adapter.name}: blocked stub`, {
        stateFips: STATE_FIPS,
        url: sourceUrl,
        blocker: BLOCKER_SUMMARY,
      });

      let rows: OrCandidacyRow[] = [];
      let contentHash = createHash('sha256').update('blocked').digest('hex');
      if (options.fetch) {
        try {
          const out = await options.fetch(ctx);
          rows = out.rows;
          contentHash = out.contentHash;
        } catch (err) {
          ctx.logger.warn(`${adapter.name}: injected fetch failed`, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      } else {
        // No automated fetch: ORESTAR rejects automated POSTs. The run
        // records 'unproductive' with a stable contentHash. Slot a parser
        // into options.fetch if a permitted data source becomes available.
        ctx.logger.info(`${adapter.name}: no automated fetch path; skipped`);
      }

      return {
        rows,
        expectedMinRows,
        source: {
          sourceType: 'sos_candidate_filing',
          name: 'oregon-sos-candidacies',
          url: sourceUrl,
          contentHash,
          license,
          stateFips: STATE_FIPS,
          meta: {
            election_year: ELECTION_YEAR,
            primary_date: PRIMARY_DATE,
            blocked: true,
            blocker: BLOCKER_SUMMARY,
            automated_fetch: false,
          },
        },
        parserSignal: rows.length > 0 ? 'ok' : 'no_table',
      };
    },

    validateRow(row) {
      if (!row.reported_name?.trim()) return 'missing reported_name';
      if (!row.office_type_slug) return 'missing office_type_slug';
      return null;
    },

    async insert(
      rows: OrCandidacyRow[],
      _refs: InsertRefs,
      _ctx: AdapterContext,
    ): Promise<InsertStats> {
      // Until live fetch lands, insert is a no-op so dry-run + live
      // both behave identically: zero writes, no errors.
      return {
        rowsInserted: 0,
        rowsUpdated: 0,
        rowsSkipped: rows.length,
        rowsFailed: 0,
        errors: [],
      };
    },
  };

  return adapter;
}
