/**
 * Vermont Secretary of State — 2026 candidate-filings adapter (FIPS 50).
 *
 * Vermont's primary is 2026-08-11 (second Tuesday in August per 17 V.S.A.
 * § 2356). Candidate filing window for federal/statewide/legislative is
 * approximately late May through end of May 2026. The SoS publishes the
 * qualified-candidate list on sos.vermont.gov.
 *
 * Source URLs (web-verified 2026-04-25):
 *   https://sos.vermont.gov/elections/candidates/                    (landing)
 *   https://sos.vermont.gov/elections/candidates/2026-candidates/    (2026)
 *
 * Wall observed (2026-04-25)
 * --------------------------
 * sos.vermont.gov is fronted by Imperva Incapsula. Every politeFetch attempt
 * (rotating Chrome/Firefox UAs) returns a tiny ~950 B HTML stub:
 *
 *   <html style="height:100%"><head>
 *     <META NAME="ROBOTS" CONTENT="NOINDEX, NOFOLLOW">
 *     <script src="/_Incapsula_Resource?SWJIYLWA=..."></script>
 *   </head><body>
 *     <iframe id="main-iframe" src="/_Incapsula_Resource?SWUDNSAI=...">
 *   </body></html>
 *
 * That stub is the JS challenge bootstrap. This adapter does not work
 * around it, so it:
 *
 *   1. Fetches the URL via politeFetch
 *   2. Detects the Incapsula sentinel
 *   3. Returns rows=[] with parserSignal='no_table' so the runner records
 *      the run as 'unproductive' (not silently 'success')
 *   4. Logs the wall to ingestion_errors so a human review surfaces it
 *
 * The full insert / parse pipeline is wired so that if real HTML becomes
 * available (for example through a published export) the adapter starts
 * producing rows without further code changes. The parser handles a
 * generic "office: name (party)" press-release shape AND a structured table
 * shape — both have been observed on past Vermont candidate listings.
 */

import { createHash } from 'node:crypto';
import { load as loadHtml } from 'cheerio';
import type { Pool } from 'pg';

import { politeFetch } from '../../fetch-polite';
import {
  findOrCreatePerson as findOrCreateStatePerson,
  resolveOfficeElection,
  normalizeOfficeName,
} from '../candidate-resolver';
import { resolvePartyId } from '../party-resolver';
import { canonicalKey } from '../base';
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

const STATE_FIPS = '50';
const ELECTION_YEAR = 2026;
const PRIMARY_DATE = '2026-08-11';

const DEFAULT_SOURCE_URL = 'https://sos.vermont.gov/elections/candidates/';

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

export type VtCandidacyRow = {
  reported_name: string;
  office_name: string;
  district_identifier: string | null;
  party_raw: string;
  source_row_id: string;
};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export type VtCandidaciesAdapterOptions = {
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
// Wall detection
// ---------------------------------------------------------------------------

/** Detect Imperva Incapsula JS-challenge bootstrap pages. */
export function isIncapsulaWall(body: string): boolean {
  if (!body || body.length === 0) return false;
  const snippet = body.slice(0, 4096).toLowerCase();
  return (
    snippet.includes('_incapsula_resource') ||
    (snippet.includes('imperva') && snippet.includes('challenge'))
  );
}

// ---------------------------------------------------------------------------
// Pure parser (exported for tests)
// ---------------------------------------------------------------------------

const OFFICE_KEYWORDS = [
  'governor', 'senator', 'representative', 'attorney general', 'secretary',
  'treasurer', 'auditor', 'state senate', 'state house', 'lieutenant',
];

export type VtParseResult = {
  rows: VtCandidacyRow[];
  signal: ParserSignal;
};

export function parseVermontHtml(body: string): VtParseResult {
  if (!body || body.length < 64) return { rows: [], signal: 'parse_failed' };
  if (isIncapsulaWall(body)) return { rows: [], signal: 'no_table' };
  const trimmed = body.trimStart();
  if (!trimmed.startsWith('<')) return { rows: [], signal: 'parse_failed' };

  const $ = loadHtml(body);
  const rows: VtCandidacyRow[] = [];
  const seen = new Set<string>();

  // Shape 1: structured candidate <table>.
  let tableFound = false;
  $('table').each((tIdx, tableEl) => {
    const $t = $(tableEl);
    const headers = $t.find('tr').first().find('th, td')
      .map((_i, el) => $(el).text().trim().toLowerCase()).get();
    const cName = headers.findIndex((h) => /\bname\b|candidate/.test(h));
    const cParty = headers.findIndex((h) => /party/.test(h));
    const cOffice = headers.findIndex((h) => /office|race/.test(h));
    if (cName < 0 || cParty < 0) return;
    tableFound = true;
    let officeFromHeading = '';
    if (cOffice < 0) {
      const $prev = $t.prevAll('h1,h2,h3,h4').first();
      if ($prev.length) officeFromHeading = $prev.text().trim();
    }
    $t.find('tr').each((rIdx, trEl) => {
      if (rIdx === 0) return;
      const cells = $(trEl).find('td').map((_i, el) => $(el).text().trim()).get();
      if (cells.length === 0) return;
      const name = cells[cName] ?? '';
      const party = cells[cParty] ?? '';
      const office = cOffice >= 0 ? (cells[cOffice] ?? officeFromHeading) : officeFromHeading;
      if (!name || !party || !office) return;
      const district = extractDistrictId(office);
      const dedupKey = `${office.toLowerCase()}|${district ?? ''}|${party.toLowerCase()}|${name.toLowerCase()}`;
      if (seen.has(dedupKey)) return;
      seen.add(dedupKey);
      rows.push({
        reported_name: name,
        office_name: office,
        district_identifier: district,
        party_raw: party,
        source_row_id: `vt-t${tIdx}-r${rIdx}`,
      });
    });
  });

  // Shape 2: paragraph / list-style "Office: Name (Party); ..." (Vermont
  // press-release convention).
  if (rows.length === 0) {
    $('p, li').each((_i, el) => {
      const text = $(el).text().replace(/\s+/g, ' ').trim();
      const m = text.match(/^([^:]{3,80}):\s*(.+)$/);
      if (!m) return;
      const officeRaw = m[1]!.trim();
      const officeNorm = normalizeOfficeName(officeRaw);
      if (!OFFICE_KEYWORDS.some((kw) => officeNorm.includes(kw))) return;
      const body2 = m[2]!;
      const sep = body2.includes(';') ? ';' : ',';
      const entries = body2.split(sep).map((s) => s.trim()).filter(Boolean);
      entries.forEach((entry, idx) => {
        const pm = entry.match(/^(.+?)\s*\(([A-Z]{1,4})\)\s*\.?$/);
        if (!pm) return;
        const name = pm[1]!.trim();
        const party = pm[2]!;
        if (!name) return;
        const district = extractDistrictId(officeRaw);
        rows.push({
          reported_name: name,
          office_name: officeRaw,
          district_identifier: district,
          party_raw: party,
          source_row_id: `vt-p-${canonicalKey(officeRaw)}-${idx}`,
        });
      });
    });
  }

  if (!tableFound && rows.length === 0) {
    return { rows: [], signal: 'no_table' };
  }
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

export function createVtCandidaciesAdapter(
  options: VtCandidaciesAdapterOptions = {},
): SourceAdapter<VtCandidacyRow> {
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
      return {
        rawBody: body,
        httpStatus: res.status,
        resolvedUrl: res.url,
      };
    });

  const adapter: SourceAdapter<VtCandidacyRow> = {
    name: 'sos-vermont-candidacies',
    stateFips: STATE_FIPS,
    tokenBucket: tokenBucketCfg,
    costService: 'other',

    async run(ctx): Promise<AdapterOutcome<VtCandidacyRow>> {
      await bucket.acquire();
      const { rawBody, httpStatus, resolvedUrl } = await fetchImpl(ctx);
      const contentHash = createHash('sha256').update(rawBody).digest('hex');

      let rows: VtCandidacyRow[] = [];
      let signal: ParserSignal = 'ok';
      const walled = isIncapsulaWall(rawBody);

      if (walled) {
        ctx.logger.warn(
          `${adapter.name}: Incapsula JS-challenge wall — source requires a browser, skipped; returning empty roster`,
          { url: sourceUrl, status: httpStatus, byte_size: rawBody.length },
        );
        signal = 'no_table';
      } else if (httpStatus >= 400) {
        throw new Error(`${adapter.name}: HTTP ${httpStatus} from ${sourceUrl}`);
      } else {
        const parsed = parseVermontHtml(rawBody);
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
          name: 'vermont-sos-candidacies',
          url: resolvedUrl ?? sourceUrl,
          contentHash, license, stateFips: STATE_FIPS,
          meta: {
            election_year: electionYear,
            primary_date: PRIMARY_DATE,
            http_status: httpStatus,
            byte_size: rawBody.length,
            incapsula_walled: walled,
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
      return insertVtCandidacies(rows, refs, ctx, electionYear);
    },
  };
  return adapter;
}

// ---------------------------------------------------------------------------
// Insert
// ---------------------------------------------------------------------------

export async function insertVtCandidacies(
  rows: VtCandidacyRow[],
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
        `VT office not resolved: "${row.office_name}" district=${row.district_identifier ?? '-'}`,
        row);
      continue;
    }
    if (ctx.dryRun) { stats.rowsInserted += 1; continue; }

    try {
      const personId = await findOrCreateStatePerson(ctx.pg, {
        name: row.reported_name, state_fips: STATE_FIPS, electionYear,
        source: 'sos-vermont-candidacies', dataSourceId: refs.dataSourceId,
      });
      const candRes = await ctx.pg.query<{ id: string; inserted: boolean }>(
        `INSERT INTO candidacies (election_id, person_id, party, status, meta)
         VALUES ($1, $2, $3, 'active', $4::jsonb)
         ON CONFLICT (election_id, person_id) DO UPDATE
           SET party = EXCLUDED.party, status = 'active'
         RETURNING id, (xmax = 0) AS inserted`,
        [officeInfo.election_id, personId, row.party_raw,
         JSON.stringify({
           source: 'sos-vermont-candidacies',
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
           JSON.stringify({ source: 'sos-vermont-candidacies' })],
        );
      } else {
        await logIngestionError(ctx, refs.ingestionRunId, 'validation',
          `VT party not resolved: "${row.party_raw}" for ${row.reported_name}`,
          row);
      }
      if (wasInserted) stats.rowsInserted += 1; else stats.rowsUpdated += 1;
    } catch (err) {
      stats.rowsFailed += 1;
      const msg = err instanceof Error ? err.message : String(err);
      stats.errors.push({ type: 'other', message: `VT insert: ${msg}`, rawInput: row });
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
    ctx.logger.warn('sos-vermont-candidacies: ingestion_errors insert failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export type { Pool };
