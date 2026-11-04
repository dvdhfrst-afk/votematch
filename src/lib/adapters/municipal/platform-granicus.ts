/**
 * Shared Granicus calendar scraper.
 *
 * Granicus (the pre-Legistar legacy product, still in use for city-council
 * calendars on <client>.granicus.com and embedded widgets on city-owned
 * domains) does NOT publish an open REST API. We scrape the standard
 * MediaManager/ViewPublisher calendar HTML, which has been stable for
 * over a decade.
 *
 * The typical markup shape we target:
 *
 *   <table class="listingTable">
 *     <tr class="listingRow">
 *       <td class="listItem" headers="Name">City Council Meeting</td>
 *       <td class="listItem" headers="Date">Apr 29, 2026 - 10:00 AM</td>
 *       <td class="listItem" headers="Agenda">
 *         <a href="/AgendaViewer.php?view_id=1&event_id=123">Agenda</a>
 *       </td>
 *     </tr>
 *     ...
 *   </table>
 *
 * Some installations use slightly different class names; we fall back to
 * a second, looser regex that pulls any row that has at least one
 * AgendaViewer-style link.
 *
 * This parser is intentionally regex-only — parsing full HTML would pull
 * in jsdom and its many native deps; the marginal correctness gain isn't
 * worth it for a structured calendar widget.
 */

export type GranicusMeetingRow = {
  title: string;
  /** ISO 8601, naive (no TZ). */
  meeting_datetime: string;
  jurisdiction_type: 'city_council' | 'planning' | 'school_board' | 'other';
  agenda_url: string | null;
  minutes_url: string | null;
  source_url: string;
};

export type GranicusParseOptions = {
  /** Base URL to resolve relative agenda/minutes links against. */
  baseUrl: string;
};

/**
 * Resolve a possibly-relative href against the calendar's base URL.
 * We use URL() so callers don't have to think about trailing slashes.
 */
export function resolveGranicusHref(href: string, baseUrl: string): string {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return href;
  }
}

/** Month lookup for the date regex. */
const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * Parse a Granicus-style date cell, e.g. "Apr 29, 2026 - 10:00 AM" or
 * "April 29, 2026 10:00 AM" or just "Apr 29, 2026". Returns null if we
 * can't recognize the month at all.
 */
export function parseGranicusDate(cell: string): string | null {
  const cleaned = cell.replace(/\s+/g, ' ').trim();
  const re = /([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})(?:[^\d]+(\d{1,2}):(\d{2})\s*(AM|PM)?)?/;
  const m = cleaned.match(re);
  if (!m) return null;
  const mon = MONTHS[m[1].slice(0, 3).toLowerCase()];
  if (!mon) return null;
  const day = Number(m[2]);
  const year = Number(m[3]);
  let hour = m[4] ? Number(m[4]) : 0;
  const minute = m[5] ? Number(m[5]) : 0;
  const ampm = m[6]?.toUpperCase();
  if (ampm === 'PM' && hour < 12) hour += 12;
  if (ampm === 'AM' && hour === 12) hour = 0;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${year}-${pad(mon)}-${pad(day)}T${pad(hour)}:${pad(minute)}:00`;
}

/**
 * Classify a meeting title into one of our five jurisdiction_type enums.
 * Same heuristic as the Legistar classifier for consistency across cities
 * that publish on both platforms (video on Granicus, agendas on Legistar).
 */
export function classifyGranicusTitle(
  title: string,
): GranicusMeetingRow['jurisdiction_type'] {
  const n = title.toLowerCase();
  if (n.includes('school') || n.includes('education')) return 'school_board';
  if (n.includes('planning') || n.includes('zoning') || n.includes('land use')) {
    return 'planning';
  }
  if (n.includes('council') || n.includes('commission')) return 'city_council';
  return 'other';
}

/**
 * Very small HTML entity decoder — just the entities Granicus actually
 * emits. Avoids pulling in a dependency for five characters.
 */
function decodeBasicEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/**
 * Extract meeting rows from a Granicus calendar HTML document.
 *
 * Strategy: find every row containing an AgendaViewer link (or an
 * archive-document link), walk the nearest <tr>, pull out the cells by
 * header attribute first and by positional cell second.
 */
export function parseGranicusCalendar(
  html: string,
  opts: GranicusParseOptions,
): GranicusMeetingRow[] {
  const rows: GranicusMeetingRow[] = [];
  const rowRe = /<tr[^>]*class="[^"]*listingRow[^"]*"[^>]*>([\s\S]*?)<\/tr>/gi;
  let match: RegExpExecArray | null;
  while ((match = rowRe.exec(html)) !== null) {
    const rowHtml = match[1];
    const nameCell = extractCell(rowHtml, 'Name') ?? extractCell(rowHtml, 'Meeting');
    const dateCell = extractCell(rowHtml, 'Date') ?? extractCell(rowHtml, 'Meeting Date');
    const agendaCell = extractCell(rowHtml, 'Agenda');
    const minutesCell = extractCell(rowHtml, 'Minutes');
    if (!nameCell || !dateCell) continue;
    const title = decodeBasicEntities(stripTags(nameCell)).trim();
    const dateText = decodeBasicEntities(stripTags(dateCell)).trim();
    const meeting_datetime = parseGranicusDate(dateText);
    if (!title || !meeting_datetime) continue;
    const agendaHref = agendaCell ? extractFirstHref(agendaCell) : null;
    const minutesHref = minutesCell ? extractFirstHref(minutesCell) : null;
    rows.push({
      title,
      meeting_datetime,
      jurisdiction_type: classifyGranicusTitle(title),
      agenda_url: agendaHref ? resolveGranicusHref(agendaHref, opts.baseUrl) : null,
      minutes_url: minutesHref ? resolveGranicusHref(minutesHref, opts.baseUrl) : null,
      source_url: opts.baseUrl,
    });
  }
  return rows;
}

/** Pull a cell out of a row by its header= attribute value. */
function extractCell(rowHtml: string, header: string): string | null {
  const re = new RegExp(
    `<t[dh][^>]*headers="${escapeRegex(header)}"[^>]*>([\\s\\S]*?)<\\/t[dh]>`,
    'i',
  );
  const m = rowHtml.match(re);
  return m ? m[1] : null;
}

function extractFirstHref(cellHtml: string): string | null {
  const m = cellHtml.match(/href="([^"]+)"/i);
  return m ? m[1] : null;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, '');
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
