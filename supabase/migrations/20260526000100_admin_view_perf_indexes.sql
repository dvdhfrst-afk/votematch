-- =============================================================================
-- 2026-05-26 — Make the two admin views the probe surfaced as slow fast
-- enough to live under PostgREST's 8s statement_timeout.
--
-- Probe (scripts/_probe-admin-dashboards.ts) showed these failing:
--   • v_data_freshness_by_table  (used by /admin/coverage)
--   • v_interpretation_backlog   (used by /admin/workers)
--
-- Diagnoses:
--
-- 1. v_data_freshness_by_table → reads v_freshness_sla_status, which does a
--    LATERAL "latest run per data_source" join into ingestion_runs:
--      WHERE data_source_id = ds.id
--        AND status IN ('success','unchanged','unproductive')
--        AND finished_at IS NOT NULL
--      ORDER BY finished_at DESC LIMIT 1
--    Existing indexes on ingestion_runs (adapter_name / state_fips / status)
--    aren't keyed on data_source_id, so each LATERAL becomes a sort over
--    everything that matches the status filter. Add a partial composite
--    that does match the predicate.
--
-- 2. v_interpretation_backlog issues count(*) across 6 tables. Each table
--    already has a partial index WHERE interpretation_status = 0 (from
--    20260425000011 + 20260426000000), but counting that partial subset
--    still scans the heap because the index isn't visibility-map-fresh.
--    The page that uses it (/admin/workers) auto-refreshes on reload and
--    a few seconds of staleness is fine, so swap VIEW → MATERIALIZED VIEW
--    and refresh it from the existing refresh-matviews Inngest job.
--
-- All operations are idempotent (IF NOT EXISTS / DROP IF EXISTS) so re-runs
-- are safe.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. ingestion_runs index for the v_freshness_sla_status LATERAL join.
--
-- Partial predicate matches the view's WHERE exactly so the planner can
-- index-only seek the most-recent finished_at per data_source.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_ingestion_runs_ds_finished_productive
  ON public.ingestion_runs (data_source_id, finished_at DESC)
  WHERE status IN ('success','unchanged','unproductive')
    AND finished_at IS NOT NULL
    AND data_source_id IS NOT NULL;

COMMENT ON INDEX public.idx_ingestion_runs_ds_finished_productive IS
  'Supports v_freshness_sla_status LATERAL "latest run per data_source". '
  'Predicate matches the view exactly so PG can use it as an index-only '
  'lookup. Without this index v_data_freshness_by_table timed out at 8s.';

-- ---------------------------------------------------------------------------
-- 2. v_interpretation_backlog: VIEW → MATERIALIZED VIEW.
--
-- We DROP the existing plain view, recreate as a matview, and add a unique
-- index on (kind) so REFRESH CONCURRENTLY works (the existing refresh-
-- matviews Inngest job calls REFRESH CONCURRENTLY).
--
-- ON CONFLICT pattern: if a previous failed migration already created the
-- matview, DROP MATERIALIZED VIEW IF EXISTS handles it; DROP VIEW IF EXISTS
-- handles the plain-view ancestor.
-- ---------------------------------------------------------------------------

DROP VIEW IF EXISTS public.v_interpretation_backlog;
DROP MATERIALIZED VIEW IF EXISTS public.v_interpretation_backlog;

CREATE MATERIALIZED VIEW public.v_interpretation_backlog AS
SELECT 'cf_resolution'::text AS kind,
       count(*)::bigint AS pending
  FROM public.state_cf_events
  WHERE interpretation_status = 0
UNION ALL
SELECT 'bill_dimension',
       count(*)::bigint
  FROM public.federal_bills
  WHERE interpretation_status = 0
UNION ALL
SELECT 'positions',
       count(*)::bigint
  FROM public.candidates
  WHERE positions_interpretation_status = 0 AND published = true
UNION ALL
SELECT 'rulemaking_dimension',
       count(*)::bigint
  FROM public.state_rulemaking_events
  WHERE interpretation_status = 0
UNION ALL
SELECT 'ballot_measure_dimension',
       count(*)::bigint
  FROM public.ballot_measures
  WHERE interpretation_status = 0
UNION ALL
SELECT 'meeting_dimension',
       count(*)::bigint
  FROM public.municipal_meetings
  WHERE interpretation_status = 0;

-- REFRESH MATERIALIZED VIEW CONCURRENTLY requires a UNIQUE index covering
-- every row in the matview. (kind) is unique by construction.
CREATE UNIQUE INDEX IF NOT EXISTS idx_v_interpretation_backlog_kind
  ON public.v_interpretation_backlog (kind);

COMMENT ON MATERIALIZED VIEW public.v_interpretation_backlog IS
  'Pending-interpretation counts per resolver kind. Refreshed by the '
  'refresh-matviews Inngest job (11:00 UTC daily + event-triggered). '
  '/admin/workers reads this directly — a few minutes of staleness is fine '
  'for an ops dashboard; full re-counts would time out under PostgREST.';

-- Service-role can read; RLS is inherited from the underlying tables, but
-- matviews don't get RLS automatically. Explicitly grant SELECT to
-- service_role since the admin layout authenticates that way.
GRANT SELECT ON public.v_interpretation_backlog TO service_role;

-- ---------------------------------------------------------------------------
-- 3. Refresh stats so the planner picks up the new index immediately.
-- ---------------------------------------------------------------------------

ANALYZE public.ingestion_runs;

-- Populate the new matview once so /admin/workers doesn't show zeros until
-- the next Inngest cron tick. REFRESH (not REFRESH CONCURRENTLY) on first
-- populate because the matview has no prior contents.
REFRESH MATERIALIZED VIEW public.v_interpretation_backlog;
