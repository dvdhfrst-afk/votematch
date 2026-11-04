/**
 * Utah disclosures.utah.gov — campaign finance adapter.
 *
 * FIPS 49. Seed URL: https://disclosures.utah.gov/
 *
 * Source formats
 * --------------
 * disclosures.utah.gov exposes:
 *   - Public search HTML: /search/publicsearch?type=pcc
 *   - CSV "download filing" per filing ID (linked from each filing detail page).
 *
 * The HTML search page returns results in a <table class="table"> with
 * columns roughly: Entity / Filer / Report Type / Reporting Period /
 * Date Filed / Amount. Each row links to a per-filing detail page where
 * individual transactions + CSV downloads live.
 *
 * This adapter parses the landing HTML into one row per FILING (not one
 * per transaction) — a filing is treated as event_type='filing' with
 * amount=summary_total. Per-transaction ingestion is a separate pass
 * that follows the CSV links; see inscribe-pass-style scripts for that
 * shape (not part of this adapter).
 *
 * Home state — fidelity matters. Utah is our demo state.
 */

import { load as loadHtml } from 'cheerio';
import type { AdapterContext } from '../../types';
import { politeFetch } from '../../fetch-polite';
import {
  createStateCfAdapter,
  parseIsoDateOrNull,
  parseMoneyOrNull,
  type StateCfFetchResult,
  type StateCfRow,
} from '../base';

export const UT_STATE_FIPS = '49';
export const UT_STATE_ABBR = 'UT';

export const UT_DISCLOSURES_URL = 'https://disclosures.utah.gov/';
export const UT_DISCLOSURES_SEARCH_URL =
  'https://disclosures.utah.gov/search/publicsearch?type=pcc';

// ---------------------------------------------------------------------------
// HTML parser
// ---------------------------------------------------------------------------

export function parseUtahDisclosuresHtml(body: string): StateCfRow[] {
  if (!body || body.length < 64) return [];
  const $ = loadHtml(body);
  const rows: StateCfRow[] = [];

  $('table').each((ti, tableEl) => {
    const $table = $(tableEl);
    const headerCells = $table
      .find('tr')
      .first()
      .find('th,td')
      .map((_i, el) => $(el).text().trim().toLowerCase())
      .get();
    if (headerCells.length === 0) return;
    const filerCol = findCol(headerCells, ['entity', 'filer', 'committee', 'candidate']);
    const reportCol = findCol(headerCells, ['report type', 'report', 'type']);
    const dateCol = findCol(headerCells, ['date filed', 'filed', 'period end', 'date']);
    const amountCol = findCol(headerCells, ['amount', 'total', 'contributions']);
    if (filerCol < 0) return;

    $table.find('tr').each((ri, trEl) => {
      if (ri === 0) return;
      const cells = $(trEl)
        .find('td')
        .map((_i, el) => $(el).text().trim())
        .get();
      if (cells.length === 0) return;
      const filer = cells[filerCol];
      if (!filer) return;

      const $link = $(trEl).find('a[href]').first();
      const href = $link.attr('href') ?? '';
      const filing_url = href.startsWith('http')
        ? href
        : href
        ? new URL(href, UT_DISCLOSURES_URL).toString()
        : UT_DISCLOSURES_SEARCH_URL;

      rows.push({
        state: UT_STATE_ABBR,
        candidate_name: filer,
        candidate_office: null,
        committee_name: filer,
        event_type: 'filing',
        amount: amountCol >= 0 ? parseMoneyOrNull(cells[amountCol]) : null,
        event_date: dateCol >= 0 ? parseIsoDateOrNull(cells[dateCol]) : null,
        counterparty: reportCol >= 0 ? cells[reportCol] ?? null : null,
        filing_url,
        confidence_score: 0.85,
        source_row_id: `ut-t${ti}-r${ri}`,
      });
    });
  });

  return rows;
}

function findCol(header: string[], needles: string[]): number {
  for (let i = 0; i < header.length; i++) {
    for (const n of needles) {
      if (header[i]!.includes(n)) return i;
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

export type UtCfAdapterOptions = {
  sourceUrl?: string;
  cycleYear?: number;
  fetchImpl?: (ctx: AdapterContext) => Promise<StateCfFetchResult>;
};

export function createUtCfAdapter(opts: UtCfAdapterOptions = {}) {
  const url = opts.sourceUrl ?? UT_DISCLOSURES_SEARCH_URL;
  const adapter = createStateCfAdapter({
    stateFips: UT_STATE_FIPS,
    stateAbbr: UT_STATE_ABBR,
    sourceName: 'ut-disclosures-cf',
    sourceUrl: url,
    sourceType: 'sos_campaign_finance',
    license: 'state_open_records',
    tokenBucket: { rps: 0.5, burst: 2 },
    expectedMinRows: 0,
    cycleYear: opts.cycleYear,
    fetch:
      opts.fetchImpl ??
      (async () => {
        const res = await politeFetch(url, {
          headers: {
            Accept: 'text/html, application/xhtml+xml',
          },
        });
        if (!res.ok) {
          throw new Error(`ut-disclosures: HTTP ${res.status} for ${url}`);
        }
        return { rawBody: await res.text(), resolvedUrl: res.url ?? url };
      }),
    parse: async (body) => parseUtahDisclosuresHtml(body),
  });
  adapter.costService = 'other';
  return adapter;
}
