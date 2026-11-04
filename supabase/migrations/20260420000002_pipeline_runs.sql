-- Pipeline runs audit + concurrency sentinel.
--
-- Motivation: council Lens 1 critical risk #4 — batch-classify is a cartesian
-- product with no cost ceiling. An accidental re-trigger (duplicate event,
-- retry storm, manual fire during an in-flight run) risks real Claude Batch
-- spend. This table serves two jobs:
--
--   1. Concurrency sentinel. At the top of a protected function we SELECT
--      for any running row with the same function_name. If found, we abort.
--   2. Cost-guard audit trail. Rejected runs (cost ceiling exceeded or
--      concurrent) are written with a terminal status so we can see why a
--      run never started.
--
-- Service-role-only; no public policies. Runs are operational telemetry.

CREATE TABLE pipeline_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  function_name text NOT NULL,
  status text NOT NULL CHECK (status IN ('running','completed','failed','rejected_cost_guard','rejected_concurrent')),
  request_count integer,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  inngest_run_id text,
  metadata jsonb
);

-- Fast lookup for the concurrency sentinel: WHERE function_name=$1 AND status='running'.
CREATE INDEX idx_pipeline_runs_running
  ON pipeline_runs(function_name, status)
  WHERE status = 'running';

-- Idempotency key: a given Inngest run_id should only ever insert one row.
-- NULLs allowed so manual/one-off writes (tests) don't collide.
CREATE UNIQUE INDEX idx_pipeline_runs_inngest_run_id
  ON pipeline_runs(inngest_run_id)
  WHERE inngest_run_id IS NOT NULL;

ALTER TABLE pipeline_runs ENABLE ROW LEVEL SECURITY;
-- Service-role only; no public policies.

COMMENT ON TABLE pipeline_runs IS
  'Audit + concurrency sentinel for cost-sensitive pipeline functions (batch-classify, etc.). '
  'Service-role only. See 15-council/00-initial-review-2026-04-20.md Lens 1 risk #4.';

COMMENT ON COLUMN pipeline_runs.status IS
  'running = in flight. completed/failed = terminal. rejected_cost_guard = planned request '
  'count exceeded MAX_BATCH_REQUESTS. rejected_concurrent = another run was already in flight.';
