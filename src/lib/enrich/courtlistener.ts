/**
 * enrich/courtlistener.ts -- CourtListener REST v4 docket search (litigation).
 *
 * NAME-ONLY source. CourtListener has no strong-id crosswalk for our people, so
 * the ONLY key is the candidate's name. Names are NOT unique -> the wrong
 * "John Smith" attached to a lawsuit is a DEFAMATION risk. Therefore every row
 * here is STAGED, NEVER auto-bound:
 *   bind_method='name_match', verified=false, requires_strong_id=true, with a
 *   mandatory `note` instructing human review before any surfacing.
 *
 * Endpoint (courtlistener.com/api/rest/v4):
 *   GET /search/?type=d&q="{name}"   -> docket search results
 *
 * Auth: env COURTLISTENER_TOKEN (a "Token <token>" Authorization header). The
 * token MAY be unset -- if so we SKIP this source gracefully (return []) rather
 * than firing unauthenticated requests.
 *
 * Produces ZERO-OR-MORE candidate_records rows of record_type='litigation',
 * one per matched docket (capped), each staged for review.
 */

import {
  fetchJson,
  nameMatchRow,
  type CandidateRecordRow,
  type EnrichContext,
} from './types';

const CL_BASE = 'https://www.courtlistener.com/api/rest/v4';
const MAX_DOCKETS = 10;

function authHeader(): Record<string, string> | null {
  const t = process.env.COURTLISTENER_TOKEN;
  if (!t || !t.trim()) return null;
  return { Authorization: `Token ${t.trim()}` };
}

export interface CourtListenerDocket {
  id?: number;
  docketNumber?: string;
  caseName?: string;
  court?: string;
  court_id?: string;
  dateFiled?: string;
  dateTerminated?: string;
  absolute_url?: string;
  nature_of_suit?: string;
}

interface SearchResponse {
  count?: number;
  results?: CourtListenerDocket[];
}

/**
 * PURE. Map docket search results into staged litigation rows. Each row is
 * name-only -> verified=false, requires_strong_id=true.
 */
export function normalizeCourtListener(
  name: string,
  dockets: CourtListenerDocket[],
  ctx: EnrichContext,
  fetchedAt?: string,
): CandidateRecordRow[] {
  const note =
    `NAME-MATCH ONLY (CourtListener). Searched docket text for "${name}". ` +
    `Homonym + defamation risk: confirm this docket is THIS person before any ` +
    `surfacing. requires_strong_id=true until human-verified.`;

  return (dockets ?? []).slice(0, MAX_DOCKETS).map((d) => {
    const ref = d.id != null ? String(d.id) : (d.docketNumber ?? d.caseName ?? null);
    const url = d.absolute_url
      ? `https://www.courtlistener.com${d.absolute_url}`
      : null;
    return nameMatchRow({
      person_id: ctx.person_id,
      record_type: 'litigation',
      source: 'courtlistener',
      source_url: url,
      external_ref: ref,
      payload: {
        searched_name: name,
        docket_id: d.id ?? null,
        docket_number: d.docketNumber ?? null,
        case_name: d.caseName ?? null,
        court: d.court ?? d.court_id ?? null,
        date_filed: d.dateFiled ?? null,
        date_terminated: d.dateTerminated ?? null,
        nature_of_suit: d.nature_of_suit ?? null,
      },
      note,
      bind_confidence: 0.2, // litigation: lowest confidence, highest scrutiny
      fetched_at: fetchedAt,
    });
  });
}

/**
 * fetchCourtListener: docket search by name. NAME-ONLY -> all rows staged.
 * Skips gracefully (returns []) when COURTLISTENER_TOKEN is unset.
 */
export async function fetchCourtListener(
  name: string,
  ctx: EnrichContext,
): Promise<CandidateRecordRow[]> {
  const auth = authHeader();
  if (!auth) return []; // no token -> skip per spec (code it, skip gracefully)
  if (!name || !name.trim()) return [];

  let dockets: CourtListenerDocket[] = [];
  try {
    const url =
      `${CL_BASE}/search/?type=d&order_by=score%20desc&q=` +
      encodeURIComponent(`"${name.trim()}"`);
    const res = await fetchJson<SearchResponse>(url, { headers: auth });
    dockets = res.results ?? [];
  } catch (e) {
    // 404 / empty search = no records, not an error.
    if (!(e instanceof Error && /HTTP 404/.test(e.message))) throw e;
  }

  return normalizeCourtListener(name.trim(), dockets, ctx);
}
