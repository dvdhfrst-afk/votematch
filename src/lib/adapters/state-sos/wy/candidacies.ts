/**
 * Wyoming Secretary of State — 2026 candidate-filings adapter (FIPS 56).
 *
 * Wyoming's primary is 2026-08-18 (third Tuesday in August per W.S. 22-2-103).
 * Candidate filing window for federal/statewide/legislative is 2026-05-14
 * through 2026-05-28 — meaning at the time this adapter was authored
 * (2026-04-25) NO 2026 candidate roster has been published yet.
 *
 * Source (web-verified 2026-04-25, link present but file 404 until published):
 *   https://sos.wyo.gov/Elections/2026ElectionInformation.aspx (landing)
 *   https://sos.wyo.gov/Elections/Docs/2026/2026_WY_Primary_Election_Candidates.csv
 *   https://sos.wyo.gov/Elections/Docs/2026/2026_WY_Primary_Election_Candidates.pdf
 *   https://sos.wyo.gov/Elections/Docs/2026/2026_WY_General_Election_Candidates.csv
 *
 * The 2026 page links to these URLs already even though the CSVs themselves
 * return 404 until SoS publishes them. This adapter handles BOTH cases:
 *   - CSV present:      parse rows, write candidacies for 2026-08-18 primary
 *   - CSV missing/404:  log + return [] (parserSignal='no_table'); the
 *                       runner records 'unproductive' and the next daily
 *                       refresh picks it up automatically.
 *
 * Parser shape (based on the 2024 Wyoming CSV format, which is the precedent
 * the 2026 file is expected to follow):
 *   Office,District,Last Name,First Name,Middle Name,Party,...
 *
 * Because the 2026 CSV doesn't exist yet, the column-detection logic is
 * keyed off header text (case-insensitive) so any reasonable column shape
 * survives. If the 2026 file ships with a different schema the adapter
 * still parses; if it ships with NO recognizable header the parser bails
 * out with a parse-signal so the runner doesn't silently report success.
 */

import { createHash } from 'node:crypto';
import { parse as parseCsv } from 'csv-parse/sync';
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

const STATE_FIPS = '56';
const ELECTION_YEAR = 2026;
const PRIMARY_DATE = '2026-08-18';

const DEFAULT_SOURCE_URL =
  'https://sos.wyo.gov/Elections/Docs/2026/2026_WY_Primary_Election_Candidates.csv';

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

export type WyCandidacyRow = {
  reported_name: string;
  office_name: string;
  district_identifier: string | null;
  party_raw: string;
  source_row_id: string;
};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export type WyCandidaciesAdapterOptions = {
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

type CsvRow = Record<string, string>;

const HEADER_PATTERNS = {
  office:    /^(office|race|contest)/i,
  district:  /district/i,
  last:      /^last/i,
  first:     /^first/i,
  middle:    /^middle/i,
  full_name: /^(name|candidate)/i,
  party:     /party|affiliation/i,
};

export type WyParseResult = {
  rows: WyCandidacyRow[];
  signal: ParserSignal;
};

export function parseWyomingCsv(body: string): WyParseResult {
  const trimmed = (body ?? '').trimStart();
  if (!trimmed) return { rows: [], signal: 'parse_failed' };
  // Reject obvious 404 / HTML bodies.
  if (trimmed.startsWith('<')) return { rows: [], signal: 'no_table' };

  let parsed: CsvRow[];
  try {
    parsed = parseCsv(body, {
      columns: (h: string[]) => h.map((c) => c.trim()),
      skip_empty_lines: true,
      relax_column_count: true,
      trim: true,
    }) as CsvRow[];
  } catch {
    return { rows: [], signal: 'parse_failed' };
  }
  if (parsed.length === 0) return { rows: [], signal: 'table_empty' };

  // Build column map by matching headers to patterns.
  const headers = Object.keys(parsed[0]!);
  const colFor = (pattern: RegExp): string | null => {
    for (const h of headers) if (pattern.test(h)) return h;
    return null;
  };
  const cols = {
    office:   colFor(HEADER_PATTERNS.office),
    district: colFor(HEADER_PATTERNS.district),
    last:     colFor(HEADER_PATTERNS.last),
    first:    colFor(HEADER_PATTERNS.first),
    middle:   colFor(HEADER_PATTERNS.middle),
    name:     colFor(HEADER_PATTERNS.full_name),
    party:    colFor(HEADER_PATTERNS.party),
  };
  if (!cols.office || !cols.party || (!cols.last && !cols.name)) {
    return { rows: [], signal: 'no_table' };
  }

  const out: WyCandidacyRow[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < parsed.length; i++) {
    const r = parsed[i]!;
    const office = (r[cols.office!] ?? '').trim();
    const party = (r[cols.party!] ?? '').trim();
    if (!office || !party) continue;

    let name = '';
    if (cols.name && r[cols.name]) {
      name = r[cols.name]!.trim();
    } else {
      const last = cols.last ? (r[cols.last] ?? '').trim() : '';
      const first = cols.first ? (r[cols.first] ?? '').trim() : '';
      const middle = cols.middle ? (r[cols.middle] ?? '').trim() : '';
      name = [first, middle, last].filter(Boolean).join(' ');
    }
    if (!name) continue;

    const districtRaw = cols.district ? (r[cols.district] ?? '').trim() : '';
    const district = districtRaw ? extractDistrictId(districtRaw) : null;

    const dedupKey = `${office.toLowerCase()}|${(district ?? '').toLowerCase()}|${party.toLowerCase()}|${name.toLowerCase()}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    out.push({
      reported_name: name,
      office_name: office,
      district_identifier: district,
      party_raw: party,
      source_row_id: dedupKey,
    });
  }

  return { rows: out, signal: out.length > 0 ? 'ok' : 'table_empty' };
}

function extractDistrictId(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  const m = /(?:district|hd|sd)?\s*0*(\d{1,3})/i.exec(s);
  if (m && m[1]) return m[1];
  return s.replace(/[^0-9a-z]/gi, '') || null;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createWyCandidaciesAdapter(
  options: WyCandidaciesAdapterOptions = {},
): SourceAdapter<WyCandidacyRow> {
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
        headers: { Accept: 'text/csv,application/octet-stream,*/*' },
      });
      const body = await res.text();
      return { rawBody: body, httpStatus: res.status, resolvedUrl: res.url };
    });

  const adapter: SourceAdapter<WyCandidacyRow> = {
    name: 'sos-wyoming-candidacies',
    stateFips: STATE_FIPS,
    tokenBucket: tokenBucketCfg,
    costService: 'other',

    async run(ctx: AdapterContext): Promise<AdapterOutcome<WyCandidacyRow>> {
      await bucket.acquire();
      ctx.logger.info(`${adapter.name}: fetching`, {
        stateFips: STATE_FIPS,
        url: sourceUrl,
      });

      const { rawBody, httpStatus, resolvedUrl } = await fetchImpl(ctx);
      const contentHash = createHash('sha256').update(rawBody).digest('hex');

      let rows: WyCandidacyRow[] = [];
      let signal: ParserSignal = 'ok';

      if (httpStatus === 404 || httpStatus === 410) {
        // Filing window not yet open — Wyoming files between mid-May and
        // late-May 2026 for the August primary. Ship empty + signal so the
        // runner records 'unproductive' and the daily refresh re-checks.
        ctx.logger.info(
          `${adapter.name}: candidate roster not yet published (HTTP ${httpStatus}); WY filing window 2026-05-14 — 2026-05-28`,
          { url: sourceUrl },
        );
        signal = 'no_table';
      } else if (httpStatus >= 400) {
        throw new Error(
          `${adapter.name}: HTTP ${httpStatus} from ${sourceUrl}`,
        );
      } else {
        const parsed = parseWyomingCsv(rawBody);
        rows = parsed.rows;
        signal = parsed.signal;
      }

      ctx.logger.info(`${adapter.name}: parsed`, {
        rowCount: rows.length,
        signal,
      });

      return {
        rows,
        expectedMinRows,
        parserSignal: signal,
        source: {
          sourceType: 'sos_candidate_filing',
          name: 'wyoming-sos-candidacies',
          url: resolvedUrl ?? sourceUrl,
          contentHash,
          license,
          stateFips: STATE_FIPS,
          meta: {
            election_year: electionYear,
            primary_date: PRIMARY_DATE,
            http_status: httpStatus,
            byte_size: rawBody.length,
            roster_published: signal === 'ok' || signal === 'table_empty',
            // Filing window from Wyo. Stat. § 22-5-209.
            filing_window_open: '2026-05-14',
            filing_window_close: '2026-05-28',
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
      return insertWyCandidacies(rows, refs, ctx, electionYear);
    },
  };

  return adapter;
}

// ---------------------------------------------------------------------------
// Insert
// ---------------------------------------------------------------------------

export async function insertWyCandidacies(
  rows: WyCandidacyRow[],
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
        ctx,
        refs.ingestionRunId,
        'validation',
        `WY office not resolved: "${row.office_name}" district=${row.district_identifier ?? '-'}`,
        row,
      );
      continue;
    }

    if (ctx.dryRun) {
      stats.rowsInserted += 1;
      continue;
    }

    try {
      const electionId = await findOrCreateElection(
        ctx, officeId, PRIMARY_DATE, refs.dataSourceId,
      );
      const personId = await findOrCreateStatePerson(ctx.pg, {
        name: row.reported_name,
        state_fips: STATE_FIPS,
        electionYear,
        source: 'sos-wyoming-candidacies',
        dataSourceId: refs.dataSourceId,
      });
      const { candidacyId, created } = await upsertCandidacy(
        ctx, electionId, personId, row.party_raw, refs.dataSourceId,
      );
      const partyId = await resolvePartyId(ctx.pg, row.party_raw, STATE_FIPS);
      if (partyId) {
        await upsertPartyLine(ctx, candidacyId, partyId, refs.dataSourceId);
      } else {
        await logIngestionError(
          ctx, refs.ingestionRunId, 'validation',
          `WY party not resolved: "${row.party_raw}" for ${row.reported_name}`,
          row,
        );
      }
      if (created) stats.rowsInserted += 1;
      else stats.rowsUpdated += 1;
    } catch (err) {
      stats.rowsFailed += 1;
      const msg = err instanceof Error ? err.message : String(err);
      stats.errors.push({ type: 'other', message: `WY insert: ${msg}`, rawInput: row });
    }
  }

  return stats;
}

async function findOrCreateElection(
  ctx: AdapterContext,
  officeId: string,
  electionDate: string,
  dataSourceId: string | undefined,
): Promise<string> {
  const sel = await ctx.pg.query<{ id: string }>(
    `SELECT id FROM elections
      WHERE office_id = $1 AND election_date = $2::date
      LIMIT 1`,
    [officeId, electionDate],
  );
  if (sel.rows[0]) return sel.rows[0].id;
  const ins = await ctx.pg.query<{ id: string }>(
    `INSERT INTO elections (office_id, election_date, election_type, meta)
     VALUES ($1, $2::date, 'primary', $3::jsonb)
     RETURNING id`,
    [officeId, electionDate, JSON.stringify({
      source: 'sos-wyoming-candidacies', data_source_id: dataSourceId ?? null,
    })],
  );
  return ins.rows[0]!.id;
}

async function upsertCandidacy(
  ctx: AdapterContext,
  electionId: string,
  personId: string,
  partyRaw: string,
  dataSourceId: string | undefined,
): Promise<{ candidacyId: string; created: boolean }> {
  const sel = await ctx.pg.query<{ id: string }>(
    `SELECT id FROM candidacies WHERE election_id = $1 AND person_id = $2 LIMIT 1`,
    [electionId, personId],
  );
  if (sel.rows[0]) {
    await ctx.pg.query(
      `UPDATE candidacies SET party = $1, status = 'active' WHERE id = $2`,
      [partyRaw, sel.rows[0].id],
    );
    return { candidacyId: sel.rows[0].id, created: false };
  }
  const ins = await ctx.pg.query<{ id: string }>(
    `INSERT INTO candidacies (election_id, person_id, party, status, meta)
     VALUES ($1, $2, $3, 'active', $4::jsonb) RETURNING id`,
    [electionId, personId, partyRaw, JSON.stringify({
      source: 'sos-wyoming-candidacies', data_source_id: dataSourceId ?? null,
    })],
  );
  return { candidacyId: ins.rows[0]!.id, created: true };
}

async function upsertPartyLine(
  ctx: AdapterContext,
  candidacyId: string,
  partyId: string,
  dataSourceId: string | undefined,
): Promise<void> {
  await ctx.pg.query(
    `INSERT INTO candidacy_party_lines
       (candidacy_id, party_id, ballot_line_order, nomination_method, data_source_id, meta)
     VALUES ($1, $2, 1, 'primary', $3::uuid, $4::jsonb)
     ON CONFLICT (candidacy_id, party_id) DO UPDATE
       SET ballot_line_order = 1, nomination_method = 'primary'`,
    [candidacyId, partyId, dataSourceId ?? null,
     JSON.stringify({ source: 'sos-wyoming-candidacies' })],
  );
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
    ctx.logger.warn('sos-wyoming-candidacies: ingestion_errors insert failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export type { Pool };
