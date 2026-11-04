/**
 * New York — State Board of Elections Campaign Finance adapter.
 *
 * Portal: https://elections.ny.gov/campaign-finance
 *         https://publicreporting.elections.ny.gov/
 * Format: HTML portal + downloadable bulk CSV ("Filer/Filing data export").
 *         NYSBOE publishes a daily bulk CSV via the public reporting site,
 *         but file naming requires per-cycle discovery; landing-page parse is
 *         the safe default.
 *
 * Strategy
 *   - Fetch the landing page with a plain politeFetch. The host is
 *     fronted by Cloudflare, so a challenge response yields no rows.
 *   - Parse any plain HTML tables present.
 *   - NY primary is 2026-06-23; off-cycle empty days marked `unproductive`.
 *
 * 2026-04-26: NYSBOE migrated www.elections.ny.gov → elections.ny.gov and
 * replaced /CampaignFinance.html with the Drupal-style /campaign-finance.
 * The new host is fronted by Cloudflare and may return 403 to automated
 * requests; the adapter then records a run with no rows.
 */

import type { AdapterContext } from '../../types';
import {
  createStateCfAdapter,
  type StateCfEventRow,
} from '../shared/base';
import { parseGenericCfHtmlTable } from '../shared/html-parsers';
import { politeFetch } from '../../fetch-polite';

export const NY_STATE_FIPS = '36';
export const NY_STATE_ABBR = 'NY';
// 2026-04-26: URL changed from https://www.elections.ny.gov/CampaignFinance.html
// (now 301→403 via Cloudflare) to the new Drupal endpoint below.
const DEFAULT_URL = 'https://elections.ny.gov/campaign-finance';

export type NyCfAdapterOptions = {
  sourceUrl?: string;
  electionYear?: number;
  reportingPeriod?: string;
  fetchImpl?: (ctx: AdapterContext) => Promise<{ rawBody: string }>;
};

export function parseNewYorkCf(
  body: string,
  opts: { sourceUrl?: string; reportingPeriod?: string } = {},
): StateCfEventRow[] {
  return parseGenericCfHtmlTable(body, {
    state: NY_STATE_ABBR,
    sourceUrl: opts.sourceUrl ?? DEFAULT_URL,
    reportingPeriod: opts.reportingPeriod,
  });
}

export function createNyCfAdapter(opts: NyCfAdapterOptions = {}) {
  const url = opts.sourceUrl ?? DEFAULT_URL;
  return createStateCfAdapter({
    stateFips: NY_STATE_FIPS,
    stateAbbr: NY_STATE_ABBR,
    sourceName: 'new-york-sboe-cf',
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
        // Plain GET. A Cloudflare challenge body contains no `<table>`
        // and yields 0 rows (no_table).
        const res = await politeFetch(url, {
          redirect: 'follow',
          headers: { Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
        });
        return { rawBody: await res.text(), resolvedUrl: res.url || url };
      }),
    parse: async (body) =>
      parseNewYorkCf(body, {
        sourceUrl: url,
        reportingPeriod: opts.reportingPeriod,
      }),
  });
}
