/**
 * Telerik RadGrid HTML extractor.
 *
 * Why this is its own module
 * --------------------------
 * Many ASP.NET state and county portals serve candidate filings through
 * Telerik's RadGrid component. The Montana SOS adapter (the canonical
 * "92% email yield" reference) is one example; many county clerks running
 * older ASP.NET WebForms apps share the same generated markup.
 *
 * RadGrid renders a `<table class="rgMasterTable">` with a `<thead>` of
 * `<th class="rgHeader">` cells and a `<tbody>` of alternating
 * `tr.rgRow` / `tr.rgAltRow` rows. Pagination is a separate
 * `<div class="rgWrap rgInfoPart">` that prints "Page 1 of N" — concrete
 * adapters that need pagination loop until that "Page X of N" reaches N.
 *
 * Implementation notes
 * --------------------
 * - We use `cheerio` (already a dep — package.json line 65) for DOM-safe
 *   extraction. RadGrid markup is well-formed enough that a regex pass
 *   would also work, but cheerio handles the inevitable `<br>` and
 *   `&nbsp;` quirks for us.
 * - Empty grid: when the portal has no rows it renders
 *   `<tr class="rgNoRecords"><td>No records to display.</td></tr>`. We
 *   detect that and return `[]` — same shape as a missing tbody.
 * - This module is **pure**. It takes HTML in, returns row dicts out.
 *   Per-county adapters do the fetch + column-mapping themselves.
 */

import * as cheerio from 'cheerio';

/**
 * Pure-functional extractor for the Telerik RadGrid HTML table pattern.
 *
 * Intended usage from a per-county adapter:
 *
 * ```ts
 * const html = await fetch(url).then((r) => r.text());
 * const rows = new TelerikRadGridScraper().extractRows(html, {
 *   'Candidate': 'canonical_name',
 *   'Party':     'party',
 *   'Office':    'office_canonical_name',
 *   'District':  'district',
 *   'Email':     'contact_email',
 * });
 * ```
 *
 * The columnMap keys are header labels as printed on the page; values are
 * the property names you want on each result row.
 */
export class TelerikRadGridScraper {
  /**
   * Extract data rows from a RadGrid HTML body.
   *
   * @param html - Full HTML body of the RadGrid page (or a fragment as
   *   long as it contains the `table.rgMasterTable` element).
   * @param columnMap - Map from RadGrid column header (case-insensitive) to
   *   the desired output property name. Headers not in the map are dropped.
   * @returns One object per data row. Returns `[]` for an empty grid or a
   *   page with no `rgMasterTable`.
   */
  extractRows(
    html: string,
    columnMap: Record<string, string>,
  ): Record<string, string>[] {
    if (!html) return [];

    const $ = cheerio.load(html);
    const $table = $('table.rgMasterTable').first();
    if ($table.length === 0) return [];

    // Build a map from column index → output property name.
    const headerCells = $table
      .find('thead th, thead td')
      .toArray()
      .map((th) => normalizeHeader($(th).text()));

    // Some skins put the headers in the first body row; fall back if
    // <thead> was empty.
    let headers = headerCells.filter((h) => h.length > 0);
    if (headers.length === 0) {
      const firstRow = $table.find('tr').first();
      headers = firstRow
        .find('th, td')
        .toArray()
        .map((td) => normalizeHeader($(td).text()));
    }

    const lowerColumnMap = new Map<string, string>();
    for (const [k, v] of Object.entries(columnMap)) {
      lowerColumnMap.set(k.toLowerCase().trim(), v);
    }

    // Map column index → output property name (or undefined to skip).
    const indexMap: (string | undefined)[] = headers.map((h) =>
      lowerColumnMap.get(h.toLowerCase()),
    );
    if (indexMap.every((m) => m === undefined)) {
      // Header row didn't match any of the requested columns — likely a
      // skin variant; bail out rather than emit empty rows.
      return [];
    }

    const out: Record<string, string>[] = [];
    $table.find('tbody tr, > tr').each((_, tr) => {
      const $tr = $(tr);
      // Skip header rows we may have already consumed and the explicit
      // "no records" placeholder.
      if (
        $tr.hasClass('rgHeader') ||
        $tr.hasClass('rgNoRecords') ||
        $tr.find('td.rgNoRecords').length > 0
      ) {
        return;
      }
      const cells = $tr.find('td').toArray();
      if (cells.length === 0) return;

      const row: Record<string, string> = {};
      cells.forEach((td, i) => {
        const propName = indexMap[i];
        if (!propName) return;
        row[propName] = normalizeCell($(td).text());
      });
      // Drop rows where every mapped cell came back empty.
      if (Object.values(row).some((v) => v.length > 0)) {
        out.push(row);
      }
    });

    return out;
  }
}

// ---------------------------------------------------------------------------
// Helpers — exported for tests, internal otherwise
// ---------------------------------------------------------------------------

/** Strip whitespace + collapse runs to single spaces. */
function normalizeHeader(text: string): string {
  return text.replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
}

/** Same as normalizeHeader but also collapses common entity remnants. */
function normalizeCell(text: string): string {
  return text
    .replace(/ /g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
