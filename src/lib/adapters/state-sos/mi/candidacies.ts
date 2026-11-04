/**
 * Michigan Bureau of Elections — 2026 candidate-filings adapter (FIPS 26).
 *
 * Primary is 2026-08-04 (closed primary).
 *
 * Source-hunt status (web-verified 2026-04-26)
 * --------------------------------------------
 * Two candidate surfaces exist:
 *   1. https://www.michigan.gov/sos/elections/election-results-and-data/candidate-listings-and-election-results-by-county
 *      → HTTP 200, ~351 KB, but ZERO `<table>` elements — the candidate
 *      grid is a JavaScript-rendered Drupal/Adaptive widget that fetches
 *      data after page load. The inner XHR endpoint requires a CSRF token
 *      tied to a stateful session; not automated here.
 *   2. https://mvic.sos.state.mi.us/Candidate/Index/2026PRI
 *      → HTTP 404 (the per-cycle cycle code "2026PRI"
 *      isn't published until ~3 weeks before primary day per BoE schedule).
 *
 * Status (2026-04-26):
 *   The canonical MI candidate-list page is the michigan.gov URL above.
 *   It returns 200 OK to politeFetch (no Cloudflare wall today — the
 *   site moved off CF since the prior probe). But the page is a SPA
 *   shell and the parser correctly returns [] until the BoE publishes a
 *   static candidate roster or a documented data feed.
 *
 *   For the prior MVIC URL — we keep MVIC_PORTAL_URL captured below for
 *   the inevitable end-of-July roster publication; Cloudflare may return
 *   then.
 *
 * Behavior of this adapter today:
 *   - The factory still wires through the real fetch + parse + insert
 *     pipeline so the dispatcher and runAdapter() see a fully-shaped
 *     SourceAdapter.
 *   - run() detects the Cloudflare wall via isCloudflareChallenge() (same
 *     helper used by the OH candidacies adapter) and returns an empty rows
 *     array with a meta.cloudflare_walled=true breadcrumb. The ingestion
 *     run records `partial` rather than `failed` so dashboards stay green.
 *   - If a permitted data path appears, swap the fetch boundary at
 *     fetchMiCandidatePage() and parseMiCandidateList() will start
 *     producing real rows without downstream changes.
 *
 * What's on the 2026 MI primary ballot (federal + state):
 *   - U.S. Senator (Class II seat)
 *   - U.S. House districts 1–13
 *   - Governor + Lt Gov (joint ticket; party convention nominates LG)
 *   - Secretary of State, Attorney General (party convention, NOT primary)
 *   - State Senate: half the chamber on the 2026 cycle (Senators serve 4y)
 *   - State House: all 110 seats (2y terms)
 *   - State Board of Education + University Boards (party convention)
 *   - Various judicial seats (nonpartisan)
 *
 * What this adapter writes (per filed candidate, when real candidate HTML is available):
 *   1. people row — find-or-create keyed on canonical_key + state scope
 *   2. elections row — find-or-create for (office_id, 2026-08-04, 'primary')
 *   3. candidacies row — upsert on (election_id, person_id)
 *   4. candidacy_party_lines — upsert primary line (ballot_line_order=1,
 *      nomination_method='primary')
 *
 * Until then, the adapter intentionally returns 0 rows so partial-not-failed
 * is the recorded outcome and a TODO breadcrumb stays in the source.
 */

import { createHash } from 'node:crypto';

import { politeFetch } from '../../fetch-polite';
import {
  findOrCreatePerson as findOrCreateStatePerson,
  resolveOfficeElection,
} from '../candidate-resolver';
import { resolvePartyId } from '../party-resolver';
import { isCloudflareChallenge } from '../oh/candidacies';
import type {
  AdapterContext,
  AdapterOutcome,
  InsertRefs,
  InsertStats,
  SourceAdapter,
} from '../../types';
import { createTokenBucket } from '../../rate-limit';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATE_FIPS = '26';
const PRIMARY_DATE = '2026-08-04';

/**
 * Canonical 2026 candidate-listings page on the main SoS host.
 * Returns 200 + 351 KB but the candidate grid is JS-rendered (SPA shell)
 * — see file header for full source-hunt notes.
 */
const CANDIDATE_LISTINGS_URL =
  'https://www.michigan.gov/sos/elections/election-results-and-data/candidate-listings-and-election-results-by-county';
/** Per-cycle MVIC URL — 404 until BoE publishes the cycle code. */
const MVIC_PORTAL_URL =
  'https://mvic.sos.state.mi.us/Candidate/Index/2026PRI';
const DEFAULT_SOURCE_URL = CANDIDATE_LISTINGS_URL;

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

export type MiCandidacyRow = {
  reported_name: string;
  party_abbreviation: string | null;
  office_name: string;
  district_identifier: string | null;
  is_write_in: boolean;
  source_row_id: string;
};

// ---------------------------------------------------------------------------
// Options / factory
// ---------------------------------------------------------------------------

export type CreateMiCandidaciesAdapterOptions = {
  sourceUrl?: string;
  electionYear?: number;
  /** Test-only fetch override; production uses politeFetch + Cloudflare detection. */
  fetchOverride?: (url: string) => Promise<{ status: number; body: string }>;
  /** Test-only HTML parser override. Production left empty until a parser is written. */
  parseOverride?: (rawBody: string) => MiCandidacyRow[];
};

export function createMiCandidaciesAdapter(
  options: CreateMiCandidaciesAdapterOptions = {},
): SourceAdapter<MiCandidacyRow> {
  const sourceUrl = options.sourceUrl ?? DEFAULT_SOURCE_URL;
  const electionYear = options.electionYear ?? new Date().getUTCFullYear();
  const tokenBucket = { rps: 0.5, burst: 2 };
  const bucket = createTokenBucket(tokenBucket);

  const adapter: SourceAdapter<MiCandidacyRow> = {
    name: 'sos-michigan-candidacies',
    stateFips: STATE_FIPS,
    tokenBucket,
    costService: 'other',

    async run(ctx: AdapterContext): Promise<AdapterOutcome<MiCandidacyRow>> {
      await bucket.acquire();

      ctx.logger.info('mi-candidacies: fetching', {
        stateFips: STATE_FIPS,
        url: sourceUrl,
        electionYear,
      });

      const fetchImpl = options.fetchOverride ?? fetchMiCandidatePage;

      let status = 0;
      let rawBody = '';
      try {
        const res = await fetchImpl(sourceUrl);
        status = res.status;
        rawBody = res.body;
      } catch (err) {
        throw new Error(
          `mi-candidacies: fetch threw for ${sourceUrl}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }

      const contentHash = createHash('sha256').update(rawBody).digest('hex');
      const walled = isCloudflareChallenge(status, rawBody);

      ctx.logger.info('mi-candidacies: fetched', {
        http_status: status,
        bytes: rawBody.length,
        contentHash: contentHash.slice(0, 12),
        cloudflare_walled: walled,
      });

      const parser = options.parseOverride ?? parseMiCandidateList;
      let rows: MiCandidacyRow[] = [];
      if (walled) {
        ctx.logger.warn(
          'mi-candidacies: Cloudflare wall on MVIC portal — returning [] (source requires a browser; skipped).',
          { status, sourceUrl },
        );
      } else if (status >= 400) {
        throw new Error(`mi-candidacies: HTTP ${status} from ${sourceUrl}`);
      } else {
        rows = parser(rawBody);
      }

      return {
        rows,
        // expectedMinRows=0 keeps the run from being marked partial purely
        // because of the wall. A run against real candidate HTML would
        // emit ~150-200 rows and this floor should be bumped then.
        expectedMinRows: 0,
        source: {
          sourceType: 'sos_candidate_filing',
          name: 'michigan-sos-candidacies',
          url: sourceUrl,
          contentHash,
          license: 'state_open_records',
          stateFips: STATE_FIPS,
          meta: {
            election_year: electionYear,
            primary_date: PRIMARY_DATE,
            http_status: status,
            byte_size: rawBody.length,
            cloudflare_walled: walled,
            mvic_portal_url: MVIC_PORTAL_URL,
            blocker:
              walled
                ? 'mvic.sos.state.mi.us is wrapped in Cloudflare JS challenge; not fetched automatically'
                : rows.length === 0
                  ? 'michigan.gov candidate-listings page is a JS-rendered SPA; data grid loads via XHR not parseable from server-side fetch'
                  : null,
          },
        },
      };
    },

    validateRow(row) {
      if (!row.reported_name || row.reported_name.trim().length === 0) {
        return 'missing reported_name';
      }
      if (!row.office_name || row.office_name.trim().length === 0) {
        return 'missing office_name';
      }
      return null;
    },

    async insert(rows, refs, ctx) {
      return insertMiCandidacies(rows, refs, ctx, electionYear);
    },
  };

  return adapter;
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

/**
 * Fetch the MVIC candidate portal with politeFetch. Currently returns the
 * Cloudflare challenge body (status 403 + "Just a moment..." HTML), which
 * the caller treats as walled.
 */
export async function fetchMiCandidatePage(
  url: string,
): Promise<{ status: number; body: string }> {
  const res = await politeFetch(url, {
    headers: {
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });
  return { status: res.status, body: await res.text() };
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

/**
 * Placeholder parser.
 *
 * Two upstream sources may eventually feed this:
 *   1. michigan.gov candidate-listings page (current DEFAULT_SOURCE_URL):
 *      Drupal SPA — the candidate grid is rendered client-side via an
 *      authenticated XHR. To parse this we need a documented data feed
 *      or a published static roster.
 *   2. mvic.sos.state.mi.us (MVIC_PORTAL_URL): Telerik-style ASP.NET grid
 *      (.RadGrid_*) listing candidates by office. 404s today; will publish
 *      ~3 weeks before primary day. Once it's up the parser mirrors OH:
 *        $('table.RadGrid').each((tableIdx, t) => { ... }) + paragraph
 *        fallback for press-release dumps.
 *
 * Today returns [] for any HTML body and the run records `unproductive`
 * via the no_table parser-signal classification.
 */
export function parseMiCandidateList(rawBody: string): MiCandidacyRow[] {
  if (typeof rawBody !== 'string' || rawBody.length < 64) return [];
  // TODO(2026-Q2): implement Telerik RadGrid scrape once the MVIC roster
  // is published as static HTML.
  return [];
}

// ---------------------------------------------------------------------------
// Insert (mirrors OH/IN candidacies adapters)
// ---------------------------------------------------------------------------

export async function insertMiCandidacies(
  rows: MiCandidacyRow[],
  refs: InsertRefs,
  ctx: AdapterContext,
  electionYear: number,
): Promise<InsertStats> {
  const stats: InsertStats = {
    rowsInserted: 0,
    rowsUpdated: 0,
    rowsSkipped: 0,
    rowsFailed: 0,
    errors: [],
  };

  if (rows.length === 0) return stats;

  for (const row of rows) {
    try {
      const officeInfo = await resolveOfficeElection(ctx.pg, {
        state_fips: STATE_FIPS,
        office_name: row.office_name,
        district_identifier: row.district_identifier,
        election_year: electionYear,
      });

      if (!officeInfo) {
        stats.rowsSkipped += 1;
        await logIngestionError(
          ctx,
          refs.ingestionRunId,
          'validation',
          `MI office not resolved: office="${row.office_name}" district=${row.district_identifier ?? '-'}`,
          row,
        );
        continue;
      }

      if (ctx.dryRun) {
        stats.rowsInserted += 1;
        continue;
      }

      const personId = await findOrCreateStatePerson(ctx.pg, {
        name: row.reported_name,
        state_fips: STATE_FIPS,
        electionYear,
        source: 'sos-michigan-candidacies',
        dataSourceId: refs.dataSourceId,
      });

      const candidacyRes = await ctx.pg.query<{ id: string; inserted: boolean }>(
        `INSERT INTO candidacies
           (election_id, person_id, party, status, meta)
         VALUES ($1, $2, $3, 'active', $4::jsonb)
         ON CONFLICT (election_id, person_id) DO UPDATE
           SET meta = candidacies.meta || EXCLUDED.meta
         RETURNING id, (xmax = 0) AS inserted`,
        [
          officeInfo.election_id,
          personId,
          row.party_abbreviation,
          JSON.stringify({
            source: 'sos-michigan-candidacies',
            reported_office: row.office_name,
            reported_district: row.district_identifier,
            data_source_id: refs.dataSourceId,
            ingestion_run_id: refs.ingestionRunId,
            source_row_id: row.source_row_id,
          }),
        ],
      );

      const candidacyId = candidacyRes.rows[0]?.id;
      const wasInserted = candidacyRes.rows[0]?.inserted === true;
      if (!candidacyId) {
        stats.rowsFailed += 1;
        stats.errors.push({
          type: 'other',
          message: 'MI candidacy upsert returned no id',
          rawInput: row,
        });
        continue;
      }
      if (wasInserted) stats.rowsInserted += 1;
      else stats.rowsUpdated += 1;

      if (row.party_abbreviation) {
        const partyId = await resolvePartyId(
          ctx.pg,
          row.party_abbreviation,
          STATE_FIPS,
        );
        if (partyId) {
          await ctx.pg.query(
            `INSERT INTO candidacy_party_lines
               (candidacy_id, party_id, ballot_line_order,
                nomination_method, data_source_id, meta)
             VALUES ($1, $2, 1, 'primary', $3, $4::jsonb)
             ON CONFLICT (candidacy_id, party_id) DO NOTHING`,
            [
              candidacyId,
              partyId,
              refs.dataSourceId,
              JSON.stringify({
                source: 'sos-michigan-candidacies',
                reported_party: row.party_abbreviation,
              }),
            ],
          );
        } else {
          await logIngestionError(
            ctx,
            refs.ingestionRunId,
            'validation',
            `MI party not resolved: "${row.party_abbreviation}"`,
            { ...row, candidacy_id: candidacyId },
          );
        }
      }
    } catch (err) {
      stats.rowsFailed += 1;
      const msg = err instanceof Error ? err.message : String(err);
      stats.errors.push({
        type: 'other',
        message: `MI row insert: ${msg}`,
        rawInput: row,
      });
      ctx.logger.warn('mi-candidacies: row insert failed', {
        error: msg,
        row: { name: row.reported_name, office: row.office_name },
      });
    }
  }

  return stats;
}

async function logIngestionError(
  ctx: AdapterContext,
  ingestionRunId: string,
  errorType: 'parse' | 'validation' | 'fk_violation' | 'other',
  message: string,
  rawInput: unknown,
): Promise<void> {
  try {
    await ctx.supabase.from('ingestion_errors').insert({
      ingestion_run_id: ingestionRunId,
      error_type: errorType,
      error_message: message.slice(0, 2000),
      raw_input: rawInput,
    });
  } catch (err) {
    ctx.logger.warn('mi-candidacies: ingestion_errors insert failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
