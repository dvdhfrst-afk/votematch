/**
 * Nevada Secretary of State — 2026 candidate-filings adapter (FIPS 32).
 *
 * Primary is 2026-06-09 (closed primary; partisan offices nominate their
 * party's candidate, voter must be registered with that party). Filing
 * window for federal/state offices: 2026-03-02 → 2026-03-13 per NRS
 * 293.177.
 *
 * Source candidates probed (web-verified 2026-04-25 via politeFetch):
 *   1. https://www.nvsos.gov/sos/elections                                → 200, 924 bytes (Imperva stub)
 *   2. https://www.nvsos.gov/sos/elections/candidate-information          → 200, 921 bytes (Imperva stub)
 *   3. https://www.nvsos.gov/sos/elections/candidate-information/candidate-filing → 200, 922 bytes (Imperva stub)
 *   4. https://www.nvsos.gov/SOSCandidateServices/AnonymousAccess/CandidatesList.aspx → 200, 921 bytes (Imperva stub)
 *   5. https://www.nvsos.gov/sosvoterservices/candidatesearch/SearchCandidates.aspx  → 200, 921 bytes (Imperva stub)
 *   6. https://silverstateelection.nv.gov/Candidates                      → 200, 212 bytes (Imperva stub)
 *
 * Status (2026-04-25):
 *   The entire nvsos.gov host is fronted by Imperva/Incapsula. Every URL
 *   returns the same ~921-byte HTML stub:
 *
 *     <html style="height:100%"><head>
 *       <META NAME="ROBOTS" CONTENT="NOINDEX, NOFOLLOW">
 *       <script src="/_Incapsula_Resource?SWJIYLWA=...,...">
 *     </script><body></body></html>
 *
 *   This is the Incapsula JS-resource bootstrap — a real browser executes
 *   that script, sets a cookie, and reloads to get the real content.
 *   politeFetch can't drive that flow. Same situation on
 *   silverstateelection.nv.gov.
 *
 *   NV does publish a structured candidate list once per cycle: the SoS
 *   Candidate Services portal exposes a PDF + Excel download via the
 *   logged-in administrative interface, but the public anonymous-access
 *   pages (CandidatesList.aspx, SearchCandidates.aspx) are all behind the
 *   Imperva wall. There is no flat XLSX/CSV anonymous-fetch endpoint.
 *
 * Behavior of this adapter today:
 *   - run() fetches the candidate-information landing page,
 *   - Detects the Imperva stub (small body + Incapsula resource ref),
 *   - Returns rows=[] with meta.bot_walled=true so the run records
 *     `partial`, not `failed`.
 *
 * The Imperva wall is not worked around. If a permitted data path
 * appears, swap fetchNvCandidatesPage().
 *
 * What's on the 2026 NV primary ballot (federal + state):
 *   - U.S. Senator (Class II seat)
 *   - U.S. House districts 1–4
 *   - Governor + Lt Gov (joint ticket; LG elected on same ticket post-2022)
 *   - Secretary of State, Attorney General, Treasurer, Controller
 *   - State Senate: half the chamber (4y staggered, odd-numbered districts)
 *   - State Assembly: all 42 seats (2y terms)
 *   - Public Utilities Commission (appointed, not elected) — skip
 *   - Various judicial seats (nonpartisan)
 */

import { createHash } from 'node:crypto';

import { politeFetch } from '../../fetch-polite';
import {
  insertGenericCandidacies,
  type GenericCandidacyRow,
} from '../candidacies-shared';
import type {
  AdapterContext,
  AdapterOutcome,
  SourceAdapter,
} from '../../types';
import { createTokenBucket } from '../../rate-limit';

const STATE_FIPS = '32';
const PRIMARY_DATE = '2026-06-09';
const DEFAULT_SOURCE_URL =
  'https://www.nvsos.gov/sos/elections/candidate-information';

export type NvCandidacyRow = GenericCandidacyRow & {
  is_write_in: boolean;
};

export type CreateNvCandidaciesAdapterOptions = {
  sourceUrl?: string;
  electionYear?: number;
  fetchOverride?: (url: string) => Promise<{ status: number; body: string }>;
  parseOverride?: (rawBody: string) => NvCandidacyRow[];
};

export function createNvCandidaciesAdapter(
  options: CreateNvCandidaciesAdapterOptions = {},
): SourceAdapter<NvCandidacyRow> {
  const sourceUrl = options.sourceUrl ?? DEFAULT_SOURCE_URL;
  const electionYear = options.electionYear ?? new Date().getUTCFullYear();
  const tokenBucket = { rps: 0.5, burst: 2 };
  const bucket = createTokenBucket(tokenBucket);

  const adapter: SourceAdapter<NvCandidacyRow> = {
    name: 'sos-nevada-candidacies',
    stateFips: STATE_FIPS,
    tokenBucket,
    costService: 'other',

    async run(ctx: AdapterContext): Promise<AdapterOutcome<NvCandidacyRow>> {
      await bucket.acquire();
      ctx.logger.info('nv-candidacies: fetching', {
        stateFips: STATE_FIPS,
        url: sourceUrl,
        electionYear,
      });

      const fetchImpl = options.fetchOverride ?? fetchNvCandidatesPage;
      const { status, body } = await fetchImpl(sourceUrl);

      const contentHash = createHash('sha256').update(body).digest('hex');
      const walled = isImpervaStub(status, body);

      ctx.logger.info('nv-candidacies: fetched', {
        http_status: status,
        bytes: body.length,
        contentHash: contentHash.slice(0, 12),
        bot_walled: walled,
      });

      const parser = options.parseOverride ?? parseNvCandidates;
      let rows: NvCandidacyRow[] = [];
      if (walled) {
        ctx.logger.warn(
          'nv-candidacies: nvsos.gov is fronted by Imperva/Incapsula JS challenge — returning [] (source requires a browser; skipped)',
          { status, bytes: body.length },
        );
      } else if (status >= 400) {
        ctx.logger.warn(`nv-candidacies: nvsos.gov returned HTTP ${status}`);
      } else {
        rows = parser(body);
      }

      return {
        rows,
        expectedMinRows: 0,
        source: {
          sourceType: 'sos_candidate_filing',
          name: 'nevada-sos-candidacies',
          url: sourceUrl,
          contentHash,
          license: 'state_open_records',
          stateFips: STATE_FIPS,
          meta: {
            election_year: electionYear,
            primary_date: PRIMARY_DATE,
            http_status: status,
            byte_size: body.length,
            bot_walled: walled,
            blocker: walled
              ? 'nvsos.gov host (and silverstateelection.nv.gov) are fronted by Imperva/Incapsula JS challenge; not fetched automatically'
              : null,
          },
        },
      };
    },

    validateRow(row) {
      if (!row.reported_name || !row.reported_name.trim()) return 'missing reported_name';
      if (!row.office_name || !row.office_name.trim()) return 'missing office_name';
      return null;
    },

    async insert(rows, refs, ctx) {
      return insertGenericCandidacies(rows, refs, ctx, {
        stateFips: STATE_FIPS,
        electionYear,
        source: 'sos-nevada-candidacies',
      });
    },
  };

  return adapter;
}

export async function fetchNvCandidatesPage(
  url: string,
): Promise<{ status: number; body: string }> {
  const res = await politeFetch(url, {
    headers: { Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
  });
  return { status: res.status, body: await res.text() };
}

/**
 * Detect Imperva/Incapsula JS-bootstrap stub:
 *   - Tiny body (<2KB)
 *   - References /_Incapsula_Resource or visid_incap cookie scripts
 *   - <body> empty
 */
export function isImpervaStub(status: number, body: string): boolean {
  if (status >= 500) return false;
  if (typeof body !== 'string') return false;
  if (body.length > 4096) return false;
  const lower = body.toLowerCase();
  return (
    lower.includes('_incapsula_resource') ||
    lower.includes('incapsula') ||
    lower.includes('visid_incap')
  );
}

/**
 * Parse NV candidate-filings HTML. Today: returns [].
 * If real HTML becomes available, parse the SoS Candidate Services portal
 * (CandidatesList.aspx) and the silverstateelection dashboard for
 * structured candidate tables.
 */
export function parseNvCandidates(rawBody: string): NvCandidacyRow[] {
  if (typeof rawBody !== 'string' || rawBody.length < 64) return [];
  // TODO(2026-Q2): parse nvsos.gov candidate services once real HTML is available.
  return [];
}
