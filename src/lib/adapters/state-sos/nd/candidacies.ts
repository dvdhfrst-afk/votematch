/**
 * North Dakota Secretary of State — 2026 candidate-filings adapter (FIPS 38).
 *
 * Source (web-verified 2026-04-25):
 *   https://vip.sos.nd.gov/CandidateList.aspx
 *     — Authoritative interactive candidate-list page on the
 *       NDSOS Voter Information Portal. ASP.NET WebForms surface:
 *       __VIEWSTATE / __EVENTVALIDATION hidden fields drive an
 *       election-selection dropdown; the actual candidate table is only
 *       rendered after a POST round-trip selects a specific election.
 *       Verified 2026-04-25 the bare GET returns ~127KB of HTML with
 *       NO populated candidate table — only the chrome and a single
 *       __VIEWSTATE-driven layout table.
 *
 *   https://sos.nd.gov/elections
 *     — Plain SoS landing page. Surfaces calendar PDFs but no flat
 *       candidate-list artifact.
 *
 * Status (2026-04-25, ND filing window not yet open)
 * --------------------------------------------------
 * ND 2026 primary date: 2026-06-09 (open primary). Candidate filing
 * window per N.D.C.C. § 16.1-11-06: opens January 1, 2026, closes
 * 64 days before primary (= 2026-04-06). Even after the deadline
 * the public list lives only behind the __VIEWSTATE round-trip.
 *
 * Strategy
 * --------
 * 1. Fetch the bare CandidateList.aspx (GET) and emit a data_sources row.
 * 2. Detect __VIEWSTATE markers and surface them in meta so the
 *    runner records that we hit the WebForms chrome only.
 * 3. Return [] until either:
 *    - NDSOS publishes a flat list URL, or
 *    - we implement the WebForms scrape path (capture __VIEWSTATE +
 *      __EVENTVALIDATION + post __EVENTTARGET=ddlElection with the
 *      2026 primary id, then parse the resulting tbody).
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

const STATE_FIPS = '38';
const ELECTION_YEAR = 2026;
const PRIMARY_DATE = '2026-06-09';

const DEFAULT_SOURCE_URL = 'https://vip.sos.nd.gov/CandidateList.aspx';

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

export type NdCandidacyRow = {
  reported_name: string;
  office_name: string;
  district_identifier: string | null;
  party_raw: string | null;
  date_filed: string | null;
  source_row_id: string;
};

export type NdCandidaciesAdapterOptions = {
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
// Heuristics + parser
// ---------------------------------------------------------------------------

/**
 * Detect whether the body is the bare ASP.NET WebForms shell (i.e. no
 * candidate table has been rendered yet because no election is
 * selected). This is the steady-state response for an unauthenticated
 * GET against CandidateList.aspx.
 */
export function isAspNetWebFormsShell(html: string): boolean {
  if (typeof html !== 'string') return false;
  const hasViewState = /name="__VIEWSTATE"/i.test(html);
  const hasEventValidation = /name="__EVENTVALIDATION"/i.test(html);
  // Plus: the chrome contains a <form> id="form1" / "aspnetForm" —
  // common ND VIP markers.
  const hasAspForm = /<form[^>]+id="(?:form1|aspnetForm)"/i.test(html);
  return hasViewState && hasEventValidation && hasAspForm;
}

/**
 * Parse a populated CandidateList.aspx response (after election
 * selection). When NDSOS emits the table, columns are typically
 * "Office | Candidate | Party | District" with one tbody row per
 * filed candidate. Today this almost always returns [] because
 * the GET shell has no rows. Symmetric with sibling adapters.
 *
 * Exported for tests.
 */
export function parseNdCandidatesList(rawBody: string): NdCandidacyRow[] {
  if (typeof rawBody !== 'string' || rawBody.length < 64) return [];
  const trimmed = rawBody.trimStart();
  if (!trimmed.startsWith('<')) return [];
  const $ = cheerio.load(rawBody);
  const rows: NdCandidacyRow[] = [];
  $('table').each((tIdx, tableEl) => {
    const $tbl = $(tableEl);
    const headers = $tbl
      .find('tr').first()
      .find('th,td')
      .map((_, el) => $(el).text().trim().toLowerCase())
      .get();
    const colName = headers.findIndex((h) => /candidate|name/.test(h) && !/party/.test(h));
    const colParty = headers.findIndex((h) => /party/.test(h));
    const colOffice = headers.findIndex((h) => /office|contest/.test(h));
    const colDistrict = headers.findIndex((h) => /district/.test(h));
    if (colName < 0 || colOffice < 0) return;
    $tbl.find('tr').each((rIdx, trEl) => {
      if (rIdx === 0) return;
      const cells = $(trEl).find('td').map((_, el) => $(el).text().trim()).get();
      const name = cells[colName] ?? '';
      const office = cells[colOffice] ?? '';
      if (!name || !office) return;
      rows.push({
        reported_name: name,
        office_name: office,
        district_identifier:
          colDistrict >= 0 ? extractDistrict(cells[colDistrict] ?? '') : extractDistrict(office),
        party_raw: colParty >= 0 ? (cells[colParty] || null) : null,
        date_filed: null,
        source_row_id: `nd-t${tIdx}-r${rIdx}`,
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

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createNdCandidaciesAdapter(
  options: NdCandidaciesAdapterOptions = {},
): SourceAdapter<NdCandidacyRow> {
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
        headers: { Accept: 'text/html,application/xhtml+xml,*/*' },
      });
      const body = await res.text();
      return { status: res.status, rawBody: body, resolvedUrl: res.url };
    });

  const adapter: SourceAdapter<NdCandidacyRow> = {
    name: 'sos-north-dakota-candidacies',
    stateFips: STATE_FIPS,
    tokenBucket: tokenBucketCfg,
    costService: 'other',

    async run(ctx: AdapterContext): Promise<AdapterOutcome<NdCandidacyRow>> {
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
      const webFormsShell = isAspNetWebFormsShell(rawBody);

      const rows = webFormsShell ? [] : parseNdCandidatesList(rawBody);

      ctx.logger.info(`${adapter.name}: parsed`, {
        rowCount: rows.length,
        bytes: rawBody.length,
        webForms_shell: webFormsShell,
        note: webFormsShell
          ? 'WebForms shell — no election selected; __VIEWSTATE round-trip required to populate table'
          : 'list parsed',
      });

      return {
        rows,
        expectedMinRows,
        source: {
          sourceType: 'sos_candidate_filing',
          name: 'north-dakota-sos-candidacies',
          url: resolvedUrl ?? sourceUrl,
          contentHash,
          license,
          stateFips: STATE_FIPS,
          meta: {
            election_year: electionYear,
            primary_date: PRIMARY_DATE,
            byte_size: rawBody.length,
            http_status: status,
            webforms_shell: webFormsShell,
            blocker: webFormsShell
              ? 'NDSOS CandidateList.aspx requires __VIEWSTATE/__EVENTVALIDATION POST with election id; bare GET returns the WebForms shell. Implement WebForms scrape (capture hidden fields, POST __EVENTTARGET=ddlElection with 2026 primary id, parse populated tbody) before filing-window data is exposed.'
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
      return insertNdCandidacies(rows, refs, ctx, electionYear);
    },
  };

  return adapter;
}

// ---------------------------------------------------------------------------
// Insert
// ---------------------------------------------------------------------------

async function insertNdCandidacies(
  rows: NdCandidacyRow[],
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
        source: 'nd-sos-candidacies',
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
            source: 'nd-sos-candidacies',
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
              JSON.stringify({ source: 'nd-sos-candidacies', reported_party: row.party_raw }),
            ],
          );
        }
      }
    } catch (err) {
      stats.rowsFailed += 1;
      const msg = err instanceof Error ? err.message : String(err);
      stats.errors.push({ type: 'other', message: `ND row: ${msg}`, rawInput: row });
    }
  }

  return stats;
}
