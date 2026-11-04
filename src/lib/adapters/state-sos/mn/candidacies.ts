/**
 * Minnesota Secretary of State — 2026 candidate-filings adapter (FIPS 27).
 *
 * Primary is 2026-08-11 (open primary; voter picks one party's ballot at
 * the polls).
 *
 * Source candidates probed (web-verified 2026-04-25 via politeFetch):
 *   1. https://www.sos.state.mn.us/elections-voting/find-candidate-information/
 *      → 200, but the response is a Radware Bot Manager captcha
 *        ("Radware Captcha Page"), not real content. Resolves to a
 *        validate.perfdrive.com URL.
 *   2. https://candidates.sos.mn.gov/ → 200 with real HTML (~49KB ASP.NET
 *      page), but the listing/search ASP.NET endpoints (CandidateList.aspx,
 *      CandidateFilings.aspx) hit the same Radware captcha as soon as we
 *      try to fetch the data tables.
 *
 * Status (2026-04-25):
 *   The MN SoS Candidate Filings application is a postback-driven ASP.NET
 *   site — the landing page works, but the actual filings table is loaded
 *   via __doPostBack into a UpdatePanel that requires a proper browser
 *   round-trip. politeFetch tier 1 cannot navigate that. Imperva/Radware
 *   bot manager intercepts the AJAX request and serves a captcha
 *   challenge instead.
 *
 *   MN does not publish a flat CSV/XLSX of statewide candidates pre-primary
 *   (filing closes June 2 2026 for the August primary; the SoS publishes
 *   per-office HTML reports linked from the candidates.sos.mn.gov tree).
 *
 * Behavior of this adapter today:
 *   - run() fetches candidates.sos.mn.gov with politeFetch.
 *   - Detects a Radware captcha redirect via response.url containing
 *     'validate.perfdrive.com' (the canonical sentinel) or body content
 *     'shieldsquare' / 'Radware Captcha'.
 *   - Returns rows=[] with meta.bot_walled=true so the run is recorded as
 *     `partial`, not `failed`.
 *
 * The Radware wall is not worked around. Parser hook parseMnCandidates()
 * is already wired for when a permitted data path exists.
 *
 * What's on the 2026 MN primary ballot (federal + state):
 *   - U.S. Senator (Class II seat)
 *   - U.S. House districts 1–8
 *   - Governor + Lt Gov (joint ticket, party-nominated)
 *   - Secretary of State, Attorney General, State Auditor (no Treasurer in MN)
 *   - Minnesota Senate: half the chamber on the 2026 cycle (4y staggered)
 *   - Minnesota House: all 134 seats (2y terms)
 *   - State Supreme Court / Court of Appeals (nonpartisan)
 *
 * MN party note: the Democratic-Farmer-Labor party (DFL) is state-scoped.
 * The shared resolvePartyId() resolves "DFL" → MN DFL row when state_fips=27.
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

const STATE_FIPS = '27';
const PRIMARY_DATE = '2026-08-11';
const DEFAULT_SOURCE_URL = 'https://candidates.sos.mn.gov/';

export type MnCandidacyRow = GenericCandidacyRow & {
  is_write_in: boolean;
};

export type CreateMnCandidaciesAdapterOptions = {
  sourceUrl?: string;
  electionYear?: number;
  fetchOverride?: (url: string) => Promise<{ status: number; body: string; finalUrl: string }>;
  parseOverride?: (rawBody: string) => MnCandidacyRow[];
};

export function createMnCandidaciesAdapter(
  options: CreateMnCandidaciesAdapterOptions = {},
): SourceAdapter<MnCandidacyRow> {
  const sourceUrl = options.sourceUrl ?? DEFAULT_SOURCE_URL;
  const electionYear = options.electionYear ?? new Date().getUTCFullYear();
  const tokenBucket = { rps: 0.5, burst: 2 };
  const bucket = createTokenBucket(tokenBucket);

  const adapter: SourceAdapter<MnCandidacyRow> = {
    name: 'sos-minnesota-candidacies',
    stateFips: STATE_FIPS,
    tokenBucket,
    costService: 'other',

    async run(ctx: AdapterContext): Promise<AdapterOutcome<MnCandidacyRow>> {
      await bucket.acquire();
      ctx.logger.info('mn-candidacies: fetching', {
        stateFips: STATE_FIPS,
        url: sourceUrl,
        electionYear,
      });

      const fetchImpl = options.fetchOverride ?? fetchMnCandidatesPage;
      const { status, body, finalUrl } = await fetchImpl(sourceUrl);

      const contentHash = createHash('sha256').update(body).digest('hex');
      const walled = isRadwareWall(status, body, finalUrl);

      ctx.logger.info('mn-candidacies: fetched', {
        http_status: status,
        bytes: body.length,
        contentHash: contentHash.slice(0, 12),
        bot_walled: walled,
      });

      const parser = options.parseOverride ?? parseMnCandidates;
      const rows = walled ? [] : parser(body);
      if (walled) {
        ctx.logger.warn(
          'mn-candidacies: Radware captcha wall on candidates.sos.mn.gov — returning [] (source requires a browser; skipped).',
          { status, finalUrl: finalUrl.slice(0, 200) },
        );
      }

      return {
        rows,
        expectedMinRows: 0,
        source: {
          sourceType: 'sos_candidate_filing',
          name: 'minnesota-sos-candidacies',
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
              ? 'candidates.sos.mn.gov ASP.NET filings table is fronted by Radware Bot Manager; not fetched automatically'
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
        source: 'sos-minnesota-candidacies',
      });
    },
  };

  return adapter;
}

export async function fetchMnCandidatesPage(
  url: string,
): Promise<{ status: number; body: string; finalUrl: string }> {
  const res = await politeFetch(url, {
    headers: { Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
  });
  return { status: res.status, body: await res.text(), finalUrl: res.url };
}

/**
 * Detect a Radware Bot Manager captcha challenge.
 *   - Captcha responses redirect to validate.perfdrive.com (or
 *     captcha.perfdrive.com) and embed shieldsquare assets.
 *   - The HTML title is literally "Radware Captcha Page".
 */
export function isRadwareWall(
  status: number,
  body: string,
  finalUrl: string,
): boolean {
  if (status >= 500) return false;
  const lurl = (finalUrl ?? '').toLowerCase();
  if (lurl.includes('perfdrive.com') || lurl.includes('shieldsquare')) {
    return true;
  }
  const snippet = (body ?? '').slice(0, 8192).toLowerCase();
  return (
    snippet.includes('radware captcha') ||
    snippet.includes('shieldsquare') ||
    snippet.includes('captcha.perfdrive')
  );
}

/**
 * Parse MN candidate-filings HTML.
 * Today: returns []. When filings HTML is available, the implementation
 * here can iterate `<table id="dgFilings">` rows and
 * map columns name|office|district|party.
 */
export function parseMnCandidates(rawBody: string): MnCandidacyRow[] {
  if (typeof rawBody !== 'string' || rawBody.length < 64) return [];
  // TODO(2026-Q2): parse the filings table once a permitted data path exists.
  return [];
}
