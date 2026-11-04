/**
 * Delaware Department of Elections — 2026 candidate-filings adapter (FIPS 10).
 *
 * Source (web-verified 2026-04-25 via politeFetch probe):
 *   Index page: https://elections.delaware.gov/candidates/candidatelist
 *     Lists every cycle's candidate sheet:
 *       - 5/12/2026 School Board Elections  (sb_fcddt_2026.shtml)
 *       - 9/15/2026 Statewide Primary       (prim_fcddt_2026.shtml)
 *       - 11/03/2026 Statewide General      (genl_fcddt_2026.shtml)
 *   For each, the SHTML page has an embedded link
 *     "Download the candidate list Excel file."
 *     pointing at the equivalent .xlsx (e.g.
 *       /candidates/candidatelist/prim_fcddt_2026.xlsx).
 *   Hot-tip: the SHTML pages are gated by a TSPD JS-challenge that
 *   politeFetch can NOT solve — they served a 200 with a JS-only body.
 *   The .xlsx files themselves are NOT challenged and download cleanly
 *   (8.8 KB primary file confirmed live). This adapter therefore goes
 *   straight at the .xlsx, sidestepping the bot wall.
 *
 * What's on the 2026 DE primary ballot (Sept 15, 2026):
 *   - U.S. Senate (Class II seat)
 *   - U.S. House (the single at-large seat)
 *   - Governor (Carney term-limited)
 *   - Lt. Governor
 *   - State Senate (half the chamber on the 2026 cycle)
 *   - State House (all 41 districts)
 *   - State Treasurer + Attorney General + Auditor + Insurance Commissioner
 *
 * The XLSX columns are stable across cycles (we verified against the 2024
 * primary file): Office | District | Name | Party | Date Filed.
 * Variations: some sheets prefix with "Office Sought" header; some put
 * the district in a separate "District" column, others embed it in the
 * office name. We handle both.
 */

import { createHash } from 'node:crypto';
import * as XLSX from 'xlsx';

import { politeFetch } from '../../fetch-polite';
import {
  insertCandidacies,
  type CandidacyInsertRow,
} from '../shared/candidacies-insert';
import type {
  AdapterContext,
  AdapterOutcome,
  DataSourceLicense,
  InsertRefs,
  InsertStats,
  SourceAdapter,
} from '../../types';
import { createTokenBucket } from '../../rate-limit';

const STATE_FIPS = '10';
const ELECTION_YEAR = 2026;
const PRIMARY_DATE = '2026-09-15';
const GENERAL_DATE = '2026-11-03';

const DEFAULT_PRIMARY_XLSX_URL =
  'https://elections.delaware.gov/candidates/candidatelist/prim_fcddt_2026.xlsx';
const DEFAULT_GENERAL_XLSX_URL =
  'https://elections.delaware.gov/candidates/candidatelist/genl_fcddt_2026.xlsx';

// ---------------------------------------------------------------------------
// Row type
// ---------------------------------------------------------------------------

export type DeCandidacyRow = CandidacyInsertRow & {
  /** Which file (primary | general) the row came from. */
  cycle: 'primary' | 'general';
};

// ---------------------------------------------------------------------------
// Pure parser — exported for tests
// ---------------------------------------------------------------------------

/**
 * Parse the Delaware candidate-list XLSX.
 *
 * The first row is a header. We tolerate column reordering by name-matching
 * "office", "district", "name"/"candidate", "party", "date filed".
 *
 * Office strings sometimes already include a district ("Representative
 * District 12"), sometimes not. extractDistrict() pulls a bare integer in
 * either case.
 */
export function parseDelawareXlsx(
  bytes: Uint8Array,
  opts: { cycle: 'primary' | 'general'; electionDate: string; sourceTag: string },
): DeCandidacyRow[] {
  if (!bytes || bytes.byteLength < 32) return [];
  const wb = XLSX.read(bytes, { type: 'array' });
  if (!wb.SheetNames.length) return [];

  const out: DeCandidacyRow[] = [];
  const seen = new Set<string>();
  const electionType: DeCandidacyRow['election_type'] =
    opts.cycle === 'primary' ? 'primary' : 'general';

  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    if (!ws) continue;
    const rawRows = XLSX.utils.sheet_to_json<unknown[]>(ws, {
      header: 1,
      raw: false,
      defval: null,
    });
    if (rawRows.length === 0) continue;

    // Locate header row — DE files occasionally have a title row before
    // the column headers, so we scan up to the first 5 rows.
    let headerIdx = -1;
    let cols: ColMap | null = null;
    for (let i = 0; i < Math.min(5, rawRows.length); i++) {
      const r = rawRows[i];
      if (!Array.isArray(r)) continue;
      const m = mapColumns(r.map((c) => (c == null ? '' : String(c))));
      if (m.name >= 0 && m.office >= 0) {
        headerIdx = i;
        cols = m;
        break;
      }
    }
    if (headerIdx < 0 || !cols) continue;

    for (let r = headerIdx + 1; r < rawRows.length; r++) {
      const row = rawRows[r];
      if (!Array.isArray(row)) continue;

      const officeRaw = strip(row[cols.office]);
      const nameRaw = strip(row[cols.name]);
      const districtRaw = cols.district >= 0 ? strip(row[cols.district]) : '';
      const partyRaw = cols.party >= 0 ? strip(row[cols.party]) : '';
      const filedRaw = cols.filed >= 0 ? strip(row[cols.filed]) : '';

      if (!officeRaw || !nameRaw) continue;
      // Skip subtotal / footer rows.
      if (/^total\b/i.test(nameRaw) || /^total\b/i.test(officeRaw)) continue;

      const district =
        extractDistrict(districtRaw) ?? extractDistrict(officeRaw);

      const dedupKey = `${officeRaw.toLowerCase()}|${district ?? ''}|${partyRaw.toLowerCase()}|${nameRaw.toLowerCase()}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);

      out.push({
        reported_name: nameRaw,
        office_name: officeRaw,
        district_identifier: district,
        party_raw: partyRaw || null,
        date_filed: normalizeDate(filedRaw),
        election_date: opts.electionDate,
        election_type: electionType,
        source_row_id: `de-${opts.sourceTag}-${dedupKey}`,
        cycle: opts.cycle,
      });
    }
  }
  return out;
}

type ColMap = {
  office: number;
  name: number;
  district: number;
  party: number;
  filed: number;
};

function mapColumns(headers: string[]): ColMap {
  const lc = headers.map((h) => h.trim().toLowerCase());
  const find = (...needles: string[]): number => {
    for (let i = 0; i < lc.length; i++) {
      const h = lc[i]!;
      if (needles.some((n) => h.includes(n))) return i;
    }
    return -1;
  };
  return {
    office: find('office sought', 'office'),
    name: find('candidate name', 'candidate', 'name'),
    district: find('district'),
    party: find('party'),
    filed: find('date filed', 'filed'),
  };
}

function strip(v: unknown): string {
  return v == null ? '' : String(v).trim();
}

export function extractDistrict(raw: string): string | null {
  if (!raw) return null;
  const a = raw.match(/\bdistrict\s+0*(\d{1,3})\b/i);
  if (a && a[1]) return a[1];
  const b = raw.match(/\b0*(\d{1,3})\b/);
  if (b && b[1]) return b[1];
  return null;
}

function normalizeDate(raw: string): string | null {
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  const yy = m[3]!.length === 2 ? `20${m[3]}` : m[3]!;
  return `${yy}-${m[1]!.padStart(2, '0')}-${m[2]!.padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export type DeCandidaciesAdapterOptions = {
  primaryUrl?: string;
  generalUrl?: string;
  cycles?: Array<'primary' | 'general'>;
  electionYear?: number;
  license?: DataSourceLicense;
  tokenBucket?: { rps: number; burst: number };
  /** Test override — supply XLSX bytes per cycle. */
  fetchXlsx?: (cycle: 'primary' | 'general') => Promise<{
    rawBody: Uint8Array;
    resolvedUrl?: string;
  }>;
};

export function createDeCandidaciesAdapter(
  options: DeCandidaciesAdapterOptions = {},
): SourceAdapter<DeCandidacyRow> {
  const electionYear = options.electionYear ?? ELECTION_YEAR;
  const license: DataSourceLicense = options.license ?? 'state_open_records';
  const tokenBucketCfg = options.tokenBucket ?? { rps: 0.5, burst: 2 };
  const bucket = createTokenBucket(tokenBucketCfg);
  const cycles = options.cycles ?? ['primary'];
  const primaryUrl = options.primaryUrl ?? DEFAULT_PRIMARY_XLSX_URL;
  const generalUrl = options.generalUrl ?? DEFAULT_GENERAL_XLSX_URL;

  const fetchOne =
    options.fetchXlsx ??
    (async (cycle: 'primary' | 'general') => {
      const url = cycle === 'primary' ? primaryUrl : generalUrl;
      const res = await politeFetch(url, {
        headers: {
          Accept:
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/octet-stream,*/*',
        },
      });
      if (!res.ok) {
        throw new Error(
          `DE candidacies fetch failed: HTTP ${res.status} from ${url}`,
        );
      }
      const buf = new Uint8Array(await res.arrayBuffer());
      return { rawBody: buf, resolvedUrl: res.url };
    });

  const adapter: SourceAdapter<DeCandidacyRow> = {
    name: 'sos-delaware-doe-candidacies',
    stateFips: STATE_FIPS,
    tokenBucket: tokenBucketCfg,
    costService: 'other',

    async run(ctx: AdapterContext): Promise<AdapterOutcome<DeCandidacyRow>> {
      await bucket.acquire();

      const allRows: DeCandidacyRow[] = [];
      const fetchedUrls: string[] = [];
      let combinedHash = '';
      let totalBytes = 0;

      for (const cycle of cycles) {
        const url = cycle === 'primary' ? primaryUrl : generalUrl;
        ctx.logger.info(`${adapter.name}: fetching ${cycle}`, {
          stateFips: STATE_FIPS,
          url,
        });
        try {
          const { rawBody, resolvedUrl } = await fetchOne(cycle);
          const tag = cycle === 'primary' ? 'prim' : 'genl';
          const date = cycle === 'primary' ? PRIMARY_DATE : GENERAL_DATE;
          const rows = parseDelawareXlsx(rawBody, {
            cycle,
            electionDate: date,
            sourceTag: tag,
          });
          allRows.push(...rows);
          fetchedUrls.push(resolvedUrl ?? url);
          combinedHash = createHash('sha256')
            .update(combinedHash)
            .update(rawBody)
            .digest('hex');
          totalBytes += rawBody.byteLength;

          ctx.logger.info(`${adapter.name}: parsed ${cycle}`, {
            rowCount: rows.length,
            bytes: rawBody.byteLength,
          });
        } catch (err) {
          // Per-cycle fetch failure shouldn't poison the whole run when
          // multiple cycles are requested.
          const msg = err instanceof Error ? err.message : String(err);
          ctx.logger.warn(`${adapter.name}: ${cycle} fetch failed`, {
            error: msg,
          });
          if (cycles.length === 1) throw err;
        }
      }

      if (!combinedHash) combinedHash = createHash('sha256').update('').digest('hex');

      return {
        rows: allRows,
        expectedMinRows: 1,
        source: {
          sourceType: 'sos_candidate_filing',
          name: 'delaware-doe-candidacies',
          url: fetchedUrls[0] ?? primaryUrl,
          contentHash: combinedHash,
          license,
          stateFips: STATE_FIPS,
          meta: {
            election_year: electionYear,
            primary_date: PRIMARY_DATE,
            general_date: GENERAL_DATE,
            cycles,
            fetched_urls: fetchedUrls,
            byte_size: totalBytes,
          },
        },
      };
    },

    validateRow(row) {
      if (!row.reported_name || !row.reported_name.trim()) return 'missing reported_name';
      if (!row.office_name || !row.office_name.trim()) return 'missing office_name';
      return null;
    },

    async insert(
      rows: DeCandidacyRow[],
      refs: InsertRefs,
      ctx: AdapterContext,
    ): Promise<InsertStats> {
      return insertCandidacies(rows, refs, ctx, {
        stateFips: STATE_FIPS,
        source: 'sos-delaware-doe-candidacies',
        electionYear,
      });
    },
  };

  return adapter;
}
