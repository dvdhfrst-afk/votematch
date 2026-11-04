/**
 * Compat shim for F1c's state-cf adapters.
 *
 * F1c (Mountain/Pacific region) imports `createHtmlFilingTableCfAdapter`
 * and `parseFilingTableHtml` from this file. F1a/F1b actually put those
 * helpers in `html-parsers.ts` under different names. This shim bridges
 * the naming gap without rewriting 10 state adapters.
 *
 * Semantic mapping:
 *   parseFilingTableHtml(body, {stateFips, stateAbbr, sourceName, sourceUrl, sourceType})
 *     → parseGenericCfHtmlTable(body, {state, sourceUrl})
 *
 *   createHtmlFilingTableCfAdapter({stateFips, stateAbbr, sourceName, sourceUrl,
 *                                    sourceType, license, tokenBucket, cycleYear,
 *                                    sourceUrlOverride, fetchImpl})
 *     → createStateCfAdapter with default HTML fetch + parseGenericCfHtmlTable
 */

import type { AdapterContext, SourceAdapter } from '../../types';
import {
  createStateCfAdapter,
  fetchCfHtml,
  type CfFetchResult,
  type StateCfAdapterOptions,
  type StateCfEventRow,
} from './base';
import { parseGenericCfHtmlTable } from './html-parsers';

export type HtmlFilingTableParseOptions = {
  stateFips: string;
  stateAbbr: string;
  sourceName: string;
  sourceUrl: string;
  sourceType: StateCfAdapterOptions['sourceType'];
  reportingPeriod?: string;
};

export function parseFilingTableHtml(
  body: string,
  options: HtmlFilingTableParseOptions,
): StateCfEventRow[] {
  return parseGenericCfHtmlTable(body, {
    state: options.stateAbbr,
    sourceUrl: options.sourceUrl,
    reportingPeriod: options.reportingPeriod,
    defaultEventType: 'filing',
  });
}

export type HtmlFilingTableAdapterOptions = {
  stateFips: string;
  stateAbbr: string;
  sourceName: string;
  sourceUrl: string;
  sourceType: StateCfAdapterOptions['sourceType'];
  license: StateCfAdapterOptions['license'];
  tokenBucket?: StateCfAdapterOptions['tokenBucket'];
  cycleYear?: number;
  expectedMinRows?: number;
  sourceUrlOverride?: string;
  fetchImpl?: (ctx: AdapterContext) => Promise<CfFetchResult>;
  /**
   * State .gov sites with stale TLS cert chains (e.g. CO TRACER) — passed
   * through to fetchCfHtml. Use sparingly; never for arbitrary endpoints.
   */
  allowSelfSignedCert?: boolean;
};

export function createHtmlFilingTableCfAdapter(
  opts: HtmlFilingTableAdapterOptions,
): SourceAdapter<StateCfEventRow> {
  const effectiveUrl = opts.sourceUrlOverride ?? opts.sourceUrl;
  return createStateCfAdapter({
    stateFips: opts.stateFips,
    stateAbbr: opts.stateAbbr,
    sourceName: opts.sourceName,
    sourceUrl: effectiveUrl,
    sourceType: opts.sourceType,
    license: opts.license,
    tokenBucket: opts.tokenBucket ?? { rps: 0.5, burst: 2 },
    expectedMinRows: opts.expectedMinRows ?? 0,
    electionYear: opts.cycleYear,
    fetch:
      opts.fetchImpl ??
      (async () =>
        fetchCfHtml(effectiveUrl, {
          allowSelfSignedCert: opts.allowSelfSignedCert,
        })),
    parse: async (rawBody) =>
      parseFilingTableHtml(rawBody, {
        stateFips: opts.stateFips,
        stateAbbr: opts.stateAbbr,
        sourceName: opts.sourceName,
        sourceUrl: effectiveUrl,
        sourceType: opts.sourceType,
      }),
  });
}
