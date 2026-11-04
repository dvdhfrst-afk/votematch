/**
 * Michigan — SoS Campaign Finance (MiTN) (FIPS 26).
 *
 * Portal: https://www.michigan.gov/sos/elections/disclosure/cfr
 * Format: Landing page for the MiTN searchable database (Michigan
 *         Transparency Network). MiTN replaced MERTS in 2024; this
 *         adapter reads the current (MiTN) URL but tolerates a MERTS
 *         legacy body in case a caller points at an archive export.
 *
 * MiTN publishes per-committee report PDFs + bulk CSV exports at
 * https://misos.michigan.gov/. Deep-linked CSV URLs change per cycle
 * so we don't hardcode them here; a reporting_period override lets the
 * CLI point at a specific cycle's export file.
 */

import { load as loadHtml } from 'cheerio';
import type { AdapterContext } from '../../types';
import {
  createStateCfAdapter,
  fetchCfHtml,
  type StateCfEventRow,
} from '../shared/base';
import {
  parseGenericCfCsv,
  parseGenericCfHtmlTable,
} from '../shared/html-parsers';

export const MI_STATE_FIPS = '26';
export const MI_STATE_ABBR = 'MI';
const DEFAULT_URL =
  'https://www.michigan.gov/sos/elections/disclosure/cfr';

export type MiCfAdapterOptions = {
  sourceUrl?: string;
  electionYear?: number;
  reportingPeriod?: string;
  fetchImpl?: (ctx: AdapterContext) => Promise<{ rawBody: string }>;
};

/**
 * The MERTS legacy dump format used pipe-delimited fields; MiTN now
 * emits CSV. Detect by first-line delimiters.
 */
export function parseMichiganCf(
  body: string,
  opts: { sourceUrl?: string; reportingPeriod?: string } = {},
): StateCfEventRow[] {
  if (!body) return [];
  const sourceUrl = opts.sourceUrl ?? DEFAULT_URL;
  const first = body.trimStart().split('\n', 1)[0] ?? '';
  if (first.startsWith('<')) {
    return parseGenericCfHtmlTable(body, {
      state: MI_STATE_ABBR,
      sourceUrl,
      reportingPeriod: opts.reportingPeriod,
    });
  }
  // MERTS legacy: pipe-delimited. Convert to CSV by escaping commas and
  // re-delimiting; simpler than forking the CSV parser for one format.
  if (first.indexOf('|') > 0 && first.indexOf(',') < 0) {
    const csv = body
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((line) =>
        line
          .split('|')
          .map((cell) =>
            cell.includes(',') || cell.includes('"')
              ? `"${cell.replace(/"/g, '""')}"`
              : cell,
          )
          .join(','),
      )
      .join('\n');
    return parseGenericCfCsv(csv, {
      state: MI_STATE_ABBR,
      sourceUrl,
      reportingPeriod: opts.reportingPeriod,
    });
  }
  // MiTN CSV path.
  return parseGenericCfCsv(body, {
    state: MI_STATE_ABBR,
    sourceUrl,
    reportingPeriod: opts.reportingPeriod,
  });
}

export function discoverMitnCsvLinks(html: string): string[] {
  const $ = loadHtml(html);
  const out: string[] = [];
  $('a').each((_, el) => {
    const href = ($(el).attr('href') ?? '').trim();
    if (!href) return;
    if (/misos\.michigan\.gov/i.test(href) || /\.csv(?:[?#]|$)/i.test(href)) {
      out.push(href);
    }
  });
  return out;
}

export function createMiCfAdapter(opts: MiCfAdapterOptions = {}) {
  const url = opts.sourceUrl ?? DEFAULT_URL;
  return createStateCfAdapter({
    stateFips: MI_STATE_FIPS,
    stateAbbr: MI_STATE_ABBR,
    sourceName: 'michigan-mitn-cf',
    sourceUrl: url,
    sourceType: 'sos_campaign_finance',
    license: 'state_open_records',
    tokenBucket: { rps: 0.5, burst: 2 },
    expectedMinRows: 0,
    electionYear: opts.electionYear,
    reportingPeriod: opts.reportingPeriod,
    fetch: opts.fetchImpl ?? (async () => fetchCfHtml(url)),
    parse: async (body, ctx) => {
      const rows = parseMichiganCf(body, {
        sourceUrl: url,
        reportingPeriod: opts.reportingPeriod,
      });
      if (rows.length === 0 && body.trimStart().startsWith('<')) {
        const links = discoverMitnCsvLinks(body);
        if (links.length > 0) {
          ctx.logger.info('mi-cf: MiTN export links discovered on landing', {
            count: links.length,
            sample: links[0],
          });
        }
      }
      return rows;
    },
  });
}
