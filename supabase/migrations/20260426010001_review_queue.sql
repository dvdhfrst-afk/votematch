-- ---------------------------------------------------------------------------
-- 20260426010001_review_queue.sql
--
-- pending_review_queue: SURFACE findings (deny-listed, cap-raising,
-- voice-conflicting, already-tried) go here instead of blocking on inline
-- prompts. The operator reviews at his convenience via `npm run review-queue`.
--
-- Dedup logic in scripts/auto-engine/cli.ts: on queue-add for an existing
-- (routine, finding) that is pending OR rejected within the last 7 days,
-- increment occurrences instead of inserting a duplicate.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS pending_review_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  routine TEXT NOT NULL,
  cycle_metric_id UUID REFERENCES cycle_metrics(id) ON DELETE SET NULL,
  finding TEXT NOT NULL,
  proposed_action TEXT,
  files_touched TEXT[] NOT NULL DEFAULT '{}',
  why_needs_review TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'auto-engine',
  decision TEXT,
  decided_at TIMESTAMPTZ,
  decision_note TEXT,
  snoozed_until TIMESTAMPTZ,
  occurrences INTEGER NOT NULL DEFAULT 1,
  last_occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pending_review_queue_decision_check
    CHECK (decision IS NULL OR decision IN ('approved', 'rejected', 'snoozed'))
);

CREATE INDEX IF NOT EXISTS idx_prq_pending
  ON pending_review_queue(created_at DESC)
  WHERE decision IS NULL;

CREATE INDEX IF NOT EXISTS idx_prq_dedupe
  ON pending_review_queue(routine, finding, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_prq_snoozed
  ON pending_review_queue(snoozed_until)
  WHERE decision = 'snoozed';

COMMENT ON TABLE pending_review_queue IS
  'Findings the auto-engine could not auto-resolve. Routines never block on
   a permission prompt; they queue here and continue. The operator reviews via
   `npm run review-queue` (lists pending) and `queue-approve|reject|snooze`.';

COMMENT ON COLUMN pending_review_queue.why_needs_review IS
  'One of: deny-list, cap-raise, voice-conflict, already-tried-reverted,
   would-prompt, or a free-text reason from a sub-agent.';

COMMENT ON COLUMN pending_review_queue.occurrences IS
  'Number of times this (routine, finding) hit the queue. Dedup increments
   instead of inserting a duplicate row when the prior entry is still
   pending or was rejected within the last 7 days.';
