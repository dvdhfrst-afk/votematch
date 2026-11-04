import { SupabaseClient } from '@supabase/supabase-js';
import type {
  Candidate,
  CandidateWithPositions,
  Correction,
  Match,
  Position,
  Race,
  User,
} from '@/types/database';

// ============================================================
// Races
// ============================================================

export async function getRacesByPrecinct(
  supabase: SupabaseClient,
  precinctId: string
): Promise<Race[]> {
  // Precinct stores race_ids as a JSONB array of UUIDs
  const { data: precinct, error: pError } = await supabase
    .from('precincts')
    .select('race_ids')
    .eq('id', precinctId)
    .single();

  if (pError) throw new Error(`Failed to load precinct: ${pError.message}`);
  if (!precinct?.race_ids || !Array.isArray(precinct.race_ids)) return [];

  const { data, error } = await supabase
    .from('races')
    .select('*')
    .in('id', precinct.race_ids)
    .order('election_date', { ascending: true });

  if (error) throw new Error(`Failed to load races: ${error.message}`);
  return data as Race[];
}

// ============================================================
// Candidates
// ============================================================

export async function getCandidatesByRace(
  supabase: SupabaseClient,
  raceId: string
): Promise<Candidate[]> {
  const { data, error } = await supabase
    .from('candidates')
    .select('*')
    .eq('race_id', raceId)
    .eq('published', true)
    .order('name');

  if (error) throw new Error(`Failed to load candidates: ${error.message}`);
  return data as Candidate[];
}

export async function getCandidateWithPositions(
  supabase: SupabaseClient,
  candidateId: string
): Promise<CandidateWithPositions> {
  const { data: candidate, error: cError } = await supabase
    .from('candidates')
    .select('*, race:races(*)')
    .eq('id', candidateId)
    .single();

  if (cError) throw new Error(`Failed to load candidate: ${cError.message}`);

  const { data: positions, error: pError } = await supabase
    .from('positions')
    .select('*')
    .eq('candidate_id', candidateId)
    .order('created_at', { ascending: false });

  if (pError) throw new Error(`Failed to load positions: ${pError.message}`);

  return {
    ...candidate,
    positions: positions as Position[],
  } as CandidateWithPositions;
}

/**
 * Returns the latest position per sub_dimension for a candidate.
 * Uses DISTINCT ON via an RPC or falls back to client-side dedup.
 */
export async function getLatestPositions(
  supabase: SupabaseClient,
  candidateId: string
): Promise<Position[]> {
  const { data, error } = await supabase
    .from('positions')
    .select('*')
    .eq('candidate_id', candidateId)
    .order('sub_dimension_id')
    .order('created_at', { ascending: false });

  if (error) throw new Error(`Failed to load positions: ${error.message}`);

  // Client-side dedup: keep first (most recent) per sub_dimension_id
  const seen = new Set<string>();
  const latest: Position[] = [];
  for (const pos of data as Position[]) {
    if (!seen.has(pos.sub_dimension_id)) {
      seen.add(pos.sub_dimension_id);
      latest.push(pos);
    }
  }

  return latest;
}

// ============================================================
// Person-keyed position reads (person/office graph)
// ============================================================
//
// The project is migrating from the legacy candidate-centric graph
// (candidate_id) to the person/office graph (person_id). positions carries
// BOTH columns. The helpers below mirror the candidate_id versions above but
// key on person_id, so a new-graph candidacy with NO legacy candidate_id can
// still surface its positions. The candidate_id versions are kept intact for
// legacy rows; nothing here removes or changes them. Trust filters
// (selectPositionsForView) and tier thresholds are unchanged: this only fixes
// the identity used to fetch the rows.

/**
 * Latest position per sub_dimension for a PERSON (person/office graph),
 * mirroring getLatestPositions but keyed on positions.person_id. Same
 * client-side dedup (keep most-recent per sub_dimension_id).
 */
export async function getLatestPositionsByPerson(
  supabase: SupabaseClient,
  personId: string
): Promise<Position[]> {
  const { data, error } = await supabase
    .from('positions')
    .select('*')
    .eq('person_id', personId)
    .order('sub_dimension_id')
    .order('created_at', { ascending: false });

  if (error) throw new Error(`Failed to load positions: ${error.message}`);

  const seen = new Set<string>();
  const latest: Position[] = [];
  for (const pos of data as Position[]) {
    if (!seen.has(pos.sub_dimension_id)) {
      seen.add(pos.sub_dimension_id);
      latest.push(pos);
    }
  }

  return latest;
}

/**
 * Fetch ALL positions for a PERSON (no per-sub_dimension dedup), ordered
 * newest-first. Mirrors the positions half of getCandidateWithPositions but
 * keyed on positions.person_id. Returns the raw Position[] so callers can run
 * the same view-filtering (selectPositionsForView) the legacy path uses. The
 * candidate envelope (name, race, ...) for a new-graph candidacy comes from
 * v_voter_candidates, not the legacy candidates table, so this helper returns
 * positions only and does not join candidates.
 */
export async function getCandidateWithPositionsByPerson(
  supabase: SupabaseClient,
  personId: string
): Promise<Position[]> {
  const { data: positions, error: pError } = await supabase
    .from('positions')
    .select('*')
    .eq('person_id', personId)
    .order('created_at', { ascending: false });

  if (pError) throw new Error(`Failed to load positions: ${pError.message}`);

  return (positions ?? []) as Position[];
}

// ============================================================
// Users
// ============================================================

export async function getUserBySessionToken(
  supabase: SupabaseClient,
  token: string
): Promise<User | null> {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('session_token', token)
    .maybeSingle();

  if (error) throw new Error(`Failed to load user: ${error.message}`);
  return data as User | null;
}

export async function createOrUpdateUser(
  supabase: SupabaseClient,
  userData: {
    session_token: string;
    address_text?: string | null;
    precinct_id?: string | null;
    quick_match_answers?: Record<string, unknown> | null;
    weights?: Record<string, number> | null;
    email?: string | null;
  }
): Promise<User> {
  const { data, error } = await supabase
    .from('users')
    .upsert(userData, { onConflict: 'session_token' })
    .select()
    .single();

  if (error) throw new Error(`Failed to upsert user: ${error.message}`);
  return data as User;
}

// ============================================================
// Matches
// ============================================================

export async function getMatchesForUser(
  supabase: SupabaseClient,
  userId: string,
  raceId?: string
): Promise<Match[]> {
  let query = supabase
    .from('matches')
    .select('*')
    .eq('user_id', userId)
    .order('score', { ascending: false });

  if (raceId) {
    query = query.eq('race_id', raceId);
  }

  const { data, error } = await query;
  if (error) throw new Error(`Failed to load matches: ${error.message}`);
  return data as Match[];
}

export async function saveMatches(
  supabase: SupabaseClient,
  matches: Omit<Match, 'id' | 'created_at'>[]
): Promise<Match[]> {
  // Delete existing matches for this user + race combinations, then insert fresh
  const userIds = [...new Set(matches.map((m) => m.user_id))];
  const raceIds = [...new Set(matches.map((m) => m.race_id))];

  // Remove stale matches for these user-race pairs
  for (const userId of userIds) {
    for (const raceId of raceIds) {
      const { error: delError } = await supabase
        .from('matches')
        .delete()
        .eq('user_id', userId)
        .eq('race_id', raceId);

      if (delError)
        throw new Error(`Failed to clear old matches: ${delError.message}`);
    }
  }

  const { data, error } = await supabase
    .from('matches')
    .insert(matches)
    .select();

  if (error) throw new Error(`Failed to save matches: ${error.message}`);
  return data as Match[];
}

// ============================================================
// Corrections
// ============================================================

export async function submitCorrection(
  supabase: SupabaseClient,
  correctionData: {
    candidate_id: string;
    position_id: string;
    submitted_by: string;
    evidence?: string;
  }
): Promise<Correction> {
  const { data, error } = await supabase
    .from('corrections')
    .insert({
      ...correctionData,
      status: 'submitted',
    })
    .select()
    .single();

  if (error) throw new Error(`Failed to submit correction: ${error.message}`);
  return data as Correction;
}

// ============================================================
// Email Opt-ins
// ============================================================

export async function saveEmailOptin(
  supabase: SupabaseClient,
  email: string,
  precinctId?: string
): Promise<void> {
  const { error } = await supabase.from('email_optins').insert({
    email,
    precinct_id: precinctId ?? null,
  });

  if (error) throw new Error(`Failed to save email opt-in: ${error.message}`);
}

// ============================================================
// Feedback
// ============================================================

export async function saveFeedback(
  supabase: SupabaseClient,
  feedbackData: {
    user_id?: string;
    did_vote?: boolean;
    changed_vote?: 'yes' | 'no' | 'not_sure';
    races_changed?: number;
  }
): Promise<void> {
  const { error } = await supabase.from('feedback_responses').insert({
    user_id: feedbackData.user_id ?? null,
    did_vote: feedbackData.did_vote ?? null,
    changed_vote: feedbackData.changed_vote ?? null,
    races_changed: feedbackData.races_changed ?? null,
  });

  if (error) throw new Error(`Failed to save feedback: ${error.message}`);
}
