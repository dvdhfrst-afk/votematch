-- Voter invites + participation-rank gamification.
--
-- Two-table split (not JSONB-on-users) so counters are SQL aggregates, not
-- row mutations under a hot key. Service-role-only writes; per-user reads
-- via server actions (no public read of either table).
--
-- Privacy guardrails baked into the schema:
--   * `invitee_user_id` is FK'd with ON DELETE CASCADE so a deleted invitee
--     vanishes from counters automatically.
--   * Inviters never see invitee identity via SQL — all reads go through
--     server actions that return aggregate counts only.
--   * IP/UA is stored only as an HMAC fingerprint (`ip_hash`), per the
--     existing geocode_cache_privacy posture.
--
-- We also stamp `state` + `congressional_district` snapshots on the `users`
-- table so the participation-rank queries don't have to join against
-- precincts→political_districts on every render. Both columns are nullable
-- and populated lazily (proxy/middleware can backfill on next visit).
--
-- The "first_match_completed_at" column on users is the canonical timestamp
-- the rank query orders against. It's set once, never updated, by the
-- attribution Inngest job (or the action path as a fallback). Indexed for
-- fast COUNT(*) FILTER queries scoped by state/district.

-- ============================================================
-- Add snapshot columns to users (idempotent)
-- ============================================================

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS state TEXT,
  ADD COLUMN IF NOT EXISTS congressional_district TEXT,
  ADD COLUMN IF NOT EXISTS first_match_completed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_users_first_match_national
  ON users (first_match_completed_at)
  WHERE first_match_completed_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_users_first_match_state
  ON users (state, first_match_completed_at)
  WHERE first_match_completed_at IS NOT NULL AND state IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_users_first_match_district
  ON users (state, congressional_district, first_match_completed_at)
  WHERE first_match_completed_at IS NOT NULL
    AND state IS NOT NULL
    AND congressional_district IS NOT NULL;

-- ============================================================
-- invites — one active code per user (rotatable)
-- ============================================================

CREATE TABLE IF NOT EXISTS invites (
  invite_code TEXT PRIMARY KEY,                     -- 7-char base32, e.g. "K7M3P2X"
  inviter_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state TEXT,                                       -- snapshot of inviter's state for k-anonymity
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  rotated_from TEXT REFERENCES invites(invite_code), -- previous code if regenerated
  active BOOLEAN NOT NULL DEFAULT true
);

-- Only one active code per inviter. Rotation: deactivate old, insert new.
CREATE UNIQUE INDEX IF NOT EXISTS idx_invites_one_active_per_user
  ON invites (inviter_user_id) WHERE active;

CREATE INDEX IF NOT EXISTS idx_invites_inviter
  ON invites (inviter_user_id);

-- ============================================================
-- invite_acceptances — one row per invitee per code
-- ============================================================

CREATE TABLE IF NOT EXISTS invite_acceptances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invite_code TEXT NOT NULL REFERENCES invites(invite_code) ON DELETE CASCADE,
  invitee_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip_hash TEXT,                                     -- HMAC(IP+UA) — anti-farming fingerprint only
  completed_match_at TIMESTAMPTZ,                   -- set when invitee finishes their first match
  UNIQUE (invite_code, invitee_user_id)
);

-- Counter query — "X visited / Y completed" — uses both indexes.
CREATE INDEX IF NOT EXISTS idx_acceptances_code_visited
  ON invite_acceptances (invite_code);

CREATE INDEX IF NOT EXISTS idx_acceptances_code_completed
  ON invite_acceptances (invite_code) WHERE completed_match_at IS NOT NULL;

-- Look up a user's open acceptance row for the attribution Inngest job.
CREATE INDEX IF NOT EXISTS idx_acceptances_invitee_open
  ON invite_acceptances (invitee_user_id) WHERE completed_match_at IS NULL;

-- ============================================================
-- RLS: service-role-only writes; reads via server actions
-- ============================================================

ALTER TABLE invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE invite_acceptances ENABLE ROW LEVEL SECURITY;

-- Inviter can SELECT their own invite rows (so server-rendered InvitePanel
-- can resolve the active code via the standard anon supabase client). All
-- writes (INSERT/UPDATE/DELETE) require service role — there is no public
-- write policy.
DROP POLICY IF EXISTS "Inviter self select invites" ON invites;
CREATE POLICY "Inviter self select invites"
  ON invites FOR SELECT
  USING (
    inviter_user_id IN (
      SELECT id FROM users WHERE session_token = public.session_token()
    )
  );

-- invite_acceptances has NO public-read policy. Counters are returned by
-- server actions running with the service-role client; raw rows never leave
-- the server. This guarantees inviters can't SELECT invitee identities.

-- ============================================================
-- Notes for follow-on work (not implemented in this migration)
-- ============================================================
-- 1. Backfill `users.state` + `users.congressional_district` for existing
--    rows by joining via precincts → political_districts. Cheap, but should
--    run once before the participation-rank UI is enabled to avoid empty
--    state/district counts for legacy users.
-- 2. A 25/day soft-cap on visible counters is enforced in the server action,
--    not in SQL — real counts stay accurate for fraud review.
-- 3. The participation-rank query (see invite-actions.ts) uses
--    `COUNT(*) WHERE first_match_completed_at < $self_ts` against the three
--    partial indexes above. At 1M users this is a single index scan per
--    scope; if it ever degrades, the next step is a materialized
--    `participation_rank_snapshot` table refreshed every N minutes.
