/**
 * Alaska APOC — campaign finance adapter.
 *
 * FIPS 02. Seed URL:
 *   https://aws.state.ak.us/apocreports/campaign/
 *
 * Alaska's CF regulator is the Public Offices Commission (APOC), not
 * the SoS. Reports lives at aws.state.ak.us/apocreports, with separate
 * "By Office / By Name / Transactions" tabs. Each tab returns an HTML
 * table; APOC also offers per-report XLSX downloads.
 *
 * TODO: add a Transactions-tab parser (richer per-row data) once URL
 * paging params are pinned.
 */

import {
  createHtmlFilingTableCfAdapter,
  parseFilingTableHtml,
} from '../shared/html-filing-table';
import type { AdapterContext } from '../../types';
import type { StateCfFetchResult, StateCfRow } from '../base';

export const AK_STATE_FIPS = '02';
export const AK_STATE_ABBR = 'AK';

export const AK_APOC_URL = 'https://aws.state.ak.us/apocreports/campaign/';
export const AK_APOC_BYNAME_URL =
  'https://aws.state.ak.us/apocreports/Campaign/CDCommSearch.aspx';

export function parseAlaskaApocHtml(body: string): StateCfRow[] {
  return parseFilingTableHtml(body, {
    stateFips: AK_STATE_FIPS,
    stateAbbr: AK_STATE_ABBR,
    sourceName: 'ak-apoc',
    sourceUrl: AK_APOC_URL,
    sourceType: 'ethics_commission',
  });
}

export type AkCfAdapterOptions = {
  sourceUrl?: string;
  cycleYear?: number;
  fetchImpl?: (ctx: AdapterContext) => Promise<StateCfFetchResult>;
};

export function createAkCfAdapter(opts: AkCfAdapterOptions = {}) {
  return createHtmlFilingTableCfAdapter({
    stateFips: AK_STATE_FIPS,
    stateAbbr: AK_STATE_ABBR,
    sourceName: 'ak-apoc',
    sourceUrl: opts.sourceUrl ?? AK_APOC_URL,
    sourceType: 'ethics_commission',
    license: 'state_open_records',
    tokenBucket: { rps: 0.5, burst: 2 },
    cycleYear: opts.cycleYear,
    sourceUrlOverride: opts.sourceUrl,
    fetchImpl: opts.fetchImpl,
  });
}
