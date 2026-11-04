/**
 * Rhode Island Department of State — 2026 candidate-filings adapter (FIPS 44).
 *
 * Status: BLOCKED — empty-but-correct stub.
 *
 * 2026 RI primary date: 2026-09-08. General: 2026-11-03.
 * RI candidate filing window opened June 2026 (statewide+federal); local
 * candidates declare July 6–8, 2026.
 *
 * Source endpoints attempted (web-verified 2026-04-25):
 *
 *   1. https://elections.ri.gov/candidate-information/index.php
 *      → HTTP 404 (the path the tasking referenced does not exist).
 *      The actual landing page lives at
 *      https://elections.ri.gov/  → HTTP 200 (state Drupal portal),
 *      but it does not embed a structured candidate roster.
 *
 *   2. https://vote.sos.ri.gov/Candidates/CandidateSearch
 *      → HTTP 403, Cloudflare "Just a moment..." JS challenge. The page
 *      is not fetched automatically.
 *
 * Plan (post-blocker):
 *   - Request a daily CSV dump from the RI Department of State;
 *     RI Department of State has historically been responsive to
 *     bulk-export requests under the state public-records statute.
 *   - 2026 RI primary is on 2026-09-08, so this blocker has runway —
 *     the candidate roster typically gets posted in late June after
 *     declaration of candidacy closes.
 *
 * Until then this adapter returns [] with parserSignal='no_table' so
 * the dispatcher records the run as 'unproductive' and the operator
 * dashboard surfaces RI as a blocked source.
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

const STATE_FIPS = '44';
const ELECTION_YEAR = 2026;
const PRIMARY_DATE = '2026-09-08';

const SOURCE_URL = 'https://vote.sos.ri.gov/Candidates/CandidateSearch';

const BLOCKER_SUMMARY =
  'RI vote.sos.ri.gov is fully Cloudflare-walled (HTTP 403 + JS challenge); no automated fetch path';

// ---------------------------------------------------------------------------
// Row shape (forward-compatible)
// ---------------------------------------------------------------------------

export type RiCandidacyRow = {
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

export type RiCandidaciesAdapterOptions = {
  sourceUrl?: string;
  license?: DataSourceLicense;
  tokenBucket?: { rps: number; burst: number };
  fetch?: (ctx: AdapterContext) => Promise<{
    rows: RiCandidacyRow[];
    contentHash: string;
  }>;
  expectedMinRows?: number;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createRiCandidaciesAdapter(
  options: RiCandidaciesAdapterOptions = {},
): SourceAdapter<RiCandidacyRow> {
  const license: DataSourceLicense = options.license ?? 'state_open_records';
  const tokenBucketCfg = options.tokenBucket ?? { rps: 0.5, burst: 2 };
  const bucket = createTokenBucket(tokenBucketCfg);
  const expectedMinRows = options.expectedMinRows ?? 0;
  const sourceUrl = options.sourceUrl ?? SOURCE_URL;

  const adapter: SourceAdapter<RiCandidacyRow> = {
    name: 'sos-rhode-island-candidacies',
    stateFips: STATE_FIPS,
    tokenBucket: tokenBucketCfg,
    costService: 'other',

    async run(ctx: AdapterContext): Promise<AdapterOutcome<RiCandidacyRow>> {
      await bucket.acquire();
      ctx.logger.info(`${adapter.name}: blocked stub`, {
        stateFips: STATE_FIPS,
        url: sourceUrl,
        blocker: BLOCKER_SUMMARY,
      });

      let rows: RiCandidacyRow[] = [];
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
        // No automated fetch: the source is behind a Cloudflare challenge.
        // The run records 'unproductive' with a stable contentHash.
        ctx.logger.info(`${adapter.name}: no automated fetch path; skipped`);
      }

      return {
        rows,
        expectedMinRows,
        source: {
          sourceType: 'sos_candidate_filing',
          name: 'rhode-island-sos-candidacies',
          url: sourceUrl,
          contentHash,
          license,
          stateFips: STATE_FIPS,
          meta: {
            election_year: ELECTION_YEAR,
            primary_date: PRIMARY_DATE,
            blocked: true,
            blocker: BLOCKER_SUMMARY,
            cloudflare_walled: true,
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
      rows: RiCandidacyRow[],
      _refs: InsertRefs,
      _ctx: AdapterContext,
    ): Promise<InsertStats> {
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
