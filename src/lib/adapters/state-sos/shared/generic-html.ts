/**
 * Generic HTML results parser shared by the mountain/southwest state
 * adapters (MT, WY, CO, NM, AZ, ID, NV). The pattern repeats across most
 * SoS portals:
 *
 *   <heading> Race Name (maybe with district) </heading>
 *   <table>
 *     <thead>Candidate | Party | Votes | % | ...</thead>
 *     <tbody> <tr>...</tr> </tbody>
 *   </table>
 *
 * Individual adapters can override selectors, cell-header matchers, and
 * winner detection when a state's markup diverges from the default. The
 * Utah adapter deliberately has its own parser because Utah is the demo
 * state and warrants extra care; everything else funnels through here.
 *
 * This parser is intentionally conservative — it returns an empty array
 * rather than throwing on an unrecognized DOM so election-night runs mark
 * as 'partial' instead of 'failed' and ops can inspect the raw body.
 */

import { load as loadHtml } from 'cheerio';
import type { StateResultRow, StateReportingLevel } from '../base';

export type GenericHtmlParseOptions = {
  reportingLevel?: StateReportingLevel;
  /** Provenance tag baked into source_row_id for debuggability. */
  stateTag: string;
  /** Selectors for race-heading elements. Defaults to h1..h4. */
  headingSelector?: string;
  /**
   * Regex that a heading text must match for us to treat its following
   * table as a race-result table. Defaults to a common-office whitelist.
   */
  headingMatcher?: RegExp;
  /**
   * Return true when the given row represents the winner. Default detects
   * common class names / text markers.
   */
  isWinnerRow?: (rowHtml: string, cells: string[]) => boolean;
};

const DEFAULT_HEADING_MATCHER =
  /(governor|senator|representative|attorney|treasur|auditor|mayor|council|board|president|judge|justice|district|commission|sheriff|assessor|recorder|clerk|secretary|proposition|initiative|amendment|ballot\s*measure)/i;

export function parseGenericSosHtml(
  body: string,
  opts: GenericHtmlParseOptions,
): StateResultRow[] {
  const reportingLevel = opts.reportingLevel ?? 'unofficial_partial';
  const headingSelector = opts.headingSelector ?? 'h1, h2, h3, h4';
  const matcher = opts.headingMatcher ?? DEFAULT_HEADING_MATCHER;
  const isWinnerRow =
    opts.isWinnerRow ??
    ((html, _cells) =>
      /(class="[^"]*winner|\bwinner\b|\belected\b|data-winner="true")/i.test(
        html,
      ));

  const $ = loadHtml(body);
  const out: StateResultRow[] = [];
  let idx = 0;

  $(headingSelector).each((_i, el) => {
    const headingText = $(el).text().trim();
    if (!headingText || !matcher.test(headingText)) return;

    const table = $(el).nextAll('table').first();
    if (!table.length) return;

    const headers = table
      .find('thead th, tr').first()
      .find('th, td')
      .map((__, th) => $(th).text().trim().toLowerCase())
      .get();
    if (headers.length === 0) return;

    const findCol = (matchers: string[]): number => {
      for (let i = 0; i < headers.length; i++) {
        for (const m of matchers) {
          if (headers[i].includes(m)) return i;
        }
      }
      return -1;
    };
    const iName = findCol(['candidate', 'name']);
    const iParty = findCol(['party']);
    const iVotes = findCol(['vote', 'total']);
    const iPct = findCol(['%', 'percent']);
    if (iName < 0 || iVotes < 0) return;

    const { office_name, district_identifier } =
      splitOfficeDistrict(headingText);

    table.find('tbody tr, tr').each((__, tr) => {
      const cells = $(tr)
        .find('td')
        .map((___, td) => $(td).text().trim())
        .get();
      if (cells.length === 0) return;
      const name = cells[iName];
      if (!name) return;

      const isWriteIn = /write[\s-]?in/i.test(name);
      out.push({
        reported_name: name,
        party_abbreviation:
          iParty >= 0 ? normalizeParty(cells[iParty]) : null,
        office_name,
        district_identifier,
        vote_count: toIntOrNull(cells[iVotes]),
        vote_percentage: iPct >= 0 ? toPercentOrNull(cells[iPct]) : null,
        pct_precincts_reporting: null,
        is_winner: isWinnerRow($.html(tr), cells),
        is_runoff_advancer: false,
        is_write_in: isWriteIn,
        reporting_level: reportingLevel,
        source_row_id: `${opts.stateTag}:${idx++}`,
      });
    });
  });

  return out;
}

// ---------------------------------------------------------------------------
// Shared helpers (public so per-state parsers can reuse)
// ---------------------------------------------------------------------------

export function toIntOrNull(v: string | null | undefined): number | null {
  if (v == null) return null;
  const cleaned = v.replace(/[,\s]/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

export function toPercentOrNull(v: string | null | undefined): number | null {
  if (v == null) return null;
  const cleaned = v.replace(/%/g, '').replace(/\s/g, '');
  if (!cleaned || /^n\/?a$/i.test(cleaned)) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  if (n < 0 || n > 100) return null;
  return n;
}

export function normalizeParty(p: string | null | undefined): string | null {
  if (!p) return null;
  const t = p.trim();
  if (!t) return null;
  const map: Record<string, string> = {
    'democrat': 'DEM',
    'democratic': 'DEM',
    'republican': 'REP',
    'libertarian': 'LIB',
    'constitution': 'CON',
    'independent american': 'IAP',
    'independent': 'IND',
    'unaffiliated': 'UNA',
    'green': 'GRN',
    'non-partisan': 'NON',
    'nonpartisan': 'NON',
  };
  const key = t.toLowerCase();
  return map[key] ?? t.toUpperCase();
}

export function splitOfficeDistrict(raw: string): {
  office_name: string;
  district_identifier: string | null;
} {
  const m = raw.match(/district\s*(\d+)/i);
  if (!m) return { office_name: raw.trim(), district_identifier: null };
  const district = m[1];
  const office = raw.replace(/,?\s*district\s*\d+/i, '').trim() || raw.trim();
  return { office_name: office, district_identifier: district };
}
