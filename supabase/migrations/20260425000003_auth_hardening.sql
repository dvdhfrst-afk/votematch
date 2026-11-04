-- Council finding #31 — magic-link revocation list.
--
-- HMAC magic-link tokens are stateless: they carry their own expiry and
-- signature, so verifying them needs no DB read. Great for low latency,
-- terrible for revocation: once minted, a token is valid until its expiry
-- ticks past, no matter how it leaks.
--
-- This table is the explicit revocation list. We store the SHA-256
-- fingerprint of the token (same scheme as `candidate_magic_link_submissions`
-- — never persist raw tokens), the time we revoked it, and a free-form
-- reason. `verifyMagicLinkTokenAsync()` in `src/lib/session.ts` consults this
-- table on every magic-link-authenticated session/write; the questionnaire
-- submit route writes to it on successful submit so a forwarded / phished
-- copy of the link can't be replayed.
--
-- Idempotent: every DDL guard uses IF NOT EXISTS / DO $$.
-- ============================================================================

CREATE TABLE IF NOT EXISTS magic_link_revocations (
  -- SHA-256 hex of the magic-link token (64 chars). We never store the raw
  -- token; the hash is enough for a constant-time membership lookup.
  token_fingerprint TEXT PRIMARY KEY,
  revoked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 'consumed' = legitimate submit landed, link is now spent.
  -- 'manual'   = ops/admin revoked (e.g. candidate reported the link leaked).
  -- 'leaked'   = automated detector flagged the token (replay attempt, etc.).
  reason TEXT NOT NULL DEFAULT 'consumed'
    CHECK (reason IN ('consumed', 'manual', 'leaked'))
);

-- Time-ordered scan for ops dashboards / cleanup jobs. Tokens older than the
-- max magic-link expiry (7 days, per session.ts MAGIC_LINK_EXPIRY_HOURS) can
-- be GC'd safely — once the underlying token is past its expiry, the HMAC
-- check rejects it without ever consulting this table.
CREATE INDEX IF NOT EXISTS idx_magic_link_revocations_revoked_at
  ON magic_link_revocations (revoked_at DESC);

-- Service role only. The API routes that authenticate via magic-link
-- already use the service client to write here; no anon read/write should
-- ever touch this table (the fingerprints are internal anti-replay state,
-- not user-facing data).
ALTER TABLE magic_link_revocations ENABLE ROW LEVEL SECURITY;

-- Drop-and-recreate the policy idempotently.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'magic_link_revocations'
      AND policyname = 'magic_link_revocations_no_anon'
  ) THEN
    DROP POLICY magic_link_revocations_no_anon ON magic_link_revocations;
  END IF;
END$$;

-- Empty USING clause = nothing for anon role. Service role bypasses RLS.
CREATE POLICY magic_link_revocations_no_anon
  ON magic_link_revocations
  FOR ALL
  TO public
  USING (false)
  WITH CHECK (false);

COMMENT ON TABLE magic_link_revocations IS
  'Revocation list for stateless HMAC magic-link tokens. Keyed by SHA-256 '
  'fingerprint of the token (raw tokens are never persisted). '
  'verifyMagicLinkTokenAsync() in src/lib/session.ts consults this on every '
  'magic-link-authenticated request. Council finding #31.';

COMMENT ON COLUMN magic_link_revocations.reason IS
  '"consumed" (link spent on a successful submit), "manual" (ops revoked), '
  '"leaked" (automated detector). One submit per link — if a candidate '
  'needs to edit, they request a fresh link.';
