/**
 * Florida — Division of Elections Campaign Finance Database (FIPS 12).
 *
 * Portal: https://dos.elections.myflorida.com/campaign-finance/contributions/
 * Format: TAB-delimited text exports. The FL DoS publishes one of the
 *         richest historical CF archives in the country (back to 1996);
 *         the live database surfaces raw contribution + expenditure data
 *         via downloadable .txt files on a per-query basis.
 *
 * Wire format (common layout — two variants are handled)
 * ------------------------------------------------------
 * Contributions export (typical column order):
 *   0 Candidate/Committee
 *   1 Office                       (Governor, US Representative, ...)
 *   2 Contribution Date            (MM/DD/YYYY)
 *   3 Amount                       (sometimes prefixed '$')
 *   4 Type Code                    ('CON', 'REF', 'INK' ...)
 *   5 Contributor Name (Last/First or "Name")
 *   6 Address (City, State, Zip)
 *   7 Occupation
 *   8 In-Kind Description          (optional)
 *
 * Expenditures export:
 *   0 Candidate/Committee
 *   1 Office
 *   2 Expenditure Date
 *   3 Amount
 *   4 Type Code                    ('MON', 'INK', 'REF' ...)
 *   5 Payee Name
 *   6 Address
 *   7 Expenditure Purpose
 *
 * If a header row is present we do name-based lookup; otherwise we fall
 * back to the positional layout above. A plain HTML landing page yields
 * an empty row set (consistent with the SoS results adapter's behaviour).
 *
 * No live network; `fetch` is pluggable for tests.
 */

import { load as loadHtml } from 'cheerio';
import type { AdapterContext } from '../../types';
import {
  createStateCfAdapter,
  fetchCfHtml,
  type CfEventType,
  type StateCfEventRow,
} from '../shared/base';
import { parseAmount, parseDate } from '../shared/html-parsers';

export const FL_STATE_FIPS = '12';
export const FL_STATE_ABBR = 'FL';
const DEFAULT_URL =
  'https://dos.elections.myflorida.com/campaign-finance/contributions/';

export type FlCfExportKind = 'contributions' | 'expenditures';

export type FlCfAdapterOptions = {
  sourceUrl?: string;
  electionYear?: number;
  reportingPeriod?: string;
  /** Which export shape to expect when the body is tab-delimited. */
  exportKind?: FlCfExportKind;
  fetchImpl?: (ctx: AdapterContext) => Promise<{ rawBody: string }>;
};

// ---------------------------------------------------------------------------
// Parser (exported for tests)
// ---------------------------------------------------------------------------

const FL_HEADER_ALIASES: Record<string, string[]> = {
  candidate: ['candidatecommittee', 'candidate', 'committee', 'name'],
  office: ['office', 'officesought'],
  date: ['contributiondate', 'expendituredate', 'date'],
  amount: ['amount', 'contributionamount', 'expenditureamount'],
  typeCode: ['typecode', 'type', 'contributiontype', 'expendituretype'],
  counterparty: [
    'contributorname',
    'contributor',
    'payeename',
    'payee',
    'vendor',
  ],
  address: ['address', 'contributoraddress', 'payeeaddress'],
  purpose: ['purpose', 'expenditurepurpose', 'description', 'inkinddescription'],
};

function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function splitTabDelim(line: string): string[] {
  // FL exports historically don't quote fields, so a plain split is safe.
  // If we do see a quoted field we fall back to honoring it.
  if (line.indexOf('"') < 0) return line.split('\t').map((s) => s.trim());
  const out: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        inQuote = !inQuote;
      }
      continue;
    }
    if (ch === '\t' && !inQuote) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

function buildIndex(header: string[]): Record<string, number> {
  const idx: Record<string, number> = {};
  const normed = header.map(normalizeHeader);
  for (const [field, aliases] of Object.entries(FL_HEADER_ALIASES)) {
    for (const a of aliases) {
      const pos = normed.indexOf(a);
      if (pos >= 0) {
        idx[field] = pos;
        break;
      }
    }
  }
  return idx;
}

function inferEventTypeFromCode(code: string | null): CfEventType {
  if (!code) return 'contribution';
  const c = code.toUpperCase().trim();
  if (c === 'INK' || c === 'IN-KIND' || c === 'INKIND') return 'in_kind';
  if (c === 'LOA' || c === 'LOAN') return 'loan';
  if (c === 'REF' || c === 'REFUND') return 'contribution';
  if (c === 'MON' || c === 'MONETARY') return 'expenditure';
  return 'contribution';
}

/**
 * Parse a FL DoS contributions/expenditures tab-delimited body. If the body
 * looks like HTML (landing page) returns [] so the runner records a zero-
 * row ingestion rather than failing.
 */
export function parseFloridaCfTabDelim(
  body: string,
  opts: {
    sourceUrl?: string;
    reportingPeriod?: string;
    exportKind?: FlCfExportKind;
  } = {},
): StateCfEventRow[] {
  if (!body || body.trim().length === 0) return [];
  const trimmed = body.trimStart();
  if (trimmed.startsWith('<')) return [];

  const cleaned = body.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = cleaned.split('\n').filter((l) => l.length > 0);
  if (lines.length < 1) return [];

  const first = splitTabDelim(lines[0]);
  const firstLooksHeader =
    first.some((c) => /^[A-Za-z]/.test(c)) &&
    first.every((c) => !/^\d+(\.\d+)?$/.test(c));
  const idx = firstLooksHeader ? buildIndex(first) : ({} as Record<string, number>);

  const hasHeader =
    firstLooksHeader &&
    (idx.candidate !== undefined || idx.counterparty !== undefined);
  const rowStart = hasHeader ? 1 : 0;

  // Positional fallback — matches the layout documented in the file header.
  if (!hasHeader) {
    idx.candidate = 0;
    idx.office = 1;
    idx.date = 2;
    idx.amount = 3;
    idx.typeCode = 4;
    idx.counterparty = 5;
    idx.address = 6;
    idx.purpose = opts.exportKind === 'expenditures' ? 7 : 8;
  }

  const sourceUrl = opts.sourceUrl ?? DEFAULT_URL;
  const reportingPeriod = opts.reportingPeriod ?? null;
  const nowIso = new Date().toISOString();
  const defaultType: CfEventType =
    opts.exportKind === 'expenditures' ? 'expenditure' : 'contribution';

  const rows: StateCfEventRow[] = [];
  for (let i = rowStart; i < lines.length; i += 1) {
    const cells = splitTabDelim(lines[i]);
    if (cells.length < 2) continue;

    const get = (field: string): string | null => {
      const pos = idx[field];
      if (pos === undefined || pos < 0 || pos >= cells.length) return null;
      const v = cells[pos];
      return v && v.length > 0 ? v : null;
    };

    const candidateRaw = get('candidate');
    if (!candidateRaw) continue;

    const counterparty = get('counterparty');
    const amount = parseAmount(get('amount') ?? undefined);
    const eventDate = parseDate(get('date') ?? undefined);
    const typeCode = get('typeCode');
    const typeInferred = inferEventTypeFromCode(typeCode);
    const eventType: CfEventType =
      typeInferred === 'contribution' ? defaultType : typeInferred;

    // FL candidate rows often collapse committee + candidate into a single
    // cell. We mirror into both columns so downstream retention-engine
    // fanout sees whichever it expects.
    const candidateName = candidateRaw;
    const office = get('office');

    rows.push({
      state: FL_STATE_ABBR,
      event_type: eventType,
      filer_name: candidateName,
      candidate_name: office ? candidateName : null,
      candidate_office: office,
      committee_name: candidateName,
      amount,
      event_date: eventDate,
      reported_at: eventDate ?? nowIso,
      counterparty,
      source_url: sourceUrl,
      raw_data: {
        row_index: i,
        type_code: typeCode,
        address: get('address'),
        purpose: get('purpose'),
        export_kind: opts.exportKind ?? 'contributions',
        reporting_period: reportingPeriod,
      },
      source_row_id: `fl::${i}::${candidateName}::${counterparty ?? ''}::${amount ?? ''}`,
    });
  }
  return rows;
}

/**
 * Pull direct links to .txt exports out of the landing page. The FL DoS
 * navigation is a classic ASP form so a deep link is preferred when one
 * is present; we surface the links in logs but never cross-site-fetch
 * (adapter discipline: explicit URLs only).
 */
export function discoverFloridaCfLinks(html: string): string[] {
  const $ = loadHtml(html);
  const out: string[] = [];
  $('a').each((_, el) => {
    const href = ($(el).attr('href') ?? '').trim();
    if (!href) return;
    if (/\.(txt|csv)(?:[?#]|$)/i.test(href) && /contrib|expend|finance/i.test(href)) {
      out.push(href);
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

export function createFlCfAdapter(opts: FlCfAdapterOptions = {}) {
  const url = opts.sourceUrl ?? DEFAULT_URL;
  return createStateCfAdapter({
    stateFips: FL_STATE_FIPS,
    stateAbbr: FL_STATE_ABBR,
    sourceName: 'florida-dos-cf',
    sourceUrl: url,
    sourceType: 'sos_campaign_finance',
    license: 'state_open_records',
    tokenBucket: { rps: 0.5, burst: 2 },
    expectedMinRows: 0,
    electionYear: opts.electionYear,
    reportingPeriod: opts.reportingPeriod,
    fetch: opts.fetchImpl ?? (async () => fetchCfHtml(url)),
    parse: async (body, ctx) => {
      const trimmed = body.trimStart();
      if (trimmed.startsWith('<')) {
        const links = discoverFloridaCfLinks(body);
        if (links.length > 0) {
          ctx.logger.info(
            'fl-cf: landing page — tabulation link(s) discovered but not auto-followed',
            { stateFips: FL_STATE_FIPS, count: links.length, sample: links[0] },
          );
        } else {
          ctx.logger.info('fl-cf: landing page — no tabulation link found', {
            stateFips: FL_STATE_FIPS,
          });
        }
        return [];
      }
      return parseFloridaCfTabDelim(body, {
        sourceUrl: url,
        reportingPeriod: opts.reportingPeriod,
        exportKind: opts.exportKind,
      });
    },
  });
}
