/**
 * Pennsylvania — Department of State Campaign Finance adapter.
 *
 * Portal: https://www.dos.pa.gov/VotingElections/CandidatesCommittees/CampaignFinance/
 *         https://www.campaignfinanceonline.pa.gov/
 * Format: HTML portal; bulk filings export to ZIP/CSV ("Full Campaign Finance
 *         Database"). Per-cycle URL convention requires discovery.
 *
 * Strategy
 *   - Fetch the landing page.
 *   - Parse any plain HTML tables present.
 *   - PA primary is 2026-05-19; off-cycle empty days marked `unproductive`.
 */

import type { AdapterContext } from '../../types';
import {
  createStateCfAdapter,
  fetchCfHtml,
  type StateCfEventRow,
} from '../shared/base';
import { parseGenericCfHtmlTable } from '../shared/html-parsers';

export const PA_STATE_FIPS = '42';
export const PA_STATE_ABBR = 'PA';
const DEFAULT_URL =
  'https://www.dos.pa.gov/VotingElections/CandidatesCommittees/CampaignFinance/Pages/default.aspx';

export type PaCfAdapterOptions = {
  sourceUrl?: string;
  electionYear?: number;
  reportingPeriod?: string;
  fetchImpl?: (ctx: AdapterContext) => Promise<{ rawBody: string }>;
};

export function parsePennsylvaniaCf(
  body: string,
  opts: { sourceUrl?: string; reportingPeriod?: string } = {},
): StateCfEventRow[] {
  return parseGenericCfHtmlTable(body, {
    state: PA_STATE_ABBR,
    sourceUrl: opts.sourceUrl ?? DEFAULT_URL,
    reportingPeriod: opts.reportingPeriod,
  });
}

export function createPaCfAdapter(opts: PaCfAdapterOptions = {}) {
  const url = opts.sourceUrl ?? DEFAULT_URL;
  return createStateCfAdapter({
    stateFips: PA_STATE_FIPS,
    stateAbbr: PA_STATE_ABBR,
    sourceName: 'pennsylvania-dos-cf',
    sourceUrl: url,
    sourceType: 'sos_campaign_finance',
    license: 'state_open_records',
    tokenBucket: { rps: 0.5, burst: 2 },
    expectedMinRows: 0,
    electionYear: opts.electionYear,
    reportingPeriod: opts.reportingPeriod,
    fetch: opts.fetchImpl ?? (async () => fetchCfHtml(url)),
    parse: async (body) =>
      parsePennsylvaniaCf(body, {
        sourceUrl: url,
        reportingPeriod: opts.reportingPeriod,
      }),
  });
}
