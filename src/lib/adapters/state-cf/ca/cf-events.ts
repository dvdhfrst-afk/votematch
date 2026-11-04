/**
 * California Cal-Access / Cal-ACCESS Raw Data — campaign finance adapter.
 *
 * FIPS 06. Seed URL: https://cal-access.sos.ca.gov/
 *
 * What we pull
 * ------------
 * CA's SoS publishes a bulk "Cal-Access Raw Data" archive as a single ZIP at
 *
 *   https://campaignfinance.cdn.sos.ca.gov/dbwebexport.zip
 *
 * (Verified 2026-04-25: HTTP 200, Content-Type application/x-zip-compressed,
 * Content-Length 1,527,283,660 bytes ≈ 1.42 GiB, magic 50 4b 03 04, first
 * entry CalAccess/CalFormat/cal_errata_1_05_02.pdf — this is the real,
 * canonical Cal-Access bulk archive.)
 *
 * Historical landing-page references (kept for context, NOT a download):
 *   https://calaccess.sos.ca.gov/Campaign/List/
 *   https://www.sos.ca.gov/campaign-lobbying/helpful-resources/raw-data-campaign-finance-and-lobbying-activity/
 *
 * The archive contains a zipped set of TSV files; the two most load-bearing
 * are RCPT_CD.TSV (receipts) and EXPN_CD.TSV (expenditures). Both are
 * multi-GB once unzipped; this adapter consumes a pre-filtered TSV stream
 * that the caller is expected to narrow down by cycle / filer before
 * handing to us. The injected `fetch` must return a UTF-8 TSV body.
 *
 * The Cal-Access schema is well-documented by CRIS (California Reform
 * of Information Systems) and is stable — this adapter keys on the 20
 * columns we actually need. Unknown columns are ignored.
 *
 * Status (2026-04-25)
 * -------------------
 * The default fetch path is a SAFETY-CAPPED HEAD-style probe (not a full
 * download). The bulk archive is 1.5 GB and `await res.text()` on it would
 * pull the entire file into memory and corrupt the bytes via UTF-8 decoding
 * before parseCalAccessTsv() ever sees them. So the default fetch:
 *
 *   1. Issues a small Range (bytes=0-2047) GET against the bulk URL.
 *   2. Confirms HTTP 206 + ZIP magic (`50 4b 03 04`).
 *   3. Returns an empty body so the parse step is a no-op (0 rows).
 *   4. Records `byte_size`, `content_length`, `archive_verified` in meta
 *      so monitoring can see "yes the bulk is reachable; no rows landed
 *      because we don't have a ZIP-aware parser yet".
 *
 * If the caller passes `--source-url=<pre-filtered-tsv-url>`, the fetch
 * runs a normal politeFetch and parseCalAccessTsv() handles the body.
 *
 * TODO(ca-cf-zip-parser, P0 for Mar 2026 primary)
 * -----------------------------------------------
 * Build a ZIP-aware staging job that:
 *   1. Streams `dbwebexport.zip` to a temp file (no full in-memory load).
 *   2. Extracts RCPT_CD.TSV and EXPN_CD.TSV using node:zlib + a streaming
 *      ZIP reader (e.g. `unzipper` or `yauzl`).
 *   3. Filters to the cycle window we care about (2024+ for 2026 primary).
 *   4. Splits per filer and uploads to Supabase Storage as
 *      `cf-staging/ca/<cycle>/<filer-id>.tsv`.
 *   5. Drives this adapter with `--source-url=<storage-url>` once per filer.
 * The parser below is unit-tested and ready; the missing piece is the
 * staging pipeline. Until that lands, CA returns 0 rows but reports the
 * archive as healthy in meta.
 */

import type { AdapterContext } from '../../types';
import { politeFetch } from '../../fetch-polite';
import {
  createStateCfAdapter,
  normalizeEventType,
  parseIsoDateOrNull,
  parseMoneyOrNull,
  type StateCfFetchResult,
  type StateCfRow,
} from '../base';

export const CA_STATE_FIPS = '06';
export const CA_STATE_ABBR = 'CA';

/**
 * Canonical Cal-Access bulk archive — single 1.5 GB ZIP, refreshed nightly
 * by the SoS. This replaces the prior landing-page URL as the default for
 * this adapter (see file-level docblock for the verification trace).
 */
export const CA_CALACCESS_BULK_URL =
  'https://campaignfinance.cdn.sos.ca.gov/dbwebexport.zip';

/** Older landing-page reference kept for documentation; NOT a download. */
export const CA_CALACCESS_LANDING_URL =
  'https://www.sos.ca.gov/campaign-lobbying/helpful-resources/raw-data-campaign-finance-and-lobbying-activity';

export const CA_CALACCESS_SEED_URL = 'https://cal-access.sos.ca.gov/';

// ---------------------------------------------------------------------------
// TSV parser — Cal-Access RCPT_CD / EXPN_CD subset
// ---------------------------------------------------------------------------

/**
 * Parse a Cal-Access RCPT_CD or EXPN_CD TSV body into StateCfRow[].
 *
 * Recognized columns (case-insensitive, any subset is OK):
 *   FILING_ID         filing_url key
 *   FILER_NAML        filer (committee)
 *   CAND_NAML         candidate (first/last split ignored for simplicity)
 *   OFFICE_CD         office code
 *   TRAN_NAMF/NAML    contributor / recipient first+last
 *   AMOUNT            dollars
 *   RCPT_DATE / EXPN_DATE   ISO date
 *   TRAN_ID           source row id
 *
 * TSV is tab-delimited, quoted fields optional, header row required.
 */
export function parseCalAccessTsv(body: string): StateCfRow[] {
  if (!body || body.length < 4) return [];
  const lines = body.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) return [];

  const header = splitTsv(lines[0]!).map((h) => h.trim().toUpperCase());
  const idx = (name: string) => header.indexOf(name);
  const COL_FILING = idx('FILING_ID');
  const COL_FILER = idx('FILER_NAML');
  const COL_CAND = idx('CAND_NAML');
  const COL_OFFICE = idx('OFFICE_CD');
  const COL_TNL = idx('TRAN_NAML');
  const COL_TNF = idx('TRAN_NAMF');
  const COL_AMOUNT = idx('AMOUNT');
  const COL_RCPT = idx('RCPT_DATE');
  const COL_EXPN = idx('EXPN_DATE');
  const COL_TRAN = idx('TRAN_ID');
  const COL_FORM = idx('FORM_TYPE');

  const rows: StateCfRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitTsv(lines[i]!);
    if (cells.length === 0) continue;

    const filing_id = cellAt(cells, COL_FILING);
    const cand = cellAt(cells, COL_CAND);
    const filer = cellAt(cells, COL_FILER);
    const office = cellAt(cells, COL_OFFICE);
    const tranL = cellAt(cells, COL_TNL);
    const tranF = cellAt(cells, COL_TNF);
    const counterparty = [tranF, tranL].filter((s) => s && s.length > 0).join(' ').trim() || null;

    // Direction: Cal-Access FORM_TYPE distinguishes schedule A (contrib)
    // vs schedule E (expenditure). Fall back to presence of RCPT/EXPN
    // date when FORM_TYPE is missing.
    const form = cellAt(cells, COL_FORM)?.toUpperCase() ?? '';
    const rcptDate = cellAt(cells, COL_RCPT);
    const expnDate = cellAt(cells, COL_EXPN);

    let event_type: StateCfRow['event_type'];
    if (form.startsWith('A')) event_type = 'contribution';
    else if (form.startsWith('E') || form.startsWith('D')) event_type = 'expenditure';
    else if (rcptDate) event_type = 'contribution';
    else if (expnDate) event_type = 'expenditure';
    else event_type = normalizeEventType(form);

    const event_date = parseIsoDateOrNull(
      event_type === 'contribution' ? rcptDate : expnDate ?? rcptDate,
    );

    rows.push({
      state: CA_STATE_ABBR,
      candidate_name: cand || null,
      candidate_office: office || null,
      committee_name: filer || null,
      event_type,
      amount: parseMoneyOrNull(cellAt(cells, COL_AMOUNT)),
      event_date,
      counterparty,
      // Cal-Access filings are indexed by FILING_ID in their web UI:
      filing_url: filing_id
        ? `https://cal-access.sos.ca.gov/PDFGen/pdfgen.prg?filingid=${encodeURIComponent(filing_id)}`
        : CA_CALACCESS_BULK_URL,
      confidence_score: 0.9,
      source_row_id: cellAt(cells, COL_TRAN) || `ca-${filing_id ?? 'row'}-${i}`,
    });
  }
  return rows;
}

function splitTsv(line: string): string[] {
  // Cal-Access is "well-formed TSV" — tab separators, no embedded tabs
  // or newlines inside cells. If a cell has a \t it's quoted; we strip
  // leading/trailing double-quotes but don't try to parse CSV-style
  // escapes (Cal-Access doesn't emit them).
  return line.split('\t').map((s) => {
    const trimmed = s.trim();
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
      return trimmed.slice(1, -1);
    }
    return trimmed;
  });
}

function cellAt(cells: string[], idx: number): string {
  if (idx < 0 || idx >= cells.length) return '';
  return cells[idx] ?? '';
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

export type CaCfAdapterOptions = {
  sourceUrl?: string;
  cycleYear?: number;
  fetchImpl?: (ctx: AdapterContext) => Promise<StateCfFetchResult>;
};

export function createCaCfAdapter(opts: CaCfAdapterOptions = {}) {
  const url = opts.sourceUrl ?? CA_CALACCESS_BULK_URL;
  const adapter = createStateCfAdapter({
    stateFips: CA_STATE_FIPS,
    stateAbbr: CA_STATE_ABBR,
    sourceName: 'ca-calaccess-cf',
    sourceUrl: url,
    sourceType: 'sos_campaign_finance',
    license: 'state_open_records',
    tokenBucket: { rps: 0.25, burst: 1 },
    expectedMinRows: 0,
    cycleYear: opts.cycleYear,
    fetch:
      opts.fetchImpl ??
      (async () => {
        // ----------------------------------------------------------------
        // Default path: SAFETY-CAPPED probe of the 1.5 GB bulk ZIP.
        //
        // We can't `await res.text()` on the full archive — that would
        // (a) pull 1.5 GB into RAM and (b) corrupt the bytes via UTF-8
        // decoding before parseCalAccessTsv() could ever see them. So
        // the default fetch:
        //   - Issues a Range bytes=0-2047 GET to confirm the bulk is up.
        //   - Validates ZIP magic (50 4b 03 04).
        //   - Returns an EMPTY body so the parse step is a no-op (0 rows).
        // The full ingestion is a separate staging pipeline (see TODO at
        // top of file). When `--source-url=<pre-filtered-tsv-url>` is
        // passed, this branch is replaced by the test-injected fetchImpl
        // OR (in future) by a per-filer TSV URL the staging job uploads
        // to Supabase Storage; in either case the body is small TSV.
        // ----------------------------------------------------------------
        const isBulkZip = url === CA_CALACCESS_BULK_URL;
        if (isBulkZip) {
          const res = await politeFetch(url, {
            headers: {
              Accept: 'application/zip, application/x-zip-compressed, */*',
              Range: 'bytes=0-2047',
            },
          });
          // 206 Partial Content is success here; 200 means server doesn't
          // honour Range (we still consume only 2 KB by aborting below).
          if (!res.ok && res.status !== 206) {
            throw new Error(`ca-calaccess: HTTP ${res.status} for ${url}`);
          }
          const reader = res.body?.getReader();
          let firstBytes = new Uint8Array(0);
          if (reader) {
            const { value } = await reader.read();
            if (value) firstBytes = value.slice(0, 8);
            await reader.cancel();
          }
          const magic = Array.from(firstBytes)
            .slice(0, 4)
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('');
          const isZip = magic === '504b0304' || magic === '504b0506' || magic === '504b0708';
          const contentLength = res.headers.get('content-range')?.split('/')[1]
            ?? res.headers.get('content-length');
          return {
            rawBody: '', // empty — bulk ZIP not parsed inline (see TODO)
            resolvedUrl: res.url ?? url,
            meta: {
              http_status: res.status,
              content_type: res.headers.get('content-type') ?? null,
              content_length: contentLength ? Number(contentLength) : null,
              zip_magic: magic,
              archive_verified: isZip,
              probe_only: true,
              probe_note:
                'Bulk archive reachable; full ingest requires ZIP-aware staging pipeline (see CA adapter TODO).',
            },
          };
        }
        // Non-bulk URL (caller-injected pre-filtered TSV): normal path.
        const res = await politeFetch(url, {
          headers: { Accept: 'text/html, text/tab-separated-values, */*' },
        });
        if (!res.ok) {
          throw new Error(`ca-calaccess: HTTP ${res.status} for ${url}`);
        }
        return { rawBody: await res.text(), resolvedUrl: res.url ?? url };
      }),
    parse: async (body) => {
      // Empty body = the safety-capped bulk-ZIP probe path (see fetch).
      if (!body) return [];
      // HTML landing page (legacy fallback) → 0 rows, legit warm-cache.
      if (body.trimStart().startsWith('<')) return [];
      return parseCalAccessTsv(body);
    },
  });
  adapter.costService = 'other';
  return adapter;
}
