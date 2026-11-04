/**
 * enrich/irs990.ts -- IRS (Internal Revenue Service) Form 990 nonprofit ties via
 * the ProPublica Nonprofit Explorer API.
 *
 * NAME-ONLY source, LOW PRIORITY. ProPublica's Nonprofit Explorer is a free,
 * no-key public API over IRS Form 990 filings (the IRS's own machine-readable
 * 990 release). There is no person crosswalk, so we search ORGANIZATION names
 * for the candidate's name (officers/board members surface in org records) and
 * STAGE every hit:
 *   bind_method='name_match', verified=false, requires_strong_id=true.
 *
 * Endpoint (projects.propublica.org/nonprofits/api/v2):
 *   GET /search.json?q={name}   -> organizations matching the query
 *
 * No API key. No license fee. Produces ZERO-OR-MORE candidate_records rows of
 * record_type='nonprofit', one per matched organization (capped), each staged.
 *
 * NOTE ON BINDING: matching a person to a nonprofit purely by a name appearing
 * in org text is weak. These rows exist to give a human reviewer a lead, never
 * to publish a "this candidate runs X nonprofit" claim automatically.
 */

import {
  fetchJson,
  nameMatchRow,
  type CandidateRecordRow,
  type EnrichContext,
} from './types';

const PP_BASE = 'https://projects.propublica.org/nonprofits/api/v2';
const MAX_ORGS = 10;

export interface ProPublicaOrg {
  ein?: number;
  name?: string;
  sub_name?: string;
  city?: string;
  state?: string;
  ntee_code?: string;
  raw_ntee_code?: string;
  score?: number;
}

interface SearchResponse {
  total_results?: number;
  organizations?: ProPublicaOrg[];
}

/** Pad an EIN to the 9-digit XX-XXXXXXX style ProPublica uses in URLs. */
function einString(ein: number | undefined): string | null {
  if (ein == null) return null;
  return String(ein);
}

/**
 * PURE. Map ProPublica org search results into staged nonprofit rows. Each row
 * is name-only -> verified=false, requires_strong_id=true.
 */
export function normalizeIrs990(
  name: string,
  orgs: ProPublicaOrg[],
  ctx: EnrichContext,
  fetchedAt?: string,
): CandidateRecordRow[] {
  const note =
    `NAME-MATCH ONLY (IRS Form 990 via ProPublica Nonprofit Explorer). ` +
    `Searched organization records for "${name}". A name appearing in an org's ` +
    `990 does not establish an officer/board tie; confirm before any surfacing. ` +
    `requires_strong_id=true until human-verified.`;

  return (orgs ?? []).slice(0, MAX_ORGS).map((o) => {
    const ein = einString(o.ein);
    return nameMatchRow({
      person_id: ctx.person_id,
      record_type: 'nonprofit',
      source: 'irs990',
      source_url: ein
        ? `https://projects.propublica.org/nonprofits/organizations/${ein}`
        : null,
      external_ref: ein,
      payload: {
        searched_name: name,
        ein: o.ein ?? null,
        org_name: o.name ?? null,
        sub_name: o.sub_name ?? null,
        city: o.city ?? null,
        state: o.state ?? null,
        ntee_code: o.ntee_code ?? o.raw_ntee_code ?? null,
        search_score: o.score ?? null,
      },
      note,
      bind_confidence: 0.2,
      fetched_at: fetchedAt,
    });
  });
}

/**
 * fetchIrs990: nonprofit search by name. NAME-ONLY -> staged. No key required.
 */
export async function fetchIrs990(
  name: string,
  ctx: EnrichContext,
): Promise<CandidateRecordRow[]> {
  if (!name || !name.trim()) return [];

  let orgs: ProPublicaOrg[] = [];
  try {
    const url = `${PP_BASE}/search.json?q=${encodeURIComponent(name.trim())}`;
    const res = await fetchJson<SearchResponse>(url);
    orgs = res.organizations ?? [];
  } catch (e) {
    if (!(e instanceof Error && /HTTP 404/.test(e.message))) throw e;
  }

  return normalizeIrs990(name.trim(), orgs, ctx);
}
