-- /for-candidates self-service portal — token registry + pending claims +
-- attestation columns.
--
-- This migration adds three things:
--
-- 1. `candidate_questionnaire_tokens` — server-side registry of issued
--    /for-candidates magic links. We persist a SHA-256 fingerprint (never
--    the raw token), the candidate or pending claim it's for, an
--    expiry, and a consumed-at timestamp. The actual token is HMAC-signed
--    via lib/for-candidates/tokens.ts (RETENTION_TOKEN_SECRET secret), so
--    cryptographic validity is stateless. This table is what lets us
--    revoke / mark-consumed without rotating the secret.
--
-- 2. `candidate_pending_claims` — when a candidate enters their email at
--    /for-candidates and we DON'T find a matching candidacy, we record a
--    pending claim row holding their self-reported name/office/state.
--    A future admin verification step (out of scope this cycle) promotes
--    the claim to a real candidacy. The token they receive points at the
--    claim row, not a candidate row, so they can still log in and prefill
--    their profile while we verify.
--
-- 3. `questionnaire_responses.attested_at` + `.attested_signature_text` —
--    the affirmation step on /for-candidates/profile/[token]/affirm flips
--    these. `attested_at` null = "saved as draft, not affirmed"; not-null =
--    "candidate explicitly affirmed and the candidate.published flag was
--    set to true downstream by the affirm flow".

-- ============================================================
-- 1. candidate_questionnaire_tokens
-- ============================================================

CREATE TABLE IF NOT EXISTS candidate_questionnaire_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Either a real candidate (after match) or a pending claim (before verification).
  -- Exactly one of these MUST be non-null. Enforced via the CHECK below.
  candidate_id UUID REFERENCES candidates(id) ON DELETE CASCADE,
  pending_claim_id UUID,

  -- Which flow issued this token. Open-ended TEXT (no enum) so we can add
  -- new flows (sms-pin, magic-link-revisions, etc.) without a migration.
  flow_type TEXT NOT NULL DEFAULT 'for-candidates',

  -- SHA-256 of the full token. Same fingerprint scheme used elsewhere.
  token_fingerprint TEXT NOT NULL UNIQUE,

  -- Email we sent the token to (for audit; the candidate may have
  -- multiple emails on file).
  sent_to_email TEXT NOT NULL,

  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT cqt_one_target_only CHECK (
    (candidate_id IS NOT NULL AND pending_claim_id IS NULL)
    OR (candidate_id IS NULL AND pending_claim_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_cqt_candidate ON candidate_questionnaire_tokens (candidate_id);
CREATE INDEX IF NOT EXISTS idx_cqt_pending_claim ON candidate_questionnaire_tokens (pending_claim_id);
CREATE INDEX IF NOT EXISTS idx_cqt_email_lower ON candidate_questionnaire_tokens (lower(sent_to_email));
CREATE INDEX IF NOT EXISTS idx_cqt_active
  ON candidate_questionnaire_tokens (expires_at)
  WHERE consumed_at IS NULL;

ALTER TABLE candidate_questionnaire_tokens ENABLE ROW LEVEL SECURITY;
-- Service role only — the API routes verify the token themselves and use
-- the service client.

COMMENT ON TABLE candidate_questionnaire_tokens IS
  '/for-candidates magic-link registry. Tokens themselves are HMAC-signed; '
  'this table tracks issuance, target candidate or pending-claim, and consumption.';

-- ============================================================
-- 2. candidate_pending_claims
-- ============================================================

CREATE TABLE IF NOT EXISTS candidate_pending_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Self-reported by the candidate during the /for-candidates claim flow.
  email TEXT NOT NULL,
  claimed_name TEXT NOT NULL,
  claimed_office TEXT,
  claimed_state TEXT,

  -- Set when an admin links this claim to a real candidates.id row.
  -- Until then, the candidate edits a draft tied to the claim itself
  -- (no positions are written until a candidacy exists).
  resolved_candidate_id UUID REFERENCES candidates(id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ,
  resolved_by TEXT,

  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'verified', 'rejected', 'duplicate')
  ),

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pending_claims_email_lower ON candidate_pending_claims (lower(email));
CREATE INDEX IF NOT EXISTS idx_pending_claims_status ON candidate_pending_claims (status);

ALTER TABLE candidate_pending_claims ENABLE ROW LEVEL SECURITY;
-- Service role only.

COMMENT ON TABLE candidate_pending_claims IS
  'Self-reported candidacy claims from /for-candidates landing page when no '
  'matching candidacy is found by email. Admin verifies and promotes to a real '
  'candidacy via resolved_candidate_id.';

-- Now wire the FK on candidate_questionnaire_tokens.pending_claim_id
ALTER TABLE candidate_questionnaire_tokens
  ADD CONSTRAINT cqt_pending_claim_fk
  FOREIGN KEY (pending_claim_id) REFERENCES candidate_pending_claims(id) ON DELETE CASCADE;

-- ============================================================
-- 3. questionnaire_responses attestation columns
-- ============================================================

ALTER TABLE questionnaire_responses
  ADD COLUMN IF NOT EXISTS attested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS attested_signature_text TEXT;

COMMENT ON COLUMN questionnaire_responses.attested_at IS
  'Set when the candidate completes the /for-candidates/profile/[token]/affirm '
  'step. Null = draft (saved but not affirmed). Not-null = the candidate explicitly '
  'attested to these answers via the portal and the candidates.published flag '
  'should be (or has been) set to true.';

COMMENT ON COLUMN questionnaire_responses.attested_signature_text IS
  'The retyped name string the candidate provided at the affirm step. Captured '
  'verbatim so the affirmation is auditable.';
