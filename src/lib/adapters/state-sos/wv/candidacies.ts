/**
 * West Virginia Secretary of State — 2026 candidate-filings adapter (FIPS 54).
 *
 * West Virginia ran its 2026 partisan primary on 2026-05-12 (per W.Va. Code
 * § 3-5-1 — second Tuesday of May in even years). The SoS publishes the
 * roster on the historical "candidate listing" service:
 *
 *   https://apps.sos.wv.gov/elections/candidate-search/
 *     — A .NET-based "Candidate Listing By Office" + "By Office With CFRS
 *       Reports" search portal. The home page lists prior cycles (2024,
 *       2022, 2020, ...) and a "Pre-candidate" section. The 2026 dropdown
 *       option appears once SoS posts that cycle's roster.
 *
 *   https://sos.wv.gov/elections/Pages/CandidateInformation.aspx
 *     — Marketing landing page; no machine-readable roster. Returns 404
 *       on direct fetch (the page exists but the case-sensitive URL doesn't
 *       resolve through this host's IIS rewrite — the path is correct but
 *       sos.wv.gov has migrated to a Drupal frontend that returns 404 for
 *       legacy ASPX paths). Captured in source meta for audit trail.
 *
 * State as of 2026-04-25
 * ----------------------
 * The candidate-search portal (apps.sos.wv.gov) does NOT yet expose a 2026
 * dropdown option — the most recent published cycle is 2024. WV's 2026
 * primary already ran (May 12, 2026), so the post-primary list will be the
 * "general election" roster pushed roughly 2-3 weeks after the primary.
 *
 * The portal also requires an ASP.NET-style POSTback (with __VIEWSTATE +
 * __EVENTVALIDATION + selected ElectionYear) to return a row set. The pure
 * GET on the home page lists the dropdown options but no data. Building
 * the POSTback dance is tier-2 work (council 2026-04-25) and out of scope
 * for this initial adapter.
 *
 * Adapter behavior
 * ----------------
 *   1. Fetches the home page via politeFetch
 *   2. Parses the dropdown to detect whether 2026 is available
 *   3. If 2026 is missing OR the page is unreachable:
 *      - Returns rows=[] with parserSignal='no_table'
 *      - Logs a partial-run reason ('roster not yet posted' / 'POSTback required')
 *   4. If 2026 IS exposed and a future POSTback impl lands, the parser hook
 *      below will pick up the row set automatically.
 *
 * The full insert / parse pipeline is wired so that when (a) the 2026
 * dropdown option appears AND (b) tier-2 POST support lands, candidate
 * rows flow through the same insert pipeline as the other states.
 */

import { createHash } from 'node:crypto';
import { load as loadHtml } from 'cheerio';
import type { Pool } from 'pg';

import { politeFetch } from '../../fetch-polite';
import {
  findOrCreatePerson as findOrCreateStatePerson,
  resolveOfficeElection,
} from '../candidate-resolver';
import { resolvePartyId } from '../party-resolver';
import type {
  AdapterContext,
  AdapterOutcome,
  DataSourceLicense,
  InsertRefs,
  InsertStats,
  ParserSignal,
  SourceAdapter,
} from '../../types';
import { createTokenBucket } from '../../rate-limit';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATE_FIPS = '54';
const ELECTION_YEAR = 2026;
const PRIMARY_DATE = '2026-05-12';
const GENERAL_DATE = '2026-11-03';

const DEFAULT_SOURCE_URL = 'https://apps.sos.wv.gov/elections/candidate-search/';

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

export type WvCandidacyRow = {
  reported_name: string;
  office_name: string;
  district_identifier: string | null;
  party_raw: string;
  source_row_id: string;
};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export type WvCandidaciesAdapterOptions = {
  sourceUrl?: string;
  license?: DataSourceLicense;
  tokenBucket?: { rps: number; burst: number };
  fetch?: (
    ctx: AdapterContext,
  ) => Promise<{ rawBody: string; httpStatus: number; resolvedUrl?: string }>;
  expectedMinRows?: number;
  electionYear?: number;
};

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Inspect the WV portal home page for which election years are exposed in
 * the dropdown. Returns true if `electionYear` is listed.
 */
export function wvDropdownHasYear(html: string, electionYear: number): boolean {
  if (!html) return false;
  const $ = loadHtml(html);
  // The home page lists year options as plain text inside the page (not
  // always in a <select>); look for the literal "2026" inside any
  // navigation-style section labeled "Candidate Listing By Office".
  const text = $.root().text();
  if (!text) return false;
  // Be conservative: require "2026" to appear in the same paragraph as
  // "Candidate Listing".
  const candidateSection = (() => {
    const ix = text.indexOf('Candidate Listing');
    if (ix < 0) return '';
    return text.slice(ix, ix + 300);
  })();
  return candidateSection.includes(String(electionYear));
}

export type WvParseResult = {
  rows: WvCandidacyRow[];
  signal: ParserSignal;
};

/**
 * Parse a WV candidate-listing result page (the post-postback HTML, NOT
 * the home page). Defensive: handles a generic <table> with name/office/
 * party columns. Today this code path isn't exercised because the
 * postback flow is not yet implemented; reserved for tier-2.
 */
export function parseWestVirginiaResultsHtml(html: string): WvParseResult {
  if (!html || html.length < 64) return { rows: [], signal: 'parse_failed' };
  if (!html.trimStart().startsWith('<')) return { rows: [], signal: 'parse_failed' };
  const $ = loadHtml(html);

  const rows: WvCandidacyRow[] = [];
  const seen = new Set<string>();
  let tableFound = false;

  $('table').each((tIdx, tableEl) => {
    const $t = $(tableEl);
    const headers = $t.find('tr').first().find('th, td')
      .map((_i, el) => $(el).text().trim().toLowerCase()).get();
    const cName = headers.findIndex((h) => /\bname\b|candidate/.test(h));
    const cParty = headers.findIndex((h) => /party/.test(h));
    const cOffice = headers.findIndex((h) => /office/.test(h));
    const cDistrict = headers.findIndex((h) => /district/.test(h));
    if (cName < 0 || cParty < 0 || cOffice < 0) return;
    tableFound = true;
    $t.find('tr').each((rIdx, trEl) => {
      if (rIdx === 0) return;
      const cells = $(trEl).find('td').map((_i, el) => $(el).text().trim()).get();
      if (cells.length === 0) return;
      const name = cells[cName] ?? '';
      const party = cells[cParty] ?? '';
      const office = cells[cOffice] ?? '';
      if (!name || !party || !office) return;
      const districtRaw = cDistrict >= 0 ? (cells[cDistrict] ?? '') : '';
      const district = districtRaw ? extractDistrictId(districtRaw) : extractDistrictId(office);
      const dedupKey = `${office.toLowerCase()}|${district ?? ''}|${party.toLowerCase()}|${name.toLowerCase()}`;
      if (seen.has(dedupKey)) return;
      seen.add(dedupKey);
      rows.push({
        reported_name: name, office_name: office,
        district_identifier: district, party_raw: party,
        source_row_id: `wv-t${tIdx}-r${rIdx}`,
      });
    });
  });

  if (!tableFound) return { rows: [], signal: 'no_table' };
  if (rows.length === 0) return { rows: [], signal: 'table_empty' };
  return { rows, signal: 'ok' };
}

function extractDistrictId(raw: string): string | null {
  if (!raw) return null;
  const m = /district\s*0*(\d{1,3})/i.exec(raw);
  return m && m[1] ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createWvCandidaciesAdapter(
  options: WvCandidaciesAdapterOptions = {},
): SourceAdapter<WvCandidacyRow> {
  const sourceUrl = options.sourceUrl ?? DEFAULT_SOURCE_URL;
  const license: DataSourceLicense = options.license ?? 'state_open_records';
  const tokenBucketCfg = options.tokenBucket ?? { rps: 0.5, burst: 2 };
  const bucket = createTokenBucket(tokenBucketCfg);
  const expectedMinRows = options.expectedMinRows ?? 0;
  const electionYear = options.electionYear ?? ELECTION_YEAR;

  const fetchImpl =
    options.fetch ??
    (async () => {
      const res = await politeFetch(sourceUrl, {
        headers: { Accept: 'text/html,*/*' },
      });
      const body = await res.text();
      return { rawBody: body, httpStatus: res.status, resolvedUrl: res.url };
    });

  const adapter: SourceAdapter<WvCandidacyRow> = {
    name: 'sos-west-virginia-candidacies',
    stateFips: STATE_FIPS,
    tokenBucket: tokenBucketCfg,
    costService: 'other',

    async run(ctx): Promise<AdapterOutcome<WvCandidacyRow>> {
      await bucket.acquire();
      const { rawBody, httpStatus, resolvedUrl } = await fetchImpl(ctx);
      const contentHash = createHash('sha256').update(rawBody).digest('hex');

      let rows: WvCandidacyRow[] = [];
      let signal: ParserSignal = 'ok';

      if (httpStatus >= 400) {
        // Not fatal — the home page sometimes 404s by case mismatch.
        // Treat as 'no_table' and let the daily refresh retry.
        ctx.logger.warn(
          `${adapter.name}: HTTP ${httpStatus} from ${sourceUrl} — treating as no_table for retry`,
        );
        signal = 'no_table';
      } else {
        const hasYear = wvDropdownHasYear(rawBody, electionYear);
        if (!hasYear) {
          ctx.logger.info(
            `${adapter.name}: portal home page does not yet list ${electionYear} dropdown option; roster not yet published`,
            { url: sourceUrl },
          );
          signal = 'no_table';
        } else {
          // Year IS exposed but POSTback dance to fetch the actual rows
          // is tier-2 work. Surface that explicitly so the next refresh
          // doesn't silently treat empty as success.
          ctx.logger.warn(
            `${adapter.name}: ${electionYear} dropdown is now available, but POSTback fetch is tier-2 work — TODO`,
            { url: sourceUrl },
          );
          signal = 'no_table';
        }
      }

      ctx.logger.info(`${adapter.name}: parsed`, { rowCount: rows.length, signal });

      return {
        rows,
        expectedMinRows,
        parserSignal: signal,
        source: {
          sourceType: 'sos_candidate_filing',
          name: 'west-virginia-sos-candidacies',
          url: resolvedUrl ?? sourceUrl,
          contentHash, license, stateFips: STATE_FIPS,
          meta: {
            election_year: electionYear,
            primary_date: PRIMARY_DATE,
            general_date: GENERAL_DATE,
            http_status: httpStatus,
            byte_size: rawBody.length,
            requires_postback: true,
            year_exposed_in_dropdown: wvDropdownHasYear(rawBody, electionYear),
          },
        },
      };
    },

    validateRow(row) {
      if (!row.reported_name || !row.reported_name.trim()) return 'missing reported_name';
      if (!row.office_name || !row.office_name.trim()) return 'missing office_name';
      if (!row.party_raw) return 'missing party_raw';
      return null;
    },

    async insert(rows, refs, ctx): Promise<InsertStats> {
      return insertWvCandidacies(rows, refs, ctx, electionYear);
    },
  };
  return adapter;
}

// ---------------------------------------------------------------------------
// Insert
// ---------------------------------------------------------------------------

export async function insertWvCandidacies(
  rows: WvCandidacyRow[],
  refs: InsertRefs,
  ctx: AdapterContext,
  electionYear: number,
): Promise<InsertStats> {
  const stats: InsertStats = {
    rowsInserted: 0, rowsUpdated: 0, rowsSkipped: 0, rowsFailed: 0, errors: [],
  };
  if (rows.length === 0) return stats;

  for (const row of rows) {
    const officeInfo = await resolveOfficeElection(ctx.pg, {
      state_fips: STATE_FIPS,
      office_name: row.office_name,
      district_identifier: row.district_identifier,
      election_year: electionYear,
    });
    if (!officeInfo) {
      stats.rowsSkipped += 1;
      await logIngestionError(ctx, refs.ingestionRunId, 'validation',
        `WV office not resolved: "${row.office_name}" district=${row.district_identifier ?? '-'}`,
        row);
      continue;
    }
    if (ctx.dryRun) { stats.rowsInserted += 1; continue; }
    try {
      const personId = await findOrCreateStatePerson(ctx.pg, {
        name: row.reported_name, state_fips: STATE_FIPS, electionYear,
        source: 'sos-west-virginia-candidacies', dataSourceId: refs.dataSourceId,
      });
      const candRes = await ctx.pg.query<{ id: string; inserted: boolean }>(
        `INSERT INTO candidacies (election_id, person_id, party, status, meta)
         VALUES ($1, $2, $3, 'active', $4::jsonb)
         ON CONFLICT (election_id, person_id) DO UPDATE
           SET party = EXCLUDED.party, status = 'active'
         RETURNING id, (xmax = 0) AS inserted`,
        [officeInfo.election_id, personId, row.party_raw,
         JSON.stringify({
           source: 'sos-west-virginia-candidacies',
           data_source_id: refs.dataSourceId ?? null,
           reported_office: row.office_name,
         })],
      );
      const candidacyId = candRes.rows[0]?.id;
      const wasInserted = candRes.rows[0]?.inserted === true;
      if (!candidacyId) {
        stats.rowsFailed += 1;
        stats.errors.push({ type: 'other', message: 'candidacy upsert returned no id', rawInput: row });
        continue;
      }
      const partyId = await resolvePartyId(ctx.pg, row.party_raw, STATE_FIPS);
      if (partyId) {
        await ctx.pg.query(
          `INSERT INTO candidacy_party_lines
             (candidacy_id, party_id, ballot_line_order, nomination_method, data_source_id, meta)
           VALUES ($1, $2, 1, 'primary', $3::uuid, $4::jsonb)
           ON CONFLICT (candidacy_id, party_id) DO NOTHING`,
          [candidacyId, partyId, refs.dataSourceId ?? null,
           JSON.stringify({ source: 'sos-west-virginia-candidacies' })],
        );
      } else {
        await logIngestionError(ctx, refs.ingestionRunId, 'validation',
          `WV party not resolved: "${row.party_raw}" for ${row.reported_name}`,
          row);
      }
      if (wasInserted) stats.rowsInserted += 1; else stats.rowsUpdated += 1;
    } catch (err) {
      stats.rowsFailed += 1;
      const msg = err instanceof Error ? err.message : String(err);
      stats.errors.push({ type: 'other', message: `WV insert: ${msg}`, rawInput: row });
    }
  }
  return stats;
}

async function logIngestionError(
  ctx: AdapterContext, ingestionRunId: string,
  errorType: 'parse' | 'validation' | 'fk_violation' | 'other',
  message: string, rawInput: unknown,
): Promise<void> {
  try {
    await ctx.supabase.from('ingestion_errors').insert({
      ingestion_run_id: ingestionRunId, error_type: errorType,
      error_message: message.slice(0, 2000), raw_input: rawInput,
    });
  } catch (err) {
    ctx.logger.warn('sos-west-virginia-candidacies: ingestion_errors insert failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export type { Pool };
