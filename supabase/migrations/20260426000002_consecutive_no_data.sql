-- ---------------------------------------------------------------------------
-- 20260426000001_consecutive_no_data.sql
--
-- Council 2026-04-26 finding: writeAdapterBackoff() in
-- app/src/lib/adapters/run.ts ramps next_check_at exponentially for chronic
-- 'unchanged' runs but RESETS to now()+5min for every other non-success
-- outcome. The result: an adapter that's been 'unproductive' (or
-- partial-with-0-rows, or 'failed') 100 times in a row keeps retrying every
-- 5 minutes (~12 runs/hour) instead of backing off.
--
-- Measured impact pre-fix: ~118 zero-row runs per 6h per candidacy adapter,
-- ~6,600 useless runs across 56 sos-*-candidacies adapters per 6h.
--
-- Fix: track 'consecutive_no_data' the same way we track
-- 'consecutive_unchanged'. The runner uses the SAME tiered schedule:
--   1-2 in a row : 5 min   (so transient blips don't lose probing)
--   3-9 in a row : 1 hour
--   10+ in a row : 6 hours
--
-- Reset rules (in run.ts):
--   success WITH rows > 0    → reset BOTH counters; next_check_at = now()+5m
--   unchanged                → bump consecutive_unchanged; tiered backoff
--   unproductive             → bump consecutive_no_data;   tiered backoff
--   partial with rows = 0    → bump consecutive_no_data;   tiered backoff
--   failed                   → bump consecutive_no_data;   tiered backoff
--   success with rows = 0    → bump consecutive_no_data;   tiered backoff
--   partial with rows > 0    → reset consecutive_no_data;  next_check_at = now()+30m
-- ---------------------------------------------------------------------------

ALTER TABLE adapter_status
  ADD COLUMN IF NOT EXISTS consecutive_no_data INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN adapter_status.consecutive_no_data IS
  'How many consecutive ingestion_runs produced no rows (unproductive, failed,
   partial-with-0-rows, or success-with-0-rows). Reset to 0 on any run that
   inserts/updates >=1 row. Drives the same tiered next_check_at schedule as
   consecutive_unchanged.';

-- Backfill: adapters currently labeled 'dormant_quiescent' have already been
-- chronic-no-data (the demoter labels them so after >=20 zero-row runs).
-- Seed them with consecutive_no_data=10 so they immediately get the 6h
-- backoff tier instead of waking every 5 minutes for the next 30 cycles.
UPDATE adapter_status
   SET consecutive_no_data = 10
 WHERE status = 'dormant_quiescent'
   AND consecutive_no_data = 0;
