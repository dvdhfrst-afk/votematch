'use server';

import crypto from 'crypto';
import { getSessionUser } from '@/lib/session';
import { createServiceClient } from '@/lib/supabase/server';

// ---------------------------------------------------------------------------
// Voter invites + participation rank — server actions
// ---------------------------------------------------------------------------
// All writes go through the service-role client. RLS on `invite_acceptances`
// blocks public reads entirely, so even SELECTs go through the service-role
// path here. The server actions are the ONLY surface that returns invite
// data; the inviter's session is verified before each call.
// ---------------------------------------------------------------------------

const VISIBLE_DAILY_CAP = 25; // soft-cap on counters (anti-farming optics)

// ---------------------------------------------------------------------------
// getOrCreateInviteCode — returns the inviter's active code, or mints one.
// ---------------------------------------------------------------------------
// One active code per user (enforced by partial unique index). On re-call
// for an existing user, returns the existing code.
// ---------------------------------------------------------------------------

export async function getOrCreateInviteCode(): Promise<
  { code: string } | { error: string }
> {
  const user = await getSessionUser();
  if (!user) return { error: 'No active session.' };

  const supabase = await createServiceClient();

  const { data: existing } = await supabase
    .from('invites')
    .select('invite_code')
    .eq('inviter_user_id', user.id)
    .eq('active', true)
    .maybeSingle();

  if (existing?.invite_code) {
    return { code: existing.invite_code };
  }

  // Mint a new code. Retry on collision (very rare at 7 base32 chars).
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateInviteCode();
    const { error } = await supabase.from('invites').insert({
      invite_code: code,
      inviter_user_id: user.id,
      state: user.state ?? null,
      active: true,
    });
    if (!error) return { code };
    // 23505 = unique_violation. Could be either the code (retry) or the
    // partial unique index on (inviter_user_id) WHERE active (re-read).
    if ((error as { code?: string }).code === '23505') {
      const { data: raced } = await supabase
        .from('invites')
        .select('invite_code')
        .eq('inviter_user_id', user.id)
        .eq('active', true)
        .maybeSingle();
      if (raced?.invite_code) return { code: raced.invite_code };
      continue; // code collision — try again
    }
    console.error('getOrCreateInviteCode insert failed:', error);
    return { error: 'Could not create invite code.' };
  }

  return { error: 'Could not create invite code.' };
}

// ---------------------------------------------------------------------------
// getInviteStats — { visited, completed } for the inviter's active code.
// ---------------------------------------------------------------------------
// Visible counts are clamped to VISIBLE_DAILY_CAP per 24h delta. Real counts
// are still in the DB for fraud review; the clamp only affects UI display.
// ---------------------------------------------------------------------------

export async function getInviteStats(): Promise<{
  visited: number;
  completed: number;
  visited_clamped: boolean;
}> {
  const user = await getSessionUser();
  if (!user) return { visited: 0, completed: 0, visited_clamped: false };

  const supabase = await createServiceClient();

  const { data: invite } = await supabase
    .from('invites')
    .select('invite_code, created_at')
    .eq('inviter_user_id', user.id)
    .eq('active', true)
    .maybeSingle();

  if (!invite) return { visited: 0, completed: 0, visited_clamped: false };

  // Two count queries in parallel. We use head:true + count:'exact' so we
  // don't transfer any rows.
  const [visitedRes, completedRes] = await Promise.all([
    supabase
      .from('invite_acceptances')
      .select('*', { count: 'exact', head: true })
      .eq('invite_code', invite.invite_code),
    supabase
      .from('invite_acceptances')
      .select('*', { count: 'exact', head: true })
      .eq('invite_code', invite.invite_code)
      .not('completed_match_at', 'is', null),
  ]);

  const realVisited = visitedRes.count ?? 0;
  const realCompleted = completedRes.count ?? 0;

  // Soft-cap visible counter at VISIBLE_DAILY_CAP * (days since creation,
  // min 1). Discourages public leaderboard-style farming without lying
  // about the actual data.
  const ageDays = Math.max(
    1,
    Math.floor(
      (Date.now() - new Date(invite.created_at).getTime()) / (1000 * 60 * 60 * 24),
    ),
  );
  const visibleCap = VISIBLE_DAILY_CAP * ageDays;
  const visited = Math.min(realVisited, visibleCap);
  const completed = Math.min(realCompleted, visibleCap);

  return {
    visited,
    completed,
    visited_clamped: realVisited > visibleCap,
  };
}

// ---------------------------------------------------------------------------
// getParticipationRanks — national / state / district ranks for the user.
// ---------------------------------------------------------------------------
// Strategy: every user that completes their first match gets a permanent
// `users.first_match_completed_at` timestamp (set by the
// `attributeInviteCompletion` Inngest function, with a fallback in
// `submitQuickMatchAction`). Rank = COUNT(*) WHERE first_match_completed_at <
// $self_ts + 1 (1-indexed).
//
// Indexes (see migration 20260502000002):
//   - idx_users_first_match_national    (timestamp partial)
//   - idx_users_first_match_state       (state, timestamp partial)
//   - idx_users_first_match_district    (state, district, timestamp partial)
//
// Each scope is ONE index range scan + count, even at 1M+ users. If we ever
// outgrow it (heavy traffic on results page), the next step is a snapshot
// table refreshed every N minutes — same query shape, just precomputed.
// ---------------------------------------------------------------------------

export type ParticipationRanks = {
  /** When the user finished their first match (set by attribution job). Null = not yet completed. */
  completed_at: string | null;
  national: { rank: number; total: number } | null;
  state: { rank: number; total: number; state: string } | null;
  district: {
    rank: number;
    total: number;
    state: string;
    district: string;
  } | null;
};

export async function getParticipationRanks(): Promise<ParticipationRanks> {
  const user = await getSessionUser();
  if (!user || !user.first_match_completed_at) {
    return { completed_at: null, national: null, state: null, district: null };
  }

  const supabase = await createServiceClient();
  const selfTs = user.first_match_completed_at;

  // Three scope queries in parallel. Each is a `count: 'exact', head: true`
  // — no rows transferred.
  //
  // National: COUNT(*) WHERE first_match_completed_at <= self_ts.
  // The "<=" is deliberate: ties between users with identical timestamps
  // resolve to the same rank, which slightly under-counts the leader's
  // place but never over-claims position.
  const nationalP = (async () => {
    const [rankRes, totalRes] = await Promise.all([
      supabase
        .from('users')
        .select('*', { count: 'exact', head: true })
        .lte('first_match_completed_at', selfTs)
        .not('first_match_completed_at', 'is', null),
      supabase
        .from('users')
        .select('*', { count: 'exact', head: true })
        .not('first_match_completed_at', 'is', null),
    ]);
    return { rank: rankRes.count ?? 0, total: totalRes.count ?? 0 };
  })();

  const stateP = user.state
    ? (async () => {
        const [rankRes, totalRes] = await Promise.all([
          supabase
            .from('users')
            .select('*', { count: 'exact', head: true })
            .eq('state', user.state!)
            .lte('first_match_completed_at', selfTs)
            .not('first_match_completed_at', 'is', null),
          supabase
            .from('users')
            .select('*', { count: 'exact', head: true })
            .eq('state', user.state!)
            .not('first_match_completed_at', 'is', null),
        ]);
        return {
          rank: rankRes.count ?? 0,
          total: totalRes.count ?? 0,
          state: user.state!,
        };
      })()
    : Promise.resolve(null);

  const districtP =
    user.state && user.congressional_district
      ? (async () => {
          const [rankRes, totalRes] = await Promise.all([
            supabase
              .from('users')
              .select('*', { count: 'exact', head: true })
              .eq('state', user.state!)
              .eq('congressional_district', user.congressional_district!)
              .lte('first_match_completed_at', selfTs)
              .not('first_match_completed_at', 'is', null),
            supabase
              .from('users')
              .select('*', { count: 'exact', head: true })
              .eq('state', user.state!)
              .eq('congressional_district', user.congressional_district!)
              .not('first_match_completed_at', 'is', null),
          ]);
          return {
            rank: rankRes.count ?? 0,
            total: totalRes.count ?? 0,
            state: user.state!,
            district: user.congressional_district!,
          };
        })()
      : Promise.resolve(null);

  const [national, state, district] = await Promise.all([
    nationalP,
    stateP,
    districtP,
  ]);

  return {
    completed_at: selfTs,
    national,
    state,
    district,
  };
}

// ---------------------------------------------------------------------------
// rotateInviteCode — deactivate current code, mint new one.
// ---------------------------------------------------------------------------
// Used when the user wants a fresh link (e.g. they shared a stale one too
// widely). Old acceptances stay attached to the old code so historical
// counts aren't lost.
// ---------------------------------------------------------------------------

export async function rotateInviteCode(): Promise<
  { code: string } | { error: string }
> {
  const user = await getSessionUser();
  if (!user) return { error: 'No active session.' };

  const supabase = await createServiceClient();

  const { data: existing } = await supabase
    .from('invites')
    .select('invite_code')
    .eq('inviter_user_id', user.id)
    .eq('active', true)
    .maybeSingle();

  // Deactivate the current code first so the partial unique index lets us
  // insert a new active row.
  if (existing) {
    const { error: deactErr } = await supabase
      .from('invites')
      .update({ active: false })
      .eq('invite_code', existing.invite_code);
    if (deactErr) {
      console.error('rotateInviteCode deactivate failed:', deactErr);
      return { error: 'Could not rotate invite code.' };
    }
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateInviteCode();
    const { error } = await supabase.from('invites').insert({
      invite_code: code,
      inviter_user_id: user.id,
      state: user.state ?? null,
      rotated_from: existing?.invite_code ?? null,
      active: true,
    });
    if (!error) return { code };
    if ((error as { code?: string }).code === '23505') continue;
    console.error('rotateInviteCode insert failed:', error);
    return { error: 'Could not rotate invite code.' };
  }
  return { error: 'Could not rotate invite code.' };
}

// ---------------------------------------------------------------------------
// generateInviteCode — 7-char Crockford base32 (no I/L/O/U).
// ---------------------------------------------------------------------------

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // 32 chars

function generateInviteCode(): string {
  const bytes = crypto.randomBytes(7);
  let out = '';
  for (let i = 0; i < 7; i++) {
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out;
}
