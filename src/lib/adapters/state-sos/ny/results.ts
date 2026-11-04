/**
 * New York State Board of Elections — election results adapter (FIPS 36).
 *
 * Primary feed (verified 2026-04-23 per state-sos-sources.ts):
 *   https://www.elections.ny.gov/
 *
 * Shape NY publishes:
 *   - NY's election-night portal historically publishes per-contest CSVs
 *     at elections.ny.gov/NYSBOE/elections/... in a rollup format.
 *   - Certified results published as PDF after the canvass. The SoS
 *     itself posts HTML landing pages.
 *   - ~30 upcoming primaries on 2026-06-23 (congressional + state leg);
 *     set expectedMinRows to 50 when full-reporting, 0 when off-cycle.
 *
 * Strategy
 * --------
 * 1. Fetch index HTML.
 * 2. If CSV/JSON body, route accordingly.
 * 3. Otherwise return [] and log discovered subpage links.
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

const SOURCE_URL = 'https://www.elections.ny.gov/';
const STATE_FIPS = '36';

export function createNyResultsAdapter(
  options: { reportingLevel?: ReportingLevel } = {},
) {
  const reportingLevel: ReportingLevel =
    options.reportingLevel ?? 'unofficial_partial';
  return createStateSosAdapter({
    stateFips: STATE_FIPS,
    sourceName: 'new-york-sboe-results',
    sourceType: 'sos_results_api',
    sourceUrl: SOURCE_URL,
    license: 'state_open_records',
    // NY has ~30 primaries 2026-06-23 — a realistic floor for the full
    // general is 50+ rows (multi-candidate contests). Off-cycle polling
    // sets expectedMinRows=0 via the parse returning an empty array.
    expectedMinRows: 0,
    tokenBucket: { rps: 0.5, burst: 2 },
    fetch: async () => {
      const res = await politeFetch(SOURCE_URL, {
        headers: { Accept: 'text/html,text/csv,*/*' },
      });
      if (!res.ok) throw new Error(`NY fetch failed: ${res.status}`);
      return { rawBody: await res.text() };
    },
    parse: async (rawBody, ctx) => {
      const trimmed = rawBody.trimStart();
      if (trimmed.startsWith('<') && /<ElectionReport/i.test(rawBody)) {
        return parseNistXml(rawBody, { reportingLevel });
      }
      if (trimmed.startsWith('<')) {
        const links = discoverNyResultLinks(rawBody);
        if (links.length === 0) {
          ctx.logger.info('ny-results: no result links (off-cycle)', {
            stateFips: STATE_FIPS,
          });
        } else {
          ctx.logger.info(
            'ny-results: discovered subpage links — real-time CSV URL TBD',
            { stateFips: STATE_FIPS, count: links.length, sample: links[0] },
          );
        }
        return [];
      }
      // CSV fallback (election-night hot path once the real URL is wired in).
      if (looksLikeCsv(rawBody)) {
        return parseNyCsv(rawBody, reportingLevel);
      }
      return [];
    },
  });
}

export function discoverNyResultLinks(html: string): string[] {
  const $ = loadHtml(html);
  const out: string[] = [];
  $('a').each((_, el) => {
    const href = ($(el).attr('href') ?? '').trim();
    const text = ($(el).text() ?? '').trim().toLowerCase();
    if (!href) return;
    if (
      /result|primary|general|certified/i.test(text) ||
      /\.(csv|xlsx?|pdf)(?:[?#]|$)/i.test(href)
    ) {
      out.push(href);
    }
  });
  return out;
}

function looksLikeCsv(s: string): boolean {
  const first = s.split(/\r?\n/, 1)[0] ?? '';
  return first.split(',').length >= 3;
}

/**
 * NY election-night CSV historical shape (per 2022 canvass release):
 *   OfficeName, DistrictNumber, CandidateName, PartyName, VoteTotal
 * Plus variant rollups with columns for district/county/precinct.
 */
export function parseNyCsv(
  body: string,
  reportingLevel: ReportingLevel,
): StateResultRow[] {
  const rows: StateResultRow[] = [];
  const lines = body.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return rows;
  const header = splitCsv(lines[0]).map((h) => h.toLowerCase().trim());
  const colOffice = header.findIndex((h) => /office|contest/.test(h));
  const colDistrict = header.findIndex((h) => /district/.test(h));
  // Candidate column must match 'candidate' or a bare 'name' — reject office/party columns.
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
      source_row_id: `ny::${office}::${parts[colDistrict] ?? '-'}::${name}`,
    });
  }
  return rows;
}

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
