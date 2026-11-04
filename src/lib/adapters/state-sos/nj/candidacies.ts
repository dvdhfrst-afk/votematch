/**
 * New Jersey Division of Elections — 2026 candidate-filings adapter (FIPS 34).
 *
 * Source (web-verified 2026-04-25):
 *   https://www.nj.gov/state/elections/election-information-2026.shtml
 *     — 2026 election information page. Currently contains links to county-
 *       level General-2025 PDFs (the prior cycle); the consolidated
 *       2026 candidate list is published here AFTER the petition filing
 *       deadline (early April 2026 for federal/state primary, June 2026
 *       primary date 2026-06-02).
 *
 *   https://www.nj.gov/state/elections/candidates.shtml
 *     — Originally referenced URL — returns HTTP 404 as of 2026-04-25.
 *       The state-elections team consolidated candidate info into the
 *       per-cycle election-information-YYYY page; we point at the working
 *       2026 page instead.
 *
 *   https://www.nj.gov/state/elections/candidate-information.shtml
 *     — Generic info page (filing instructions, no list).
 *
 * Status (2026-04-25, post primary-filing deadline)
 * -------------------------------------------------
 * The election-information-2026.shtml page does not yet expose a
 * machine-parseable candidate list at this URL — only PDFs of 2025
 * county-level RESULTS by county. NJ's Division of Elections publishes
 * the qualified 2026 primary candidate list as a PDF a few weeks
 * AFTER the April 2026 petition deadline (per N.J.S.A. 19:13-3 timing).
 * As of this commit, that PDF has not been published.
 *
 * Strategy
 * --------
 * 1. Fetch the 2026 election-information page and discover candidate-
 *    filing links (any anchor under candidates/candidate-filings/cand-list).
 * 2. If a structured CSV/XLSX link is present, follow it (TODO when
 *    NJDOE publishes the list — currently returns []).
 * 3. Always emit a data_sources row so we have provenance + a
 *    content_hash to detect when the page changes (= candidate list
 *    is published).
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

const STATE_FIPS = '34';
const ELECTION_YEAR = 2026;
const PRIMARY_DATE = '2026-06-02';

const DEFAULT_SOURCE_URL =
  'https://www.nj.gov/state/elections/election-information-2026.shtml';

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

export type NjCandidacyRow = {
  reported_name: string;
  office_name: string;
  district_identifier: string | null;
  party_raw: string | null;
  date_filed: string | null;
  source_row_id: string;
};

export type NjCandidaciesAdapterOptions = {
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
 * Discover candidate-filing artifact URLs on the NJ 2026 election-info
 * page. NJDOE links them as "Official Primary Candidate List", "Final
 * Candidate Filings", etc. Returns absolute URLs.
 *
 * Exported for tests. The dispatcher can drive a follow-up fetch when
 * a non-empty list comes back.
 */
export function discoverNjCandidateLinks(html: string): string[] {
  const $ = cheerio.load(html);
  const out = new Set<string>();
  $('a').each((_, el) => {
    const href = ($(el).attr('href') ?? '').trim();
    const text = ($(el).text() ?? '').trim().toLowerCase();
    if (!href) return;
    const looksLikeList =
      /candidate.*list|qualified.*candidate|candidate.*filing|primary.*candidate|certified.*candidate/i.test(text)
      || /candidate.*list|qualified[-_]candidate/i.test(href);
    const isArtifact = /\.(pdf|xlsx?|csv)(?:[?#]|$)/i.test(href);
    if (looksLikeList && isArtifact) out.add(href);
  });
  return [...out];
}

/**
 * If NJDOE's eventual list is published as an HTML table on the same
 * page, parse it. Today this returns []. Kept symmetric with other
 * adapters so a future "embedded list" page works without code change.
 */
export function parseNjCandidatesList(rawBody: string): NjCandidacyRow[] {
  if (typeof rawBody !== 'string' || rawBody.length < 64) return [];
  const trimmed = rawBody.trimStart();
  if (!trimmed.startsWith('<')) return [];

  const $ = cheerio.load(rawBody);
  const rows: NjCandidacyRow[] = [];
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
        source_row_id: `nj-t${tIdx}-r${rIdx}`,
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

export function createNjCandidaciesAdapter(
  options: NjCandidaciesAdapterOptions = {},
): SourceAdapter<NjCandidacyRow> {
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

  const adapter: SourceAdapter<NjCandidacyRow> = {
    name: 'sos-new-jersey-candidacies',
    stateFips: STATE_FIPS,
    tokenBucket: tokenBucketCfg,
    costService: 'other',

    async run(ctx: AdapterContext): Promise<AdapterOutcome<NjCandidacyRow>> {
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

      const tableRows = parseNjCandidatesList(rawBody);
      const links = discoverNjCandidateLinks(rawBody);
      let rows = tableRows;

      // Production: NJDOE publishes the consolidated 2026 primary
      // candidate list as a PDF after the April petition deadline.
      // When a candidate-list PDF appears, fetch + parse via the shared
      // table extractor. Until then this loop never enters the body.
      let pdfFetched: Array<{ url: string; bytes: number; rows: number }> = [];
      if (rows.length === 0 && links.length > 0) {
        for (const url of links) {
          if (!/\.pdf(?:[?#]|$)/i.test(url)) continue;
          try {
            const pdfRes = await politeFetch(url, {
              headers: { Accept: 'application/pdf,*/*' },
            });
            if (!pdfRes.ok) continue;
            const ab = await pdfRes.arrayBuffer();
            const bytes = new Uint8Array(ab);
            const { pages } = await extractTextFromPdf(bytes);
            const text = pages.join('\n\n');
            const parsed = parsePdfTable(text, {
              columns: [
                { name: 'office_name', aliases: ['Office', 'Position', 'Contest'], required: true },
                { name: 'reported_name', aliases: ['Candidate', 'Name'], required: true },
                { name: 'party_raw', aliases: ['Party', 'Affiliation'] },
                { name: 'district_identifier', aliases: ['District', 'Dist'] },
              ],
            });
            const njRows: NjCandidacyRow[] = parsed.map((r, i) => ({
              reported_name: String(r.reported_name ?? ''),
              office_name: String(r.office_name ?? ''),
              district_identifier: r.district_identifier ? String(r.district_identifier) : null,
              party_raw: r.party_raw ? String(r.party_raw) : null,
              date_filed: null,
              source_row_id: `nj-pdf-${i + 1}`,
            }));
            rows = rows.concat(njRows);
            pdfFetched.push({ url, bytes: bytes.byteLength, rows: njRows.length });
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
        candidate_links_discovered: links.length,
        sample_link: links[0],
        note: rows.length === 0 && links.length === 0
          ? 'empty (NJDOE has not yet published 2026 primary candidate list; petition deadline early April 2026)'
          : rows.length === 0
            ? 'links discovered but PDF/XLSX parsing not yet implemented'
            : 'list parsed',
      });

      return {
        rows,
        expectedMinRows,
        source: {
          sourceType: 'sos_candidate_filing',
          name: 'new-jersey-elections-candidacies',
          url: resolvedUrl ?? sourceUrl,
          contentHash,
          license,
          stateFips: STATE_FIPS,
          meta: {
            election_year: electionYear,
            primary_date: PRIMARY_DATE,
            byte_size: rawBody.length,
            http_status: status,
            candidate_artifact_links: links,
            pdfs_fetched: pdfFetched,
            blocker: rows.length === 0
              ? 'NJDOE has not yet published 2026 primary candidate list (post-April-2026 petition deadline). PDF parser is wired and ready; will pick up rows when the consolidated list appears at one of candidate_artifact_links.'
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
      return insertNjCandidacies(rows, refs, ctx, electionYear);
    },
  };

  return adapter;
}

// ---------------------------------------------------------------------------
// Insert
// ---------------------------------------------------------------------------

async function insertNjCandidacies(
  rows: NjCandidacyRow[],
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
        source: 'nj-doe-candidacies',
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
            source: 'nj-doe-candidacies',
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
              JSON.stringify({ source: 'nj-doe-candidacies', reported_party: row.party_raw }),
            ],
          );
        }
      }
    } catch (err) {
      stats.rowsFailed += 1;
      const msg = err instanceof Error ? err.message : String(err);
      stats.errors.push({ type: 'other', message: `NJ row: ${msg}`, rawInput: row });
    }
  }

  return stats;
}
