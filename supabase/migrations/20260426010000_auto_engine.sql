-- ---------------------------------------------------------------------------
-- 20260426010000_auto_engine.sql
--
-- Auto-engine: shared infrastructure for autonomous council routines.
-- Backs the unified pattern: snapshot → council → categorize →
-- (auto-resolve OR surface) → verify-gate → journal → next-cycle revert.
--
-- Used by:
--   - ballot-bridge-ops-council-half-1   (every 5h)
--   - ballot-bridge-ops-council-half-2   (every 5h, offset 2.5h)
--   - ballot-bridge-data-quality-council (daily)
-- ---------------------------------------------------------------------------

-- Per-cycle metric snapshot. Each routine takes a snapshot at the start of
-- its cycle and writes one row. The next cycle compares its snapshot to the
-- prior to detect regressions caused by auto-applied fixes.
CREATE TABLE IF NOT EXISTS cycle_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  routine TEXT NOT NULL,
  cycle_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metrics JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cycle_metrics_routine_started
  ON cycle_metrics(routine, cycle_started_at DESC);

COMMENT ON TABLE cycle_metrics IS
  'One row per routine cycle. metrics is a flat jsonb of named numeric values
   (candidacies, candidacies_with_positions, dq_errors_unresolved, etc.).
   Used to detect regressions introduced by auto-applied fixes.';

-- Every auto-applied change produces a journal row. before_files is the
-- snapshot used for rollback; verify_status tracks the gate outcome;
-- metric_delta is filled in by the NEXT cycle when it compares snapshots.
CREATE TABLE IF NOT EXISTS auto_fix_journal (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  routine TEXT NOT NULL,
  cycle_metric_id UUID REFERENCES cycle_metrics(id) ON DELETE SET NULL,
  finding TEXT NOT NULL,
  action_kind TEXT NOT NULL,
  files_touched TEXT[] NOT NULL DEFAULT '{}',
  before_files JSONB NOT NULL DEFAULT '{}',
  after_files JSONB NOT NULL DEFAULT '{}',
  pm2_action TEXT,
  sql_action TEXT,
  verify_status TEXT NOT NULL DEFAULT 'pending',
  verify_log TEXT,
  applied_at TIMESTAMPTZ,
  reverted_at TIMESTAMPTZ,
  reverted_reason TEXT,
  metric_delta JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT auto_fix_journal_action_kind_check
    CHECK (action_kind IN ('code_edit', 'pm2_restart', 'sql', 'config')),
  CONSTRAINT auto_fix_journal_verify_status_check
    CHECK (verify_status IN (
      'pending', 'tsc_fail', 'lint_fail', 'build_fail',
      'applied', 'reverted', 'gate_skipped', 'failed_other'
    ))
);

CREATE INDEX IF NOT EXISTS idx_auto_fix_journal_routine
  ON auto_fix_journal(routine, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_auto_fix_journal_active
  ON auto_fix_journal(verify_status, created_at DESC)
  WHERE verify_status = 'applied' AND reverted_at IS NULL;

COMMENT ON TABLE auto_fix_journal IS
  'Every change auto-applied by a council routine. before_files holds the
   snapshot used for rollback when the next cycle detects a metric regression.
   action_kind discriminates the rollback path: code_edit restores files,
   pm2_restart and sql are journaled but not auto-reverted (compensating
   actions belong to the routine).';

-- Lightweight view: the last 2 cycles for a given routine, side-by-side, with
-- a metric_diff jsonb computed for convenience. Used by check-regression.
CREATE OR REPLACE VIEW v_cycle_metric_diff AS
SELECT
  curr.routine,
  curr.id AS curr_id,
  curr.cycle_started_at AS curr_started_at,
  prev.id AS prev_id,
  prev.cycle_started_at AS prev_started_at,
  curr.metrics AS curr_metrics,
  prev.metrics AS prev_metrics
FROM cycle_metrics curr
LEFT JOIN LATERAL (
  SELECT id, cycle_started_at, metrics
  FROM cycle_metrics p
  WHERE p.routine = curr.routine
    AND p.cycle_started_at < curr.cycle_started_at
  ORDER BY p.cycle_started_at DESC
  LIMIT 1
) prev ON TRUE;

COMMENT ON VIEW v_cycle_metric_diff IS
  'Each cycle paired with its immediate predecessor for the same routine.
   Consumers compute the delta in JS to keep regression rules centralized
   in scripts/auto-engine/cli.ts.';
