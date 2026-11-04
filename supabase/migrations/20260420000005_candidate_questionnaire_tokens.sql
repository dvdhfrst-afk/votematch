-- S1.10 — Candidate questionnaire: per-submission rate-limit log + direct-stated-position
-- confidence values.
--
-- Rationale:
--   1. The magic-link token model is HMAC-stateless (no DB row per token). Rate limiting
--      one submit per 10 min per token requires server-side state. A `candidate_magic_link_submissions`
--      table records every submit attempt with (candidate_id, token_fingerprint, submitted_at)
--      so the API route can check the last attempt's timestamp before accepting a new one.
--      Token fingerprint = SHA-256 of the token (so we don't store secrets in plaintext).
--
--   2. When a candidate explicitly picks a Likert position in the questionnaire, that IS
--      their stated position — no Claude classification needed. We write a `positions`
--      row with view_type='stated' directly at submission time. This needs two new
--      values on the `confidence` check constraint:
--        - 'candidate_direct': the candidate's own Likert pick (highest possible authenticity).
--        - 'no_data': surfaced when the candidate wrote free-text but didn't pick a scale;
--          we store no score (skip the row) but need the value available for other
--          source-floor logic. Reserved here for forward compat — this migration does not
--          yet insert any 'no_data' rows (positions.score is NOT NULL).
--      Expanding the check is backward-compat: 'high'/'medium'/'low' still valid.

-- ============================================================
-- 1. candidate_magic_link_submissions — rate-limit log
-- ============================================================

CREATE TABLE candidate_magic_link_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id UUID NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  -- SHA-256 of the magic-link token. We never store the raw token — the token is
  -- only ever seen at the edge (URL query param or Authorization header).
  token_fingerprint TEXT NOT NULL,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The extraction_audit row produced by this submission. FK enables per-submit drill-down.
  extraction_audit_id UUID REFERENCES extraction_audit(id) ON DELETE SET NULL,
  -- Count of sub-dimensions the candidate answered on this submit. Useful for
  -- "did the candidate edit their existing responses or add new ones" diffs.
  response_count INT NOT NULL DEFAULT 0,
  -- Minimal client metadata for anti-abuse. Do not store raw IPs — hash if needed.
  user_agent_hash TEXT
);

CREATE INDEX idx_candidate_magic_link_subs_token_time
  ON candidate_magic_link_submissions (token_fingerprint, submitted_at DESC);

CREATE INDEX idx_candidate_magic_link_subs_candidate_time
  ON candidate_magic_link_submissions (candidate_id, submitted_at DESC);

ALTER TABLE candidate_magic_link_submissions ENABLE ROW LEVEL SECURITY;

-- No anon read/write. Service role only (the API route authenticates via the
-- magic-link token itself and then writes via service client).

COMMENT ON TABLE candidate_magic_link_submissions IS
  'Per-submit audit log for candidate questionnaire magic-link usage. Drives the '
  '10-minute per-token rate limit in /api/questionnaire, and ties each submit '
  'to its extraction_audit row for provenance.';

-- ============================================================
-- 2. positions.confidence — allow candidate_direct + no_data
-- ============================================================

ALTER TABLE positions DROP CONSTRAINT positions_confidence_check;

ALTER TABLE positions
  ADD CONSTRAINT positions_confidence_check
  CHECK (confidence IN ('high', 'medium', 'low', 'candidate_direct', 'no_data'));

COMMENT ON COLUMN positions.confidence IS
  'high | medium | low (classifier outputs) OR candidate_direct (candidate picked the '
  'Likert themselves — highest authenticity) OR no_data (sub-dim surfaced as free-text '
  'source only, no numeric position). Per blueprint-v6 never-impute rule, candidate_direct '
  'is always pair with view_type=''stated''.';
