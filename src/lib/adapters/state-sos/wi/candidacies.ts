/**
 * Wisconsin Elections Commission — 2026 candidate-filings adapter (FIPS 55).
 *
 * Wisconsin's federal/statewide partisan primary is 2026-08-11 (per Wis.
 * Stat. § 5.02(21)). Filing window for the August primary closes June 1
 * for non-incumbents. The Wisconsin Elections Commission (WEC) — there is
 * no SoS election function in WI; WEC is the governing body — publishes
 * the qualified-candidate roster on elections.wi.gov.
 *
 * Source URLs (web-verified 2026-04-25):
 *   https://elections.wi.gov/elections/candidates                  (primary)
 *   https://elections.wi.gov/2026-fall-elections-candidates        (alt)
 *   https://elections.wi.gov/elections-voting/elections            (calendar)
 *
 * Wall observed (2026-04-25)
 * --------------------------
 * elections.wi.gov is fronted by Cloudflare with a "Just a moment..." JS
 * challenge. Every politeFetch attempt returns HTTP 403 with a ~5.7 KB
 * Cloudflare interstitial. This adapter has no automated workaround.
 *
 * Adapter behavior under the wall
 * -------------------------------
 *   1. Fetches via politeFetch
 *   2. Detects the Cloudflare challenge
 *   3. Returns rows=[] with parserSignal='no_table' so the runner records
 *      'unproductive', not 'success'
 *   4. Logs the wall to the run meta + ingestion_errors
 *
 * The pure parser is wired so that as soon as the real HTML is available
 * (for example through a published export), candidate rows flow through
 * the same insert pipeline as the other states. WI publishes its lists in HTML tables ("Senator District 1" /
 * "Assembly District 17" with one row per candidate); the parser handles
 * that shape.
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

const STATE_FIPS = '55';
const ELECTION_YEAR = 2026;
const PRIMARY_DATE = '2026-08-11';

const DEFAULT_SOURCE_URL = 'https://elections.wi.gov/elections/candidates';

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

export type WiCandidacyRow = {
  reported_name: string;
  office_name: string;
  district_identifier: string | null;
  party_raw: string;
  source_row_id: string;
};

// ---------------------------------------------------------------------------
// Wall detection (mirrors oh/candidacies.ts isCloudflareChallenge)
// ---------------------------------------------------------------------------

export function isCloudflareChallenge(status: number, body: string): boolean {
  if (status === 403 || status === 503) return true;
  if (typeof body !== 'string' || body.length === 0) return false;
  const snippet = body.slice(0, 8192).toLowerCase();
  return (
    snippet.includes('__cf_chl') ||
    snippet.includes('cf-chl-bypass') ||
    snippet.includes('cf-browser-verification') ||
    (snippet.includes('cloudflare') && snippet.includes('challenge')) ||
    snippet.includes('just a moment')
  );
}

// ---------------------------------------------------------------------------
// Pure parser (exported for tests)
// ---------------------------------------------------------------------------

export type WiParseResult = {
  rows: WiCandidacyRow[];
  signal: ParserSignal;
};

export function parseWisconsinHtml(body: string): WiParseResult {
  if (!body || body.length < 64) return { rows: [], signal: 'parse_failed' };
  if (isCloudflareChallenge(200, body)) return { rows: [], signal: 'no_table' };
  const trimmed = body.trimStart();
  if (!trimmed.startsWith('<')) return { rows: [], signal: 'parse_failed' };

  const $ = loadHtml(body);
  const rows: WiCandidacyRow[] = [];
  const seen = new Set<string>();
  let tableFound = false;

  $('table').each((tIdx, tableEl) => {
    const $t = $(tableEl);
    const headers = $t.find('tr').first().find('th, td')
      .map((_i, el) => $(el).text().trim().toLowerCase()).get();
    const cName = headers.findIndex((h) => /\bname\b|candidate/.test(h));
    const cParty = headers.findIndex((h) => /party/.test(h));
    if (cName < 0) return;
    tableFound = true;
    let officeFromHeading = '';
    const $prev = $t.prevAll('h1,h2,h3,h4').first();
    if ($prev.length) officeFromHeading = $prev.text().trim();

    $t.find('tr').each((rIdx, trEl) => {
      if (rIdx === 0) return;
      const cells = $(trEl).find('td').map((_i, el) => $(el).text().trim()).get();
      if (cells.length === 0) return;
      const name = cells[cName] ?? '';
      const party = cParty >= 0 ? (cells[cParty] ?? '') : '';
      if (!name || !party) return;
      const district = extractDistrictId(officeFromHeading);
      const dedupKey = `${officeFromHeading.toLowerCase()}|${district ?? ''}|${party.toLowerCase()}|${name.toLowerCase()}`;
      if (seen.has(dedupKey)) return;
      seen.add(dedupKey);
      rows.push({
        reported_name: name,
        office_name: officeFromHeading || 'Unknown Office',
        district_identifier: district,
        party_raw: party,
        source_row_id: `wi-t${tIdx}-r${rIdx}`,
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
// Fetch (politeFetch only; a CF challenge is returned as-is)
// ---------------------------------------------------------------------------

export async function fetchWisconsinCandidatesPage(
  url: string,
): Promise<{ status: number; body: string }> {
  const res = await politeFetch(url, {
    headers: { Accept: 'text/html,*/*' },
  });
  const body = await res.text();
  return { status: res.status, body };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export type WiCandidaciesAdapterOptions = {
  sourceUrl?: string;
  license?: DataSourceLicense;
  tokenBucket?: { rps: number; burst: number };
  fetch?: (
    ctx: AdapterContext,
  ) => Promise<{ rawBody: string; httpStatus: number; resolvedUrl?: string }>;
  expectedMinRows?: number;
  electionYear?: number;
};

export function createWiCandidaciesAdapter(
  options: WiCandidaciesAdapterOptions = {},
): SourceAdapter<WiCandidacyRow> {
  const sourceUrl = options.sourceUrl ?? DEFAULT_SOURCE_URL;
  const license: DataSourceLicense = options.license ?? 'state_open_records';
  const tokenBucketCfg = options.tokenBucket ?? { rps: 0.5, burst: 2 };
  const bucket = createTokenBucket(tokenBucketCfg);
  const expectedMinRows = options.expectedMinRows ?? 0;
  const electionYear = options.electionYear ?? ELECTION_YEAR;

  const fetchImpl =
    options.fetch ??
    (async () => {
      const r = await fetchWisconsinCandidatesPage(sourceUrl);
      return {
        rawBody: r.body,
        httpStatus: r.status,
        resolvedUrl: sourceUrl,
      };
    });

  const adapter: SourceAdapter<WiCandidacyRow> = {
    name: 'sos-wisconsin-candidacies',
    stateFips: STATE_FIPS,
    tokenBucket: tokenBucketCfg,
    costService: 'other',

    async run(ctx): Promise<AdapterOutcome<WiCandidacyRow>> {
      await bucket.acquire();
      const { rawBody, httpStatus, resolvedUrl } = await fetchImpl(ctx);
      const contentHash = createHash('sha256').update(rawBody).digest('hex');

      let rows: WiCandidacyRow[] = [];
      let signal: ParserSignal = 'ok';
      const walled = isCloudflareChallenge(httpStatus, rawBody);

      if (walled) {
        ctx.logger.warn(
          `${adapter.name}: Cloudflare wall — source requires a browser, skipped; returning empty roster`,
          { url: sourceUrl, status: httpStatus, byte_size: rawBody.length },
        );
        signal = 'no_table';
      } else if (httpStatus >= 400) {
        throw new Error(`${adapter.name}: HTTP ${httpStatus} from ${sourceUrl}`);
      } else {
        const parsed = parseWisconsinHtml(rawBody);
        rows = parsed.rows;
        signal = parsed.signal;
      }

      ctx.logger.info(`${adapter.name}: parsed`, { rowCount: rows.length, signal });

      return {
        rows,
        expectedMinRows,
        parserSignal: signal,
        source: {
          sourceType: 'sos_candidate_filing',
          name: 'wisconsin-wec-candidacies',
          url: resolvedUrl ?? sourceUrl,
          contentHash, license, stateFips: STATE_FIPS,
          meta: {
            election_year: electionYear,
            primary_date: PRIMARY_DATE,
            http_status: httpStatus,
            byte_size: rawBody.length,
            cloudflare_walled: walled,
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
      return insertWiCandidacies(rows, refs, ctx, electionYear);
    },
  };
  return adapter;
}

// ---------------------------------------------------------------------------
// Insert
// ---------------------------------------------------------------------------

export async function insertWiCandidacies(
  rows: WiCandidacyRow[],
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
        `WI office not resolved: "${row.office_name}" district=${row.district_identifier ?? '-'}`,
        row);
      continue;
    }
    if (ctx.dryRun) { stats.rowsInserted += 1; continue; }
    try {
      const personId = await findOrCreateStatePerson(ctx.pg, {
        name: row.reported_name, state_fips: STATE_FIPS, electionYear,
        source: 'sos-wisconsin-candidacies', dataSourceId: refs.dataSourceId,
      });
      const candRes = await ctx.pg.query<{ id: string; inserted: boolean }>(
        `INSERT INTO candidacies (election_id, person_id, party, status, meta)
         VALUES ($1, $2, $3, 'active', $4::jsonb)
         ON CONFLICT (election_id, person_id) DO UPDATE
           SET party = EXCLUDED.party, status = 'active'
         RETURNING id, (xmax = 0) AS inserted`,
        [officeInfo.election_id, personId, row.party_raw,
         JSON.stringify({
           source: 'sos-wisconsin-candidacies',
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
           JSON.stringify({ source: 'sos-wisconsin-candidacies' })],
        );
      } else {
        await logIngestionError(ctx, refs.ingestionRunId, 'validation',
          `WI party not resolved: "${row.party_raw}" for ${row.reported_name}`,
          row);
      }
      if (wasInserted) stats.rowsInserted += 1; else stats.rowsUpdated += 1;
    } catch (err) {
      stats.rowsFailed += 1;
      const msg = err instanceof Error ? err.message : String(err);
      stats.errors.push({ type: 'other', message: `WI insert: ${msg}`, rawInput: row });
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
    ctx.logger.warn('sos-wisconsin-candidacies: ingestion_errors insert failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export type { Pool };
