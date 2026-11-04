/**
 * Kansas Secretary of State — 2026 primary candidate-filings adapter (FIPS 20).
 *
 * Primary is 2026-08-04 (semi-closed; party-affiliated voters only, plus
 * unaffiliated voters who pick a party at the polls).
 *
 * Source landing pages (web-verified 2026-04-25):
 *   https://sos.ks.gov/elections/elections-candidate-filings.html
 *     — redirects to Page Not Found on the new SoS site; the canonical
 *       listing UI now lives at:
 *   https://sos.ks.gov/elections/elections_upcoming_candidate.aspx
 *     — ASP.NET WebForms page with a "Choose an election" dropdown
 *       (`ddlElections`). The 2026 Primary maps to value `35` and the 2026
 *       General to `36`. Selecting an election triggers an ASP.NET postback
 *       (`__VIEWSTATE` + `__EVENTVALIDATION`) and a client-side render of
 *       the candidate grid.
 *
 * Source format — DOCUMENTED BLOCKER
 * -----------------------------------
 * The candidate grid is rendered entirely client-side by JavaScript (the
 * server response contains the page chrome + dropdown but no `<tr>` rows or
 * `<table>` data). Postback POSTs with the captured `__VIEWSTATE` /
 * `__EVENTVALIDATION` / `ddlElections=35` return the same shell — no rows.
 *
 * Verified 2026-04-25 by:
 *   1. GET    https://sos.ks.gov/elections/elections_upcoming_candidate.aspx
 *      → 200, no `<tr>` elements in body (0 rows)
 *   2. POST  with viewstate + ddlElections=35
 *      → 200, still 0 rows (the grid is fetched via XHR after page load)
 *   3. GET ?elecID=35  → 200, 0 rows
 *
 * The XHR endpoint that backfills the grid is not currently identified —
 * candidates likely flow through a separate JSON or SignalR-style call. A
 * Playwright fallback (already used by OH for Cloudflare) would solve this
 * by waiting on `networkidle` and then reading the rendered DOM. That work
 * is Phase 2 (the adapter shape is wired so swapping the fetch implementation
 * is the only change needed).
 *
 * Today this adapter:
 *   1. Fetches the WebForms shell via politeFetch and records the SHA-256,
 *   2. Returns ZERO rows (parser is a stub that filters out the empty page),
 *   3. Logs a CLEAR blocker on the ingestion run so a Phase-2 ticket lands.
 *
 * What's on the 2026 KS primary ballot (per
 *   https://sos.ks.gov/elections/candidate-information.html web-verified
 *   2026-04-25):
 *   - 1 U.S. Senator
 *   - 4 U.S. Representatives
 *   - Governor / Lt. Governor
 *   - Secretary of State, Attorney General, State Treasurer
 *   - Commissioner of Insurance
 *   - State Senate District 24 (only Senate seat on this cycle)
 *   - All 125 State Representatives
 *   - State Board of Education (Districts 1, 3, 5, 7, 9)
 *   - 1 Kansas Supreme Court Justice (retention)
 */

import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import type {
  AdapterContext,
  AdapterOutcome,
  DataSourceLicense,
  InsertRefs,
  InsertStats,
  SourceAdapter,
} from '../../types';
import { createTokenBucket } from '../../rate-limit';
import { politeFetch } from '../../fetch-polite';
import {
  findOrCreatePerson as findOrCreateStatePerson,
  resolveOfficeElection,
} from '../candidate-resolver';
import { resolvePartyId } from '../party-resolver';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATE_FIPS = '20';
const ELECTION_YEAR = 2026;
const PRIMARY_DATE = '2026-08-04';

const DEFAULT_SOURCE_URL =
  'https://sos.ks.gov/elections/elections_upcoming_candidate.aspx?elecID=35';

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

export type KsCandidacyRow = {
  reported_name: string;
  office_name: string;
  district_identifier: string | null;
  party_raw: string;
  date_filed: string | null;
  is_write_in: boolean;
  source_row_id: string;
};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export type KsCandidaciesAdapterOptions = {
  sourceUrl?: string;
  electionYear?: number;
  license?: DataSourceLicense;
  tokenBucket?: { rps: number; burst: number };
  fetch?: (ctx: AdapterContext) => Promise<{ rawBody: string; resolvedUrl?: string }>;
  parseOverride?: (html: string) => KsCandidacyRow[];
};

// ---------------------------------------------------------------------------
// Parser stub — see file header for blocker explanation
// ---------------------------------------------------------------------------

/**
 * Parse the Kansas elections candidate page. The WebForms shell HTML carries
 * no `<tr>` candidate rows — the grid is XHR-loaded by the page's JS. This
 * stub falls back to the same heuristic as OH: if the body has no rendered
 * candidate table, return [] and let the framework record a `partial` run.
 *
 * Once Playwright fallback is wired (Phase 2), this parser will receive
 * post-render HTML and can use cheerio to walk the populated grid.
 */
export function parseKansasHtml(html: string): KsCandidacyRow[] {
  if (!html || html.length < 64) return [];
  const $ = cheerio.load(html);
  const rows: KsCandidacyRow[] = [];

  // Look for tables that have a candidate-shaped header row. Kansas's
  // rendered grid (post-JS) uses Bootstrap tables with `Office`,
  // `Candidate Name`, `Party`, `District` columns — match by header text.
  $('table').each((tableIdx, tableEl) => {
    const $table = $(tableEl);
    const headerCells = $table
      .find('tr')
      .first()
      .find('th,td')
      .map((_i, el) => $(el).text().trim().toLowerCase())
      .get();
    if (headerCells.length === 0) return;
    const nameCol = headerCells.findIndex(
      (h) => h.includes('candidate') || h === 'name',
    );
    const partyCol = headerCells.findIndex((h) => h.includes('party'));
    const officeCol = headerCells.findIndex((h) => h.includes('office'));
    const districtCol = headerCells.findIndex((h) => h.includes('district'));
    if (nameCol < 0 || officeCol < 0) return;

    $table.find('tr').each((rowIdx, trEl) => {
      if (rowIdx === 0) return;
      const cells = $(trEl)
        .find('td')
        .map((_i, el) => $(el).text().trim())
        .get();
      if (cells.length < 2) return;
      const name = cells[nameCol];
      const office = cells[officeCol];
      if (!name || !office) return;
      rows.push({
        reported_name: name,
        office_name: office,
        district_identifier: districtCol >= 0 ? cells[districtCol] || null : null,
        party_raw: partyCol >= 0 ? cells[partyCol] || '' : '',
        date_filed: null,
        is_write_in: /write[-\s]*in/i.test(name),
        source_row_id: `ks-t${tableIdx}-r${rowIdx}`,
      });
    });
  });

  return rows;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createKsCandidaciesAdapter(
  options: KsCandidaciesAdapterOptions = {},
): SourceAdapter<KsCandidacyRow> {
  const sourceUrl = options.sourceUrl ?? DEFAULT_SOURCE_URL;
  const license: DataSourceLicense = options.license ?? 'state_open_records';
  const tokenBucketCfg = options.tokenBucket ?? { rps: 0.5, burst: 2 };
  const bucket = createTokenBucket(tokenBucketCfg);
  const electionYear = options.electionYear ?? ELECTION_YEAR;

  const fetchHtml =
    options.fetch ??
    (async () => {
      const res = await politeFetch(sourceUrl, {
        headers: {
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });
      const body = await res.text();
      if (!res.ok) {
        throw new Error(
          `KS candidacies fetch failed: HTTP ${res.status} from ${sourceUrl}`,
        );
      }
      return { rawBody: body, resolvedUrl: res.url };
    });

  const parser = options.parseOverride ?? parseKansasHtml;

  const adapter: SourceAdapter<KsCandidacyRow> = {
    name: 'sos-kansas-candidacies',
    stateFips: STATE_FIPS,
    tokenBucket: tokenBucketCfg,

    async run(ctx: AdapterContext): Promise<AdapterOutcome<KsCandidacyRow>> {
      await bucket.acquire();
      ctx.logger.info(`${adapter.name}: fetching`, {
        stateFips: STATE_FIPS,
        url: sourceUrl,
      });

      const { rawBody, resolvedUrl } = await fetchHtml(ctx);
      const contentHash = createHash('sha256').update(rawBody).digest('hex');

      ctx.logger.info(`${adapter.name}: fetched`, {
        bytes: rawBody.length,
        contentHash: contentHash.slice(0, 12),
      });

      const rows = parser(rawBody);

      if (rows.length === 0) {
        ctx.logger.warn(
          `${adapter.name}: parser returned 0 rows — KS SoS candidate grid is ` +
            'JS-rendered (XHR after page load); plain HTML fetch returns shell ' +
            'only. See file header for blocker; ingestion run will record ' +
            '`partial`. Phase 2 swaps fetchHtml for the Playwright fallback.',
          { bytes: rawBody.length, contentHash: contentHash.slice(0, 12) },
        );
      }

      return {
        rows,
        expectedMinRows: 0,
        source: {
          sourceType: 'sos_candidate_filing',
          name: 'kansas-sos-candidacies',
          url: resolvedUrl ?? sourceUrl,
          contentHash,
          license,
          stateFips: STATE_FIPS,
          meta: {
            election_year: electionYear,
            primary_date: PRIMARY_DATE,
            byte_size: rawBody.length,
            blocker: 'js_rendered_grid',
            blocker_doc:
              'KS candidate grid is XHR-rendered. Wire Playwright fallback ' +
              '(see oh/candidacies.ts for the established pattern).',
          },
        },
      };
    },

    validateRow(row) {
      if (!row.reported_name?.trim()) return 'missing reported_name';
      if (!row.office_name) return 'missing office_name';
      return null;
    },

    async insert(
      rows: KsCandidacyRow[],
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
              `KS office not resolved: "${row.office_name}" district=${row.district_identifier ?? '-'}`,
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
            source: 'sos-kansas-candidacies',
            dataSourceId: refs.dataSourceId,
          });
          const candidacyRes = await ctx.pg.query<{ id: string; inserted: boolean }>(
            `INSERT INTO candidacies
               (election_id, person_id, party, status, filed_on, meta)
             VALUES ($1, $2, $3, 'active', $4::date, $5::jsonb)
             ON CONFLICT (election_id, person_id) DO UPDATE
               SET party = EXCLUDED.party
             RETURNING id, (xmax = 0) AS inserted`,
            [
              officeInfo.election_id,
              personId,
              row.party_raw,
              row.date_filed,
              JSON.stringify({
                source: 'sos-kansas-candidacies',
                reported_office: row.office_name,
                source_row_id: row.source_row_id,
                data_source_id: refs.dataSourceId,
              }),
            ],
          );
          const candidacyId = candidacyRes.rows[0]!.id;
          if (candidacyRes.rows[0]!.inserted) stats.rowsInserted += 1;
          else stats.rowsUpdated += 1;
          if (row.party_raw) {
            const partyId = await resolvePartyId(ctx.pg, row.party_raw, STATE_FIPS);
            if (partyId) {
              await ctx.pg.query(
                `INSERT INTO candidacy_party_lines
                   (candidacy_id, party_id, ballot_line_order, nomination_method,
                    data_source_id, meta)
                 VALUES ($1, $2, 1, 'primary', $3::uuid, $4::jsonb)
                 ON CONFLICT (candidacy_id, party_id) DO NOTHING`,
                [
                  candidacyId,
                  partyId,
                  refs.dataSourceId ?? null,
                  JSON.stringify({ source: 'sos-kansas-candidacies' }),
                ],
              );
            }
          }
        } catch (err) {
          stats.rowsFailed += 1;
          stats.errors.push({
            type: 'other',
            message: `KS candidacy insert: ${err instanceof Error ? err.message : String(err)}`,
            rawInput: row,
          });
        }
      }
      return stats;
    },
  };

  return adapter;
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
    ctx.logger.warn('sos-kansas-candidacies: ingestion_errors insert failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
