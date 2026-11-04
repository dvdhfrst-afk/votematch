/**
 * Shared HTML parsers for state CF portals.
 *
 * Many state portals publish a common-ish shape:
 *   - A landing page with filing download links.
 *   - A per-filing HTML or CSV detail that lists rows with
 *     (filer, committee, date, amount, counterparty).
 *
 * parseGenericCfHtmlTable() covers the most common variant: an HTML
 * <table> on the filings list page. It's permissive on column order and
 * falls back to 'filing' event_type when it can't infer a more specific
 * contribution/expenditure label.
 *
 * This helper is format-agnostic above the bytes. Per-state adapters that
 * need to handle ASP.NET __VIEWSTATE pages, bulk CSVs, or JSON APIs should
 * write their own parser rather than massaging those into HTML shape.
 */

import { load as loadHtml } from 'cheerio';
import type { CfEventType, StateCfEventRow } from './base';

export type GenericCfParseOptions = {
  state: string;            // 2-letter abbr
  sourceUrl: string;
  defaultEventType?: CfEventType;
  reportingPeriod?: string;
};

function normalizeHeader(s: string): string {
  return s.toLowerCase().replace(/[\s_]+/g, '').replace(/[^a-z0-9]/g, '');
}

function parseAmount(s: string | number | null | undefined): number | null {
  if (s === null || s === undefined) return null;
  if (typeof s === 'number') return Number.isFinite(s) ? s : null;
  const cleaned = s.replace(/[$,\s]/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Locale options for {@link parseDate}.
 *
 * - `en-US` — US convention, mm/dd/yyyy. Default.
 * - `es-PR` — Latin convention, dd/mm/yyyy. Use for Puerto Rico CF feeds
 *   (CEE Puerto Rico, ASUME) and any source that publishes dates in
 *   Spanish locale order.
 * - `auto`  — disambiguate when possible (day > 12 forces dd/mm; month > 12
 *   forces mm/dd; else fall back to en-US with a console warning).
 */
export type ParseDateLocale = 'en-US' | 'es-PR' | 'auto';

export type ParseDateOptions = {
  locale?: ParseDateLocale;
};

/**
 * Parse a date string into ISO 8601 form.
 *
 * Behaviour:
 *  - Pure date inputs (`yyyy-mm-dd`, `mm/dd/yyyy`, etc.) → `YYYY-MM-DD`.
 *  - ISO-8601 with a time portion (e.g. `2026-04-25T14:30:00Z` or
 *    `2026-04-25T14:30:00-04:00`) → returned verbatim, time + offset
 *    preserved (council #10: don't strip the time component).
 *  - Localized order: `mm/dd/yyyy` for `en-US` (default), `dd/mm/yyyy`
 *    for `es-PR`, `auto` to disambiguate when the month or day field
 *    rules out one ordering.
 *
 * Returns null when the string can't be parsed.
 */
function parseDate(
  s: string | null | undefined,
  opts: ParseDateOptions = {},
): string | null {
  if (!s) return null;
  const trimmed = s.trim();
  if (!trimmed) return null;

  // 1. Pure ISO date — yyyy-mm-dd.
  const isoDate = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(trimmed);
  if (isoDate) {
    const [, y, m, d] = isoDate;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  // 2. Full ISO-8601 with time — preserve the time + offset verbatim
  //    (council #10). We accept anything that starts with yyyy-mm-ddT
  //    or yyyy-mm-dd<space>HH:MM and contains either Z or ±HH:MM.
  const isoTime =
    /^\d{4}-\d{1,2}-\d{1,2}[T ]\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/.exec(
      trimmed,
    );
  if (isoTime) {
    // Don't reformat — return the input as-is so callers preserve the
    // timezone the source declared. Validate by round-tripping through Date.
    const d = new Date(trimmed);
    if (!isNaN(d.getTime())) return trimmed;
    return null;
  }

  // 3. Slash- or dash-separated three-component date with optional 2/4-digit year.
  const us = /^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})$/.exec(trimmed);
  if (us) {
    const [, aStr, bStr, yRaw] = us;
    const y = yRaw.length === 2 ? `20${yRaw}` : yRaw;
    const a = parseInt(aStr, 10);
    const b = parseInt(bStr, 10);

    const locale: ParseDateLocale = opts.locale ?? 'en-US';
    let month: number;
    let day: number;

    if (locale === 'en-US') {
      month = a;
      day = b;
    } else if (locale === 'es-PR') {
      month = b;
      day = a;
    } else {
      // auto
      if (a > 12 && b <= 12) {
        // first field can't be a month → dd/mm
        day = a;
        month = b;
      } else if (b > 12 && a <= 12) {
        // second field can't be a month → mm/dd
        month = a;
        day = b;
      } else if (a > 12 && b > 12) {
        return null; // unparseable
      } else {
        // ambiguous — log + default to en-US
        if (typeof console !== 'undefined') {
          console.warn(
            `[parseDate] ambiguous date '${trimmed}' under locale 'auto'; ` +
              `defaulting to en-US (mm/dd/yyyy). Specify opts.locale to force ordering.`,
          );
        }
        month = a;
        day = b;
      }
    }

    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  return null;
}

/**
 * Parse a localized date+time string and return ISO 8601 with explicit
 * IANA timezone offset attached. Used for jurisdictions whose TZ comes
 * from `jurisdictions.iana_tz` (column added in migration
 * 20260425000002_council_wave_2_hardening.sql).
 *
 * The function avoids pulling a heavy dep — it computes the wall-clock
 * UTC offset for the given IANA TZ at the parsed date using
 * `Intl.DateTimeFormat`'s `timeZoneName: 'shortOffset'` extension. Returns
 * an ISO string like `2026-04-25T14:30:00-04:00` (or `Z` for UTC zones).
 *
 * Returns null when input is unparseable.
 */
export function parseDateTimeWithTZ(
  s: string | null | undefined,
  ianaTz: string,
  opts: ParseDateOptions = {},
): string | null {
  if (!s) return null;
  const trimmed = s.trim();

  // Try to extract date + time. Accept:
  //   "2026-04-25T14:30:00"      → take as wall-clock in ianaTz
  //   "2026-04-25 14:30:00"      → idem
  //   "04/25/2026 14:30"         → US wall-clock + ianaTz
  //   "25/04/2026 14:30"         → es-PR wall-clock + ianaTz
  //   "2026-04-25T14:30:00-04:00" → already has offset → return as-is
  const isoWithOffset =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;
  if (isoWithOffset.test(trimmed)) return trimmed;

  // Split date / time components.
  const parts = trimmed.split(/[T ]/);
  if (parts.length !== 2) {
    // Date-only: pin to local-noon-in-tz to avoid DST edge cases when
    // the caller cares about the calendar date.
    const dateOnly = parseDate(trimmed, opts);
    if (!dateOnly) return null;
    return formatWithIanaOffset(`${dateOnly}T12:00:00`, ianaTz);
  }
  const [datePart, timePartRaw] = parts;
  const dateIso = parseDate(datePart, opts);
  if (!dateIso) return null;

  // Time: HH:MM[:SS][.fff]
  const tm = /^(\d{1,2}):(\d{2})(?::(\d{2}))?(\.\d+)?$/.exec(timePartRaw!.trim());
  if (!tm) return null;
  const [, hh, mm, ss, frac] = tm;
  const timeIso = `${hh.padStart(2, '0')}:${mm}:${(ss ?? '00').padStart(2, '0')}${frac ?? ''}`;

  return formatWithIanaOffset(`${dateIso}T${timeIso}`, ianaTz);
}

/**
 * Given a wall-clock ISO string (no offset) interpreted in `ianaTz`,
 * return ISO 8601 with the matching offset suffix. Used by
 * {@link parseDateTimeWithTZ}.
 */
function formatWithIanaOffset(wallClockIso: string, ianaTz: string): string | null {
  // Construct a date as if the wall-clock string were UTC, then use
  // Intl to find what UTC offset this instant has in ianaTz, and shift.
  // This double-correction yields the correct UTC instant + offset.
  const asUtc = new Date(`${wallClockIso}Z`);
  if (isNaN(asUtc.getTime())) return null;
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: ianaTz,
      timeZoneName: 'shortOffset',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const parts = fmt.formatToParts(asUtc);
    const tzName = parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
    // tzName looks like "GMT-4", "GMT+10:30", or "GMT" for UTC.
    const m = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(tzName);
    let offsetMinutes = 0;
    if (m) {
      const sign = m[1] === '+' ? 1 : -1;
      offsetMinutes = sign * (parseInt(m[2]!, 10) * 60 + parseInt(m[3] ?? '0', 10));
    } else if (tzName !== 'GMT' && tzName !== 'UTC') {
      // Unknown format — fall back to Z and let downstream see UTC.
      return `${wallClockIso}Z`;
    }
    // The wall-clock-as-UTC instant is offsetMinutes ahead of the true
    // UTC instant. Shift back, then format with the offset suffix.
    const trueInstant = new Date(asUtc.getTime() - offsetMinutes * 60_000);
    const isoUtc = trueInstant.toISOString().replace(/\.\d+Z$/, 'Z');
    if (offsetMinutes === 0) return isoUtc;
    const sign = offsetMinutes > 0 ? '+' : '-';
    const abs = Math.abs(offsetMinutes);
    const oh = String(Math.floor(abs / 60)).padStart(2, '0');
    const om = String(abs % 60).padStart(2, '0');
    // Render as wall-clock + offset (more useful for downstream display).
    return `${wallClockIso}${sign}${oh}:${om}`;
  } catch {
    return null;
  }
}

function inferEventType(s: string | undefined): CfEventType | null {
  if (!s) return null;
  const t = s.toLowerCase();
  if (/contribut|donat|receipt/.test(t)) return 'contribution';
  if (/expend|disburse|payment/.test(t)) return 'expenditure';
  if (/loan/.test(t)) return 'loan';
  if (/in.?kind/.test(t)) return 'in_kind';
  if (/independent.*expend|ie\b/.test(t)) return 'independent_expenditure';
  if (/filing|report|disclosure/.test(t)) return 'filing';
  return null;
}

/**
 * Parse an HTML page with one or more result tables and surface each row
 * as a StateCfEventRow. Column detection is fuzzy: it maps by header keyword
 * and falls back to positional defaults when headers are missing.
 */
export function parseGenericCfHtmlTable(
  html: string,
  opts: GenericCfParseOptions,
): StateCfEventRow[] {
  const $ = loadHtml(html);
  const rows: StateCfEventRow[] = [];
  const nowIso = new Date().toISOString();

  $('table').each((tableIdx, table) => {
    const headerCells = $(table)
      .find('thead th, tr:first-child th, tr:first-child td')
      .map((_, th) => normalizeHeader($(th).text()))
      .get();
    if (headerCells.length < 2) return;

    const idxFiler = headerCells.findIndex((h) =>
      /(filer|candidate|committee|name)/.test(h),
    );
    const idxCommittee = headerCells.findIndex((h) => /committee/.test(h));
    const idxOffice = headerCells.findIndex((h) => /office|position/.test(h));
    const idxAmount = headerCells.findIndex((h) =>
      /amount|total|contributiontotal|expendituretotal|sum/.test(h),
    );
    const idxDate = headerCells.findIndex((h) =>
      /date|filed|period|reported/.test(h),
    );
    const idxCounterparty = headerCells.findIndex((h) =>
      /contributor|donor|payee|vendor|recipient/.test(h),
    );
    const idxType = headerCells.findIndex((h) =>
      /type|category|kind|reporttype/.test(h),
    );

    $(table)
      .find('tbody tr')
      .each((rowIdx, tr) => {
        const cells = $(tr)
          .find('td')
          .map((_, td) => $(td).text().trim())
          .get();
        if (cells.length === 0) return;

        const filer =
          (idxFiler >= 0 ? cells[idxFiler] : cells[0]) ?? '';
        if (!filer) return;

        const committee =
          idxCommittee >= 0 && idxCommittee !== idxFiler
            ? cells[idxCommittee]
            : null;
        const office = idxOffice >= 0 ? cells[idxOffice] : null;
        const amount = parseAmount(idxAmount >= 0 ? cells[idxAmount] : undefined);
        const eventDate = parseDate(idxDate >= 0 ? cells[idxDate] : undefined);
        const counterparty =
          idxCounterparty >= 0 ? cells[idxCounterparty] : null;
        const inferred = inferEventType(idxType >= 0 ? cells[idxType] : undefined);
        const eventType: CfEventType =
          inferred ?? opts.defaultEventType ?? 'filing';

        rows.push({
          state: opts.state,
          event_type: eventType,
          filer_name: filer,
          candidate_name: office ? filer : null,
          candidate_office: office,
          committee_name: committee,
          amount,
          event_date: eventDate,
          reported_at: eventDate ?? nowIso,
          counterparty: counterparty || null,
          source_url: opts.sourceUrl,
          raw_data: {
            row_index: rowIdx,
            table_index: tableIdx,
            header_cells: headerCells,
            cells,
            reporting_period: opts.reportingPeriod ?? null,
          },
          source_row_id: `${opts.state.toLowerCase()}::${tableIdx}::${rowIdx}::${filer}`,
        });
      });
  });

  return rows;
}

/**
 * Very loose JSON extractor: walks an arbitrary JSON object looking for
 * arrays whose elements carry the common CF shape (`filer_name|name|committee`
 * + `amount|total`). Good enough to surface rows from a state JSON API
 * without knowing its exact schema in advance.
 */
export function parseGenericCfJson(
  body: string,
  opts: GenericCfParseOptions,
): StateCfEventRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  const nowIso = new Date().toISOString();
  const out: StateCfEventRow[] = [];

  const visit = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((v, i) => visit(v, `${path}[${i}]`));
      return;
    }
    if (!value || typeof value !== 'object') return;
    const rec = value as Record<string, unknown>;
    const keys = Object.keys(rec).map((k) => k.toLowerCase());
    const hasFiler = keys.some((k) =>
      /filer|candidate|committee|name/.test(k),
    );
    const hasAmount = keys.some((k) =>
      /amount|total|contribution|expenditure/.test(k),
    );
    if (hasFiler && hasAmount) {
      const get = (re: RegExp): string | null => {
        for (const k of Object.keys(rec)) {
          if (re.test(k.toLowerCase())) {
            const v = rec[k];
            if (v === null || v === undefined) return null;
            return String(v);
          }
        }
        return null;
      };
      const filer = get(/filer|candidate|committee|name/) ?? '';
      if (filer) {
        const amountRaw = get(/amount|total|contribution|expenditure/);
        const dateRaw = get(/date|filed|period/);
        const typeInferred = inferEventType(get(/type|category|kind/) ?? undefined);
        out.push({
          state: opts.state,
          event_type: typeInferred ?? opts.defaultEventType ?? 'filing',
          filer_name: filer,
          candidate_name: get(/candidate/),
          candidate_office: get(/office|position/),
          committee_name: get(/committee/),
          amount: parseAmount(amountRaw ?? undefined),
          event_date: parseDate(dateRaw ?? undefined),
          reported_at: parseDate(dateRaw ?? undefined) ?? nowIso,
          counterparty: get(/contributor|donor|payee|vendor|recipient/),
          source_url: opts.sourceUrl,
          raw_data: rec,
          source_row_id: `${opts.state.toLowerCase()}::json::${path}`,
        });
      }
    }
    for (const [k, v] of Object.entries(rec)) {
      visit(v, `${path}.${k}`);
    }
  };

  visit(parsed, '$');
  return out;
}

/**
 * CSV parser. Handles quoted fields and commas-within-quotes. Not a full
 * RFC 4180 implementation — good enough for the state bulk downloads we
 * ship here; adapter authors who need stricter parsing should import csv-parse.
 */
export function parseGenericCfCsv(
  body: string,
  opts: GenericCfParseOptions,
): StateCfEventRow[] {
  const lines = body.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) return [];
  const headerLine = lines[0];
  const headers = splitCsvLine(headerLine).map(normalizeHeader);

  const idxFiler = headers.findIndex((h) =>
    /(filer|candidate|committee|name)/.test(h),
  );
  const idxCommittee = headers.findIndex((h) => /committee/.test(h));
  const idxOffice = headers.findIndex((h) => /office|position/.test(h));
  const idxAmount = headers.findIndex((h) =>
    /amount|total|contribution|expenditure|sum/.test(h),
  );
  const idxDate = headers.findIndex((h) =>
    /date|filed|period|reported/.test(h),
  );
  const idxCounterparty = headers.findIndex((h) =>
    /contributor|donor|payee|vendor|recipient/.test(h),
  );
  const idxType = headers.findIndex((h) =>
    /type|category|kind|reporttype/.test(h),
  );

  const out: StateCfEventRow[] = [];
  const nowIso = new Date().toISOString();
  for (let i = 1; i < lines.length; i += 1) {
    const cells = splitCsvLine(lines[i]);
    if (cells.length === 0) continue;
    const filer =
      (idxFiler >= 0 ? cells[idxFiler] : cells[0]) ?? '';
    if (!filer) continue;
    const office = idxOffice >= 0 ? cells[idxOffice] : null;
    const inferred = inferEventType(idxType >= 0 ? cells[idxType] : undefined);

    out.push({
      state: opts.state,
      event_type: inferred ?? opts.defaultEventType ?? 'filing',
      filer_name: filer,
      candidate_name: office ? filer : null,
      candidate_office: office,
      committee_name:
        idxCommittee >= 0 && idxCommittee !== idxFiler
          ? cells[idxCommittee]
          : null,
      amount: parseAmount(idxAmount >= 0 ? cells[idxAmount] : undefined),
      event_date: parseDate(idxDate >= 0 ? cells[idxDate] : undefined),
      reported_at:
        parseDate(idxDate >= 0 ? cells[idxDate] : undefined) ?? nowIso,
      counterparty:
        idxCounterparty >= 0 ? cells[idxCounterparty] || null : null,
      source_url: opts.sourceUrl,
      raw_data: {
        row_index: i,
        headers,
        cells,
        reporting_period: opts.reportingPeriod ?? null,
      },
      source_row_id: `${opts.state.toLowerCase()}::csv::${i}::${filer}`,
    });
  }
  return out;
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (ch === '"') {
        inQuote = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuote = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

// Re-export numeric / date helpers so per-state adapters can reuse
// them instead of re-implementing. Keeps parser behaviour identical
// across states that don't need bespoke logic.
export { parseAmount, parseDate, inferEventType, normalizeHeader };
// parseDateTimeWithTZ is exported at its declaration above.
