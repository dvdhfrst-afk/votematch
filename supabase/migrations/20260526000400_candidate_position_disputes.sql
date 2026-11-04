-- ============================================================
-- candidate_position_disputes: right-of-reply portal data store
-- ============================================================
--
-- Per notes/ballot-bridge-execution-order.md Week 3 item 12 and the
-- council legal reviewer: "right-of-reply portal in code is the
-- single biggest defamation risk reducer."
--
-- When the platform publishes an *inferred* position vector for a
-- candidate (positions.view_type='inferred'), the candidate must have
-- a clear, low-friction path to push back. This table is the data
-- store behind that path. The UI lives at
-- /for-candidates/profile/[token]/disputes (code-only at this stage;
-- not deployed publicly until a public launch).
--
-- Design constraints:
--   1. The candidate is identified by their portal session token, not
--      a user account. We store the SHA-256 of that token alongside the
--      candidate_id so the row's authenticity is verifiable, matching
--      the candidate_magic_link_submissions pattern from
--      20260420000005_candidate_questionnaire_tokens.sql.
--   2. We do NOT auto-modify the disputed position row. A dispute is
--      an editorial signal queued for human review (an admin or
--      research-agent re-pass). The status column tracks that workflow.
--   3. The candidate may also submit a "suggested" score (0..1). This
--      is informational; review is required before any score change.
--   4. Free-text "reason" is length-bounded (2000 chars) to align with
--      the data-minimization posture used elsewhere.
--   5. RLS service-role-only — like all other candidate-portal tables.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.candidate_position_disputes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Who is disputing. candidate_id is the strong reference.
  candidate_id UUID NOT NULL
    REFERENCES public.candidates(id) ON DELETE CASCADE,

  -- Which dimension is being disputed. The sub_dim resolves the human-
  -- readable label; the position_id (if present) pins the exact row the
  -- candidate was looking at when they hit dispute.
  sub_dimension_id UUID NOT NULL
    REFERENCES public.sub_dimensions(id) ON DELETE CASCADE,
  position_id UUID
    REFERENCES public.positions(id) ON DELETE SET NULL,

  -- What the candidate is claiming about the inferred score.
  --   'wrong_score'   — the score is wrong but we got the topic right
  --   'wrong_topic'   — we attributed the wrong issue to them entirely
  --   'wrong_source'  — the source we cited doesn't say what we claim
  --   'no_position'   — they have not taken a public position on this
  --   'other'         — see reason field
  dispute_type TEXT NOT NULL
    CHECK (dispute_type IN (
      'wrong_score', 'wrong_topic', 'wrong_source', 'no_position', 'other'
    )),

  -- Optional: what the candidate believes the correct score is (0..1).
  -- Treated as informational only — admin review is required to actually
  -- change a position.
  suggested_score NUMERIC(4, 3)
    CHECK (suggested_score IS NULL OR (suggested_score >= 0 AND suggested_score <= 1)),

  -- The candidate's narrative reason. Length-bounded.
  reason TEXT
    CHECK (reason IS NULL OR length(reason) <= 2000),

  -- SHA-256 of the for-candidates portal token that submitted this.
  -- Allows audit ("this dispute came from a session validated by token X")
  -- without storing the raw token. Mirrors the
  -- candidate_magic_link_submissions.token_fingerprint pattern.
  submitted_via_token_hash TEXT NOT NULL,

  -- Editorial workflow status.
  --   'submitted' (default)   — fresh, waiting for triage
  --   'in_review'             — an admin/agent is looking
  --   'accepted'              — the position has been corrected
  --   'rejected_evidence'     — review found our original was correct
  --   'rejected_off_topic'    — dispute didn't match the dim
  --   'merged'                — folded into a related dispute
  status TEXT NOT NULL DEFAULT 'submitted'
    CHECK (status IN (
      'submitted', 'in_review', 'accepted',
      'rejected_evidence', 'rejected_off_topic', 'merged'
    )),

  -- Admin annotations after triage.
  resolver_notes TEXT
    CHECK (resolver_notes IS NULL OR length(resolver_notes) <= 4000),
  resolved_at TIMESTAMPTZ,
  resolved_by TEXT,                            -- admin email or agent id

  -- Optional FK to the new position row created when an acceptance
  -- correction lands.
  resulting_position_id UUID
    REFERENCES public.positions(id) ON DELETE SET NULL,

  meta JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_candidate_position_disputes_candidate
  ON public.candidate_position_disputes (candidate_id);

CREATE INDEX IF NOT EXISTS idx_candidate_position_disputes_sub_dim
  ON public.candidate_position_disputes (sub_dimension_id);

CREATE INDEX IF NOT EXISTS idx_candidate_position_disputes_status
  ON public.candidate_position_disputes (status)
  WHERE status IN ('submitted', 'in_review');

CREATE INDEX IF NOT EXISTS idx_candidate_position_disputes_resolver
  ON public.candidate_position_disputes (resolved_at DESC NULLS LAST);

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.candidate_position_disputes_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_candidate_position_disputes_updated_at
  ON public.candidate_position_disputes;
CREATE TRIGGER trg_candidate_position_disputes_updated_at
  BEFORE UPDATE ON public.candidate_position_disputes
  FOR EACH ROW
  EXECUTE FUNCTION public.candidate_position_disputes_set_updated_at();

-- RLS: service-role-only (matches all other candidate-portal tables).
ALTER TABLE public.candidate_position_disputes ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.candidate_position_disputes IS 'Right-of-reply portal: when a candidate disputes an inferred position vector through /for-candidates/profile/[token]/disputes, the dispute lands here for human review.';

COMMENT ON COLUMN public.candidate_position_disputes.submitted_via_token_hash IS 'SHA-256 of the for-candidates portal token used to submit this dispute. Raw token never stored. Mirrors candidate_magic_link_submissions.token_fingerprint.';

COMMENT ON COLUMN public.candidate_position_disputes.status IS 'Editorial workflow. Default ''submitted''. Admins move through in_review and either an accept- or reject-class terminal status.';
