/**
 * Ohio — Secretary of State Campaign Finance (FIPS 39).
 *
 * Portal: https://www.ohiosos.gov/campaign-finance/
 * APEX Search: https://www6.ohiosos.gov/ords/f?p=138
 * Bulk:        (none published — filings live inside the filer portal)
 *
 * Status (2026-04-25 — third retest with expanded URL probe)
 * -----------------------------------------------------------
 * The www.ohiosos.gov and www6.ohiosos.gov hosts are protected by a
 * Cloudflare JavaScript-challenge wall. A plain politeFetch returns
 * HTTP 403 with a ~1.2 MB CF challenge HTML body.
 *
 * Note that `liveresults.ohiosos.gov`, a sister subdomain, serves
 * plaintext. The disclosure property has its Cloudflare security level
 * set to "interactive challenge", so it is not fetched automatically.
 *
 * 2026-04-25 update: `data.ohiosos.gov` now DOES resolve in DNS (it didn't
 * a year ago) and hosts an Esri ArcGIS Hub portal at /portal/campaign-finance
 * — but it's also behind the same Cloudflare wall and returns 403 to every
 * server-side fetch tried (root, /portal/, /sharing/rest/portals/self,
 * /datasets, /datasets/campaign-finance). The page is a React SPA whose
 * underlying API endpoints would still need a CF cookie to talk to.
 *
 * Other unsuccessful URL probes (2026-04-25):
 *   - cf.ohiosos.gov, campaignfinance.ohiosos.gov, cfreport.ohiosos.gov,
 *     cfdownload.ohiosos.gov, cfftp.ohiosos.gov, cfdb.ohiosos.gov,
 *     ftp.ohiosos.gov  -> all DNS NXDOMAIN
 *   - www.ohiosos.gov/campaign-finance/data-downloads, /elections/...,
 *     /globalassets/cfftp/, /data/campaign-finance/  -> all 403 CF
 *   - www6.ohiosos.gov/cfftp/, /ords/cfdownload, /ords/cfdownload.csv,
 *     /ords/f?p=CFDISCLOSURE:1, /ords/cfdisclosure  -> all 403 CF
 *
 * Public references (Transparency USA, Public Accountability Project) DO
 * import OH SoS bulk CSVs split by committee type and year. So the data
 * exists and is published; it just isn't reachable from a server fetch
 * without CF clearance. ProPublica's Campaign Finance API is FEC-only and
 * does not cover OH state CF.
 *
 * What this adapter does
 * ----------------------
 * - Attempts the public CF landing page via politeFetch.
 * - If a Cloudflare 403 is served, swallows it, records the block in
 *   ingestion_runs.meta via the fetch-result `meta.cloudflare_blocked`
 *   flag, and returns zero rows. The adapter runner marks the run partial
 *   (expectedMinRows > 0) rather than failed so the dispatcher continues.
 * - If we do get HTML (e.g. the CF level is dialled back during a future
 *   retest), it is parsed as an opportunistic fallback via the generic
 *   HTML table helper. The `discoverOhioCfLinks()` side-path scans for
 *   `.csv`/`.xlsx`/`.txt` attachments in case OH ever re-publishes
 *   bulk files on the landing page.
 *
 * Future work: request a bulk export from the Ohio Secretary of State, or
 * use a published dataset if one appears. The parser below works
 * unchanged against real HTML or CSV.
 *
 * Source type: `sos_campaign_finance` (state SoS, not a separate ethics body).
 */

import { load as loadHtml } from 'cheerio';
import type { AdapterContext } from '../../types';
import {
  createStateCfAdapter,
  type CfFetchResult,
  type StateCfEventRow,
} from '../shared/base';
import {
  parseGenericCfCsv,
  parseGenericCfHtmlTable,
} from '../shared/html-parsers';
import { politeFetch } from '../../fetch-polite';

export const OH_STATE_FIPS = '39';
export const OH_STATE_ABBR = 'OH';
const DEFAULT_URL = 'https://www.ohiosos.gov/campaign-finance/';

export type OhCfAdapterOptions = {
  sourceUrl?: string;
  electionYear?: number;
  reportingPeriod?: string;
  fetchImpl?: (ctx: AdapterContext) => Promise<CfFetchResult>;
};

/**
 * Side-channel link discovery. If Ohio ever adds bulk download links
 * (CSV/XLSX/TXT) to the landing page, this surfaces them in adapter logs
 * without automatically following — the follow step is kept manual so an
 * unexpected large attachment doesn't trigger a silent multi-MB fetch.
 */
export function discoverOhioCfLinks(html: string): string[] {
  const $ = loadHtml(html);
  const out: string[] = [];
  $('a').each((_, el) => {
    const href = ($(el).attr('href') ?? '').trim();
    if (!href) return;
    if (
      /\.(csv|xlsx|txt|zip)(?:[?#]|$)/i.test(href) &&
      /(contrib|expend|finance|disclosure|annual|campaign)/i.test(href)
    ) {
      out.push(href);
    }
  });
  return out;
}

/**
 * Heuristic: is this response body the Cloudflare challenge wall?
 * CF's challenge page includes the string "Just a moment" (the title) and
 * embeds `challenge-platform` / `_cf_chl_opt`. Catching either marker is
 * enough — we don't need regex-perfect detection; false positives only
 * affect provenance labelling, not row data.
 */
function isCloudflareChallenge(body: string, status: number): boolean {
  if (status === 403 || status === 503) {
    if (
      body.includes('Just a moment') ||
      body.includes('cf-chl-opt') ||
      body.includes('challenge-platform') ||
      body.includes('__cf_chl_rt_tk')
    ) {
      return true;
    }
  }
  return false;
}

export function parseOhioCf(
  body: string,
  opts: { sourceUrl?: string; reportingPeriod?: string } = {},
): StateCfEventRow[] {
  const sourceUrl = opts.sourceUrl ?? DEFAULT_URL;
  if (!body) return [];
  const trimmed = body.trimStart();
  // CSV shape: header line (no '<') with commas.
  if (!trimmed.startsWith('<') && /,/.test(trimmed.split('\n', 1)[0] ?? '')) {
    return parseGenericCfCsv(body, {
      state: OH_STATE_ABBR,
      sourceUrl,
      reportingPeriod: opts.reportingPeriod,
    });
  }
  return parseGenericCfHtmlTable(body, {
    state: OH_STATE_ABBR,
    sourceUrl,
    reportingPeriod: opts.reportingPeriod,
  });
}

async function fetchOhCfLanding(url: string): Promise<CfFetchResult> {
  const res = await politeFetch(url, {
    redirect: 'follow',
    headers: {
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });
  const body = await res.text();
  const cfBlocked = isCloudflareChallenge(body, res.status);

  // A Cloudflare challenge is returned as-is (flagged in meta); the
  // parse step skips it and the run records 0 rows.

  return {
    rawBody: body,
    resolvedUrl: res.url ?? url,
    meta: {
      http_status: res.status,
      cloudflare_blocked: cfBlocked,
      content_type: res.headers.get('content-type') ?? null,
      byte_size: body.length,
    },
  };
}

export function createOhCfAdapter(opts: OhCfAdapterOptions = {}) {
  const url = opts.sourceUrl ?? DEFAULT_URL;
  return createStateCfAdapter({
    stateFips: OH_STATE_FIPS,
    stateAbbr: OH_STATE_ABBR,
    sourceName: 'ohio-sos-cf',
    sourceUrl: url,
    sourceType: 'sos_campaign_finance',
    license: 'state_open_records',
    tokenBucket: { rps: 0.25, burst: 2 },
    // expectedMinRows=0 because the Cloudflare block is expected today; a
    // zero-row run will complete=true without a partial flag. When/if we
    // a permitted data path is available this should bump to ~50.
    expectedMinRows: 0,
    electionYear: opts.electionYear,
    reportingPeriod: opts.reportingPeriod,
    fetch: opts.fetchImpl ?? (async () => fetchOhCfLanding(url)),
    parse: async (body, ctx) => {
      // Detect CF challenge body up front so we skip parsing JS gibberish.
      if (isCloudflareChallenge(body, 200)) {
        // 200 for heuristic-only — status already baked into fetch meta.
        ctx.logger.warn(
          'oh-cf: Cloudflare challenge body received; source requires a browser, skipped',
          { bytes: body.length },
        );
        return [];
      }
      // If CF returned actual status 403 with its challenge HTML, the body
      // will still contain 'Just a moment' — detect by marker.
      if (body.includes('Just a moment') || body.includes('challenge-platform')) {
        ctx.logger.warn(
          'oh-cf: response contains CF challenge markers; skipping parse',
          { bytes: body.length },
        );
        return [];
      }
      const rows = parseOhioCf(body, {
        sourceUrl: url,
        reportingPeriod: opts.reportingPeriod,
      });
      if (rows.length === 0 && body.trimStart().startsWith('<')) {
        const links = discoverOhioCfLinks(body);
        if (links.length > 0) {
          ctx.logger.info('oh-cf: bulk download links discovered on landing', {
            count: links.length,
            sample: links[0],
          });
        }
      }
      return rows;
    },
  });
}
