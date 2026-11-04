/**
 * Pennsylvania Department of State — election results adapter (FIPS 42).
 *
 * Primary feed (verified 2026-04-23 per state-sos-sources.ts):
 *   https://www.pa.gov/agencies/dos/programs/voting-and-elections
 *
 * Shape PA publishes:
 *   - PA runs electionreturns.pa.gov (the live election-night portal)
 *     which exposes per-contest data via an internal XML/JSON feed
 *     ("ElectionFeed"). Canonical archive page lives at pa.gov.
 *   - Primary date: 2026-05-19.
 *
 * Strategy
 * --------
 * 1. Fetch the DOS index (stable URL).
 * 2. If body is XML with <ElectionReport>, route to NIST parser.
 * 3. If body is JSON array/object, route to {@link parsePaJson}.
 * 4. If HTML, try embedded table parser (for certified summaries) and
 *    fall back to link discovery.
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
  'https://www.pa.gov/agencies/dos/programs/voting-and-elections';
const STATE_FIPS = '42';
export function createPaResultsAdapter(
  options: { reportingLevel?: ReportingLevel } = {},
) {
  const reportingLevel: ReportingLevel =
    options.reportingLevel ?? 'unofficial_partial';
  return createStateSosAdapter({
    stateFips: STATE_FIPS,
    sourceName: 'pennsylvania-dos-results',
    sourceType: 'sos_results_api',
    sourceUrl: SOURCE_URL,
    license: 'state_open_records',
    expectedMinRows: 0,
    tokenBucket: { rps: 0.5, burst: 2 },
    fetch: async () => {
      const res = await politeFetch(SOURCE_URL, {
        headers: {
          Accept: 'application/json,text/xml,text/html,*/*',
        },
      });
      if (!res.ok) throw new Error(`PA fetch failed: ${res.status}`);
      return { rawBody: await res.text() };
    },
    parse: async (rawBody, ctx) => {
      const trimmed = rawBody.trimStart();
      if (trimmed.startsWith('<') && /<ElectionReport/i.test(rawBody)) {
        return parseNistXml(rawBody, { reportingLevel });
      }
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          return parsePaJson(JSON.parse(rawBody), reportingLevel);
        } catch (err) {
          ctx.logger.warn('pa-results: JSON parse failed', {
            err: err instanceof Error ? err.message : String(err),
          });
          return [];
        }
      }
      if (!trimmed.startsWith('<')) return [];
      const tableRows = parsePaResultTables(rawBody, reportingLevel);
      if (tableRows.length > 0) return tableRows;
      const links = discoverPaResultLinks(rawBody);
      if (links.length === 0) {
        ctx.logger.info('pa-results: no result links (off-cycle)', {
          stateFips: STATE_FIPS,
        });
      } else {
        ctx.logger.info('pa-results: subpages discovered (parse deferred)', {
          stateFips: STATE_FIPS,
          count: links.length,
          sample: links[0],
        });
      }
      return [];
    },
  });
}

export function discoverPaResultLinks(html: string): string[] {
  const $ = loadHtml(html);
  const out: string[] = [];
  $('a').each((_, el) => {
    const href = ($(el).attr('href') ?? '').trim();
    const text = ($(el).text() ?? '').trim().toLowerCase();
    if (!href) return;
    if (
      /result|primary|general|return/i.test(text) ||
      /electionreturns\.pa\.gov/i.test(href) ||
      /\.(csv|xlsx?|pdf|xml|json)(?:[?#]|$)/i.test(href)
    ) {
      out.push(href);
    }
  });
  return out;
}

/**
 * PA electionreturns.pa.gov internal JSON shape (reverse-engineered):
 *   {
 *     "Elections": [
 *       {
 *         "ElectionID":"...", "ElectionName":"...",
 *         "Races": [
 *           {
 *             "RaceName":"Governor", "District":"",
 *             "Candidates":[
 *               { "CandidateName":"", "PartyCode":"DEM",
 *                 "TotalVotes":12345, "PercentVote":50.1,
 *                 "IsWinner":true, "IsWriteIn":false }
 *             ],
 *             "PrecinctsReporting": 50.0
 *           }
 *         ]
 *       }
 *     ]
 *   }
 */
type PaRace = {
  RaceName?: string;
  District?: string | null;
  PrecinctsReporting?: number | null;
  Candidates?: Array<{
    CandidateName?: string;
    PartyCode?: string | null;
    TotalVotes?: number | null;
    PercentVote?: number | null;
    IsWinner?: boolean;
    IsWriteIn?: boolean;
  }>;
};
type PaElection = { Races?: PaRace[] };

export function parsePaJson(
  data: unknown,
  reportingLevel: ReportingLevel,
): StateResultRow[] {
  const elections: PaElection[] = Array.isArray(
    (data as { Elections?: unknown })?.Elections,
  )
    ? ((data as { Elections: PaElection[] }).Elections)
    : Array.isArray(data)
      ? (data as PaElection[])
      : [];
  const rows: StateResultRow[] = [];
  for (const e of elections) {
    for (const race of e.Races ?? []) {
      const office = (race.RaceName ?? '').toString().trim();
      if (!office) continue;
      const district =
        race.District === null || race.District === undefined
          ? null
          : String(race.District).trim() || null;
      for (const cand of race.Candidates ?? []) {
        const name = (cand.CandidateName ?? '').toString().trim();
        if (!name) continue;
        rows.push({
          reported_name: name,
          party_abbreviation: cand.PartyCode ?? null,
          office_name: office,
          district_identifier: district,
          vote_count:
            typeof cand.TotalVotes === 'number' &&
            Number.isFinite(cand.TotalVotes)
              ? cand.TotalVotes
              : null,
          vote_percentage:
            typeof cand.PercentVote === 'number' &&
            Number.isFinite(cand.PercentVote)
              ? cand.PercentVote
              : null,
          pct_precincts_reporting:
            typeof race.PrecinctsReporting === 'number'
              ? race.PrecinctsReporting
              : null,
          is_winner: Boolean(cand.IsWinner),
          is_runoff_advancer: false,
          is_write_in:
            Boolean(cand.IsWriteIn) || /write[\s-]?in/i.test(name),
          reporting_level: reportingLevel,
          source_row_id: `pa::${office}::${district ?? '-'}::${name}`,
        });
      }
    }
  }
  return rows;
}

export function parsePaResultTables(
  html: string,
  reportingLevel: ReportingLevel,
): StateResultRow[] {
  const $ = loadHtml(html);
  const rows: StateResultRow[] = [];
  $('table').each((_, table) => {
    const caption = $(table).find('caption').first().text().trim();
    const prevHeading = $(table)
      .prevAll('h1,h2,h3,h4')
      .first()
      .text()
      .trim();
    const office = caption || prevHeading;

    const headers = $(table)
      .find('thead th, tr:first-child th, tr:first-child td')
      .map((__, th) => $(th).text().toLowerCase().trim())
      .get();
    if (headers.length < 2) return;
    const colName = headers.findIndex((h) => /candidate|name/.test(h));
    const colVotes = headers.findIndex((h) => /votes?|total/.test(h));
    const colParty = headers.findIndex((h) => /party/.test(h));
    if (colName < 0 || colVotes < 0 || !office) return;

    $(table)
      .find('tbody tr')
      .each((__, tr) => {
        const cells = $(tr)
          .find('td')
          .map((___, td) => $(td).text().trim())
          .get();
        if (cells.length === 0) return;
        const name = cells[colName] ?? '';
        const votesStr = (cells[colVotes] ?? '').replace(/[,\s]/g, '');
        if (!name) return;
        const vc = Number(votesStr);
        rows.push({
          reported_name: name,
          party_abbreviation:
            colParty >= 0 ? cells[colParty] || null : null,
          office_name: office,
          district_identifier: null,
          vote_count: Number.isFinite(vc) ? vc : null,
          vote_percentage: null,
          pct_precincts_reporting: null,
          is_winner: false,
          is_runoff_advancer: false,
          is_write_in: /write[\s-]?in/i.test(name),
          reporting_level: reportingLevel,
          source_row_id: `pa::${office}::${name}`,
        });
      });
  });
  return rows;
}
