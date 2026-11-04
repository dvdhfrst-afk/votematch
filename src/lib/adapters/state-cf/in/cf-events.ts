/**
 * Indiana — Campaign Finance Authority (CFA) / Election Division (FIPS 18).
 *
 * Portal: https://campaignfinance.in.gov/PublicSite/
 * Wire format: annual bulk CSV zip downloads, one per year 2000..current.
 *
 * Discovery (2026-04-24)
 * ----------------------
 * The ASP.NET search UI at `SearchPages/*.aspx` is __VIEWSTATE+__EVENTVALIDATION
 * gated and JS-renders result grids — plain politeFetch returns the search form
 * HTML with empty grids. There is a Playwright-based enricher at
 * `scripts/enrich-pass4-in-cfa.ts` that drives the search form for per-candidate
 * lookups (used for contact_email backfill), but that pattern is too heavyweight
 * for a routine adapter run.
 *
 * The landing-page menu links to "Download Data" at
 * `/PublicSite/Reporting/DataDownload.aspx`, which serves a static HTML table
 * of annual bulk zips. Each year has two files:
 *
 *   - {year}_ContributionData.csv.zip   (contributions: filer → committee)
 *   - {year}_ExpenditureData.csv.zip    (expenditures: committee → vendor)
 *
 * Each zip contains a single CSV. Schema (web-verified 2026-04-24 against
 * 2026_ContributionData.csv):
 *
 *   FileNumber,CommitteeType,Committee,CandidateName,ContributorType,
 *   Name,Address,City,State,Zip,Occupation,Type,Description,Amount,
 *   ContributionDate,Received_By,Amended
 *
 * Expenditures use the same shape but with Payee/ExpenditureDate instead of
 * Name/ContributionDate.
 *
 * The Playwright scraper at `scripts/enrich-pass4-in-cfa.ts` remains the fallback
 * for individual candidate lookups (treasurer email, committee registration detail).
 * The adapter does NOT invoke it — bulk CSV is the production path.
 *
 * Rate limiting: 0.25 rps / burst 2. IN CFA is a small ASP.NET host; we don't
 * want to hammer it. The zips are ~1 MB each so one fetch per year is fine.
 *
 * Source type
 * -----------
 * Per the task spec, IN CFA is classified as `ethics_commission` (not
 * `sos_campaign_finance`) — it's run by the Election Division as an
 * independent agency, not as part of the SoS web portal.
 */

import AdmZip from 'adm-zip';
import type { AdapterContext } from '../../types';
import {
  createStateCfAdapter,
  type CfEventType,
  type CfFetchResult,
  type StateCfEventRow,
} from '../shared/base';
import { politeFetch } from '../../fetch-polite';

export const IN_STATE_FIPS = '18';
export const IN_STATE_ABBR = 'IN';

const DATA_DOWNLOAD_PAGE =
  'https://campaignfinance.in.gov/PublicSite/Reporting/DataDownload.aspx';

/** Build the bulk CSV zip URL for a given year + dataset. */
function bulkZipUrl(
  year: number,
  dataset: 'Contribution' | 'Expenditure',
): string {
  // The DataDownload.aspx HTML uses a literal backslash in the href — which
  // the server happily serves with a forward slash too. Use forward slash so
  // the URL passes WHATWG URL parsing in Node fetch.
  return `https://campaignfinance.in.gov/PublicSite/Docs/BulkDataDownloads/${year}_${dataset}Data.csv.zip`;
}

export type InCfAdapterOptions = {
  /** Override the default source URL (primarily for tests). */
  sourceUrl?: string;
  /**
   * Year to pull. Defaults to the current UTC year. IN CFA publishes a
   * fresh zip every night during active cycles; one adapter run = one year.
   */
  electionYear?: number;
  /**
   * Which dataset to pull. IN splits contributions and expenditures into
   * two zips with different column sets. Default: contributions (higher-
   * volume and what we care about for voter guidance).
   */
  dataset?: 'Contribution' | 'Expenditure';
  reportingPeriod?: string;
  /** Optional: override the fetch step (used by tests + the adapter runner). */
  fetchImpl?: (ctx: AdapterContext) => Promise<CfFetchResult>;
  /**
   * Cap parsed rows at this many. The 2026 file is ~32K rows; DB inserts
   * batch at 500 in base.ts, so uncapped will run ~64 roundtrips. Leave
   * undefined in production, set in tests to keep runtime bounded.
   */
  maxRows?: number;
};

// ---------------------------------------------------------------------------
// IN-specific CSV parser
// ---------------------------------------------------------------------------
//
// We cannot use parseGenericCfCsv directly because its fuzzy header matcher
// picks the FIRST column whose name contains any of /filer|candidate|
// committee|name/ — against IN's schema that matches `CommitteeType` before
// `Committee` or `CandidateName`, producing junk rows where filer_name is
// literally the string "Regular Party". IN's columns are stable (same shape
// every year since 2000), so a schema-aware parser is the right call.

type InCsvCols = {
  fileNumber?: number;
  committeeType?: number;
  committee?: number;
  candidateName?: number;
  contributorType?: number;
  name?: number;          // counterparty (contributor or payee)
  payee?: number;         // expenditure-file alias for `name`
  address?: number;
  city?: number;
  state?: number;
  zip?: number;
  occupation?: number;
  type?: number;          // contribution/expenditure subtype ("Direct", etc.)
  description?: number;
  amount?: number;
  contributionDate?: number;
  expenditureDate?: number;
  receivedBy?: number;
  amended?: number;
};

/** Map IN's exact header names -> field index (case-insensitive). */
function indexInColumns(headers: string[]): InCsvCols {
  const cols: InCsvCols = {};
  headers.forEach((raw, i) => {
    const h = raw.toLowerCase().replace(/[^a-z0-9]/g, '');
    switch (h) {
      case 'filenumber':        cols.fileNumber = i;       break;
      case 'committeetype':     cols.committeeType = i;    break;
      case 'committee':         cols.committee = i;        break;
      case 'candidatename':     cols.candidateName = i;    break;
      case 'contributortype':   cols.contributorType = i;  break;
      case 'name':              cols.name = i;             break;
      case 'payee':             cols.payee = i;            break;
      case 'address':           cols.address = i;          break;
      case 'city':              cols.city = i;             break;
      case 'state':             cols.state = i;            break;
      case 'zip':               cols.zip = i;              break;
      case 'occupation':        cols.occupation = i;       break;
      case 'type':              cols.type = i;             break;
      case 'description':       cols.description = i;      break;
      case 'amount':            cols.amount = i;           break;
      case 'contributiondate':  cols.contributionDate = i; break;
      case 'expendituredate':   cols.expenditureDate = i;  break;
      case 'receivedby':        cols.receivedBy = i;       break;
      case 'amended':           cols.amended = i;          break;
      default: break;
    }
  });
  return cols;
}

/** Minimal RFC-4180-ish CSV splitter — same algorithm as shared helpers. */
function splitInCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 1; }
      else if (ch === '"') inQuote = false;
      else cur += ch;
    } else if (ch === '"') inQuote = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function parseInAmount(s: string | undefined): number | null {
  if (!s) return null;
  const cleaned = s.replace(/[$,\s]/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * IN uses `2026-03-19 00:00:00` for dates. Also accept the rare `MM/DD/YYYY`
 * variant in case the schema flips.
 */
function parseInDate(s: string | undefined): string | null {
  if (!s) return null;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s.trim());
  if (iso) {
    const [, y, m, d] = iso;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  const us = /^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})/.exec(s.trim());
  if (us) {
    const [, m, d, yRaw] = us;
    const y = yRaw.length === 2 ? `20${yRaw}` : yRaw;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  return null;
}

/** Parse an IN CSV body. Handles both Contribution and Expenditure shapes. */
export function parseInCsv(
  body: string,
  opts: {
    sourceUrl: string;
    reportingPeriod?: string;
    dataset?: 'Contribution' | 'Expenditure';
  },
): StateCfEventRow[] {
  const lines = body.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) return [];
  const headers = splitInCsvLine(lines[0]);
  const cols = indexInColumns(headers);
  const nowIso = new Date().toISOString();
  const out: StateCfEventRow[] = [];

  const eventType: CfEventType =
    opts.dataset === 'Expenditure' ? 'expenditure' : 'contribution';

  for (let i = 1; i < lines.length; i += 1) {
    const cells = splitInCsvLine(lines[i]);
    if (cells.length === 0) continue;

    const committee = cols.committee !== undefined ? cells[cols.committee] : '';
    const candidateName =
      cols.candidateName !== undefined ? cells[cols.candidateName] : '';
    const counterparty =
      (cols.name !== undefined && cells[cols.name]) ||
      (cols.payee !== undefined && cells[cols.payee]) ||
      '';
    const amountRaw = cols.amount !== undefined ? cells[cols.amount] : undefined;
    const dateRaw =
      (cols.contributionDate !== undefined && cells[cols.contributionDate]) ||
      (cols.expenditureDate !== undefined && cells[cols.expenditureDate]) ||
      undefined;

    // Skip rows with neither a candidate nor a committee — can't be retained.
    if (!candidateName?.trim() && !committee?.trim()) continue;

    const eventDate = parseInDate(dateRaw);

    out.push({
      state: IN_STATE_ABBR,
      event_type: eventType,
      // filer_name is what the retention system surfaces. Prefer candidate
      // when present (most contributions target a named candidate); fall
      // back to committee (party committees, PAC-to-PAC, etc.).
      filer_name: candidateName?.trim() || committee?.trim() || undefined,
      candidate_name: candidateName?.trim() || null,
      candidate_office: null,    // IN bulk CSV doesn't carry office; lookup via candidate search if needed.
      committee_name: committee?.trim() || null,
      amount: parseInAmount(amountRaw),
      event_date: eventDate,
      reported_at: eventDate ? `${eventDate}T00:00:00Z` : nowIso,
      counterparty: counterparty?.trim() || null,
      source_url: opts.sourceUrl,
      raw_data: {
        row_index: i,
        headers,
        cells,
        reporting_period: opts.reportingPeriod ?? null,
        dataset: opts.dataset ?? 'Contribution',
        in_file_number: cols.fileNumber !== undefined ? cells[cols.fileNumber] : null,
        in_committee_type:
          cols.committeeType !== undefined ? cells[cols.committeeType] : null,
        in_contributor_type:
          cols.contributorType !== undefined ? cells[cols.contributorType] : null,
        in_sub_type: cols.type !== undefined ? cells[cols.type] : null,
        in_description:
          cols.description !== undefined ? cells[cols.description] : null,
        in_counterparty_city: cols.city !== undefined ? cells[cols.city] : null,
        in_counterparty_state: cols.state !== undefined ? cells[cols.state] : null,
        in_amended: cols.amended !== undefined ? cells[cols.amended] : null,
      },
      source_row_id: `in::${opts.dataset ?? 'C'}::${
        cols.fileNumber !== undefined ? cells[cols.fileNumber] : 'nf'
      }::${i}`,
    });
  }
  return out;
}

/**
 * Parse the CSV inside a downloaded zip into StateCfEventRow[].
 *
 * Uses a schema-aware parser (parseInCsv) because the generic CSV helper
 * mis-maps IN's columns — it picks `CommitteeType` as the filer before it
 * looks at `Committee` or `CandidateName`. IN's schema is documented and
 * stable year-over-year so the bespoke parser is a clean win.
 */
export function parseIndianaCfZip(
  zipBytes: Buffer | Uint8Array,
  opts: {
    sourceUrl: string;
    reportingPeriod?: string;
    maxRows?: number;
    dataset?: 'Contribution' | 'Expenditure';
  },
): StateCfEventRow[] {
  const zip = new AdmZip(Buffer.from(zipBytes));
  const entries = zip.getEntries();
  const csvEntry = entries.find((e) => /\.csv$/i.test(e.entryName));
  if (!csvEntry) return [];

  let body = csvEntry.getData().toString('utf8');
  if (opts.maxRows !== undefined) {
    const lines = body.split(/\r?\n/);
    if (lines.length > opts.maxRows + 1) {
      body = lines.slice(0, opts.maxRows + 1).join('\n');
    }
  }

  return parseInCsv(body, {
    sourceUrl: opts.sourceUrl,
    reportingPeriod: opts.reportingPeriod,
    dataset: opts.dataset,
  });
}

/**
 * Live fetch: download the annual bulk zip and return its bytes.
 *
 * Uses politeFetch (UA rotation + per-host spacing). IN CFA has not
 * historically required browser-level spoofing — a reasonable UA gets
 * served fine — but politeFetch's defaults include everything we'd
 * otherwise have to assemble by hand.
 */
async function fetchInCfBulk(
  year: number,
  dataset: 'Contribution' | 'Expenditure',
): Promise<CfFetchResult> {
  const url = bulkZipUrl(year, dataset);
  const res = await politeFetch(url, {
    redirect: 'follow',
    headers: {
      // Explicit — politeFetch's default Accept is text/html-first; be
      // precise so any future WAF sniff sees "yes, this client wants a zip".
      Accept: 'application/zip, application/x-zip-compressed, */*',
    },
  });
  if (!res.ok) {
    throw new Error(
      `IN CFA bulk fetch: HTTP ${res.status} for ${url}`,
    );
  }
  const buf = Buffer.from(await res.arrayBuffer());
  // Sanity check the ZIP magic: PK\x03\x04. An unexpected redirect to an
  // HTML error page would surface here before we feed it to adm-zip.
  if (buf.length < 4 || buf.readUInt32LE(0) !== 0x04034b50) {
    throw new Error(
      `IN CFA bulk fetch: response is not a zip archive (first 4 bytes: ${buf.slice(0, 4).toString('hex')})`,
    );
  }
  return {
    rawBody: buf.toString('base64'),
    resolvedUrl: res.url ?? url,
    meta: {
      http_status: res.status,
      bulk_zip_url: url,
      bulk_zip_bytes: buf.length,
      dataset,
      year,
      content_type: res.headers.get('content-type') ?? null,
      last_modified: res.headers.get('last-modified') ?? null,
      etag: res.headers.get('etag') ?? null,
      // The interactive search form needs a browser; this adapter only uses
      // the bulk download.
      search_form_notes: {
        search_page_url: DATA_DOWNLOAD_PAGE,
        search_form_requires_browser: true,
      },
    },
  };
}

export function createInCfAdapter(opts: InCfAdapterOptions = {}) {
  const year = opts.electionYear ?? new Date().getUTCFullYear();
  const dataset = opts.dataset ?? 'Contribution';
  const url = opts.sourceUrl ?? bulkZipUrl(year, dataset);

  return createStateCfAdapter({
    stateFips: IN_STATE_FIPS,
    stateAbbr: IN_STATE_ABBR,
    sourceName: 'indiana-cfa',
    sourceUrl: url,
    sourceType: 'ethics_commission',
    license: 'state_open_records',
    tokenBucket: { rps: 0.25, burst: 2 },
    // A healthy 2026 contribution pull returns ~30K rows; set a conservative
    // floor so off-cycle January pulls (which may only have a handful of
    // filings) don't mark the run partial.
    expectedMinRows: 10,
    electionYear: year,
    reportingPeriod: opts.reportingPeriod,
    fetch:
      opts.fetchImpl ??
      (async () => fetchInCfBulk(year, dataset)),
    parse: async (rawBody) => {
      // rawBody is base64-encoded zip bytes from fetchInCfBulk. Test fixtures
      // can also pass raw CSV text directly; we detect that by checking
      // whether it parses as a plausible CSV header — real CSV will have a
      // comma in the first line; base64'd zip bytes will not.
      const firstLine = rawBody.split('\n', 1)[0] ?? '';
      const looksLikeCsv = firstLine.includes(',');
      if (!looksLikeCsv && rawBody.length > 128) {
        const bytes = Buffer.from(rawBody, 'base64');
        return parseIndianaCfZip(bytes, {
          sourceUrl: url,
          reportingPeriod: opts.reportingPeriod,
          maxRows: opts.maxRows,
          dataset,
        });
      }
      // Fallback: treat as raw CSV (synthetic fixtures).
      return parseInCsv(rawBody, {
        sourceUrl: url,
        reportingPeriod: opts.reportingPeriod,
        dataset,
      });
    },
  });
}
