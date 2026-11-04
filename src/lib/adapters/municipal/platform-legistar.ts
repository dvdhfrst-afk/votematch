/**
 * Shared Legistar fetcher + parser.
 *
 * Legistar (owned by Granicus) is the dominant civic-meetings platform in
 * major US cities. The important architectural property is that the
 * web-facing UI differs per city (<client>.legistar.com) but the *data*
 * API is uniform:
 *
 *   GET https://webapi.legistar.com/v1/<client>/Events
 *       ?$filter=EventDate ge datetime'<iso>' and EventDate le datetime'<iso>'
 *       &$top=1000
 *
 * Returns a JSON array of Event objects with a stable shape (see
 * {@link LegistarEvent}). API keys are optional — without a key the endpoint
 * is rate-limited per-IP but otherwise equivalent. We throttle ourselves to
 * 0.5 rps with burst 2 (per the operator's constraint) which keeps us well under
 * any documented ceiling.
 *
 * Intentionally does NOT own HTTP — fetch is passed in by the adapter base
 * so unit tests can drive synthetic JSON without network.
 */

/**
 * Shape of the Legistar /Events response (fields we consume). Legistar
 * sends quite a few more columns (`EventInSiteURL`, `EventGuid`, etc.) but
 * we only keep the ones that map to municipal_meetings.
 */
export type LegistarEvent = {
  EventId: number;
  EventBodyName: string;
  EventDate: string;
  EventTime: string | null;
  EventLocation: string | null;
  EventAgendaFile: string | null;
  EventMinutesFile: string | null;
  EventInSiteURL: string | null;
  EventComment: string | null;
};

/** Intermediate row produced by the Legistar parser; consumed by the base adapter. */
export type LegistarMeetingRow = {
  title: string;
  meeting_datetime: string;
  jurisdiction_type: 'city_council' | 'planning' | 'school_board' | 'other';
  agenda_url: string | null;
  minutes_url: string | null;
  source_url: string;
  event_id: number;
};

export type LegistarFetchOptions = {
  /** Legistar client slug, e.g. 'chicago' for chicago.legistar.com. */
  client: string;
  /** Window start (inclusive), ISO 8601. */
  sinceIso: string;
  /** Window end (inclusive), ISO 8601. */
  untilIso: string;
  /**
   * Injected fetch — lets unit tests hand back synthetic JSON and lets the
   * adapter base inject a rate-limited fetch wrapper.
   */
  fetchFn: (url: string) => Promise<{ status: number; body: string }>;
  /** Optional API key; Legistar accepts it as the `token` query param. */
  apiKey?: string;
};

export const LEGISTAR_API_BASE = 'https://webapi.legistar.com/v1';

/**
 * Build the Legistar Events URL for a date window.
 *
 * The OData $filter syntax is fussy — Legistar requires datetime'YYYY-MM-DD'
 * literals *without* timezone suffixes. We coerce any ISO string down to a
 * date-only literal which matches Legistar's server-side comparison (they
 * store EventDate as a date, not a datetime).
 */
export function buildLegistarEventsUrl(opts: LegistarFetchOptions): string {
  const since = opts.sinceIso.slice(0, 10);
  const until = opts.untilIso.slice(0, 10);
  const filter = `EventDate ge datetime'${since}' and EventDate le datetime'${until}'`;
  const params = new URLSearchParams({
    $filter: filter,
    $orderby: 'EventDate asc',
    $top: '1000',
  });
  if (opts.apiKey) params.set('token', opts.apiKey);
  return `${LEGISTAR_API_BASE}/${encodeURIComponent(opts.client)}/Events?${params.toString()}`;
}

/**
 * Call Legistar /Events and return parsed Events. Throws only on transport
 * failures (non-2xx, malformed JSON) — empty arrays are a legitimate result
 * for a future date window with no scheduled meetings.
 */
export async function fetchLegistarEvents(
  opts: LegistarFetchOptions,
): Promise<LegistarEvent[]> {
  const url = buildLegistarEventsUrl(opts);
  const res = await opts.fetchFn(url);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(
      `legistar: HTTP ${res.status} on ${url.replace(/token=[^&]+/, 'token=***')}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.body);
  } catch (err) {
    throw new Error(
      `legistar: malformed JSON (${(err as Error).message}) — first 200 chars: ${res.body.slice(0, 200)}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error('legistar: expected top-level JSON array');
  }
  // Keep only the fields we care about; tolerate extra columns.
  return parsed.map((raw): LegistarEvent => {
    const e = raw as Record<string, unknown>;
    return {
      EventId: typeof e.EventId === 'number' ? e.EventId : Number(e.EventId ?? 0),
      EventBodyName: String(e.EventBodyName ?? ''),
      EventDate: String(e.EventDate ?? ''),
      EventTime: e.EventTime == null ? null : String(e.EventTime),
      EventLocation: e.EventLocation == null ? null : String(e.EventLocation),
      EventAgendaFile: e.EventAgendaFile == null ? null : String(e.EventAgendaFile),
      EventMinutesFile: e.EventMinutesFile == null ? null : String(e.EventMinutesFile),
      EventInSiteURL: e.EventInSiteURL == null ? null : String(e.EventInSiteURL),
      EventComment: e.EventComment == null ? null : String(e.EventComment),
    };
  });
}

/**
 * Map an EventBodyName to one of our five municipal jurisdiction_type enums.
 * The heuristic is deliberately loose — Legistar body names are free-text
 * and vary widely between cities ("City Council", "Council", "Planning
 * Commission", "Board of Education", etc.).
 */
export function classifyBody(bodyName: string): LegistarMeetingRow['jurisdiction_type'] {
  const n = bodyName.toLowerCase();
  if (n.includes('school') || n.includes('education')) return 'school_board';
  if (n.includes('planning') || n.includes('zoning') || n.includes('land use')) {
    return 'planning';
  }
  if (n.includes('council') || n.includes('board of supervisors') || n.includes('board of aldermen')) {
    return 'city_council';
  }
  return 'other';
}

/**
 * Combine Legistar EventDate + EventTime into an ISO timestamp. Legistar
 * emits EventDate as 'YYYY-MM-DDT00:00:00' (local, no TZ) and EventTime as
 * a 12-hour clock string like '10:00 AM' or null. We don't know the city's
 * timezone here, so we emit a naive ISO (no 'Z') and let downstream
 * consumers supply the city TZ via policy (city lookup table).
 */
export function combineLegistarDateTime(
  eventDate: string,
  eventTime: string | null,
): string {
  const datePart = eventDate.slice(0, 10);
  if (!eventTime) {
    return `${datePart}T00:00:00`;
  }
  // Try '10:00 AM' style.
  const match = eventTime.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
  if (!match) {
    // Fall through: leave whatever Legistar sent, best-effort.
    return `${datePart}T00:00:00`;
  }
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const ampm = match[3]?.toUpperCase();
  if (ampm === 'PM' && hour < 12) hour += 12;
  if (ampm === 'AM' && hour === 12) hour = 0;
  const hh = String(hour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  return `${datePart}T${hh}:${mm}:00`;
}

/**
 * Turn raw LegistarEvent objects into the intermediate row shape the base
 * adapter hands to the DB insert path. Filters out events missing the
 * essentials (date + body).
 */
export function parseLegistarEvents(
  events: LegistarEvent[],
  client: string,
): LegistarMeetingRow[] {
  const rows: LegistarMeetingRow[] = [];
  for (const ev of events) {
    if (!ev.EventDate || !ev.EventBodyName) continue;
    const meeting_datetime = combineLegistarDateTime(ev.EventDate, ev.EventTime);
    // source_url prefers the site URL if Legistar gave us one, else
    // synthesize the MeetingDetail link (stable pattern used by every
    // Legistar install).
    const source_url =
      ev.EventInSiteURL ??
      `https://${encodeURIComponent(client)}.legistar.com/MeetingDetail.aspx?ID=${ev.EventId}`;
    rows.push({
      title: ev.EventBodyName,
      meeting_datetime,
      jurisdiction_type: classifyBody(ev.EventBodyName),
      agenda_url: ev.EventAgendaFile,
      minutes_url: ev.EventMinutesFile,
      source_url,
      event_id: ev.EventId,
    });
  }
  return rows;
}
