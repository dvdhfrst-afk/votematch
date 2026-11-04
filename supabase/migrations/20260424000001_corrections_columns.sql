-- ============================================================
-- 20260424000001_corrections_columns.sql
--
-- Widen `public.corrections` to support the human-in-the-loop
-- triage surface at /admin/corrections-review (2h SLA).
--
-- The initial schema (20260416000000) modeled corrections as
-- {candidate_id, position_id} — narrow to position-level fact
-- disputes. The retention engine + office-graph build has since
-- expanded the surface area: voters now submit corrections
-- against candidacies, endorsements, positions, events, office
-- holders, and ballot measures. Rather than fork into N tables,
-- this migration generalizes the existing row into a
-- polymorphic claim: {target_type, target_id, claim, claim_type}.
--
-- Columns ADDED (all nullable so existing rows don't break):
--   - submitter_email TEXT — optional reply-to for voter
--   - target_type TEXT — 'candidacy' | 'endorsement' | 'position'
--                        | 'event' | 'officeholder' | 'ballot_measure'
--   - target_id UUID — polymorphic FK (enforced in app layer only;
--                      postgres lacks a native polymorphic ref)
--   - claim TEXT — free-text description from the voter
--   - claim_type TEXT — 'stale' | 'factual_error' | 'missing_data'
--                       | 'other'
--   - resolution_status TEXT — populated by the re-verify Inngest
--                              fn: 'verified_corrected'
--                                | 'could_not_confirm'
--                                | 'no_change_found'
--                                | 'could_not_resolve'
--                                | 'dismissed'
--   - resolution_note TEXT — free-text from editor + Inngest fn
--   - reverify_triggered_at TIMESTAMPTZ — set when an editor
--                                         kicks off correction-reverify
--
-- Existing columns kept for back-compat:
--   - candidate_id, position_id (nullable now; new rows use
--     target_type+target_id; old rows keep the typed FKs)
--   - submitted_by (TEXT free-form; used when submitter_email null)
--   - status (legacy CHECK tightened — see below)
--   - resolution_notes (legacy; mirrored to resolution_note by app)
--   - created_at, resolved_at, evidence
--
-- Because `corrections.candidate_id` + `position_id` are NOT NULL
-- in the initial schema, we relax them to NULL so polymorphic rows
-- can be inserted without a candidate/position FK. Back-fill is
-- unnecessary (no prod rows yet; retention engine only rolled in
-- 2026-04-18).
-- ============================================================

BEGIN;

-- 1. Relax legacy NOT NULLs so polymorphic rows can skip them.
ALTER TABLE public.corrections
  ALTER COLUMN candidate_id DROP NOT NULL,
  ALTER COLUMN position_id  DROP NOT NULL;

-- 2. Add the new polymorphic columns.
ALTER TABLE public.corrections
  ADD COLUMN IF NOT EXISTS submitter_email       TEXT,
  ADD COLUMN IF NOT EXISTS target_type           TEXT,
  ADD COLUMN IF NOT EXISTS target_id             UUID,
  ADD COLUMN IF NOT EXISTS claim                 TEXT,
  ADD COLUMN IF NOT EXISTS claim_type            TEXT,
  ADD COLUMN IF NOT EXISTS resolution_status     TEXT,
  ADD COLUMN IF NOT EXISTS resolution_note       TEXT,
  ADD COLUMN IF NOT EXISTS reverify_triggered_at TIMESTAMPTZ;

-- 3. CHECK constraints. Only applied to rows where the column is
--    populated (NULL always passes) so legacy rows don't trip on
--    the rollout.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'corrections_target_type_check'
  ) THEN
    ALTER TABLE public.corrections
      ADD CONSTRAINT corrections_target_type_check
      CHECK (
        target_type IS NULL OR target_type IN (
          'candidacy',
          'endorsement',
          'position',
          'event',
          'officeholder',
          'ballot_measure'
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'corrections_claim_type_check'
  ) THEN
    ALTER TABLE public.corrections
      ADD CONSTRAINT corrections_claim_type_check
      CHECK (
        claim_type IS NULL OR claim_type IN (
          'stale',
          'factual_error',
          'missing_data',
          'other'
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'corrections_resolution_status_check'
  ) THEN
    ALTER TABLE public.corrections
      ADD CONSTRAINT corrections_resolution_status_check
      CHECK (
        resolution_status IS NULL OR resolution_status IN (
          'verified_corrected',
          'could_not_confirm',
          'no_change_found',
          'could_not_resolve',
          'dismissed'
        )
      );
  END IF;

  -- A polymorphic row must have both target_type + target_id OR
  -- neither (legacy path). Enforce at the DB layer.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'corrections_target_pair_check'
  ) THEN
    ALTER TABLE public.corrections
      ADD CONSTRAINT corrections_target_pair_check
      CHECK (
        (target_type IS NULL AND target_id IS NULL)
        OR
        (target_type IS NOT NULL AND target_id IS NOT NULL)
      );
  END IF;
END$$;

-- 4. Indexes. Triage needs to pull unresolved + sort by submitted_at
--    (aliased to created_at here). SLA banner walks the same set.
CREATE INDEX IF NOT EXISTS idx_corrections_unresolved
  ON public.corrections (created_at DESC)
  WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_corrections_target
  ON public.corrections (target_type, target_id)
  WHERE target_type IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_corrections_reverify_pending
  ON public.corrections (reverify_triggered_at DESC)
  WHERE reverify_triggered_at IS NOT NULL AND resolved_at IS NULL;

-- 5. pending_correction_replies — stubbed outbox for voter replies.
--    An email cron (built later) will walk this table, send via Resend,
--    and mark sent_at. We don't send real mail from the Inngest fn in
--    this PR — just enqueue.
CREATE TABLE IF NOT EXISTS public.pending_correction_replies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  correction_id UUID NOT NULL REFERENCES public.corrections(id) ON DELETE CASCADE,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_pending_correction_replies_unsent
  ON public.pending_correction_replies (created_at DESC)
  WHERE sent_at IS NULL;

ALTER TABLE public.pending_correction_replies ENABLE ROW LEVEL SECURITY;
-- Service-role only; no voter-facing reads.

-- 6. Documentation
COMMENT ON COLUMN public.corrections.target_type IS
  'Polymorphic target: candidacy|endorsement|position|event|officeholder|ballot_measure. '
  'Replaces the legacy (candidate_id, position_id) pair for new rows.';
COMMENT ON COLUMN public.corrections.claim_type IS
  'Nature of the complaint: stale (data has since changed), factual_error '
  '(we got it wrong), missing_data (incomplete), other.';
COMMENT ON COLUMN public.corrections.resolution_status IS
  'Populated by correction-reverify Inngest fn or editor triage. '
  'verified_corrected: voter was right, we updated the canonical row. '
  'could_not_confirm: re-fetch inconclusive. '
  'no_change_found: we still think the original data was right. '
  'could_not_resolve: target_type did not map to an adapter; human needed. '
  'dismissed: editor explicitly dismissed (spam, bad-faith).';
COMMENT ON COLUMN public.corrections.reverify_triggered_at IS
  'Set when an editor/admin kicks off correction-reverify. Used to '
  'detect stuck re-verifications (triggered > 2h ago, no resolved_at).';
COMMENT ON TABLE public.pending_correction_replies IS
  'Outbox for voter replies. Inngest correction-reverify writes here; '
  'an email cron (built later) drains and sends via Resend.';

COMMIT;
