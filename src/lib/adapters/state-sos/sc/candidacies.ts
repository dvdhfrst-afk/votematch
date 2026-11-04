/**
 * South Carolina State Election Commission (SCVotes) — 2026 candidate-
 * filings adapter (FIPS 45).
 *
 * Status: BLOCKED — empty-but-correct stub.
 *
 * 2026 SC primary date: 2026-06-09. Runoffs: 2026-06-23. General: 2026-11-03.
 * Filing window opened March 16, 2026 at noon and closed March 30, 2026.
 *
 * Source endpoints attempted (web-verified 2026-04-25):
 *
 *   1. https://scvotes.gov/candidates/2026-candidate-information/
 *      → HTTP 200, but the page is editorial — no embedded JSON
 *      roster. It links to:
 *
 *   2. https://vrems.scvotes.sc.gov/Candidate/SelectElection
 *      → HTTP 200 — an MVC form (ASP.NET Core Razor) requiring an
 *      anti-forgery cookie + __RequestVerificationToken POST plus a
 *      multi-step Ajax flow:
 *        a. POST /Candidate/GetElectionsByYear (year + ElectionKindSid)
 *        b. POST /Candidate/SelectElection (ElectionID hidden)
 *        c. GET  /Candidate/CandidateSearch?electionId={id}
 *      Step (c) hit directly returns HTTP 500 ("session expired" — the
 *      session needs Step b to seed the ElectionID server-side).
 *
 *   3. https://vrems.scvotes.sc.gov/Candidate/CandidateSearch?electionId=22114
 *      → HTTP 500 (session not seeded)
 *
 * Plan (post-blocker):
 *   - Implement the three-request CSRF dance with cookie persistence
 *     across calls. Once Step c lands HTML, parse it with the same
 *     row-shape as the other state adapters.
 *   - Defer until the SC primary window approaches (early June). The
 *     filing list isn't expected to change much between mid-April and
 *     early June, so this blocker is low-urgency.
 *
 * Until then this adapter returns [] with parserSignal='no_table' so
 * the dispatcher records the run as 'unproductive'. The dispatcher run
 * still creates a `data_sources` row with the blocker recorded in meta,
 * so the operator dashboard can surface SC as a blocked source.
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

const STATE_FIPS = '45';
const ELECTION_YEAR = 2026;
const PRIMARY_DATE = '2026-06-09';

const SOURCE_URL =
  'https://vrems.scvotes.sc.gov/Candidate/SelectElection';

const BLOCKER_SUMMARY =
  'SC scvotes.sc.gov requires a multi-step CSRF + cookie-session POST flow not yet implemented';

// ---------------------------------------------------------------------------
// Row shape (forward-compatible)
// ---------------------------------------------------------------------------

export type ScCandidacyRow = {
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

export type ScCandidaciesAdapterOptions = {
  sourceUrl?: string;
  license?: DataSourceLicense;
  tokenBucket?: { rps: number; burst: number };
  fetch?: (ctx: AdapterContext) => Promise<{
    rows: ScCandidacyRow[];
    contentHash: string;
  }>;
  expectedMinRows?: number;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createScCandidaciesAdapter(
  options: ScCandidaciesAdapterOptions = {},
): SourceAdapter<ScCandidacyRow> {
  const license: DataSourceLicense = options.license ?? 'state_open_records';
  const tokenBucketCfg = options.tokenBucket ?? { rps: 0.5, burst: 2 };
  const bucket = createTokenBucket(tokenBucketCfg);
  const expectedMinRows = options.expectedMinRows ?? 0;
  const sourceUrl = options.sourceUrl ?? SOURCE_URL;

  const adapter: SourceAdapter<ScCandidacyRow> = {
    name: 'sos-south-carolina-candidacies',
    stateFips: STATE_FIPS,
    tokenBucket: tokenBucketCfg,
    costService: 'other',

    async run(ctx: AdapterContext): Promise<AdapterOutcome<ScCandidacyRow>> {
      await bucket.acquire();
      ctx.logger.info(`${adapter.name}: blocked stub`, {
        stateFips: STATE_FIPS,
        url: sourceUrl,
        blocker: BLOCKER_SUMMARY,
      });

      let rows: ScCandidacyRow[] = [];
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
        // No automated fetch: the source needs a multi-step CSRF +
        // cookie-session POST flow. The run records 'unproductive' with
        // a stable contentHash.
        ctx.logger.info(`${adapter.name}: no automated fetch path; skipped`);
      }

      return {
        rows,
        expectedMinRows,
        source: {
          sourceType: 'sos_candidate_filing',
          name: 'south-carolina-sos-candidacies',
          url: sourceUrl,
          contentHash,
          license,
          stateFips: STATE_FIPS,
          meta: {
            election_year: ELECTION_YEAR,
            primary_date: PRIMARY_DATE,
            blocked: true,
            blocker: BLOCKER_SUMMARY,
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
      rows: ScCandidacyRow[],
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
