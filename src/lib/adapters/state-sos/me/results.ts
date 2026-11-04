/**
 * Maine Secretary of State — election results adapter (FIPS 23).
 *
 * Primary feed (verified 2026-04-23 per state-sos-sources.ts):
 *   https://www.maine.gov/sos/elections-voting/election-results-data
 *
 * Shape ME publishes:
 *   - HTML index page linking to per-election XLS/TXT/PDF "Tabulations" files.
 *   - No machine-readable JSON or XML feed as of 2026.
 *   - Primary date: 2026-06-09 (semi-closed primary).
 *
 * Strategy
 * --------
 * 1. Fetch the index HTML.
 * 2. Detect the most-recent "Tabulations" link. If none present (off-cycle),
 *    return an empty row set — the framework will mark the run 'partial'
 *    with expectedMinRows=0 so that's fine.
 * 3. When the link points at XLS/PDF: mark as deferred for now (we'd need
 *    xlsx/pdf parsers plumbed through). Log and return [].
 * 4. When the link points at a CSV/TXT text format: fetch + parse via
 *    {@link parseMaineTabulationTxt}.
 *
 * NIST XML never observed for ME; parseNistXml is only tried if the body
 * starts with '<' AND contains 'ElectionReport' (future-proofing).
 */

import { load as loadHtml } from 'cheerio';
import {
  createStateSosAdapter,
  type StateResultRow,
  type StateReportingLevel,
} from '../base';
import { parseNistXml } from '../nist-xml-parser';
import { politeFetch } from '../../fetch-polite';

export type ReportingLevel = StateReportingLevel;

const SOURCE_URL =
  'https://www.maine.gov/sos/elections-voting/election-results-data';
const STATE_FIPS = '23';

export function createMeResultsAdapter(
  options: { reportingLevel?: ReportingLevel } = {},
) {
  const reportingLevel: ReportingLevel =
    options.reportingLevel ?? 'unofficial_partial';
  return createStateSosAdapter({
    stateFips: STATE_FIPS,
    sourceName: 'maine-sos-results',
    sourceType: 'sos_results_api',
    sourceUrl: SOURCE_URL,
    license: 'state_open_records',
    expectedMinRows: 0,
    tokenBucket: { rps: 0.5, burst: 2 },
    fetch: async () => {
      const res = await politeFetch(SOURCE_URL, {
        headers: { Accept: 'text/html,*/*' },
      });
      if (!res.ok) throw new Error(`ME fetch failed: ${res.status}`);
      return { rawBody: await res.text() };
    },
    parse: async (rawBody, ctx) => {
      const trimmed = rawBody.trimStart();
      if (trimmed.startsWith('<') && /<ElectionReport/i.test(rawBody)) {
        return parseNistXml(rawBody, { reportingLevel });
      }
      if (trimmed.startsWith('<')) {
        // HTML index page — discover the latest tabulation link.
        const links = discoverTabulationLinks(rawBody);
        if (links.length === 0) {
          ctx.logger.info('me-results: no tabulation links found (off-cycle)', {
            stateFips: STATE_FIPS,
          });
          return [];
        }
        // TODO: once xlsx/pdf parsers are shipped, dispatch on link suffix.
        ctx.logger.info(
          'me-results: found tabulation links but XLS/PDF parsing deferred',
          { stateFips: STATE_FIPS, count: links.length, sample: links[0] },
        );
        return [];
      }
      // CSV/TXT fallback (election night may publish tab-separated text).
      return parseMaineTabulationTxt(rawBody, reportingLevel);
    },
  });
}

// ---------------------------------------------------------------------------
// Helpers (exported for tests)
// ---------------------------------------------------------------------------

export function discoverTabulationLinks(html: string): string[] {
  const $ = loadHtml(html);
  const out: string[] = [];
  $('a').each((_, el) => {
    const href = ($(el).attr('href') ?? '').trim();
    const text = ($(el).text() ?? '').trim().toLowerCase();
    if (!href) return;
    // Maine historically publishes "Tabulations" links with .xls, .xlsx,
    // .pdf, or .txt extensions. We accept any.
    if (
      /tabulation|results|summary/i.test(text) ||
      /\.(xlsx?|pdf|txt|csv)(?:[?#]|$)/i.test(href)
    ) {
      out.push(href);
    }
  });
  return out;
}

/**
 * Parse Maine's tab-separated "Tabulations" TXT format when available.
 * Historical shape (pre-2024, may have shifted):
 *   OFFICE \t DISTRICT \t CANDIDATE \t PARTY \t VOTES
 * We accept a header row; any unrecognized shape returns [].
 */
export function parseMaineTabulationTxt(
  body: string,
  reportingLevel: ReportingLevel,
): StateResultRow[] {
  const rows: StateResultRow[] = [];
  const lines = body.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return rows;

  const header = lines[0].toLowerCase().split('\t');
  const colOffice = header.findIndex((h) => /office|contest/.test(h));
  const colDistrict = header.findIndex((h) => /district/.test(h));
  const colName = header.findIndex(
    (h) => /candidate/.test(h) || (/\bname\b/.test(h) && !/office|party/.test(h)),
  );
  const colParty = header.findIndex((h) => /party/.test(h));
  const colVotes = header.findIndex(
    (h) => /\bvotes?\b/.test(h) || /\bcount\b/.test(h),
  );

  if (colOffice < 0 || colName < 0 || colVotes < 0) return rows;

  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split('\t');
    const office = (parts[colOffice] ?? '').trim();
    const name = (parts[colName] ?? '').trim();
    const votesStr = (parts[colVotes] ?? '').replace(/[,\s]/g, '');
    if (!office || !name) continue;
    const vc = Number(votesStr);
    rows.push({
      reported_name: name,
      party_abbreviation:
        colParty >= 0 ? (parts[colParty] ?? '').trim() || null : null,
      office_name: office,
      district_identifier:
        colDistrict >= 0 ? (parts[colDistrict] ?? '').trim() || null : null,
      vote_count: Number.isFinite(vc) ? vc : null,
      vote_percentage: null,
      pct_precincts_reporting: null,
      is_winner: false,
      is_runoff_advancer: false,
      is_write_in: /write[\s-]?in/i.test(name),
      reporting_level: reportingLevel,
      source_row_id: `me::${office}::${name}`,
    });
  }
  return rows;
}
