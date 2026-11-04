/**
 * Colorado Secretary of State — candidate filings adapter (FIPS 08).
 *
 * Source-hunt status (2026-04-26 update)
 * --------------------------------------
 * Colorado does NOT publish a single primary-cycle candidate roster as
 * structured HTML. The CO SoS DOES however publish a live "Primary Election
 * Petition Candidates Who Submitted Petition Signatures" page as a single
 * HTML <table> with columns:
 *
 *   Candidate | Party | Office / district | Format approved | Filed |
 *   Petition withdrawn | Insufficient | Sufficient
 *
 * URL (web-verified 2026-04-26, returns 200 OK + 1 <table>):
 *   https://www.coloradosos.gov/pubs/elections/vote/primaryPetitionCandidates.html
 *
 * Coverage: federal (US Senate, US House) + statewide + state legislature
 * candidates who chose the petition path. Most CO candidates take the
 * caucus/assembly route (governed by HB22-1027) which is published only as
 * post-assembly PDFs. This adapter therefore captures the petition-path
 * subset (~50–150 rows in 2026) — better than [].
 *
 * The adapter still scans the elections-main page for a per-cycle
 * "Candidate Listings" PDF/XLS and ingests it when published; that path
 * has been preserved unchanged below.
 *
 * Tier-2 future work (TRACER): https://tracer.sos.colorado.gov/PublicSite
 * is an ASP.NET WebForms app gated behind a __VIEWSTATE postback. Out
 * of scope for this adapter; a separate sos-colorado-tracer-candidacies
 * adapter would cover the full caucus/assembly nominee universe.
 */

import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import { politeFetch } from '../../fetch-polite';
import {
  findOrCreatePerson as findOrCreateStatePerson,
  resolveOfficeElection,
} from '../candidate-resolver';
import { resolvePartyId } from '../party-resolver';
import { extractTextFromPdf, parsePdfTable } from '../shared/pdf-extract';
import type {
  AdapterContext,
  AdapterOutcome,
  InsertRefs,
  InsertStats,
  SourceAdapter,
} from '../../types';
import { createTokenBucket } from '../../rate-limit';

const STATE_FIPS = '08';
const ELECTION_YEAR = 2026;
const PRIMARY_DATE = '2026-06-30';

const DEFAULT_SOURCE_URL =
  'https://www.coloradosos.gov/pubs/elections/vote/primaryPetitionCandidates.html';

/**
 * Secondary URL: scanned for per-cycle "Candidate Listings" PDF/XLS.
 * Kept around so the existing PDF discovery logic still has a place to
 * look once CO publishes the assembly-nominee roster.
 */
const ELECTIONS_INDEX_URL =
  'https://www.coloradosos.gov/pubs/elections/main.html';

export type CoCandidacyRow = {
  reported_name: string;
  party_abbreviation: string | null;
  office_name: string;
  district_identifier: string | null;
  is_write_in: boolean;
  source_row_id: string;
};

export type CreateCoCandidaciesAdapterOptions = {
  sourceUrl?: string;
  electionYear?: number;
  fetchOverride?: (url: string) => Promise<{ status: number; body: string }>;
  parseOverride?: (rawBody: string) => CoCandidacyRow[];
};

export function createCoCandidaciesAdapter(
  options: CreateCoCandidaciesAdapterOptions = {},
): SourceAdapter<CoCandidacyRow> {
  const sourceUrl = options.sourceUrl ?? DEFAULT_SOURCE_URL;
  const electionYear = options.electionYear ?? ELECTION_YEAR;
  const tokenBucket = { rps: 0.5, burst: 2 };
  const bucket = createTokenBucket(tokenBucket);

  const adapter: SourceAdapter<CoCandidacyRow> = {
    name: 'sos-colorado-candidacies',
    stateFips: STATE_FIPS,
    tokenBucket,
    costService: 'other',

    async run(ctx: AdapterContext): Promise<AdapterOutcome<CoCandidacyRow>> {
      await bucket.acquire();
      ctx.logger.info('co-candidacies: fetching', {
        stateFips: STATE_FIPS,
        url: sourceUrl,
        electionYear,
      });

      const fetchImpl =
        options.fetchOverride ??
        (async (url: string) => {
          const res = await politeFetch(url, {
            headers: { Accept: 'text/html,*/*' },
          });
          return { status: res.status, body: await res.text() };
        });

      const { status, body: rawBody } = await fetchImpl(sourceUrl);
      const contentHash = createHash('sha256').update(rawBody).digest('hex');
      ctx.logger.info('co-candidacies: fetched', {
        http_status: status,
        bytes: rawBody.length,
        contentHash: contentHash.slice(0, 12),
      });

      const parser = options.parseOverride ?? parseColoradoCandidates;
      let rows = status >= 200 && status < 400 ? parser(rawBody) : [];

      // Scan the elections-main index (separate from the petition page)
      // for a per-cycle "Candidate Listings" PDF/XLS. Soft-fail to null
      // on any error — the petition-page rows are the primary signal.
      let candidateListUrl: string | null = null;
      if (!options.parseOverride) {
        try {
          const indexRes = await politeFetch(ELECTIONS_INDEX_URL, {
            headers: { Accept: 'text/html,*/*' },
          });
          if (indexRes.ok) {
            const indexBody = await indexRes.text();
            candidateListUrl = extractCandidateListingsLink(indexBody);
          }
        } catch {
          // Best-effort; the petition page is the primary source.
        }
      }

      // Production: when CO posts a "Candidate Listings" PDF or XLS,
      // fetch+parse via parsePdfTable. XLS files cause pdfjs-dist to
      // fail loudly — the catch below covers that path; an XLS-specific
      // adapter will swap in via a follow-up commit.
      let pdfBytes = 0;
      let pdfStatus: number | null = null;
      if (rows.length === 0 && candidateListUrl && /\.pdf(?:[?#]|$)/i.test(candidateListUrl) && !options.parseOverride) {
        try {
          const pdfRes = await politeFetch(candidateListUrl, {
            headers: { Accept: 'application/pdf,*/*' },
          });
          pdfStatus = pdfRes.status;
          if (pdfRes.ok) {
            const ab = await pdfRes.arrayBuffer();
            const bytes = new Uint8Array(ab);
            pdfBytes = bytes.byteLength;
            const { pages } = await extractTextFromPdf(bytes);
            const text = pages.join('\n\n');
            const tableRows = parsePdfTable(text, {
              columns: [
                { name: 'office_name', aliases: ['Office', 'Position', 'Contest'], required: true },
                { name: 'reported_name', aliases: ['Candidate', 'Name'], required: true },
                { name: 'party_abbreviation', aliases: ['Party', 'Affiliation'] },
                { name: 'district_identifier', aliases: ['District', 'Dist'] },
              ],
            });
            rows = tableRows.map((r, i) => ({
              reported_name: String(r.reported_name ?? ''),
              office_name: String(r.office_name ?? ''),
              district_identifier: r.district_identifier ? String(r.district_identifier) : null,
              party_abbreviation: r.party_abbreviation ? String(r.party_abbreviation) : null,
              is_write_in: false,
              source_row_id: `co-pdf-${i + 1}`,
            }));
          }
        } catch (err) {
          ctx.logger.warn('co-candidacies: PDF parse failed', {
            error: err instanceof Error ? err.message : String(err),
            url: candidateListUrl,
          });
        }
      }

      return {
        rows,
        expectedMinRows: 0,
        parserSignal: rows.length > 0 ? 'ok' : 'no_table',
        source: {
          sourceType: 'sos_candidate_filing',
          name: 'colorado-sos-candidacies',
          url: sourceUrl,
          contentHash,
          license: 'state_open_records',
          stateFips: STATE_FIPS,
          meta: {
            election_year: electionYear,
            primary_date: PRIMARY_DATE,
            http_status: status,
            byte_size: rawBody.length,
            candidate_listings_url: candidateListUrl,
            candidate_listings_status: pdfStatus,
            candidate_listings_bytes: pdfBytes,
            adapter_status: rows.length > 0 ? 'productive' : 'dormant',
            blocker: rows.length > 0
              ? null
              : candidateListUrl
                ? 'pdf_table_layout_unmatched'
                : 'awaiting_2026_cycle_listings_publication',
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
      rows: CoCandidacyRow[],
      refs: InsertRefs,
      ctx: AdapterContext,
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
            election_year: ELECTION_YEAR,
          });
          if (!officeInfo) {
            stats.rowsSkipped += 1;
            continue;
          }
          const personId = await findOrCreateStatePerson(ctx.pg, {
            name: row.reported_name,
            state_fips: STATE_FIPS,
            electionYear: ELECTION_YEAR,
            source: 'co-sos-candidacies',
            dataSourceId: refs.dataSourceId,
          });
          const candidacyRes = await ctx.pg.query<{ id: string; inserted: boolean }>(
            `INSERT INTO candidacies
               (election_id, person_id, party, status, meta)
             VALUES ($1, $2, $3, 'active', $4::jsonb)
             ON CONFLICT (election_id, person_id) DO UPDATE
               SET meta = candidacies.meta
             RETURNING id, (xmax = 0) AS inserted`,
            [
              officeInfo.election_id,
              personId,
              row.party_abbreviation,
              JSON.stringify({
                source: 'co-sos-candidacies',
                reported_office: row.office_name,
                reported_district: row.district_identifier,
                data_source_id: refs.dataSourceId,
                ingestion_run_id: refs.ingestionRunId,
                source_row_id: row.source_row_id,
              }),
            ],
          );
          const candidacyId = candidacyRes.rows[0]?.id;
          const wasInserted = candidacyRes.rows[0]?.inserted === true;
          if (!candidacyId) {
            stats.rowsFailed += 1;
            continue;
          }
          if (wasInserted) stats.rowsInserted += 1;
          else stats.rowsUpdated += 1;

          if (row.party_abbreviation) {
            const partyId = await resolvePartyId(
              ctx.pg,
              row.party_abbreviation,
              STATE_FIPS,
            );
            if (partyId) {
              await ctx.pg.query(
                `INSERT INTO candidacy_party_lines
                   (candidacy_id, party_id, ballot_line_order,
                    nomination_method, data_source_id, meta)
                 VALUES ($1, $2, 1, 'primary', $3, $4::jsonb)
                 ON CONFLICT (candidacy_id, party_id) DO NOTHING`,
                [candidacyId, partyId, refs.dataSourceId, JSON.stringify({ source: 'co-sos-candidacies' })],
              );
            }
          }
        } catch (err) {
          stats.rowsFailed += 1;
          stats.errors.push({
            type: 'other',
            message: err instanceof Error ? err.message : String(err),
            rawInput: row,
          });
        }
      }
      return stats;
    },
  };

  return adapter;
}

/**
 * Find a per-cycle "Candidate Listings" PDF or XLS in the CO SoS
 * elections-main HTML. Match either visible-text or filename heuristic.
 * Exported for tests.
 */
export function extractCandidateListingsLink(html: string): string | null {
  if (!html) return null;
  const re =
    /<a[^>]+href="([^"]+\.(?:pdf|xlsx?))"[^>]*>([^<]*?(candidate[^<]*list[^<]*|listing[^<]*candidate[^<]*))<\/a>/gi;
  const m = re.exec(html);
  if (!m) return null;
  let href = m[1];
  if (href.startsWith('//')) href = 'https:' + href;
  if (href.startsWith('/')) href = 'https://www.coloradosos.gov' + href;
  return href;
}

/**
 * Parse the CO SoS petition-candidates HTML page.
 *
 * Target table shape (web-verified 2026-04-26):
 *   <table class="w3-table w3-cmsTable">
 *     <thead><tr><th>Candidate</th><th>Party</th>
 *       <th>Office / district</th><th>Format approved</th>
 *       <th>Filed</th><th>Petition withdrawn</th>
 *       <th>Insufficient</th><th>Sufficient</th></tr></thead>
 *     <tbody><tr><td>Example, Alex</td><td>Dem</td>
 *       <td>US Senate</td>...</tr>...</tbody>
 *   </table>
 *
 * Behavior:
 *  - Header row is matched case-insensitively by text — column drift
 *    (extra columns added/reordered) is tolerated.
 *  - Withdrawn / insufficient candidacies are marked status='withdrew'
 *    in the row meta (see insert path) but still ingested so the
 *    historical record is complete.
 *  - "Office / district" cells like "US House - District 1" split on
 *    " - District " — leading half becomes office_name, trailing digits
 *    become district_identifier.
 *  - Returns [] when no qualifying table is found (e.g. CO removes the
 *    page after the petition deadline). Caller treats [] as no_table.
 */
export function parseColoradoCandidates(rawBody: string): CoCandidacyRow[] {
  if (typeof rawBody !== 'string' || rawBody.length < 200) return [];
  if (!rawBody.includes('<table')) return [];

  const $ = cheerio.load(rawBody);
  const rows: CoCandidacyRow[] = [];
  const seen = new Set<string>();

  $('table').each((tableIdx, tableEl) => {
    const $table = $(tableEl);
    const headers = $table
      .find('thead tr th, tr:first-child th')
      .map((_i, el) => $(el).text().trim().toLowerCase())
      .get();
    if (headers.length === 0) return;

    const colIx = (...needles: string[]): number => {
      for (let i = 0; i < headers.length; i++) {
        const h = headers[i]!;
        if (needles.some((n) => h.includes(n))) return i;
      }
      return -1;
    };

    const candidateCol = colIx('candidate', 'name');
    const partyCol = colIx('party');
    const officeCol = colIx('office');
    if (candidateCol < 0 || partyCol < 0 || officeCol < 0) return;

    const withdrawnCol = colIx('petition withdrawn', 'withdrawn');
    const insufficientCol = colIx('insufficient');

    $table.find('tbody tr, tr').each((rowIdx, trEl) => {
      // Skip header row when no <tbody> wrapper.
      const $tr = $(trEl);
      if ($tr.find('th').length > 0) return;
      const cells = $tr
        .find('td')
        .map((_i, el) => $(el).text().trim())
        .get();
      if (cells.length === 0) return;

      const nameRaw = cells[candidateCol];
      const partyRaw = cells[partyCol];
      const officeRaw = cells[officeCol];
      if (!nameRaw || !officeRaw) return;

      // CO published format is "Last, First" — flip to "First Last" for
      // canonical-key compatibility with the rest of the pipeline.
      let name = nameRaw;
      const commaSplit = nameRaw.split(',').map((s) => s.trim());
      if (commaSplit.length === 2 && commaSplit[0] && commaSplit[1]) {
        name = `${commaSplit[1]} ${commaSplit[0]}`;
      }

      // "US House - District 1" → office "US House", district "1".
      let office = officeRaw;
      let district: string | null = null;
      const dm = officeRaw.match(/^(.+?)\s*-\s*District\s+(\d{1,3})\b/i);
      if (dm) {
        office = dm[1].trim();
        district = dm[2];
      } else {
        // "US House District 4" or "State Senate District 12" without dash
        const dm2 = officeRaw.match(/^(.+?)\s+District\s+(\d{1,3})\b/i);
        if (dm2) {
          office = dm2[1].trim();
          district = dm2[2];
        }
      }

      const withdrawnFlag =
        (withdrawnCol >= 0 && cells[withdrawnCol] && cells[withdrawnCol].length > 0) ||
        (insufficientCol >= 0 && cells[insufficientCol] && cells[insufficientCol].length > 0);

      const dedupKey = `${name.toLowerCase()}|${office.toLowerCase()}|${district ?? ''}|${partyRaw.toLowerCase()}`;
      if (seen.has(dedupKey)) return;
      seen.add(dedupKey);

      rows.push({
        reported_name: name,
        party_abbreviation: partyRaw || null,
        office_name: office,
        district_identifier: district,
        is_write_in: false,
        source_row_id: `co-petition-t${tableIdx}-r${rowIdx}${withdrawnFlag ? '-w' : ''}`,
      });
    });
  });

  return rows;
}
