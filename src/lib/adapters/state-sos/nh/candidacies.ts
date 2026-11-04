/**
 * New Hampshire Secretary of State — 2026 candidate-filings adapter (FIPS 33).
 *
 * Source (web-verified 2026-04-25):
 *   https://www.sos.nh.gov/elections/candidates
 *     — Hub page describing how to file. NH's filing window for 2026 state
 *       primary (2026-09-08) opens June 3 and closes June 12, 2026
 *       (RSA 655:14). Until that window closes, NSOS does NOT publish a
 *       consolidated candidate list; once it closes, the agency releases
 *       the qualified-candidate list as a PDF / Excel artifact linked
 *       from this hub.
 *
 *   https://www.sos.nh.gov/elections/2026-2027-political-calendar
 *     — Companion calendar of statutory dates.
 *
 * Status (2026-04-25, pre-filing-window)
 * --------------------------------------
 * The hub page returns HTTP 200 with ~3MB of HTML but NO candidate-list
 * link of any kind — the page is currently a navigation-only surface.
 * Consequence: this adapter's parse() returns []. The data_sources row
 * is still written with the page's content_hash so we get provenance
 * + a cache key the runner can use to mark subsequent runs `unchanged`
 * until NSOS publishes the list.
 *
 * When the list ships (post 2026-06-12), parseNhCandidatesList() needs
 * to be extended to either:
 *   - download + parse the linked PDF (TODO: pdf-parse not currently a
 *     workspace dep), or
 *   - if NSOS publishes XLSX (they did so for 2024), pivot to xlsx via
 *     the same pattern as in/candidacies.ts.
 *
 * Idempotent + safe to run nightly. The runner's content-hash dedup
 * prevents repeated DB churn on the unchanged hub page.
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

const STATE_FIPS = '33';
const ELECTION_YEAR = 2026;
const PRIMARY_DATE = '2026-09-08';

const DEFAULT_SOURCE_URL = 'https://www.sos.nh.gov/elections/candidates';

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

export type NhCandidacyRow = {
  reported_name: string;
  office_name: string;
  district_identifier: string | null;
  party_raw: string | null;
  date_filed: string | null;
  source_row_id: string;
};

export type NhCandidaciesAdapterOptions = {
  sourceUrl?: string;
  license?: DataSourceLicense;
  tokenBucket?: { rps: number; burst: number };
  fetch?: (
    ctx: AdapterContext,
  ) => Promise<{ status: number; rawBody: string; resolvedUrl?: string }>;
  expectedMinRows?: number;
  electionYear?: number;
};

// ---------------------------------------------------------------------------
// Pure parser
// ---------------------------------------------------------------------------

/**
 * Parse the NH SoS candidates hub page. Today this almost always returns
 * [] because NSOS does not publish a candidate list before the June
 * filing window closes — and once it does, the format historically
 * pivots between PDF and XLSX. We handle the most accommodating shape
 * (HTML <table> with Candidate / Party / District / Office headers)
 * so a future "embedded list" page works without a code change.
 *
 * Exported for tests.
 */
export function parseNhCandidatesList(rawBody: string): NhCandidacyRow[] {
  if (typeof rawBody !== 'string' || rawBody.length < 64) return [];
  const trimmed = rawBody.trimStart();
  if (!trimmed.startsWith('<')) return [];

  const $ = cheerio.load(rawBody);
  const rows: NhCandidacyRow[] = [];

  $('table').each((tIdx, tableEl) => {
    const $tbl = $(tableEl);
    const headers = $tbl
      .find('tr').first()
      .find('th,td')
      .map((_, el) => $(el).text().trim().toLowerCase())
      .get();
    if (headers.length === 0) return;
    const colName = headers.findIndex((h) => /candidate|name/.test(h) && !/party/.test(h));
    const colParty = headers.findIndex((h) => /party/.test(h));
    const colOffice = headers.findIndex((h) => /office|contest/.test(h));
    const colDistrict = headers.findIndex((h) => /district|dist\b/.test(h));
    const colFiled = headers.findIndex((h) => /filed|date/.test(h));
    if (colName < 0 || colOffice < 0) return;

    $tbl.find('tr').each((rIdx, trEl) => {
      if (rIdx === 0) return;
      const cells = $(trEl).find('td').map((_, el) => $(el).text().trim()).get();
      if (cells.length === 0) return;
      const name = cells[colName] ?? '';
      const office = cells[colOffice] ?? '';
      if (!name || !office) return;
      rows.push({
        reported_name: name,
        office_name: office,
        district_identifier:
          colDistrict >= 0 ? extractDistrict(cells[colDistrict] ?? '') : extractDistrict(office),
        party_raw: colParty >= 0 ? (cells[colParty] || null) : null,
        date_filed: colFiled >= 0 ? normalizeDate(cells[colFiled] ?? '') : null,
        source_row_id: `nh-t${tIdx}-r${rIdx}`,
      });
    });
  });

  return rows;
}

function extractDistrict(raw: string): string | null {
  if (!raw) return null;
  const m = /district\s+0*(\d{1,3})\b/i.exec(raw);
  if (m && m[1]) return m[1];
  const trailing = /\b0*(\d{1,3})\s*$/.exec(raw);
  if (trailing && trailing[1]) return trailing[1];
  return null;
}

function normalizeDate(raw: string): string | null {
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(raw);
  if (us) {
    const mm = us[1]!.padStart(2, '0');
    const dd = us[2]!.padStart(2, '0');
    const yyyy = us[3]!.length === 2 ? `20${us[3]}` : us[3];
    return `${yyyy}-${mm}-${dd}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createNhCandidaciesAdapter(
  options: NhCandidaciesAdapterOptions = {},
): SourceAdapter<NhCandidacyRow> {
  const sourceUrl = options.sourceUrl ?? DEFAULT_SOURCE_URL;
  const license: DataSourceLicense = options.license ?? 'state_open_records';
  const tokenBucketCfg = options.tokenBucket ?? { rps: 0.5, burst: 2 };
  const bucket = createTokenBucket(tokenBucketCfg);
  // 0 floor — the hub page is empty until June 12, 2026.
  const expectedMinRows = options.expectedMinRows ?? 0;
  const electionYear = options.electionYear ?? ELECTION_YEAR;

  const fetchImpl =
    options.fetch ??
    (async () => {
      const res = await politeFetch(sourceUrl, {
        headers: { Accept: 'text/html,application/xhtml+xml,*/*' },
      });
      const body = await res.text();
      return { status: res.status, rawBody: body, resolvedUrl: res.url };
    });

  const adapter: SourceAdapter<NhCandidacyRow> = {
    name: 'sos-new-hampshire-candidacies',
    stateFips: STATE_FIPS,
    tokenBucket: tokenBucketCfg,
    costService: 'other',

    async run(ctx: AdapterContext): Promise<AdapterOutcome<NhCandidacyRow>> {
      await bucket.acquire();
      ctx.logger.info(`${adapter.name}: fetching`, {
        stateFips: STATE_FIPS,
        url: sourceUrl,
      });

      const { status, rawBody, resolvedUrl } = await fetchImpl(ctx);
      if (status >= 400) {
        throw new Error(`${adapter.name}: HTTP ${status} from ${sourceUrl}`);
      }
      const contentHash = createHash('sha256').update(rawBody).digest('hex');
      const rows = parseNhCandidatesList(rawBody);

      ctx.logger.info(`${adapter.name}: parsed`, {
        rowCount: rows.length,
        bytes: rawBody.length,
        note: rows.length === 0
          ? 'empty (NH filing window opens 2026-06-03; consolidated list publishes after 2026-06-12)'
          : 'list parsed',
      });

      return {
        rows,
        expectedMinRows,
        source: {
          sourceType: 'sos_candidate_filing',
          name: 'new-hampshire-sos-candidacies',
          url: resolvedUrl ?? sourceUrl,
          contentHash,
          license,
          stateFips: STATE_FIPS,
          meta: {
            election_year: electionYear,
            primary_date: PRIMARY_DATE,
            byte_size: rawBody.length,
            http_status: status,
            blocker: rows.length === 0
              ? 'NH publishes 2026 candidate list as PDF/XLSX after 2026-06-12 filing close; this adapter parses HTML tables only. Extend with pdf-parse or xlsx pivot when artifact is published.'
              : null,
          },
        },
      };
    },

    validateRow(row) {
      if (!row.reported_name?.trim()) return 'missing reported_name';
      if (!row.office_name?.trim()) return 'missing office_name';
      return null;
    },

    async insert(rows, refs, ctx): Promise<InsertStats> {
      return insertNhCandidacies(rows, refs, ctx, electionYear);
    },
  };

  return adapter;
}

// ---------------------------------------------------------------------------
// Insert
// ---------------------------------------------------------------------------

async function insertNhCandidacies(
  rows: NhCandidacyRow[],
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
        source: 'nh-sos-candidacies',
        dataSourceId: refs.dataSourceId,
      });
      const candRes = await ctx.pg.query<{ id: string; inserted: boolean }>(
        `INSERT INTO candidacies
           (election_id, person_id, party, status, filed_on, meta)
         VALUES ($1, $2, $3, 'active', $4::date, $5::jsonb)
         ON CONFLICT (election_id, person_id) DO UPDATE
           SET party = COALESCE(EXCLUDED.party, candidacies.party),
               filed_on = COALESCE(candidacies.filed_on, EXCLUDED.filed_on),
               status = CASE WHEN candidacies.status IN ('withdrew','disqualified')
                             THEN candidacies.status ELSE 'active' END
         RETURNING id, (xmax = 0) AS inserted`,
        [
          officeInfo.election_id,
          personId,
          row.party_raw,
          row.date_filed,
          JSON.stringify({
            source: 'nh-sos-candidacies',
            reported_office: row.office_name,
            data_source_id: refs.dataSourceId,
            ingestion_run_id: refs.ingestionRunId,
            source_row_id: row.source_row_id,
          }),
        ],
      );
      const candidacyId = candRes.rows[0]?.id;
      if (!candidacyId) {
        stats.rowsFailed += 1;
        continue;
      }
      if (candRes.rows[0]?.inserted) stats.rowsInserted += 1;
      else stats.rowsUpdated += 1;

      if (row.party_raw) {
        const partyId = await resolvePartyId(ctx.pg, row.party_raw, STATE_FIPS);
        if (partyId) {
          await ctx.pg.query(
            `INSERT INTO candidacy_party_lines
               (candidacy_id, party_id, ballot_line_order, nomination_method, qualified_on, data_source_id, meta)
             VALUES ($1, $2, 1, 'primary', $3::date, $4::uuid, $5::jsonb)
             ON CONFLICT (candidacy_id, party_id) DO UPDATE
               SET qualified_on = COALESCE(candidacy_party_lines.qualified_on, EXCLUDED.qualified_on),
                   data_source_id = COALESCE(EXCLUDED.data_source_id, candidacy_party_lines.data_source_id)`,
            [
              candidacyId,
              partyId,
              row.date_filed,
              refs.dataSourceId ?? null,
              JSON.stringify({ source: 'nh-sos-candidacies', reported_party: row.party_raw }),
            ],
          );
        }
      }
    } catch (err) {
      stats.rowsFailed += 1;
      const msg = err instanceof Error ? err.message : String(err);
      stats.errors.push({ type: 'other', message: `NH row: ${msg}`, rawInput: row });
    }
  }

  return stats;
}
