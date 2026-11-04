/**
 * New Mexico Secretary of State — 2026 candidate-filings adapter (FIPS 35).
 *
 * Sources (web-verified 2026-04-25):
 *   https://www.sos.nm.gov/voting-and-elections/candidate-and-campaign/
 *     — Originally referenced URL — returns HTTP 404. NMSOS reorganized
 *       the candidate-and-campaigns section under a different slug.
 *
 *   https://www.sos.nm.gov/candidate-and-campaigns/
 *     — Working hub page (HTTP 200 ~257KB). Surfaces a link to the
 *       NMSOS Candidate Portal at
 *       https://candidateportal.servis.sos.state.nm.us/CandidateList.aspx
 *       which is the authoritative interactive candidate-list system.
 *       The portal page renders ASP.NET WebForms (__VIEWSTATE) and
 *       requires the user to choose an election + (optionally) a county
 *       from dropdowns; query string examples we surfaced still point at
 *       the 2021 Local Election (eid=2796) and not the 2026 cycle.
 *
 *   https://candidateportal.servis.sos.state.nm.us/
 *     — Root returns HTTP 403 unless an election is selected.
 *
 *   https://www.sos.nm.gov/candidate-and-campaigns/search-public-information-data/
 *     — Search hub for OpenJustice/CFIS data; not a filing list.
 *
 * Status (2026-04-25, pre primary-filing deadline)
 * ------------------------------------------------
 * NM 2026 primary date: 2026-06-02. Filing window for federal/state
 * primary candidates: 2026-02-03 → 2026-02-10 (per N.M.S.A. 1-8-26).
 * Even after the deadline, the public list lives on the WebForms portal
 * which does not expose a stable bulk URL — every filter combination
 * goes through __VIEWSTATE round-tripping. Without an event-id (eid)
 * parameter for the 2026 primary, the public-facing list URL hasn't
 * yet been published by NMSOS.
 *
 * Strategy
 * --------
 * 1. Fetch the working hub page (sos.nm.gov/candidate-and-campaigns/).
 * 2. Discover candidate-portal links (anchor href containing
 *    candidateportal.servis.sos.state.nm.us). Capture in meta for
 *    operator follow-up.
 * 3. Return [] until NMSOS publishes a 2026-eid portal URL we can wire
 *    in (or until the WebForms scrape path is implemented — would
 *    require __VIEWSTATE handling similar to what AZ + IL portals
 *    already do in this codebase).
 *
 * Idempotent + safe to nightly run; runner's content-hash prevents
 * repeat DB churn on the unchanged hub page.
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
import { extractTextFromPdf, parsePdfTable } from '../shared/pdf-extract';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATE_FIPS = '35';
const ELECTION_YEAR = 2026;
const PRIMARY_DATE = '2026-06-02';

const DEFAULT_SOURCE_URL = 'https://www.sos.nm.gov/candidate-and-campaigns/';
const PORTAL_HOST = 'candidateportal.servis.sos.state.nm.us';

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

export type NmCandidacyRow = {
  reported_name: string;
  office_name: string;
  district_identifier: string | null;
  party_raw: string | null;
  date_filed: string | null;
  source_row_id: string;
};

export type NmCandidaciesAdapterOptions = {
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
 * Discover any 2026 candidate-list PDF on the NM SoS hub page. NMSOS's
 * primary publication channel is the ASP.NET WebForms portal; on rare
 * occasions a flat PDF roster appears between filing-period closes.
 */
export function discoverNmCandidatePdfs(html: string): string[] {
  if (!html) return [];
  const $ = cheerio.load(html);
  const out = new Set<string>();
  $('a[href]').each((_, el) => {
    const href = ($(el).attr('href') ?? '').trim();
    const text = ($(el).text() ?? '').trim().toLowerCase();
    if (!href) return;
    if (!/\.pdf(?:[?#]|$)/i.test(href)) return;
    const combined = `${href} ${text}`.toLowerCase();
    if (!/2026/.test(combined)) return;
    if (!/(candidat|filed.*list|qualif)/.test(combined)) return;
    try {
      out.add(new URL(href, 'https://www.sos.nm.gov').toString());
    } catch {
      out.add(href);
    }
  });
  return [...out];
}

/**
 * Surface NMSOS candidate-portal URLs from the hub page so an operator
 * can configure the 2026 eid follow-up. Today this typically returns
 * one or two URLs pointing at past cycles (eid=2796 / 2021 Local).
 */
export function discoverNmPortalLinks(html: string): string[] {
  const $ = cheerio.load(html);
  const out = new Set<string>();
  $('a').each((_, el) => {
    const href = ($(el).attr('href') ?? '').trim();
    if (!href) return;
    if (href.includes(PORTAL_HOST)) out.add(href);
  });
  return [...out];
}

/**
 * If NMSOS ever publishes a flat HTML candidate table on this page,
 * parse it. Today returns []. Symmetric with sibling adapters.
 */
export function parseNmCandidatesList(rawBody: string): NmCandidacyRow[] {
  if (typeof rawBody !== 'string' || rawBody.length < 64) return [];
  const trimmed = rawBody.trimStart();
  if (!trimmed.startsWith('<')) return [];
  const $ = cheerio.load(rawBody);
  const rows: NmCandidacyRow[] = [];
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
        source_row_id: `nm-t${tIdx}-r${rIdx}`,
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

export function createNmCandidaciesAdapter(
  options: NmCandidaciesAdapterOptions = {},
): SourceAdapter<NmCandidacyRow> {
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

  const adapter: SourceAdapter<NmCandidacyRow> = {
    name: 'sos-new-mexico-candidacies',
    stateFips: STATE_FIPS,
    tokenBucket: tokenBucketCfg,
    costService: 'other',

    async run(ctx: AdapterContext): Promise<AdapterOutcome<NmCandidacyRow>> {
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

      let rows = parseNmCandidatesList(rawBody);
      const portalLinks = discoverNmPortalLinks(rawBody);

      // Production: NM's authoritative source is the ASP.NET WebForms
      // candidate portal (separate __VIEWSTATE-driven adapter, TBD).
      // As a complementary path, scan the hub page for any 2026
      // candidate-list PDF (rare but possible — NMSOS sometimes posts
      // a flat PDF after each filing-period close). When found, fetch
      // + parse via the shared table extractor.
      const pdfLinks = discoverNmCandidatePdfs(rawBody);
      const fetchedPdfs: Array<{ url: string; bytes: number; rows: number }> = [];
      if (rows.length === 0 && pdfLinks.length > 0) {
        for (const url of pdfLinks) {
          try {
            const pdfRes = await politeFetch(url, {
              headers: { Accept: 'application/pdf,*/*' },
            });
            if (!pdfRes.ok) continue;
            const ab = await pdfRes.arrayBuffer();
            const bytes = new Uint8Array(ab);
            const { pages } = await extractTextFromPdf(bytes);
            const text = pages.join('\n\n');
            const tableRows = parsePdfTable(text, {
              columns: [
                { name: 'office_name', aliases: ['Office', 'Position', 'Contest'], required: true },
                { name: 'reported_name', aliases: ['Candidate', 'Name'], required: true },
                { name: 'party_raw', aliases: ['Party', 'Affiliation'] },
                { name: 'district_identifier', aliases: ['District', 'Dist'] },
              ],
            });
            const nmRows: NmCandidacyRow[] = tableRows.map((r, i) => ({
              reported_name: String(r.reported_name ?? ''),
              office_name: String(r.office_name ?? ''),
              district_identifier: r.district_identifier ? String(r.district_identifier) : null,
              party_raw: r.party_raw ? String(r.party_raw) : null,
              date_filed: null,
              source_row_id: `nm-pdf-${i + 1}`,
            }));
            rows = rows.concat(nmRows);
            fetchedPdfs.push({ url, bytes: bytes.byteLength, rows: nmRows.length });
          } catch (err) {
            ctx.logger.warn(`${adapter.name}: PDF parse failed`, {
              error: err instanceof Error ? err.message : String(err),
              url,
            });
          }
        }
      }

      ctx.logger.info(`${adapter.name}: parsed`, {
        rowCount: rows.length,
        bytes: rawBody.length,
        portal_links_discovered: portalLinks.length,
        sample_portal_link: portalLinks[0],
        note: rows.length === 0
          ? 'empty (NM publishes candidate list on WebForms portal — needs __VIEWSTATE scrape; 2026 eid not yet available)'
          : 'list parsed',
      });

      return {
        rows,
        expectedMinRows,
        source: {
          sourceType: 'sos_candidate_filing',
          name: 'new-mexico-sos-candidacies',
          url: resolvedUrl ?? sourceUrl,
          contentHash,
          license,
          stateFips: STATE_FIPS,
          meta: {
            election_year: electionYear,
            primary_date: PRIMARY_DATE,
            byte_size: rawBody.length,
            http_status: status,
            portal_links: portalLinks,
            candidate_pdfs: pdfLinks,
            fetched_pdfs: fetchedPdfs,
            blocker: rows.length === 0
              ? 'NM SoS authoritative source is ASP.NET WebForms portal (candidateportal.servis.sos.state.nm.us) requiring __VIEWSTATE round-trip; 2026 eid not yet published. PDF parser is wired and ready as a complementary path; will pick up rows when a 2026-cycle PDF appears on the hub page.'
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
      return insertNmCandidacies(rows, refs, ctx, electionYear);
    },
  };

  return adapter;
}

// ---------------------------------------------------------------------------
// Insert
// ---------------------------------------------------------------------------

async function insertNmCandidacies(
  rows: NmCandidacyRow[],
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
        source: 'nm-sos-candidacies',
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
            source: 'nm-sos-candidacies',
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
              JSON.stringify({ source: 'nm-sos-candidacies', reported_party: row.party_raw }),
            ],
          );
        }
      }
    } catch (err) {
      stats.rowsFailed += 1;
      const msg = err instanceof Error ? err.message : String(err);
      stats.errors.push({ type: 'other', message: `NM row: ${msg}`, rawInput: row });
    }
  }

  return stats;
}
