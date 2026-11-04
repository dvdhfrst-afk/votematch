/**
 * Shared PDF text-extraction utility for state SoS candidacy adapters.
 *
 * Why this exists
 * ---------------
 * 11 of the ~50 state-candidacy adapters were shipped as "PDF-deferred
 * stubs" — the SoS publishes its candidate list as a PDF and we had no
 * extractor on board. This module fills that gap. It uses Mozilla's
 * `pdfjs-dist` (better-maintained than `pdf-parse`, no FFI deps) and
 * exposes three primitives state adapters can compose:
 *
 *   1. extractTextFromPdf(buffer)
 *      - Returns { pages: string[], metadata } where each page string is
 *        the extracted text in reading order (top-to-bottom, then left-
 *        to-right within each line). Item Y-positions are clustered into
 *        rows using a 2px tolerance so columns line up across cells.
 *
 *   2. parsePdfTable(text, opts)
 *      - Heuristic table parser. Splits the text into lines, finds a
 *        header row by matching column ColumnDef.aliases against each
 *        line, then maps subsequent non-blank lines to rows by
 *        splitting on multi-space gaps. Handles section banners
 *        (e.g. "DEMOCRATIC PARTY", "WARD 1 COUNCIL") via an optional
 *        `section_marker_regex`; the matched banner is exposed on each
 *        row as `_section`.
 *
 *   3. findColumnByHeader(headers, def)
 *      - Robust column finder using fuzzy match on def.aliases.
 *
 *   4. splitByLines(text)
 *      - Normalizes \r\n / \r / form-feed line breaks and trims trailing
 *        whitespace.
 *
 * Example
 * -------
 *   const buf = await fetchPdf(url);
 *   const { pages } = await extractTextFromPdf(buf);
 *   const text = pages.join('\n\n');
 *   const rows = parsePdfTable(text, {
 *     columns: [
 *       { name: 'office', aliases: ['Office', 'Position'], required: true },
 *       { name: 'name', aliases: ['Candidate', 'Name'], required: true },
 *       { name: 'party', aliases: ['Party', 'Affiliation'] },
 *       { name: 'district', aliases: ['District', 'Dist'] },
 *     ],
 *     section_marker_regex: /^(DEMOCRATIC|REPUBLICAN|LIBERTARIAN)/i,
 *   });
 *   // rows = [{ office, name, party, district, _section, _lineIndex }]
 *
 * Notes
 * -----
 * - PDF text extraction is HEURISTIC. Two-column layouts, embedded
 *   bullets, and page footers are common state-SoS-PDF quirks — each
 *   state adapter is expected to do post-processing (filter out
 *   "Page N of M" lines, reject rows with empty office/name, etc.).
 * - `pdfjs-dist` v5+ ships with both `build/pdf.mjs` (modern ESM) and
 *   the option to disable the worker for Node use (which we do here to
 *   avoid spinning a worker_thread for one-shot extraction).
 */

// Use a dynamic import (resolved at call time) so that bundlers that
// can't statically resolve the worker entry don't choke at build time.
// pdfjs-dist v5 exports an ESM module; we only need the small set of
// helpers below.

export type PdfMetadata = {
  numPages: number;
  /** Raw `info` block from the document (Title, Author, Producer, ...). */
  info: Record<string, unknown>;
  /** PDF version string as reported by pdfjs-dist (may be undefined). */
  pdfVersion?: string;
};

export type ColumnDef = {
  /** Output key on the parsed row (e.g. 'office', 'name', 'party'). */
  name: string;
  /**
   * Header strings to match against. Case-insensitive substring match.
   * Provide both the exact header you expect AND common synonyms.
   */
  aliases?: string[];
  /** If true, parsePdfTable skips rows that lack a value in this column. */
  required?: boolean;
  /** Post-process the raw cell text. Defaults to identity (trim only). */
  transform?: (s: string) => unknown;
};

export type ParsedRow = Record<string, unknown> & {
  /** The full source line, useful for debugging unmatched rows. */
  _raw: string;
  /** Page-aware line index within the joined `text` argument. */
  _lineIndex: number;
  /** Most recent section marker that preceded the row (if any). */
  _section?: string;
};

export type ParsePdfTableOptions = {
  columns: ColumnDef[];
  /**
   * Optional regex matched against trimmed lines BEFORE the header row;
   * a match is treated as a section banner and attached to every row
   * that follows (until the next match). The matched group(0) is used
   * as the section value.
   */
  section_marker_regex?: RegExp;
  /**
   * Optional override for the multi-space split threshold. Default 2 —
   * i.e. two or more consecutive spaces are treated as a column gap.
   * Some PDFs are tightly packed; bump down to 1 if needed.
   */
  min_gap_spaces?: number;
};

// ---------------------------------------------------------------------------
// extractTextFromPdf
// ---------------------------------------------------------------------------

/**
 * Extract per-page text from a PDF buffer.
 *
 * Implementation note: pdfjs-dist v5 ships ESM only, and its default
 * entry point spins up a worker. We disable the worker (single-thread
 * Node usage) and stream-load via `getDocument({ data, useWorker: false,
 * isEvalSupported: false, disableFontFace: true })`.
 *
 * Each page's items are sorted by (y desc, x asc) — pdfjs uses a
 * Y-up coordinate space, so a higher transform[5] = nearer the top of
 * the page. Items within ~2 device pixels of each other are treated
 * as the same line; a single space is inserted between items on the
 * same line, except where the original items already produced a newline
 * via "hasEOL".
 */
export async function extractTextFromPdf(
  buffer: Buffer | Uint8Array,
): Promise<{ pages: string[]; metadata: PdfMetadata }> {
  // We import dynamically so this module can be statically analyzed by
  // the rest of the codebase without pulling pdfjs-dist into bundles
  // that don't actually call extractTextFromPdf.
  //
  // The `legacy` build is required in Node ≥20 (the modern build relies
  // on DOMMatrix, OffscreenCanvas, and other browser-only globals). The
  // legacy build is shipped by pdfjs-dist explicitly for Node + older
  // browsers and exposes the same getDocument / getTextContent API.
  const pdfjs = (await import(
    'pdfjs-dist/legacy/build/pdf.mjs'
  )) as typeof import('pdfjs-dist');

  // pdfjs needs a Uint8Array; Buffer works directly because Buffer
  // extends Uint8Array. We pass `.subarray()` to pin the underlying
  // ArrayBuffer in case the caller passed us a Buffer view of a larger
  // pool.
  const data =
    buffer instanceof Buffer
      ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
      : buffer;

  const loadingTask = pdfjs.getDocument({
    data,
    // Hardening: untrusted PDFs from third-party SoS sites should not
    // run any embedded JS or load remote font URLs.
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    // pdfjs-dist v5 auto-detects Node and runs in-thread (the
    // documented behavior — no `useWorker` option exists). The default
    // does the right thing here.
  } as Parameters<typeof pdfjs.getDocument>[0]);

  const doc = await loadingTask.promise;

  const numPages = doc.numPages;
  const pages: string[] = [];

  // pdfjs's documented metadata accessor.
  let info: Record<string, unknown> = {};
  let pdfVersion: string | undefined;
  try {
    const meta = await doc.getMetadata();
    info = (meta?.info as Record<string, unknown>) ?? {};
    pdfVersion = (meta?.info as { PDFFormatVersion?: string } | undefined)?.PDFFormatVersion;
  } catch {
    // Some PDFs have no info dictionary; ignore.
  }

  for (let p = 1; p <= numPages; p += 1) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();

    type Item = { str: string; transform: number[]; hasEOL?: boolean; width?: number };
    const items = (content.items as Item[]).filter(
      (it) => typeof it?.str === 'string',
    );

    // Group items into lines by Y-coordinate (transform[5] in PDF user space).
    // Tolerance of 2 pt absorbs minor anti-aliasing offsets within the same
    // visual row. Items are then sorted by X within each row.
    const yTolerance = 2;
    type Line = { y: number; items: Item[] };
    const lines: Line[] = [];
    for (const it of items) {
      const y = it.transform?.[5] ?? 0;
      const found = lines.find((l) => Math.abs(l.y - y) <= yTolerance);
      if (found) found.items.push(it);
      else lines.push({ y, items: [it] });
    }
    // Higher Y = top of page in PDF user space → reverse-sort.
    lines.sort((a, b) => b.y - a.y);
    for (const line of lines) {
      line.items.sort((a, b) => (a.transform?.[4] ?? 0) - (b.transform?.[4] ?? 0));
    }

    // Render each line: insert a separator (multi-space) between items
    // when the X-gap between them is large; this preserves column spacing
    // so parsePdfTable can split on ≥2-space gaps later.
    const lineStrings: string[] = lines.map((line) => {
      let prev: Item | null = null;
      let buf = '';
      for (const it of line.items) {
        const x = it.transform?.[4] ?? 0;
        const w = it.width ?? estimateWidth(it.str);
        // Detect "spacer" items: pdfjs frequently emits a synthetic item
        // whose str is a single whitespace character and whose width
        // covers the entire column gap. We translate those into the
        // appropriate run of literal spaces so downstream tabular
        // parsers (split on /\s{2,}/) see a clear column break.
        const isSpacer = /^\s+$/.test(it.str);
        if (isSpacer) {
          // A 12pt-body single-space glyph is ~3pt wide. A column gap
          // is typically 6-100pt. Convert width → space count, capping
          // at 12 (more than enough to satisfy any /\s{2,}/ split).
          const spaces =
            w >= 6 ? Math.min(12, Math.max(2, Math.round(w / 3))) : 1;
          buf += ' '.repeat(spaces);
          prev = it;
          continue;
        }
        if (prev) {
          const prevEnd = (prev.transform?.[4] ?? 0) + (prev.width ?? estimateWidth(prev.str));
          const gap = x - prevEnd;
          // Items that aren't spacer but still have a positive gap
          // (e.g. paragraphs that don't emit synthetic spacers) get the
          // legacy heuristic.
          const spaces =
            gap >= 12
              ? Math.min(8, Math.max(2, Math.round(gap / 4)))
              : gap >= 4
                ? 2
                : gap >= 1
                  ? 1
                  : 0;
          buf += ' '.repeat(spaces);
        }
        buf += it.str;
        prev = it;
      }
      return buf.replace(/\s+$/g, '');
    });

    pages.push(lineStrings.join('\n'));
  }

  await doc.destroy?.();

  return {
    pages,
    metadata: { numPages, info, pdfVersion },
  };
}

/** Rough width estimate for an item that didn't report its own width. */
function estimateWidth(s: string): number {
  // ~6 points per glyph at 12pt body type. Good enough for gap detection.
  return Math.max(0, s.length * 6);
}

// ---------------------------------------------------------------------------
// splitByLines
// ---------------------------------------------------------------------------

/**
 * Normalize line endings (\r\n, \r, form-feed) and trim trailing
 * whitespace. Empty lines are preserved as empty strings so callers can
 * see paragraph breaks if they want.
 */
export function splitByLines(text: string): string[] {
  if (typeof text !== 'string') return [];
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\f/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/g, ''));
}

// ---------------------------------------------------------------------------
// findColumnByHeader
// ---------------------------------------------------------------------------

/**
 * Find the index in a header-cell array that best matches a ColumnDef.
 * Returns null if no header cell matches. Match is case-insensitive
 * substring against any of `def.aliases` (or `def.name` if aliases
 * isn't supplied).
 *
 * Tie-breaker: shortest header wins (so "Office" beats "Office Address"
 * when looking for "office").
 */
export function findColumnByHeader(
  headers: string[],
  def: ColumnDef,
): number | null {
  const candidates = (def.aliases && def.aliases.length > 0
    ? def.aliases
    : [def.name]
  ).map((s) => s.toLowerCase());
  let best: { idx: number; len: number } | null = null;
  for (let i = 0; i < headers.length; i += 1) {
    const h = (headers[i] ?? '').trim().toLowerCase();
    if (!h) continue;
    for (const c of candidates) {
      if (h.includes(c) || c.includes(h)) {
        const len = h.length;
        if (!best || len < best.len) best = { idx: i, len };
        break;
      }
    }
  }
  return best ? best.idx : null;
}

// ---------------------------------------------------------------------------
// parsePdfTable
// ---------------------------------------------------------------------------

/**
 * Heuristic table parser for column-aligned PDF text.
 *
 * Strategy:
 *   1. Split text into lines via splitByLines.
 *   2. Walk top-down, watching for a "header line" — a line where
 *      every required column's alias appears as a substring.
 *   3. After the header is found, treat each non-blank line as a data
 *      row: split on runs of ≥min_gap_spaces spaces (default 2), then
 *      map cells to columns by counting from the left.
 *   4. Lines matching `section_marker_regex` set the current section
 *      that downstream rows inherit (`_section`).
 *
 * Limitations (intentional):
 *   - Doesn't try to handle wrapped cells. State adapters that need
 *     cell-wrap support should pre-process pages by collapsing
 *     wrapped lines BEFORE calling parsePdfTable.
 *   - When the header isn't found at all, returns []. Caller can
 *     inspect this case via the (empty) return and fall back to a
 *     state-specific parser.
 */
export function parsePdfTable(
  text: string,
  opts: ParsePdfTableOptions,
): ParsedRow[] {
  const lines = splitByLines(text);
  const minGap = opts.min_gap_spaces ?? 2;
  const splitRegex = new RegExp(`\\s{${minGap},}`);

  let headerIdx = -1;
  let headerCells: string[] = [];
  let columnMap: Array<{ def: ColumnDef; idx: number | null }> = [];

  for (let i = 0; i < lines.length; i += 1) {
    const cells = lines[i]!.trim().split(splitRegex).filter((c) => c.length > 0);
    if (cells.length < 2) continue;

    // Try to map every required column to a header cell. If we hit them
    // all, this is the header row.
    const probe = opts.columns.map((def) => ({
      def,
      idx: findColumnByHeader(cells, def),
    }));
    const requiredOk = opts.columns
      .filter((c) => c.required)
      .every((c) => probe.find((p) => p.def === c)?.idx != null);
    if (requiredOk && probe.some((p) => p.idx != null)) {
      headerIdx = i;
      headerCells = cells;
      columnMap = probe;
      break;
    }
  }

  if (headerIdx < 0) return [];

  const out: ParsedRow[] = [];
  let currentSection: string | undefined;
  for (let i = headerIdx + 1; i < lines.length; i += 1) {
    const raw = lines[i] ?? '';
    const trimmed = raw.trim();
    if (!trimmed) continue;

    if (opts.section_marker_regex) {
      const m = opts.section_marker_regex.exec(trimmed);
      if (m) {
        currentSection = m[0];
        continue;
      }
    }

    const cells = trimmed.split(splitRegex);
    if (cells.length < 2) continue;

    const row: ParsedRow = { _raw: raw, _lineIndex: i };
    if (currentSection) row._section = currentSection;

    let missingRequired = false;
    for (const { def, idx } of columnMap) {
      const cell = idx != null ? (cells[idx] ?? '').trim() : '';
      const value = def.transform ? def.transform(cell) : cell;
      row[def.name] = value;
      if (def.required && (value == null || value === '')) {
        missingRequired = true;
      }
    }
    if (missingRequired) continue;
    out.push(row);
  }

  return out;
}

// ---------------------------------------------------------------------------
// Convenience: fetch + extract in one call (used by adapters).
// ---------------------------------------------------------------------------

/**
 * Tiny convenience: fetch a PDF URL via the runtime's `fetch` and pipe
 * the bytes through extractTextFromPdf. Adapters that already have a
 * politeFetch wrapper should call extractTextFromPdf directly with the
 * bytes from their own fetcher; this helper exists for tests and ad-hoc
 * scripts.
 */
export async function fetchAndExtractPdf(
  url: string,
  init?: RequestInit,
): Promise<{ pages: string[]; metadata: PdfMetadata; bytes: Uint8Array }> {
  const res = await fetch(url, init);
  if (!res.ok) {
    throw new Error(`fetchAndExtractPdf: HTTP ${res.status} from ${url}`);
  }
  const ab = await res.arrayBuffer();
  const bytes = new Uint8Array(ab);
  const { pages, metadata } = await extractTextFromPdf(bytes);
  return { pages, metadata, bytes };
}
