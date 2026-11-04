/**
 * Portal "subject" loader — normalizes the three magic-link target kinds
 * (office-graph `candidacy`, legacy `candidate`, unverified `pending_claim`)
 * into one shape the portal pages render and the actions write against.
 *
 * This is the seam that lets the candidate portal serve current 2026
 * candidacies (which live in people/candidacies with no legacy `candidates`
 * row) WITHOUT every page re-implementing the candidate-vs-candidacy branch.
 *
 * Read/write keying contract (see DATA-MAP.md + the office-graph notes):
 *   - office-graph candidacy: positions + candidate_sources are keyed by
 *     `personId`; drafts/disputes carry `candidacyId` + `personId`. The voter
 *     read path (`v_voter_candidates`, `/candidate/[id]`) already reads
 *     new-graph rows by person_id, so person-keyed writes surface to voters.
 *   - legacy candidate: keyed by `candidateId` (+ `raceId` for drafts), exactly
 *     as the original portal did.
 */
import type { createServiceClient } from '@/lib/supabase/server';
import type { ResolvedTokenTarget } from './session';

type ServiceClient = Awaited<ReturnType<typeof createServiceClient>>;

export type PortalSubject = {
  /** Which identity model backs this subject. */
  kind: 'candidate' | 'candidacy' | 'pending_claim';
  /** Legacy candidates.id (null for office-graph + pending). */
  candidateId: string | null;
  /** Office-graph candidacies.id (null for legacy + pending). */
  candidacyId: string | null;
  /** people.id — set for office-graph; best-effort for legacy; null for pending. */
  personId: string | null;
  /** Legacy races.id — only meaningful for legacy candidate drafts. */
  raceId: string | null;
  /** candidate_pending_claims.id (only for pending). */
  pendingClaimId: string | null;
  /** Display name (ballot name / canonical name / claimed name). */
  name: string;
  /** Human-readable office/race label for headers. */
  raceLabel: string | null;
  /** Photo URL on file (people.photo_url / candidates.photo_url). */
  photoUrl: string | null;
  /** True while a self-claim awaits admin verification. */
  isPending: boolean;
  /** Public profile slug for /candidate/[id] (candidacies.id or candidates.id). */
  publicProfileId: string | null;
};

function arrayOrSingle<T>(v: T | T[] | null | undefined): T | null {
  if (v == null) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

/**
 * Resolve a token target into a normalized subject. Returns null only when the
 * underlying record has vanished (rare — token row references a deleted entity).
 */
export async function loadPortalSubject(
  supabase: ServiceClient,
  target: ResolvedTokenTarget,
): Promise<PortalSubject | null> {
  if (target.kind === 'candidacy') {
    const { data: cdy } = await supabase
      .from('candidacies')
      .select(
        'id, person_id, person:people(canonical_name, photo_url), election:elections(office:offices(canonical_name, seat_designation, level))',
      )
      .eq('id', target.candidacyId)
      .maybeSingle();
    if (!cdy) return null;

    const person = arrayOrSingle(
      cdy.person as
        | { canonical_name?: string; photo_url?: string | null }
        | Array<{ canonical_name?: string; photo_url?: string | null }>
        | null,
    );
    const election = arrayOrSingle(cdy.election as unknown);
    const office = election
      ? arrayOrSingle((election as { office?: unknown }).office)
      : null;
    const officeName =
      (office as { canonical_name?: string } | null)?.canonical_name ?? null;

    return {
      kind: 'candidacy',
      candidateId: null,
      candidacyId: cdy.id as string,
      personId: (cdy.person_id as string) ?? target.personId,
      raceId: null,
      pendingClaimId: null,
      name: (person?.canonical_name as string) ?? '',
      raceLabel: officeName,
      photoUrl: (person?.photo_url as string | null) ?? null,
      isPending: false,
      publicProfileId: cdy.id as string,
    };
  }

  if (target.kind === 'candidate') {
    const { data: cand } = await supabase
      .from('candidates')
      .select('id, name, photo_url, race_id, race:races(name)')
      .eq('id', target.candidateId)
      .maybeSingle();
    if (!cand) return null;

    const race = arrayOrSingle(cand.race as { name?: string } | { name?: string }[] | null);

    // Best-effort person resolution so legacy attestations can also write a
    // person_id (keeps the two tracks consistent). Non-fatal if absent.
    let personId: string | null = null;
    const { data: ppl } = await supabase
      .from('people')
      .select('id')
      .contains('legacy_candidate_ids', [target.candidateId])
      .limit(1)
      .maybeSingle();
    if (ppl?.id) personId = ppl.id as string;

    return {
      kind: 'candidate',
      candidateId: cand.id as string,
      candidacyId: null,
      personId,
      raceId: (cand.race_id as string | null) ?? null,
      pendingClaimId: null,
      name: (cand.name as string) ?? '',
      raceLabel: (race?.name as string | null) ?? null,
      photoUrl: (cand.photo_url as string | null) ?? null,
      isPending: false,
      publicProfileId: cand.id as string,
    };
  }

  // pending_claim
  const { data: claim } = await supabase
    .from('candidate_pending_claims')
    .select('id, claimed_name, claimed_office, claimed_state, resolved_candidate_id')
    .eq('id', target.pendingClaimId)
    .maybeSingle();
  if (!claim) return null;

  // A claim can be promoted to a real candidate after the token was minted.
  if (claim.resolved_candidate_id) {
    const promoted = await loadPortalSubject(supabase, {
      kind: 'candidate',
      candidateId: claim.resolved_candidate_id as string,
    });
    if (promoted) return promoted;
  }

  const office = (claim.claimed_office as string | null) ?? null;
  const st = (claim.claimed_state as string | null) ?? null;
  return {
    kind: 'pending_claim',
    candidateId: null,
    candidacyId: null,
    personId: null,
    raceId: null,
    pendingClaimId: claim.id as string,
    name: (claim.claimed_name as string) ?? '',
    raceLabel: office ? `${office}${st ? ` · ${st}` : ''}` : st,
    photoUrl: null,
    isPending: true,
    publicProfileId: null,
  };
}
