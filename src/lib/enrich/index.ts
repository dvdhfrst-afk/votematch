/**
 * enrich/index.ts -- official structured-data enrichment for Havesay,
 * BOUND BY STRONG ID. This is Build 2 of the candidate-research ingestion
 * engine.
 *
 * WHAT THIS DOES
 *   Given a person_id, look up that person's registered external identifiers in
 *   person_xref (written by Build 1's strong-id crosswalk ingest) and dispatch
 *   to one wrapper per official government primary API. Each wrapper returns
 *   normalized candidate_records rows (see migration 20260614020000):
 *
 *     STRONG-ID sources (deterministic, AUTO-BIND):
 *       fec        -> campaign_finance   (by fec_candidate_id)
 *       congress   -> member_bio + sponsorship (by bioguide_id)
 *       openstates -> state_role         (by openstates_id)
 *
 *     NAME-ONLY sources (homonym + defamation risk, STAGE for review):
 *       courtlistener -> litigation      (by person name)
 *       edgar         -> business        (by person name)
 *       irs990        -> nonprofit       (by person name)
 *
 * BIND DISCIPLINE (mirrors src/lib/ingest/identity-resolve.ts):
 *   * strong-id sources set bind_method = 'strong_id:<kind>',
 *     bind_confidence = 1.0, verified = TRUE (for the structured fact itself).
 *   * name-only sources set bind_method = 'name_match', verified = FALSE,
 *     requires_strong_id = TRUE, with a `note` for human review. They NEVER
 *     auto-bind, because the only key is a name -- the wrong John Smith showing
 *     a lawsuit is a defamation risk.
 *
 * DATA-SOURCE POLICY (app/CLAUDE.md): every source here is an official
 * government primary API or a free no-license public mirror of one (ProPublica
 * Nonprofit Explorer wraps IRS 990 filings). We hold Ballotpedia / Vote Smart /
 * OpenSecrets / BallotReady IDs only as crosswalk in person_xref and NEVER fetch
 * their content.
 *
 * NO metered per-token API. NO new npm dependency: native fetch + small helpers.
 * Single TypeScript runtime, no Python.
 *
 * The exported wrappers are PURE relative to the DB: they fetch and normalize,
 * returning rows. The dispatching script (scripts/enrich-candidates.ts) opens
 * the pg connection, reads person_xref, calls these, and (in --apply mode)
 * upserts the rows transactionally via the candidate_records UNIQUE constraint.
 */

import type { QueryClient } from '@/lib/ingest/identity-resolve';
import { fetchFec } from './fec';
import { fetchCongress } from './congress';
import { fetchOpenStates } from './openstates';
import { fetchCourtListener } from './courtlistener';
import { fetchEdgar } from './edgar';
import { fetchIrs990 } from './irs990';
import type {
  CandidateRecordRow,
  EnrichContext,
  EnrichSource,
  PersonStrongIds,
} from './types';

export * from './types';
export {
  fetchFec,
  fetchCongress,
  fetchOpenStates,
  fetchCourtListener,
  fetchEdgar,
  fetchIrs990,
};

/** All sources, in a stable dispatch order (strong-id first, name-only last). */
export const ALL_SOURCES: readonly EnrichSource[] = [
  'fec',
  'congress',
  'openstates',
  'courtlistener',
  'edgar',
  'irs990',
] as const;

/** Sources that auto-bind deterministically (require a strong id in person_xref). */
export const STRONG_ID_SOURCES: readonly EnrichSource[] = [
  'fec',
  'congress',
  'openstates',
] as const;

/** Sources searched by NAME ONLY -- they stage rows for human review. */
export const NAME_ONLY_SOURCES: readonly EnrichSource[] = [
  'courtlistener',
  'edgar',
  'irs990',
] as const;

export function isValidSource(s: string): s is EnrichSource {
  return (ALL_SOURCES as readonly string[]).includes(s);
}

// ---------------------------------------------------------------------------
// Strong-id + person lookup (read-only)
// ---------------------------------------------------------------------------

/**
 * Read a person's registered strong ids from person_xref plus the canonical
 * name + primary state from people. Read-only. Returns a typed bundle the
 * dispatcher hands to each wrapper.
 */
export async function loadPersonStrongIds(
  client: QueryClient,
  personId: string,
): Promise<PersonStrongIds | null> {
  const personRes = await client.query<{
    id: string;
    canonical_name: string | null;
    state_fips_primary: string | null;
  }>(
    `SELECT id, canonical_name, state_fips_primary FROM people WHERE id = $1 LIMIT 1`,
    [personId],
  );
  if (!personRes.rowCount) return null;
  const p = personRes.rows[0];

  const xrefRes = await client.query<{ kind: string; external_id: string }>(
    `SELECT kind, external_id FROM person_xref WHERE person_id = $1`,
    [personId],
  );

  const byKind: Record<string, string> = {};
  for (const r of xrefRes.rows) {
    // First write wins per kind; person_xref enforces one external_id per
    // (kind, external_id) but a person could in theory hold two of the same
    // kind. We take the first deterministically (ordering is irrelevant for
    // enrichment correctness -- the wrapper just needs one valid id).
    if (!(r.kind in byKind)) byKind[r.kind] = r.external_id;
  }

  return {
    person_id: p.id,
    canonical_name: p.canonical_name,
    state_fips: p.state_fips_primary,
    fec_candidate_id: byKind['fec_candidate_id'] ?? null,
    bioguide_id: byKind['bioguide_id'] ?? null,
    openstates_id: byKind['openstates_id'] ?? null,
  };
}

// ---------------------------------------------------------------------------
// enrichPerson -- dispatch
// ---------------------------------------------------------------------------

export interface EnrichPersonResult {
  person_id: string;
  rows: CandidateRecordRow[];
  /** Per-source outcome for the CLI summary. */
  perSource: Record<
    EnrichSource,
    {
      fetched: number; // rows returned by the wrapper
      bound: number; // verified strong-id rows
      staged: number; // name-only rows (verified=false)
      skippedNoId: boolean; // strong-id source with no matching xref
      error: string | null;
    }
  >;
}

/**
 * enrichPerson(client, personId, sources): look up strong ids and dispatch to
 * the requested wrappers. Returns the normalized candidate_records rows plus a
 * per-source summary. This function does NOT write to the DB -- the caller
 * (scripts/enrich-candidates.ts) decides dry-run vs apply.
 *
 * Resilient: a single source throwing never aborts the others; the error is
 * captured in perSource[source].error and the dispatch continues.
 */
export async function enrichPerson(
  client: QueryClient,
  personId: string,
  sources: readonly EnrichSource[],
): Promise<EnrichPersonResult> {
  const ids = await loadPersonStrongIds(client, personId);

  const perSource = {} as EnrichPersonResult['perSource'];
  for (const s of ALL_SOURCES) {
    perSource[s] = { fetched: 0, bound: 0, staged: 0, skippedNoId: false, error: null };
  }

  const rows: CandidateRecordRow[] = [];
  if (!ids) {
    // Unknown person -- mark every requested source as skipped (no id).
    for (const s of sources) perSource[s].skippedNoId = true;
    return { person_id: personId, rows, perSource };
  }

  const ctx: EnrichContext = {
    person_id: personId,
    canonical_name: ids.canonical_name,
    state_fips: ids.state_fips,
  };

  for (const source of sources) {
    try {
      let produced: CandidateRecordRow[] = [];
      switch (source) {
        case 'fec':
          if (!ids.fec_candidate_id) {
            perSource.fec.skippedNoId = true;
            break;
          }
          produced = await fetchFec(ids.fec_candidate_id, ctx);
          break;
        case 'congress':
          if (!ids.bioguide_id) {
            perSource.congress.skippedNoId = true;
            break;
          }
          produced = await fetchCongress(ids.bioguide_id, ctx);
          break;
        case 'openstates':
          if (!ids.openstates_id) {
            perSource.openstates.skippedNoId = true;
            break;
          }
          produced = await fetchOpenStates(ids.openstates_id, ctx);
          break;
        case 'courtlistener':
          if (!ids.canonical_name) {
            perSource.courtlistener.skippedNoId = true;
            break;
          }
          produced = await fetchCourtListener(ids.canonical_name, ctx);
          break;
        case 'edgar':
          if (!ids.canonical_name) {
            perSource.edgar.skippedNoId = true;
            break;
          }
          produced = await fetchEdgar(ids.canonical_name, ctx);
          break;
        case 'irs990':
          if (!ids.canonical_name) {
            perSource.irs990.skippedNoId = true;
            break;
          }
          produced = await fetchIrs990(ids.canonical_name, ctx);
          break;
        default:
          break;
      }

      for (const r of produced) {
        rows.push(r);
        perSource[source].fetched += 1;
        if (r.verified) perSource[source].bound += 1;
        else perSource[source].staged += 1;
      }
    } catch (e) {
      perSource[source].error = e instanceof Error ? e.message : String(e);
    }
  }

  return { person_id: personId, rows, perSource };
}
