/**
 * enrich/openstates.ts -- OpenStates v3 current role / office.
 *
 * Strong-id source: bound by openstates_id (kind 'openstates_id' in
 * person_xref, an ocd-person/... id). AUTO-BIND: verified=true,
 * bind_confidence=1.0.
 *
 * Endpoint (v3.openstates.org):
 *   GET /people?id={ocd-person-id}&include=other_identifiers
 *   (the /people endpoint accepts an `id` filter; we read results[0].)
 *
 * Key: env OPENSTATES_API_KEY, sent as the X-API-KEY header.
 *
 * LICENSE NOTE (app/CLAUDE.md + person_xref migration): OpenStates data is
 * share-alike; we store the current OFFICE/ROLE FACT for our own use and never
 * redistribute the OpenStates corpus. The crosswalk id is reference-only.
 *
 * Produces ONE candidate_records row of record_type='state_role'.
 *
 * Skips gracefully (returns []) when OPENSTATES_API_KEY is unset.
 */

import {
  fetchJson,
  strongIdRow,
  type CandidateRecordRow,
  type EnrichContext,
} from './types';

const OPENSTATES_BASE = 'https://v3.openstates.org';

function apiKey(): string | null {
  const k = process.env.OPENSTATES_API_KEY;
  return k && k.trim() ? k.trim() : null;
}

export interface OpenStatesRole {
  type?: string; // 'upper' | 'lower' | ...
  title?: string;
  org_classification?: string;
  district?: string;
  start_date?: string;
  end_date?: string;
}

export interface OpenStatesPerson {
  id?: string; // ocd-person/...
  name?: string;
  party?: string;
  current_role?: {
    title?: string;
    org_classification?: string;
    district?: string | number;
    division_id?: string;
  };
  jurisdiction?: { id?: string; name?: string; classification?: string };
  given_name?: string;
  family_name?: string;
  email?: string;
  roles?: OpenStatesRole[];
  offices?: Array<{ classification?: string; address?: string; voice?: string }>;
  updated_at?: string;
}

interface PeopleResponse {
  results?: OpenStatesPerson[];
}

/** PURE. Map an OpenStates person record to a state_role row. */
export function normalizeOpenStates(
  openstatesId: string,
  person: OpenStatesPerson | null,
  ctx: EnrichContext,
  fetchedAt?: string,
): CandidateRecordRow[] {
  if (!person) return [];

  const payload: Record<string, unknown> = {
    openstates_id: openstatesId,
    name: person.name ?? null,
    party: person.party ?? null,
    current_role: person.current_role
      ? {
          title: person.current_role.title ?? null,
          org_classification: person.current_role.org_classification ?? null,
          district: person.current_role.district ?? null,
          division_id: person.current_role.division_id ?? null,
        }
      : null,
    jurisdiction: person.jurisdiction
      ? {
          name: person.jurisdiction.name ?? null,
          classification: person.jurisdiction.classification ?? null,
        }
      : null,
    email: person.email ?? null,
    updated_at: person.updated_at ?? null,
  };

  return [
    strongIdRow({
      person_id: ctx.person_id,
      record_type: 'state_role',
      source: 'openstates',
      source_url: `https://openstates.org/person/${encodeURIComponent(openstatesId)}/`,
      external_ref: openstatesId,
      payload,
      id_kind: 'openstates_id',
      fetched_at: fetchedAt,
    }),
  ];
}

/**
 * fetchOpenStates: current role / office. Bound by openstates_id.
 */
export async function fetchOpenStates(
  openstatesId: string,
  ctx: EnrichContext,
): Promise<CandidateRecordRow[]> {
  const key = apiKey();
  if (!key) return []; // no key configured -> skip this source quietly

  let person: OpenStatesPerson | null = null;
  try {
    const res = await fetchJson<PeopleResponse>(
      `${OPENSTATES_BASE}/people?id=${encodeURIComponent(openstatesId)}&include=offices`,
      { headers: { 'X-API-KEY': key } },
    );
    person = res.results?.[0] ?? null;
  } catch (e) {
    if (!(e instanceof Error && /HTTP 404/.test(e.message))) throw e;
  }

  return normalizeOpenStates(openstatesId, person, ctx);
}
