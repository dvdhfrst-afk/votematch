/**
 * Illinois — State Board of Elections Campaign Disclosure (FIPS 17).
 *
 * Portal: https://elections.il.gov/campaigndisclosure/politicalcommittee.aspx
 *         (results-bearing search:
 *          https://elections.il.gov/CampaignDisclosure/CommitteeSearch.aspx)
 * Format: ASP.NET WebForms search portal. The SBE also publishes bulk
 *         CSV exports on adjacent pages (D-2/A-1/etc. report dumps);
 *         pointing `sourceUrl` at a specific export CSV switches the
 *         parser to CSV mode automatically.
 *
 * The default URL is `CommitteeSearch.aspx` (the WebForms search page)
 * rather than the informational landing page, which has no `<table>`.
 * The fetch is a single plain GET (politeFetch); no form postback is
 * issued, so the seed page usually yields no committee rows and the run
 * is recorded as `unproductive`.
 *
 * Skeleton parses tabular HTML on the landing page (usually empty) and
 * falls through to the CSV path when the body looks like CSV.
 */

import type { AdapterContext } from '../../types';
import {
  createStateCfAdapter,
  type StateCfEventRow,
} from '../shared/base';
import {
  parseGenericCfCsv,
  parseGenericCfHtmlTable,
} from '../shared/html-parsers';
import { politeFetch } from '../../fetch-polite';

export const IL_STATE_FIPS = '17';
export const IL_STATE_ABBR = 'IL';
// Was politicalcommittee.aspx (info-only, no `<table>`).
// CommitteeSearch.aspx is the WebForms results-search page.
const DEFAULT_URL =
  'https://elections.il.gov/CampaignDisclosure/CommitteeSearch.aspx';

export type IlCfAdapterOptions = {
  sourceUrl?: string;
  electionYear?: number;
  reportingPeriod?: string;
  fetchImpl?: (ctx: AdapterContext) => Promise<{ rawBody: string }>;
};

export function parseIllinoisCf(
  body: string,
  opts: { sourceUrl?: string; reportingPeriod?: string } = {},
): StateCfEventRow[] {
  const sourceUrl = opts.sourceUrl ?? DEFAULT_URL;
  if (!body) return [];
  const first = body.trimStart().split('\n', 1)[0] ?? '';
  if (first.startsWith('<')) {
    return parseGenericCfHtmlTable(body, {
      state: IL_STATE_ABBR,
      sourceUrl,
      reportingPeriod: opts.reportingPeriod,
    });
  }
  return parseGenericCfCsv(body, {
    state: IL_STATE_ABBR,
    sourceUrl,
    reportingPeriod: opts.reportingPeriod,
  });
}

export function createIlCfAdapter(opts: IlCfAdapterOptions = {}) {
  const url = opts.sourceUrl ?? DEFAULT_URL;
  return createStateCfAdapter({
    stateFips: IL_STATE_FIPS,
    stateAbbr: IL_STATE_ABBR,
    sourceName: 'illinois-sbe-cf',
    sourceUrl: url,
    sourceType: 'sos_campaign_finance',
    license: 'state_open_records',
    tokenBucket: { rps: 0.5, burst: 2 },
    expectedMinRows: 0,
    electionYear: opts.electionYear,
    reportingPeriod: opts.reportingPeriod,
    fetch:
      opts.fetchImpl ??
      (async () => {
        // Single plain GET. The WebForms seed page carries the form shell
        // but no committee rows; caller-supplied CSV export URLs flow
        // through the CSV branch in `parseIllinoisCf`.
        const res = await politeFetch(url, {
          redirect: 'follow',
          headers: {
            Accept: 'text/html,application/xhtml+xml,text/csv,*/*;q=0.8',
          },
        });
        return { rawBody: await res.text(), resolvedUrl: res.url || url };
      }),
    parse: async (body) =>
      parseIllinoisCf(body, {
        sourceUrl: url,
        reportingPeriod: opts.reportingPeriod,
      }),
  });
}
