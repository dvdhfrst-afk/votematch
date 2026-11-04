/**
 * Minimal dependency-free HTML results-table extractor.
 *
 * Shared by AL / MS / TN / KY adapters where the SoS publishes an HTML
 * tabulation page rather than a structured API. We intentionally DO NOT
 * add a DOM parser dependency (cheerio, jsdom) — these tables are narrow,
 * well-formed-enough, and we already pay the maintenance cost of one XML
 * parser (fast-xml-parser) for NIST feeds.
 *
 * Limitations
 * -----------
 * - Assumes one <table> per contest OR one big table keyed by a contest
 *   column. Configurable per-state.
 * - Nested tables are NOT supported; all four target-state SoS result
 *   pages as of 2026-04-23 use flat tables per contest.
 * - rowspan/colspan in header are handled as best-effort; verify fixtures
 *   before relying on complex layouts.
 */

export type HtmlTable = {
  /** The <caption> or preceding <h2>/<h3> if detectable. */
  caption: string | null;
  headers: string[];
  rows: string[][];
};

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Extract all <table>...</table> blocks plus the nearest preceding heading. */
export function extractTables(html: string): HtmlTable[] {
  if (!html) return [];
  const out: HtmlTable[] = [];
  const tableRe = /<table\b[^>]*>([\s\S]*?)<\/table>/gi;
  let m: RegExpExecArray | null;
  while ((m = tableRe.exec(html)) !== null) {
    const tableStart = m.index;
    const tableBody = m[1];

    // Caption: prefer <caption>, else last <h1-h3> before this table.
    let caption: string | null = null;
    const capMatch = /<caption\b[^>]*>([\s\S]*?)<\/caption>/i.exec(tableBody);
    if (capMatch) {
      caption = stripTags(capMatch[1]);
    } else {
      const precede = html.slice(0, tableStart);
      const hMatches = Array.from(
        precede.matchAll(/<h([1-4])\b[^>]*>([\s\S]*?)<\/h\1>/gi),
      );
      if (hMatches.length > 0) {
        caption = stripTags(hMatches[hMatches.length - 1][2]);
      }
    }

    // Row extraction.
    const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
    const rawRows: string[][] = [];
    const isHeaderRow: boolean[] = [];
    let rm: RegExpExecArray | null;
    while ((rm = rowRe.exec(tableBody)) !== null) {
      const inner = rm[1];
      const cells: string[] = [];
      const cellRe = /<(th|td)\b[^>]*>([\s\S]*?)<\/\1>/gi;
      let cm: RegExpExecArray | null;
      let sawTh = false;
      while ((cm = cellRe.exec(inner)) !== null) {
        if (cm[1].toLowerCase() === 'th') sawTh = true;
        cells.push(stripTags(cm[2]));
      }
      if (cells.length === 0) continue;
      rawRows.push(cells);
      isHeaderRow.push(sawTh);
    }

    if (rawRows.length === 0) continue;

    // Determine header row: first row of all-<th>, else first row.
    const headerIdx = isHeaderRow.findIndex((b) => b);
    const effectiveHeaderIdx = headerIdx >= 0 ? headerIdx : 0;
    const headers = rawRows[effectiveHeaderIdx];
    const dataRows = rawRows.slice(effectiveHeaderIdx + 1);

    out.push({ caption, headers, rows: dataRows });
  }
  return out;
}

/** Normalize a header token for fuzzy column matching. */
export function normalizeHeader(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Find the first matching column index for any of `aliases` (already normalized). */
export function findColumn(
  headers: string[],
  aliases: string[],
): number {
  const normed = headers.map(normalizeHeader);
  for (const a of aliases) {
    const i = normed.indexOf(a);
    if (i >= 0) return i;
  }
  // Fall back: substring match
  for (let i = 0; i < normed.length; i += 1) {
    for (const a of aliases) {
      if (normed[i].includes(a)) return i;
    }
  }
  return -1;
}

export function toNum(s: string | null | undefined): number | null {
  if (!s) return null;
  const cleaned = s.replace(/[,%$\s]/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Extract a leading district number from a contest title ("District 5", "CD-01"). */
export function extractDistrict(s: string): string | null {
  if (!s) return null;
  const anchored = s.match(/\b(?:district|dist|cd|hd|sd)[-.\s]*0*(\d+)/i);
  if (anchored) return anchored[1];
  const trail = s.match(/\b0*(\d+)(?:st|nd|rd|th)?\s*$/i);
  if (trail) return trail[1];
  return null;
}
