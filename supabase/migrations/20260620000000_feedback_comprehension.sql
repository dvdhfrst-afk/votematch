-- ============================================================
-- feedback_comprehension: make ballot COMPREHENSION the headline feedback
-- signal, and demote the vote-change question to an optional secondary,
-- internal-only signal.
--
-- Per MESSAGING.md (2026-06-20) + 08-research/voter-demand-research-2026-06-20.md:
-- the key metric is "did you understand your whole ballot?", NOT "did this change
-- how you voted" (turnout / vote-change claims do not survive scrutiny; self-report
-- runs ~10x actual change). The vote-change columns stay as an optional internal
-- signal, honestly reported, never headlined.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS), safe to re-run.
-- ============================================================

-- In-app FeedbackModal storage (POST /api/feedback -> feedback_responses).
ALTER TABLE public.feedback_responses
  ADD COLUMN IF NOT EXISTS understood_ballot TEXT
    CHECK (understood_ballot IS NULL OR understood_ballot IN ('yes', 'somewhat', 'no'));

COMMENT ON COLUMN public.feedback_responses.understood_ballot IS
  'Headline metric: did the voter feel they understood their whole ballot (yes/somewhat/no). did_vote and changed_vote are now optional secondary internal signals (see MESSAGING.md).';

-- Post-election email survey storage (vote_outcome_surveys), same reframe.
ALTER TABLE public.vote_outcome_surveys
  ADD COLUMN IF NOT EXISTS understood_ballot TEXT
    CHECK (understood_ballot IS NULL OR understood_ballot IN ('yes', 'somewhat', 'no', 'declined'));

COMMENT ON COLUMN public.vote_outcome_surveys.understood_ballot IS
  'Headline metric: did the voter understand their whole ballot. changed_vote is now an optional secondary internal signal (see MESSAGING.md).';

COMMENT ON TABLE public.vote_outcome_surveys IS
  'Post-election survey responses. Headline metric is ballot comprehension (understood_ballot). changed_vote and alignment are optional secondary INTERNAL signals, honestly reported, never headlined (see MESSAGING.md). PII-sensitive; service-role-only RLS; closed-set categorical responses.';

COMMENT ON COLUMN public.vote_outcome_surveys.changed_vote IS
  'Optional secondary INTERNAL signal (not the headline metric). Closed set so aggregates are honest. The value ''declined'' is intentional (distinct from NULL: invite sent, not yet answered).';
