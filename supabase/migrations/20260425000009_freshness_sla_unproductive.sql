-- =============================================================================
-- Freshness SLA: treat 'unproductive' and 'unchanged' as fresh.
--
-- Council META-ASSUMPTION + SRE follow-up to 20260424000002_freshness_sla.sql.
--
-- Background. The original v_freshness_sla_status defined "last successful
-- run" as `ingestion_runs.status = 'success'`. Two newer status values were
-- added later by 20260425000002:
--   - 'unproductive' — runner reached the source successfully and the source
--                      legitimately had no rows to return (e.g. an off-cycle
--                      state CF feed that's empty until candidate filing
--                      opens).
--   - 'unchanged'    — runner reached the source, computed a content_hash,
--                      and the hash matched the previous successful run, so
--                      we short-circuited re-ingest.
--
-- Both signal "the runner reached the source and decided there was nothing
-- new" — i.e. healthy. With the old view, off-season state CF sources
-- silently flip to 'never_run' → 'breach' after 24h, which spams Sentry and
-- cascades into the staleness-scanner flipping district_ingestion_status to
-- 'partial'.
--
-- Fix: include both 'unproductive' AND 'unchanged' in the "last successful
-- run" lateral subquery. Replace the view in place; downstream views
-- (v_data_freshness_by_table) inherit the fix automatically because they
-- read from this view.
-- =============================================================================

CREATE OR REPLACE VIEW public.v_freshness_sla_status AS
SELECT
  ds.id                                              AS data_source_id,
  ds.name,
  ds.state_fips,
  ds.source_type,
  ds.license,
  ir.finished_at                                     AS last_run_at,
  ir.ingestion_run_id                                AS last_ingestion_run_id,
  ds.sla_max_staleness_hours                         AS sla_hours,
  -- numeric staleness in hours; falls back to created_at when never run
  ROUND(
    (EXTRACT(EPOCH FROM (now() - COALESCE(ir.finished_at, ds.created_at))) / 3600.0)::numeric,
    2
  )                                                  AS actual_staleness_hours,
  CASE
    WHEN ir.finished_at IS NULL
      THEN 'never_run'
    WHEN ds.sla_max_staleness_hours IS NULL
      THEN 'ok'                                       -- no SLA defined → don't alarm
    WHEN EXTRACT(EPOCH FROM (now() - ir.finished_at)) / 3600.0
         > ds.sla_max_staleness_hours
      THEN 'breach'
    WHEN EXTRACT(EPOCH FROM (now() - ir.finished_at)) / 3600.0
         > ds.sla_max_staleness_hours * 0.8
      THEN 'warning'
    ELSE 'ok'
  END                                                AS sla_status
FROM data_sources ds
LEFT JOIN LATERAL (
  SELECT
    ir_inner.id          AS ingestion_run_id,
    ir_inner.finished_at
  FROM ingestion_runs ir_inner
  WHERE ir_inner.data_source_id = ds.id
    AND ir_inner.status IN ('success', 'unchanged', 'unproductive')
    AND ir_inner.finished_at IS NOT NULL
  ORDER BY ir_inner.finished_at DESC
  LIMIT 1
) ir ON TRUE;

COMMENT ON VIEW public.v_freshness_sla_status IS
  'Per data_sources row: last successful ingestion + computed staleness + SLA '
  'status (ok | warning | breach | never_run). "Successful" includes '
  'status IN (success, unchanged, unproductive) — all three signal the runner '
  'reached the source. Warning threshold = 0.8 * SLA. Consumed by admin '
  '/coverage page and the staleness-scanner Inngest function.';

-- ---------------------------------------------------------------------------
-- Migration registration (idempotent)
-- ---------------------------------------------------------------------------

INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260425000009')
ON CONFLICT DO NOTHING;
