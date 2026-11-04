-- =============================================================================
-- Recompute data_sources.expected_min_rows_floor including 'unchanged' runs.
--
-- The original backfill in 20260425000002_council_wave_2_hardening.sql §6
-- computed the trailing-7d median over `status = 'success' AND
-- rows_inserted > 0`. That filter pre-dated the 'unchanged' status (added by
-- the same migration); now that ~269 runs / 3h legitimately complete as
-- 'unchanged' (rows_inserted=0 because the content_hash matched), the median
-- is computed on a smaller dataset and floors are systematically too high.
--
-- Cascade: spurious 'partial' classifications by the staleness-scanner +
-- false-alarm Sentry events when a content-hash short-circuit chain happens
-- to coincide with a low-volume source.
--
-- Fix: recompute the median across `status IN ('success','unchanged')`. We
-- intentionally include unchanged runs even though their rows_inserted is 0
-- — they represent a real successful pass at the source where the floor is
-- "0 net new rows" and the value of the median should reflect that mix.
--
-- This is destructive vs. the prior backfill — we OVERWRITE all
-- expected_min_rows_floor values for which we have ≥1 qualifying run in the
-- last 7d. Operators who hand-set a floor and want it preserved should set
-- data_sources.meta->>'expected_min_rows_floor_locked' = 'true' beforehand;
-- this migration honors that lock.
-- =============================================================================

UPDATE data_sources ds
   SET expected_min_rows_floor = sub.median
  FROM (
    SELECT
      r.data_source_id,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY r.rows_inserted)::int AS median
    FROM ingestion_runs r
    WHERE r.status IN ('success','unchanged')
      AND r.started_at > now() - interval '7 days'
    GROUP BY r.data_source_id
  ) sub
 WHERE ds.id = sub.data_source_id
   AND COALESCE(ds.meta->>'expected_min_rows_floor_locked', 'false') <> 'true';

-- ---------------------------------------------------------------------------
-- Migration registration (idempotent)
-- ---------------------------------------------------------------------------

INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260425000010')
ON CONFLICT DO NOTHING;
