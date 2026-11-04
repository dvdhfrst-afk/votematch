/**
 * New Hampshire Secretary of State — election results adapter (FIPS 33).
 *
 * Primary feed (verified 2026-04-23 per state-sos-sources.ts):
 *   https://sos.nh.gov/
 *
 * Shape NH publishes:
 *   - HTML landing pages linking to per-election PDF summaries.
 *   - Historically returns town-by-town CSV/XLSX on election night via
 *     the elections portal at sos.nh.gov/elections/. No NIST XML.
 *   - Primary date: 2026-09-08 (state primary).
 *
 * Strategy
 * --------
 * 1. Fetch the SoS index page.
 * 2. Scrape anchor tags for ".csv" / ".xlsx" / "-results" links under the
 *    current election year. If none, return [] (off-cycle).
 * 3. XLSX parsing deferred (TODO); CSV fallback parser provided below.
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

const SOURCE_URL = 'https://sos.nh.gov/elections/';
const STATE_FIPS = '33';

export function createNhResultsAdapter(
  options: { reportingLevel?: ReportingLevel } = {},
) {
  const reportingLevel: ReportingLevel =
    options.reportingLevel ?? 'unofficial_partial';
  return createStateSosAdapter({
    stateFips: STATE_FIPS,
    sourceName: 'new-hampshire-sos-results',
    sourceType: 'sos_results_api',
    sourceUrl: SOURCE_URL,
    license: 'state_open_records',
    expectedMinRows: 0,
    tokenBucket: { rps: 0.5, burst: 2 },
    fetch: async () => {
      const res = await politeFetch(SOURCE_URL, {
        headers: { Accept: 'text/html,*/*' },
      });
      if (!res.ok) throw new Error(`NH fetch failed: ${res.status}`);
      return { rawBody: await res.text() };
    },
    parse: async (rawBody, ctx) => {
      const trimmed = rawBody.trimStart();
      if (trimmed.startsWith('<') && /<ElectionReport/i.test(rawBody)) {
        return parseNistXml(rawBody, { reportingLevel });
      }
      if (trimmed.startsWith('<')) {
        const links = discoverNhResultLinks(rawBody);
        if (links.length === 0) {
          ctx.logger.info('nh-results: no result links found (off-cycle)', {
            stateFips: STATE_FIPS,
          });
          return [];
        }
        ctx.logger.info(
          'nh-results: links discovered but XLSX/PDF parsing deferred',
          { stateFips: STATE_FIPS, count: links.length, sample: links[0] },
        );
        return [];
      }
      if (/^[A-Za-z0-9 "',\t]+,/.test(trimmed)) {
        return parseNhCsv(rawBody, reportingLevel);
      }
      return [];
    },
  });
}

export function discoverNhResultLinks(html: string): string[] {
  const $ = loadHtml(html);
  const out: string[] = [];
  $('a').each((_, el) => {
    const href = ($(el).attr('href') ?? '').trim();
    const text = ($(el).text() ?? '').trim().toLowerCase();
    if (!href) return;
    if (
      /result|summary|tabulation/i.test(text) ||
      /\.(csv|xlsx?|pdf)(?:[?#]|$)/i.test(href)
    ) {
      out.push(href);
    }
  });
  return out;
}

export function parseNhCsv(
  body: string,
  reportingLevel: ReportingLevel,
): StateResultRow[] {
  const rows: StateResultRow[] = [];
  const lines = body.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return rows;
  const header = splitCsv(lines[0]).map((h) => h.toLowerCase().trim());
  const colOffice = header.findIndex((h) => /office|contest/.test(h));
  const colDistrict = header.findIndex((h) => /district|dist/.test(h));
  const colName = header.findIndex(
    (h) => /candidate/.test(h) || (/\bname\b/.test(h) && !/office|party/.test(h)),
  );
  const colParty = header.findIndex((h) => /party/.test(h));
  const colVotes = header.findIndex(
    (h) => /\bvotes?\b/.test(h) || /votetotal|total\s*votes?/.test(h),
  );
  if (colOffice < 0 || colName < 0 || colVotes < 0) return rows;

  for (let i = 1; i < lines.length; i++) {
    const parts = splitCsv(lines[i]);
    const office = (parts[colOffice] ?? '').trim();
    const name = (parts[colName] ?? '').trim();
    if (!office || !name) continue;
    const vc = Number((parts[colVotes] ?? '').replace(/[,\s]/g, ''));
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
      source_row_id: `nh::${office}::${name}`,
    });
  }
  return rows;
}

// Minimal CSV splitter — handles quoted fields with commas inside.
function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') {
        inQ = false;
      } else {
        cur += c;
      }
    } else {
      if (c === ',') {
        out.push(cur);
        cur = '';
      } else if (c === '"') {
        inQ = true;
      } else {
        cur += c;
      }
    }
  }
  out.push(cur);
  return out;
}
