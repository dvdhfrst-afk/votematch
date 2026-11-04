-- ============================================================
-- vote_outcome_surveys: the "did this tool change how you voted?" plumbing
-- ============================================================
--
-- Per notes/ballot-bridge-execution-order.md Week 4-5 item 20 (and the
-- council review's "key metric needs plumbing" finding). The product's
-- north-star question is "did Ballot Bridge change how you voted?" — we
-- can't answer it post-Nov-3 if there's nowhere to store the answer.
--
-- Design constraints baked in:
--   1. PII-sensitive. Voting behavior is highly personal. Closed-set
--      answers preferred over free text; notes column length-bounded.
--   2. Hash-token discipline (mirrors candidate_magic_link_submissions in
--      20260420000005). Raw invite tokens live in the email only; the DB
--      stores SHA-256 fingerprints.
--   3. Anonymization survival: FK to users is ON DELETE SET NULL, so a
--      user requesting deletion doesn't wipe the aggregate signal — the
--      row stays, just orphans. (election_cycle_id FK stays, that's
--      reference data.)
--   4. RLS service-role-only writes; no public read. The dashboard
--      aggregates over this via service client only.
--   5. Per-(user, cycle) uniqueness — one survey per voter per cycle.
--
-- The post-Nov-3 send mechanism (Inngest function that batches invite
-- emails to all users with completed quick-match) is sketched in
-- notes/vote-outcome-survey-trigger-plan.md and built closer to the
-- election. This migration just gets the table in place so app code
-- can start writing to it as quick-match is exercised in demos.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.vote_outcome_surveys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Who answered. Nullable because (a) anon-friendly future surveys may
  -- not have a user_id and (b) ON DELETE SET NULL keeps aggregates alive
  -- through deletion requests.
  user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,

  -- Which cycle the survey is about. NOT NULL so a row always answers
  -- "for which election?". Defaults at app level to the most recent
  -- completed cycle; not a DB default because the right cycle depends
  -- on submission context.
  election_cycle_id UUID NOT NULL
    REFERENCES public.election_cycles(id) ON DELETE CASCADE,

  -- Invite token tracking. The raw token is sent in the email URL once
  -- and never persisted; we store SHA-256 for lookup at submit time.
  -- This matches candidate_magic_link_submissions (migration
  -- 20260420000005) — same posture, separate table.
  invite_token_hash TEXT NOT NULL UNIQUE,
  invite_sent_at TIMESTAMPTZ,
  invite_opened_at TIMESTAMPTZ,
  invite_expires_at TIMESTAMPTZ NOT NULL,

  -- The key-metric question. Closed set so we can aggregate honestly:
  --   no_effect       — voter would have voted the same without the tool
  --   shifted_one     — tool changed their vote in one race
  --   shifted_multiple — tool changed their vote in 2+ races
  --   discovered_race — tool surfaced a race they didn't know was on the ballot
  --   unsure          — voter doesn't remember well enough to answer
  --   declined        — voter explicitly opted not to answer this question
  changed_vote TEXT
    CHECK (changed_vote IN (
      'no_effect',
      'shifted_one',
      'shifted_multiple',
      'discovered_race',
      'unsure',
      'declined'
    )),

  -- How many of the tool's top-match recommendations matched the actual
  -- vote, in the voter's recollection. Closed set on the same rationale.
  alignment_with_recommendation TEXT
    CHECK (alignment_with_recommendation IN (
      'all_matched',
      'most_matched',
      'some_matched',
      'few_matched',
      'none_matched',
      'declined'
    )),

  -- How confident the voter is in their own answer (self-reported).
  -- Useful for filtering high-confidence respondents in aggregate metrics.
  response_confidence TEXT
    CHECK (response_confidence IN ('low', 'medium', 'high')),

  -- Free text. Optional. Length-bounded. The application MUST scrub for
  -- obvious PII patterns (SSN, email, phone) before persisting.
  notes TEXT
    CHECK (notes IS NULL OR length(notes) <= 2000),

  -- When the voter actually submitted the survey. NULL = invite sent but
  -- not yet completed.
  submitted_at TIMESTAMPTZ,

  -- Per CLAUDE.md retention policy: aggregate-and-purge after a window.
  -- This timestamp gates the purge — set by application code, not the DB.
  retention_purge_at TIMESTAMPTZ,

  meta JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- One survey per (user, cycle). If user_id is NULL (anonymous), the
  -- partial unique index below enforces uniqueness via invite_token_hash
  -- instead.
  UNIQUE (user_id, election_cycle_id)
);

CREATE INDEX IF NOT EXISTS idx_vote_outcome_surveys_cycle
  ON public.vote_outcome_surveys (election_cycle_id);

CREATE INDEX IF NOT EXISTS idx_vote_outcome_surveys_changed_vote
  ON public.vote_outcome_surveys (changed_vote)
  WHERE changed_vote IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_vote_outcome_surveys_submitted
  ON public.vote_outcome_surveys (submitted_at)
  WHERE submitted_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_vote_outcome_surveys_retention
  ON public.vote_outcome_surveys (retention_purge_at)
  WHERE retention_purge_at IS NOT NULL;

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.vote_outcome_surveys_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_vote_outcome_surveys_updated_at
  ON public.vote_outcome_surveys;
CREATE TRIGGER trg_vote_outcome_surveys_updated_at
  BEFORE UPDATE ON public.vote_outcome_surveys
  FOR EACH ROW
  EXECUTE FUNCTION public.vote_outcome_surveys_set_updated_at();

-- RLS: service-role-only. No anon read (PII), no anon write (token-auth
-- happens at the API edge, then service client writes).
ALTER TABLE public.vote_outcome_surveys ENABLE ROW LEVEL SECURITY;

-- No SELECT policy for anon — service role bypasses RLS so dashboards
-- still work. The voter sees their own submission via app code that
-- authenticates against the invite_token_hash, not via direct RLS read.

COMMENT ON TABLE public.vote_outcome_surveys IS 'Post-election survey responses for the north-star "did this tool change your vote?" metric. PII-sensitive; service-role-only RLS; closed-set categorical responses.';

COMMENT ON COLUMN public.vote_outcome_surveys.invite_token_hash IS 'SHA-256 of the one-time invite token. Raw token lives in the email URL only — same pattern as candidate_magic_link_submissions.token_fingerprint.';

COMMENT ON COLUMN public.vote_outcome_surveys.changed_vote IS 'The key-metric question. Closed set so aggregates are honest. ''declined'' is intentional — distinct from NULL (invite sent, not yet answered).';

COMMENT ON COLUMN public.vote_outcome_surveys.retention_purge_at IS 'Per data-minimization posture, free-text notes get scrubbed after this timestamp; the row stays (the aggregate signal is what matters).';
