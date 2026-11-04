/**
 * Washington Secretary of State — 2026 candidate-filings adapter (FIPS 53).
 *
 * Washington uses a "Top Two" primary on 2026-08-04. Filing window is
 * 2026-05-11 through 2026-05-15 (RCW 29A.24.050). The authoritative
 * candidate roster is published on voter.votewa.gov, the SoS-run public
 * voter portal, parameterized by election id:
 *
 *   https://voter.votewa.gov/CandidateList.aspx?e=898   (PRIMARY 2026)
 *   https://voter.votewa.gov/CandidateList.aspx?e=897   (GENERAL 2026)
 *
 * Both pages serve a server-rendered HTML table whose header row is:
 *   District Type | District | Race | Term Type | Term Length | Name |
 *   Mailing Address | Email | Phone | Filing Date | Party Preference |
 *   Status | Election Status | Ballot Order
 *
 * NOTE (2026-04-25): the table is EMPTY today — filing window opens
 * 2026-05-11. The adapter still ships now so the daily-refresh loop picks
 * up rows the moment SoS publishes them. Empty runs are signaled with
 * parserSignal='table_empty' so the runner doesn't lie with status='success'.
 *
 * Source verified 2026-04-25 via politeFetch:
 *   - HTTP 200, ~100 KB, public-readable, no captcha or login wall
 *   - Header row present, 0 data rows pre-filing-window
 *   - Page at /Default.aspx?e=898&c=99 is the same data with a different
 *     left-side filter widget (county dropdown); /CandidateList.aspx is
 *     the printable/scrapable view we target.
 *
 * Schema notes
 * ------------
 * "Race" carries a concatenated string like "U.S. Senator" or
 * "State Representative Pos. 1, District 41" — we split on the first
 * "District" token to recover the office name and district number.
 *
 * "Party Preference" in WA top-two is a candidate-declared preference
 * (e.g. "GOP Party", "Democratic Party", "States No Party Preference"),
 * not an actual nominating party. We pass the raw string through to
 * resolvePartyId; the parties table normalizes "GOP" / "Republican" / etc.
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

const STATE_FIPS = '53';
const ELECTION_YEAR = 2026;
const PRIMARY_DATE = '2026-08-04';

const DEFAULT_SOURCE_URL =
  'https://voter.votewa.gov/CandidateList.aspx?e=898';

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

export type WaCandidacyRow = {
  reported_name: string;
  /** "U.S. Senator", "State Representative Pos. 1", etc. */
  office_name: string;
  /** District number when present in the Race column. */
  district_identifier: string | null;
  /** Raw "Party Preference" string. */
  party_raw: string;
  /** "Filed" / "Withdrawn" / etc. from the Status column. */
  status_raw: string;
  source_row_id: string;
};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export type WaCandidaciesAdapterOptions = {
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
// Pure parser (exported for tests)
// ---------------------------------------------------------------------------

export type WaParseResult = {
  rows: WaCandidacyRow[];
  signal: ParserSignal;
};

/** Strip "<n>th District" / "Pos. N" / "District N" → split office and district. */
export function splitWaRace(raw: string): {
  office: string;
  district: string | null;
} {
  if (!raw) return { office: '', district: null };
  const s = raw.trim();
  // "Legislative District 1 - State Representative Pos. 1"
  const ld = /Legislative\s+District\s+(\d+)/i.exec(s);
  if (ld) {
    const office = s
      .replace(/Legislative\s+District\s+\d+\s*[-–:]?\s*/i, '')
      .trim();
    return { office: office || s, district: ld[1]! };
  }
  // "State Senate District 27"
  const sd = /District\s+(\d+)/i.exec(s);
  if (sd) {
    const office = s.replace(/,?\s*District\s+\d+/i, '').trim();
    return { office: office || s, district: sd[1]! };
  }
  // "U.S. Representative — Congressional District 1"
  const cd = /Congressional\s+District\s+(\d+)/i.exec(s);
  if (cd) {
    const office = s.replace(/,?\s*Congressional\s+District\s+\d+/i, '').trim();
    return { office: office || s, district: cd[1]! };
  }
  return { office: s, district: null };
}

export function parseWashingtonHtml(rawHtml: string): WaParseResult {
  if (!rawHtml || rawHtml.length < 64) return { rows: [], signal: 'parse_failed' };
  const trimmed = rawHtml.trimStart();
  if (!trimmed.startsWith('<')) return { rows: [], signal: 'parse_failed' };

  const $ = loadHtml(rawHtml);
  let bestRows: WaCandidacyRow[] = [];
  let foundTable = false;

  $('table').each((tIdx, tableEl) => {
    const $t = $(tableEl);
    const headerCells = $t.find('tr').first().find('th, td')
      .map((_i, el) => $(el).text().trim().toLowerCase()).get();
    if (headerCells.length === 0) return;

    // Heuristic: WA candidate table has columns including 'name' AND 'race'
    // AND ('party preference' OR 'party').
    const hasName = headerCells.some((h) => /\bname\b/.test(h));
    const hasRace = headerCells.some((h) => /\brace\b/.test(h));
    const hasParty = headerCells.some((h) => /party/.test(h));
    if (!hasName || !hasRace || !hasParty) return;

    foundTable = true;
    const ix = (matcher: (h: string) => boolean): number =>
      headerCells.findIndex(matcher);
    const cName = ix((h) => h === 'name' || h.endsWith(' name'));
    const cRace = ix((h) => h === 'race');
    const cParty = ix((h) => /party preference/.test(h)) >= 0
      ? ix((h) => /party preference/.test(h))
      : ix((h) => /party/.test(h));
    const cStatus = ix((h) => h === 'status');
    const cFiled = ix((h) => /filing date/.test(h));

    const rowsOut: WaCandidacyRow[] = [];
    const seen = new Set<string>();
    $t.find('tr').each((rIdx, trEl) => {
      if (rIdx === 0) return;
      const cells = $(trEl).find('td').map((_i, el) => $(el).text().trim()).get();
      if (cells.length === 0) return;
      const name = cells[cName] ?? '';
      const race = cells[cRace] ?? '';
      const party = cells[cParty] ?? '';
      if (!name || !race || !party) return;

      const { office, district } = splitWaRace(race);
      const status = cStatus >= 0 ? (cells[cStatus] ?? '') : '';
      const filed = cFiled >= 0 ? (cells[cFiled] ?? '') : '';
      const dedupKey = `wa-t${tIdx}|${office.toLowerCase()}|${district ?? ''}|${party.toLowerCase()}|${name.toLowerCase()}|${filed}`;
      if (seen.has(dedupKey)) return;
      seen.add(dedupKey);
      rowsOut.push({
        reported_name: name,
        office_name: office,
        district_identifier: district,
        party_raw: party,
        status_raw: status,
        source_row_id: dedupKey,
      });
    });

    if (rowsOut.length > bestRows.length) bestRows = rowsOut;
  });

  if (!foundTable) return { rows: [], signal: 'no_table' };
  if (bestRows.length === 0) return { rows: [], signal: 'table_empty' };
  return { rows: bestRows, signal: 'ok' };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createWaCandidaciesAdapter(
  options: WaCandidaciesAdapterOptions = {},
): SourceAdapter<WaCandidacyRow> {
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

  const adapter: SourceAdapter<WaCandidacyRow> = {
    name: 'sos-washington-candidacies',
    stateFips: STATE_FIPS,
    tokenBucket: tokenBucketCfg,
    costService: 'other',

    async run(ctx: AdapterContext): Promise<AdapterOutcome<WaCandidacyRow>> {
      await bucket.acquire();
      ctx.logger.info(`${adapter.name}: fetching`, {
        stateFips: STATE_FIPS, url: sourceUrl,
      });

      const { rawBody, httpStatus, resolvedUrl } = await fetchImpl(ctx);
      const contentHash = createHash('sha256').update(rawBody).digest('hex');

      let rows: WaCandidacyRow[] = [];
      let signal: ParserSignal = 'ok';

      if (httpStatus >= 400) {
        throw new Error(`${adapter.name}: HTTP ${httpStatus} from ${sourceUrl}`);
      } else {
        const parsed = parseWashingtonHtml(rawBody);
        rows = parsed.rows;
        signal = parsed.signal;
      }

      ctx.logger.info(`${adapter.name}: parsed`, {
        rowCount: rows.length, signal,
      });

      return {
        rows,
        expectedMinRows,
        parserSignal: signal,
        source: {
          sourceType: 'sos_candidate_filing',
          name: 'washington-sos-candidacies',
          url: resolvedUrl ?? sourceUrl,
          contentHash, license, stateFips: STATE_FIPS,
          meta: {
            election_year: electionYear,
            primary_date: PRIMARY_DATE,
            http_status: httpStatus,
            byte_size: rawBody.length,
            // RCW 29A.24.050.
            filing_window_open: '2026-05-11',
            filing_window_close: '2026-05-15',
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
      return insertWaCandidacies(rows, refs, ctx, electionYear);
    },
  };

  return adapter;
}

// ---------------------------------------------------------------------------
// Insert
// ---------------------------------------------------------------------------

export async function insertWaCandidacies(
  rows: WaCandidacyRow[],
  refs: InsertRefs,
  ctx: AdapterContext,
  electionYear: number,
): Promise<InsertStats> {
  const stats: InsertStats = {
    rowsInserted: 0, rowsUpdated: 0, rowsSkipped: 0, rowsFailed: 0, errors: [],
  };
  if (rows.length === 0) return stats;

  const officeCache = new Map<string, string | null>();

  for (const row of rows) {
    const cacheKey = `${row.office_name.toLowerCase()}|${row.district_identifier ?? ''}`;
    let officeId = officeCache.get(cacheKey) ?? null;
    if (!officeCache.has(cacheKey)) {
      const fb = await resolveOfficeElection(ctx.pg, {
        state_fips: STATE_FIPS,
        office_name: row.office_name,
        district_identifier: row.district_identifier,
        election_year: electionYear,
      });
      officeId = fb?.office_id ?? null;
      officeCache.set(cacheKey, officeId);
    }

    if (!officeId) {
      stats.rowsSkipped += 1;
      await logIngestionError(
        ctx, refs.ingestionRunId, 'validation',
        `WA office not resolved: "${row.office_name}" district=${row.district_identifier ?? '-'}`,
        row,
      );
      continue;
    }

    if (ctx.dryRun) {
      stats.rowsInserted += 1;
      continue;
    }

    try {
      const electionId = await findOrCreateElection(ctx, officeId, PRIMARY_DATE, refs.dataSourceId);
      const personId = await findOrCreateStatePerson(ctx.pg, {
        name: row.reported_name, state_fips: STATE_FIPS, electionYear,
        source: 'sos-washington-candidacies', dataSourceId: refs.dataSourceId,
      });
      const status = /withdraw/i.test(row.status_raw) ? 'withdrew' : 'active';
      const { candidacyId, created } = await upsertCandidacy(
        ctx, electionId, personId, row.party_raw, status, refs.dataSourceId, row.status_raw,
      );
      const partyId = await resolvePartyId(ctx.pg, row.party_raw, STATE_FIPS);
      if (partyId) {
        await upsertPartyLine(ctx, candidacyId, partyId, refs.dataSourceId);
      } else {
        await logIngestionError(
          ctx, refs.ingestionRunId, 'validation',
          `WA party not resolved: "${row.party_raw}" for ${row.reported_name}`,
          row,
        );
      }
      if (created) stats.rowsInserted += 1; else stats.rowsUpdated += 1;
    } catch (err) {
      stats.rowsFailed += 1;
      const msg = err instanceof Error ? err.message : String(err);
      stats.errors.push({ type: 'other', message: `WA insert: ${msg}`, rawInput: row });
    }
  }
  return stats;
}

async function findOrCreateElection(
  ctx: AdapterContext, officeId: string, electionDate: string,
  dataSourceId: string | undefined,
): Promise<string> {
  const sel = await ctx.pg.query<{ id: string }>(
    `SELECT id FROM elections WHERE office_id = $1 AND election_date = $2::date LIMIT 1`,
    [officeId, electionDate],
  );
  if (sel.rows[0]) return sel.rows[0].id;
  const ins = await ctx.pg.query<{ id: string }>(
    `INSERT INTO elections (office_id, election_date, election_type, meta)
     VALUES ($1, $2::date, 'primary', $3::jsonb) RETURNING id`,
    [officeId, electionDate, JSON.stringify({
      source: 'sos-washington-candidacies', data_source_id: dataSourceId ?? null,
    })],
  );
  return ins.rows[0]!.id;
}

async function upsertCandidacy(
  ctx: AdapterContext, electionId: string, personId: string,
  partyRaw: string, status: 'active' | 'withdrew',
  dataSourceId: string | undefined, rawStatus: string,
): Promise<{ candidacyId: string; created: boolean }> {
  const sel = await ctx.pg.query<{ id: string }>(
    `SELECT id FROM candidacies WHERE election_id = $1 AND person_id = $2 LIMIT 1`,
    [electionId, personId],
  );
  if (sel.rows[0]) {
    await ctx.pg.query(
      `UPDATE candidacies SET party = $1, status = $2,
              meta = jsonb_set(COALESCE(meta, '{}'::jsonb), '{wa_status}', to_jsonb($3::text), true)
        WHERE id = $4`,
      [partyRaw, status, rawStatus, sel.rows[0].id],
    );
    return { candidacyId: sel.rows[0].id, created: false };
  }
  const ins = await ctx.pg.query<{ id: string }>(
    `INSERT INTO candidacies (election_id, person_id, party, status, meta)
     VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING id`,
    [electionId, personId, partyRaw, status, JSON.stringify({
      source: 'sos-washington-candidacies', data_source_id: dataSourceId ?? null,
      wa_status: rawStatus,
    })],
  );
  return { candidacyId: ins.rows[0]!.id, created: true };
}

async function upsertPartyLine(
  ctx: AdapterContext, candidacyId: string, partyId: string,
  dataSourceId: string | undefined,
): Promise<void> {
  await ctx.pg.query(
    `INSERT INTO candidacy_party_lines
       (candidacy_id, party_id, ballot_line_order, nomination_method, data_source_id, meta)
     VALUES ($1, $2, 1, 'primary', $3::uuid, $4::jsonb)
     ON CONFLICT (candidacy_id, party_id) DO UPDATE
       SET ballot_line_order = 1, nomination_method = 'primary'`,
    [candidacyId, partyId, dataSourceId ?? null,
     JSON.stringify({ source: 'sos-washington-candidacies' })],
  );
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
    ctx.logger.warn('sos-washington-candidacies: ingestion_errors insert failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export type { Pool };
