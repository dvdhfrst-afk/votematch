/**
 * Washington Public Disclosure Commission (PDC) — campaign finance adapter.
 *
 * FIPS 53. Priority state for this wave: WA's PDC is the richest state CF
 * data pipe in the US — a proper Socrata-style JSON REST API at
 * data.wa.gov, keyed by per-dataset resource IDs.
 *
 * Datasets we pull (Socrata, all JSON, all public):
 *
 *   Contributions:     https://data.wa.gov/resource/kv7h-kjye.json
 *   Expenditures:      https://data.wa.gov/resource/tijg-9zyp.json
 *   Independent expend: https://data.wa.gov/resource/rsmk-hwzu.json (I/E only; wired as a
 *                       separate sourceName so cost accounting is per-dataset)
 *
 * Rate limits
 * -----------
 * PDC/Socrata policy (published): 1000 req/hour with an app token,
 * 100 req/hour without. Default is anon — set tokenBucket rps=0.25
 * burst=1 so we stay under the anon ceiling (900/hour worst case).
 * Wire PDC_APP_TOKEN via the `appToken` option when cutting over to
 * an authenticated account.
 *
 * Source row seeding
 * ------------------
 * data_sources has a row keyed source_type='ethics_commission' for
 * state_fips='53'. This adapter prefers the richer JSON endpoint over
 * the seed URL (pdc.wa.gov landing page); the seed URL is treated as a
 * user-facing link, and `sourceUrl` here is the data.wa.gov JSON URL.
 */

import type { AdapterContext } from '../../types';
import { politeFetch } from '../../fetch-polite';
import {
  createStateCfAdapter,
  parseIsoDateOrNull,
  parseMoneyOrNull,
  type StateCfFetchResult,
  type StateCfRow,
} from '../base';

export const WA_STATE_FIPS = '53';
export const WA_STATE_ABBR = 'WA';

/** Default Socrata endpoint (Contributions to Candidates and Political Committees). */
export const WA_CONTRIBUTIONS_URL =
  'https://data.wa.gov/resource/kv7h-kjye.json';
/** Default Socrata endpoint (Expenditures by Candidates and Political Committees). */
export const WA_EXPENDITURES_URL =
  'https://data.wa.gov/resource/tijg-9zyp.json';

// ---------------------------------------------------------------------------
// Parser — public for tests
// ---------------------------------------------------------------------------

/**
 * Socrata row shape for PDC contributions. Every field is optional
 * because the API happily returns partial rows after amendments.
 */
export type WaPdcJsonRow = {
  id?: string;
  // Committee / candidate identity
  filer_name?: string;
  filer_id?: string;
  office?: string;
  jurisdiction?: string;
  election_year?: string | number;
  // Counterparty (contribution)
  contributor_name?: string;
  contributor_employer?: string;
  contributor_occupation?: string;
  // Counterparty (expenditure)
  recipient_name?: string;
  description?: string;
  // Money
  amount?: string | number;
  cash_or_in_kind?: string;
  receipt_date?: string;
  expenditure_date?: string;
  // Provenance
  url?: string;
  report_number?: string;
};

export type WaParseOptions = {
  /** Direction — determines event_type mapping when the row is ambiguous. */
  eventType?: 'contribution' | 'expenditure' | 'independent_expenditure';
};

export function parseWaPdcJson(
  body: string,
  opts: WaParseOptions = {},
): StateCfRow[] {
  if (!body || body.length < 2) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const rows: StateCfRow[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const raw = parsed[i];
    if (!raw || typeof raw !== 'object') continue;
    const j = raw as WaPdcJsonRow;

    const isInKind =
      typeof j.cash_or_in_kind === 'string' &&
      j.cash_or_in_kind.toLowerCase().includes('kind');

    const opt = opts.eventType;
    const event_type: StateCfRow['event_type'] = isInKind
      ? 'in_kind'
      : opt === 'expenditure' || opt === 'independent_expenditure'
      ? 'expenditure'
      : 'contribution';

    const filing_url =
      typeof j.url === 'string' && j.url.length > 0
        ? j.url
        : opt === 'expenditure' || opt === 'independent_expenditure'
        ? WA_EXPENDITURES_URL
        : WA_CONTRIBUTIONS_URL;

    const counterparty =
      j.contributor_name ??
      j.recipient_name ??
      j.description ??
      null;

    const event_date = parseIsoDateOrNull(
      j.receipt_date ?? j.expenditure_date ?? null,
    );

    const amount = parseMoneyOrNull(j.amount ?? null);

    rows.push({
      state: WA_STATE_ABBR,
      candidate_name: normalizeOrNull(j.filer_name),
      candidate_office: normalizeOrNull(j.office),
      committee_name: normalizeOrNull(j.filer_name),
      event_type,
      amount,
      event_date,
      counterparty: normalizeOrNull(counterparty),
      filing_url,
      // PDC is an authoritative government primary source; treat
      // machine-shaped rows as high confidence.
      confidence_score: 0.95,
      source_row_id: j.id ?? j.report_number ?? `wa-pdc-${i}`,
    });
  }
  return rows;
}

function normalizeOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

export type WaCfAdapterOptions = {
  /** Override endpoint URL (tests / dataset swap). */
  sourceUrl?: string;
  /** PDC / Socrata app token. Lifts anon 100/hr limit to 1000/hr. */
  appToken?: string;
  /** Dataset flavor — contributions (default), expenditures, or I/E. */
  dataset?: 'contributions' | 'expenditures' | 'independent_expenditures';
  cycleYear?: number;
  /** Socrata $where clause — narrows the set; passed as a query param. */
  where?: string;
  /**
   * Socrata $order clause. Default: `receipt_date DESC` (contributions) /
   * `expenditure_date DESC` (expenditures, I/E). Without this, Socrata
   * returns rows in arbitrary insertion order — a fixed `$limit=5000`
   * sweep produces the SAME 5000 rows on every run, so dedup blocks all
   * inserts after the first. Ordering by date descending sweeps the most
   * recent filings each run, which is also what voters want surfaced.
   */
  order?: string;
  /** Max rows per fetch. Default 5000 (Socrata hard max 50000). */
  limit?: number;
  fetchImpl?: (ctx: AdapterContext) => Promise<StateCfFetchResult>;
};

export function createWaCfAdapter(opts: WaCfAdapterOptions = {}) {
  const dataset = opts.dataset ?? 'contributions';
  const defaultUrl =
    dataset === 'expenditures' || dataset === 'independent_expenditures'
      ? WA_EXPENDITURES_URL
      : WA_CONTRIBUTIONS_URL;
  const url = opts.sourceUrl ?? defaultUrl;
  const limit = opts.limit ?? 5000;
  const sourceName =
    dataset === 'expenditures'
      ? 'wa-pdc-expenditures'
      : dataset === 'independent_expenditures'
      ? 'wa-pdc-independent-expenditures'
      : 'wa-pdc-contributions';

  // Council 2026-04-26 data-quality fix: previously the runner stored the
  // full Socrata URL (with $limit / $where query) on data_sources.url while
  // the parser put the BARE URL on every state_cf_events.filing_url. The
  // mismatch made URL-based provenance reconstruction impossible. Provenance
  // now flows through data_source_id (FK) regardless, but to keep the
  // human-readable URL consistent across the two tables we strip the query
  // string on the data_sources side too — both rows now reference the same
  // bare canonical URL.
  const adapter = createStateCfAdapter({
    stateFips: WA_STATE_FIPS,
    stateAbbr: WA_STATE_ABBR,
    sourceName,
    sourceUrl: url,
    sourceType: 'ethics_commission',
    license: 'public_domain',
    // Anon: 100/hr -> 0.025 rps. With app token: 1000/hr -> 0.25 rps.
    tokenBucket: opts.appToken
      ? { rps: 0.25, burst: 2 }
      : { rps: 0.025, burst: 1 },
    expectedMinRows: 0,
    cycleYear: opts.cycleYear,
    fetch:
      opts.fetchImpl ??
      (async () => {
        // Default ordering — newest filings first. Without $order Socrata
        // returns the SAME N rows on every run, so the dedupe upsert blocks
        // every insert after the first one. Ordering by date descending
        // gives the runner a chance to surface fresh contributions/
        // expenditures (which is also what voters care about most).
        const defaultOrder =
          dataset === 'expenditures' || dataset === 'independent_expenditures'
            ? 'expenditure_date DESC'
            : 'receipt_date DESC';
        const order = opts.order ?? defaultOrder;
        const qs = new URLSearchParams();
        qs.set('$limit', String(limit));
        qs.set('$order', order);
        if (opts.where) qs.set('$where', opts.where);
        const full = `${url}?${qs.toString()}`;
        const headers: Record<string, string> = { Accept: 'application/json' };
        if (opts.appToken) headers['X-App-Token'] = opts.appToken;
        const res = await politeFetch(full, { headers });
        if (!res.ok) {
          throw new Error(`wa-pdc: HTTP ${res.status} for ${full}`);
        }
        return {
          rawBody: await res.text(),
          // Use the BARE canonical URL (no $limit / $where / $order) so
          // data_sources.url matches state_cf_events.filing_url. The runner
          // records meta with the query parameters separately; the URL
          // itself stays clean.
          resolvedUrl: url,
          meta: {
            dataset,
            app_token_set: Boolean(opts.appToken),
            limit,
            order,
            where: opts.where ?? null,
            fetched_query_url: full,
          },
        };
      }),
    parse: async (body) =>
      parseWaPdcJson(body, {
        eventType:
          dataset === 'independent_expenditures'
            ? 'independent_expenditure'
            : dataset === 'contributions'
            ? 'contribution'
            : 'expenditure',
      }),
  });
  adapter.costService = 'other';
  return adapter;
}
