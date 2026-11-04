-- Race-condition + observability hardening (council 2026-05-26 / item #8).

-- Add 'abandoned' to the allowed status set so the reaper can use it.
ALTER TABLE ingestion_runs DROP CONSTRAINT IF EXISTS ingestion_runs_status_check;
ALTER TABLE ingestion_runs ADD CONSTRAINT ingestion_runs_status_check
  CHECK (status = ANY (ARRAY[
    'running','success','partial','failed','skipped','unproductive',
    'unchanged','unknown_termination','rejected_concurrent','rejected_cost_cap',
    'abandoned'
  ]));
--
-- 1. Reaper: rows stuck in 'running' for > 30 min get marked 'abandoned'.
--    Lets the dashboard distinguish "still working" from "crashed and left
--    a row in 'running' forever."
-- 2. Advisory-lock helper: pg_try_advisory_lock(hashtext(body_id::text))
--    is called from research-body.ts before opening a run. Prevents two
--    watchers from racing on the same body.
-- 3. Reaper helper as a function so we can call from a cron RPC.

-- ── Mark stuck-running rows as abandoned ────────────────────────────────
-- Run this from a scheduled job every ~5 min. Idempotent.
CREATE OR REPLACE FUNCTION reap_stuck_ingestion_runs(stuck_threshold_minutes int DEFAULT 30)
RETURNS TABLE(reaped_id uuid, body_id text, started_at timestamptz, stuck_minutes int) AS $$
BEGIN
  RETURN QUERY
  UPDATE ingestion_runs r
  SET status = 'abandoned',
      finished_at = now(),
      error_summary = format(
        'reaper: stuck in running > %s min; assumed crash. original started_at=%s',
        stuck_threshold_minutes, r.started_at
      )
  WHERE r.status = 'running'
    AND r.started_at < now() - (stuck_threshold_minutes || ' minutes')::interval
  RETURNING r.id,
            (r.meta->>'body_id'),
            r.started_at,
            EXTRACT(EPOCH FROM (now() - r.started_at))::int / 60;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION reap_stuck_ingestion_runs IS
  'Marks ingestion_runs rows stuck in status=running for longer than the threshold as status=abandoned. Returns the reaped rows.';

-- ── Advisory-lock helper for body_id contention ─────────────────────────
-- Use from app: SELECT try_lock_body(body_id::uuid). Returns true if lock
-- acquired (caller must release on completion via pg_advisory_unlock).
-- Two watchers racing the same body: only the first wins; the second's
-- try_lock_body returns false and the worker should skip + log.
CREATE OR REPLACE FUNCTION try_lock_body(p_body_id uuid)
RETURNS boolean AS $$
DECLARE
  lock_key bigint;
BEGIN
  -- hashtext returns int4; cast up to bigint and OR a discriminator so
  -- body-id locks don't collide with other advisory locks elsewhere.
  lock_key := (hashtext(p_body_id::text)::bigint) # x'00BB0001'::bigint;
  RETURN pg_try_advisory_lock(lock_key);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION unlock_body(p_body_id uuid)
RETURNS boolean AS $$
DECLARE
  lock_key bigint;
BEGIN
  lock_key := (hashtext(p_body_id::text)::bigint) # x'00BB0001'::bigint;
  RETURN pg_advisory_unlock(lock_key);
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION try_lock_body IS
  'Acquire a Postgres advisory lock keyed on body_id. Returns true on success. Caller MUST release with unlock_body when done.';

-- ── Index for fast "abandon stuck rows" scans ──────────────────────────
CREATE INDEX IF NOT EXISTS idx_ingestion_runs_running_oldest
  ON ingestion_runs (started_at)
  WHERE status = 'running';

-- ── Unique partial index: one in-flight run per body at a time ─────────
-- Replaces the advisory-lock approach because the Supabase HTTP client
-- doesn't preserve session state across pooled requests. The unique index
-- gives us atomic concurrency control with zero application-side gymnastics:
-- a second concurrent INSERT for the same body fails with a unique-violation
-- and the application catches it + emits status='rejected_concurrent'.
-- Auto-releases the moment the row's status moves out of 'running'.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_ingestion_runs_running_per_body
  ON ingestion_runs ((meta->>'body_id'))
  WHERE status = 'running' AND meta ? 'body_id';
