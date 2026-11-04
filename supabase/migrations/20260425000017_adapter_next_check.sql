-- ---------------------------------------------------------------------------
-- 20260425000017_adapter_next_check.sql
--
-- Council 2026-04-25 finding: ballot-measures-* adapters hit unchanged-content
-- short-circuits dozens of times per cycle, burning ~13K worker-seconds/hour
-- with zero useful work. Add a per-adapter back-off cache: after N consecutive
-- 'unchanged' runs, push the next eligible-check time out so the dispatcher
-- skips this adapter until it makes sense to try again.
--
-- Backoff schedule (applied in app/src/lib/adapters/run.ts):
--   1st-2nd unchanged in a row: now() + 5 min   (no real backoff)
--   3rd-9th unchanged in a row: now() + 1 hour
--   10th+   unchanged in a row: now() + 6 hours
--   any non-unchanged outcome: reset to now() + 5 min
--
-- continuous-ingest's buildTaskQueue() reads next_check_at and skips any
-- adapter whose value is still in the future.
-- ---------------------------------------------------------------------------

ALTER TABLE adapter_status
  ADD COLUMN IF NOT EXISTS next_check_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS consecutive_unchanged INT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_adapter_status_next_check_at
  ON adapter_status (next_check_at);

COMMENT ON COLUMN adapter_status.next_check_at IS
  'Earliest time this adapter should be eligible to run again. Used by
   continuous-ingest to back off chronic-unchanged adapters. NULL = always
   eligible (default).';

COMMENT ON COLUMN adapter_status.consecutive_unchanged IS
  'How many consecutive ingestion_runs ended with status=unchanged. Reset to 0
   on any non-unchanged outcome. Drives the next_check_at backoff schedule.';
