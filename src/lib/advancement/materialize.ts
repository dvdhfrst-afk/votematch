/**
 * Given a primary winner (`from_candidacy_id`) and a target general/runoff
 * election (`to_election_id`), create the rows that put that person on the
 * next ballot:
 *
 *   1. `candidacies` — a new row for the target election (same person,
 *      inherited incumbency + primary party, status='active'). If the
 *      person already has a candidacy on the target election (e.g. manual
 *      pre-seeding, or a prior idempotent run), re-use it.
 *   2. `candidacy_party_lines` — mirror every ballot line from the primary
 *      candidacy (fusion-aware: NY / CT / SC / VT can carry multiple).
 *   3. `candidacy_advancement` — lineage record
 *      (from_candidacy_id, to_election_id, to_candidacy_id, advancement_rule,
 *      triggered_by_result_id). UNIQUE (from_candidacy_id, to_election_id)
 *      on the table makes ON CONFLICT DO NOTHING safe for re-runs.
 *
 * Idempotent by design — a second invocation for the same advancement is a
 * no-op (returns `created: false`). DB-internal only; no external calls.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { PrimaryAdvanceRule } from './rules';

export interface MaterializeInput {
  /** Pure-function rule output lineage: the primary candidacy. */
  fromCandidacyId: string;
  /** Target general (or runoff) election we're placing this person on. */
  toElectionId: string;
  /** Which rule produced this decision — recorded for traceability. */
  advancementRule: PrimaryAdvanceRule;
  /** Result row that triggered the advancement (for provenance). */
  triggeredByResultId?: string | null;
  /** When non-null, the script wrote in --dry-run mode and rolled nothing. */
  dryRun?: boolean;
}

export interface MaterializeOutput {
  /** True if we newly inserted the advancement row, false if it was already present. */
  created: boolean;
  /** New or pre-existing general-candidacy id (null if --dry-run).  */
  toCandidacyId: string | null;
  /** New or pre-existing candidacy_advancement id (null if --dry-run). */
  advancementId: string | null;
  /** How many candidacy_party_lines rows we carried over (0 in dry-run). */
  partyLinesCopied: number;
  /**
   * If we didn't create anything because the UNIQUE constraint already held
   * a row (re-run idempotency), we surface the reason for the summary line.
   */
  skippedReason?: 'already_advanced' | 'dry_run';
}

interface CandidacyRow {
  id: string;
  election_id: string;
  person_id: string;
  is_incumbent: boolean | null;
  primary_party_id: string | null;
  ballot_designation: string | null;
}

interface PartyLineRow {
  candidacy_id: string;
  party_id: string;
  ballot_line_order: number | null;
  nomination_method: string | null;
  qualified_on: string | null;
  data_source_id: string | null;
}

/**
 * Thin wrapper over Supabase error surface so the script can log & continue.
 */
export class MaterializeError extends Error {
  constructor(
    public readonly phase:
      | 'load_from_candidacy'
      | 'insert_candidacy'
      | 'load_party_lines'
      | 'insert_party_lines'
      | 'insert_advancement'
      | 'select_existing_advancement'
      | 'select_existing_candidacy',
    message: string,
  ) {
    super(message);
    this.name = 'MaterializeError';
  }
}

/**
 * Run one from→to materialization. Assumes the caller already filtered
 * `existing_advancement_id IS NULL` — but re-checks defensively (races
 * between query and write are possible when multiple pipelines run).
 */
export async function materializeAdvancement(
  supabase: SupabaseClient,
  input: MaterializeInput,
): Promise<MaterializeOutput> {
  const {
    fromCandidacyId,
    toElectionId,
    advancementRule,
    triggeredByResultId,
    dryRun = false,
  } = input;

  // --- 1. Load the primary candidacy -------------------------------------
  const fromRes = await supabase
    .from('candidacies')
    .select('id, election_id, person_id, is_incumbent, primary_party_id, ballot_designation')
    .eq('id', fromCandidacyId)
    .maybeSingle<CandidacyRow>();

  if (fromRes.error) {
    throw new MaterializeError('load_from_candidacy', fromRes.error.message);
  }
  if (!fromRes.data) {
    throw new MaterializeError(
      'load_from_candidacy',
      `from_candidacy ${fromCandidacyId} not found`,
    );
  }
  const fromCandidacy: CandidacyRow = fromRes.data;

  // --- 2. Short-circuit: already advanced? -------------------------------
  const existingAdvRes = await supabase
    .from('candidacy_advancement')
    .select('id, to_candidacy_id')
    .eq('from_candidacy_id', fromCandidacyId)
    .eq('to_election_id', toElectionId)
    .maybeSingle<{ id: string; to_candidacy_id: string | null }>();

  if (existingAdvRes.error) {
    throw new MaterializeError(
      'select_existing_advancement',
      existingAdvRes.error.message,
    );
  }
  if (existingAdvRes.data) {
    return {
      created: false,
      toCandidacyId: existingAdvRes.data.to_candidacy_id,
      advancementId: existingAdvRes.data.id,
      partyLinesCopied: 0,
      skippedReason: 'already_advanced',
    };
  }

  if (dryRun) {
    return {
      created: false,
      toCandidacyId: null,
      advancementId: null,
      partyLinesCopied: 0,
      skippedReason: 'dry_run',
    };
  }

  // --- 3. Find-or-insert the target candidacy ----------------------------
  //
  // There's a UNIQUE (election_id, person_id) on candidacies. If the person
  // somehow already has a candidacy on the target election (manual entry,
  // legacy import), reuse it — otherwise insert fresh.
  const existingToRes = await supabase
    .from('candidacies')
    .select('id')
    .eq('election_id', toElectionId)
    .eq('person_id', fromCandidacy.person_id)
    .maybeSingle<{ id: string }>();

  if (existingToRes.error) {
    throw new MaterializeError(
      'select_existing_candidacy',
      existingToRes.error.message,
    );
  }

  let toCandidacyId: string;
  if (existingToRes.data) {
    toCandidacyId = existingToRes.data.id;
  } else {
    const insertCandRes = await supabase
      .from('candidacies')
      .insert({
        election_id: toElectionId,
        person_id: fromCandidacy.person_id,
        status: 'active',
        is_incumbent: fromCandidacy.is_incumbent ?? false,
        primary_party_id: fromCandidacy.primary_party_id,
        ballot_designation: fromCandidacy.ballot_designation,
        meta: {
          source_primary_candidacy_id: fromCandidacyId,
          advanced_at: new Date().toISOString(),
          advancement_rule: advancementRule,
        },
      })
      .select('id')
      .single<{ id: string }>();

    if (insertCandRes.error || !insertCandRes.data) {
      throw new MaterializeError(
        'insert_candidacy',
        insertCandRes.error?.message ?? 'insert returned no row',
      );
    }
    toCandidacyId = insertCandRes.data.id;
  }

  // --- 4. Mirror party lines (fusion-aware) ------------------------------
  //
  // Carry over every line from the primary candidacy. cross_endorsement
  // semantics on the new rows: the nomination on the target ballot derives
  // from the primary win, so we mark the top line as 'primary' and any
  // additional lines as 'cross_endorsement' (typical fusion treatment —
  // the candidate won a primary on line 1, earns fusion lines 2+ by
  // carry-over convention).
  const linesRes = await supabase
    .from('candidacy_party_lines')
    .select('candidacy_id, party_id, ballot_line_order, nomination_method, qualified_on, data_source_id')
    .eq('candidacy_id', fromCandidacyId);

  if (linesRes.error) {
    throw new MaterializeError('load_party_lines', linesRes.error.message);
  }
  const sourceLines: PartyLineRow[] = linesRes.data ?? [];

  let partyLinesCopied = 0;
  if (sourceLines.length > 0) {
    const toInsert = sourceLines.map((row) => ({
      candidacy_id: toCandidacyId,
      party_id: row.party_id,
      ballot_line_order: row.ballot_line_order ?? 1,
      nomination_method:
        (row.ballot_line_order ?? 1) === 1 ? 'primary' : 'cross_endorsement',
      qualified_on: null,
      data_source_id: row.data_source_id,
    }));

    // ON CONFLICT on (candidacy_id, party_id) PK — re-runs are no-ops.
    const insertLinesRes = await supabase
      .from('candidacy_party_lines')
      .upsert(toInsert, {
        onConflict: 'candidacy_id,party_id',
        ignoreDuplicates: true,
      })
      .select('candidacy_id');

    if (insertLinesRes.error) {
      throw new MaterializeError('insert_party_lines', insertLinesRes.error.message);
    }
    partyLinesCopied = (insertLinesRes.data ?? []).length;
  }

  // --- 5. The lineage row ------------------------------------------------
  const advRes = await supabase
    .from('candidacy_advancement')
    .insert({
      from_candidacy_id: fromCandidacyId,
      to_election_id: toElectionId,
      to_candidacy_id: toCandidacyId,
      advancement_rule: advancementRule,
      triggered_by_result_id: triggeredByResultId ?? null,
    })
    .select('id')
    .single<{ id: string }>();

  if (advRes.error || !advRes.data) {
    // If we lose a race with another worker, UNIQUE (from, to) will fail —
    // treat as idempotent and resolve the existing row.
    const msg = advRes.error?.message ?? '';
    if (/duplicate key|unique constraint/i.test(msg)) {
      const recheck = await supabase
        .from('candidacy_advancement')
        .select('id')
        .eq('from_candidacy_id', fromCandidacyId)
        .eq('to_election_id', toElectionId)
        .maybeSingle<{ id: string }>();
      if (recheck.data) {
        return {
          created: false,
          toCandidacyId,
          advancementId: recheck.data.id,
          partyLinesCopied,
          skippedReason: 'already_advanced',
        };
      }
    }
    throw new MaterializeError(
      'insert_advancement',
      advRes.error?.message ?? 'advancement insert returned no row',
    );
  }

  return {
    created: true,
    toCandidacyId,
    advancementId: advRes.data.id,
    partyLinesCopied,
  };
}
