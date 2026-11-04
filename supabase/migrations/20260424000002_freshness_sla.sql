-- ============================================================
-- Freshness SLA tracking
-- ============================================================
--
-- Goal: make "is this data stale?" a first-class, queryable fact.
-- Every ingestion source has an expected max staleness (per
-- source_type default, optionally overridden per-row). Two views
-- expose this:
--
--   v_freshness_sla_status      — per data_sources row, with
--                                 last successful ingestion +
--                                 computed staleness + SLA status
--                                 (ok | warning | breach | never_run)
--
--   v_data_freshness_by_table   — pivot: one row per source_type
--                                 aggregating counts + oldest run
--                                 across all sources of that type.
--
-- Consumed by:
--   - Admin /coverage page (new "Freshness SLA" section)
--   - Inngest staleness-scanner (cron 15 */6 * * *) that fires
--     Sentry events when breach counts cross thresholds
--
-- Design notes:
--   - "Last run" = most recent ingestion_runs row with
--     status='success' for this data_source_id. We use LATERAL +
--     LIMIT 1 instead of a window function because the planner
--     picks up idx_ingestion_runs_status naturally.
--   - We FALL BACK to data_sources.created_at when no successful
--     run exists — status is 'never_run' in that case, so the
--     numeric staleness is advisory only.
--   - sla_hours lives as a column on data_sources so a single
--     source (e.g. "Ohio SoS results, election day") can be
--     tightened without changing the source_type default.
--   - Thresholds: breach = actual > sla, warning = actual > 0.8 * sla.
-- ============================================================

-- ------------------------------------------------------------
-- 1. sla_max_staleness_hours column on data_sources
-- ------------------------------------------------------------

ALTER TABLE data_sources
  ADD COLUMN IF NOT EXISTS sla_max_staleness_hours INT;

COMMENT ON COLUMN data_sources.sla_max_staleness_hours IS
  'Maximum permitted time between successful ingestions for this source, '
  'in hours. NULL means "no SLA defined — fall back to source_type default '
  'at query time". Populated per source_type by the seed UPDATE in this '
  'migration; per-source overrides are encouraged for high-stakes sources '
  '(e.g., election-day results APIs should be tightened to 0.25).';

-- ------------------------------------------------------------
-- 2. Seed sensible defaults per source_type
--
-- Runs only against rows that don't already have an SLA set, so
-- this is idempotent AND safe to re-run after per-source overrides.
-- ------------------------------------------------------------

UPDATE data_sources SET sla_max_staleness_hours = CASE source_type
  WHEN 'sos_results_api' THEN 1           -- election results are time-critical
  WHEN 'sos_candidate_filing' THEN 24
  WHEN 'sos_campaign_finance' THEN 24
  WHEN 'ethics_commission' THEN 24
  WHEN 'federal_api' THEN 24
  WHEN 'federal_vote_record' THEN 24
  WHEN 'state_legislature_api' THEN 48
  WHEN 'ballot_measure_official' THEN 168  -- 7 days
  WHEN 'state_ballot_measures' THEN 168
  WHEN 'municipal_meetings_portal' THEN 48
  WHEN 'newspaper_editorial' THEN 48
  WHEN 'editorial_rss' THEN 24
  WHEN 'census_tiger' THEN 720             -- 30 days
  WHEN 'census_geocoder' THEN 720
  WHEN 'redistricting_data_hub' THEN 720
  WHEN 'state_gis_portal' THEN 168
  WHEN 'county_gis_portal' THEN 168
  WHEN 'openstates' THEN 24
  WHEN 'campaign_website' THEN 168
  WHEN 'candidate_questionnaire' THEN 168
  WHEN 'ai_extraction' THEN 72
  WHEN 'manual_entry' THEN 720
  WHEN 'wayback_snapshot' THEN 720
  ELSE 72
END
WHERE sla_max_staleness_hours IS NULL;

-- ------------------------------------------------------------
-- 3. v_freshness_sla_status — per-source SLA view
-- ------------------------------------------------------------

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
    AND ir_inner.status = 'success'
    AND ir_inner.finished_at IS NOT NULL
  ORDER BY ir_inner.finished_at DESC
  LIMIT 1
) ir ON TRUE;

COMMENT ON VIEW public.v_freshness_sla_status IS
  'Per data_sources row: last successful ingestion + computed staleness + SLA '
  'status (ok | warning | breach | never_run). Warning threshold = 0.8 * SLA. '
  'Consumed by admin /coverage page and the staleness-scanner Inngest function.';

-- ------------------------------------------------------------
-- 4. v_data_freshness_by_table — pivot per source_type
-- ------------------------------------------------------------

CREATE OR REPLACE VIEW public.v_data_freshness_by_table AS
SELECT
  source_type,
  count(*)                                              AS source_count,
  count(*) FILTER (WHERE sla_status = 'breach')         AS breach_count,
  count(*) FILTER (WHERE sla_status = 'warning')        AS warning_count,
  count(*) FILTER (WHERE sla_status = 'ok')             AS ok_count,
  count(*) FILTER (WHERE sla_status = 'never_run')      AS never_run_count,
  -- oldest last_run across the sources of this type (NULLs = never_run sort last)
  min(last_run_at)                                      AS oldest_last_run_at,
  max(last_run_at)                                      AS newest_last_run_at,
  -- median staleness across sources that have run at least once
  round(
    percentile_cont(0.5) WITHIN GROUP (
      ORDER BY actual_staleness_hours
    ) FILTER (WHERE last_run_at IS NOT NULL)::numeric,
    2
  )                                                     AS median_staleness_hours,
  max(actual_staleness_hours)                           AS max_staleness_hours,
  -- a single representative SLA for the type; distinct per design choice
  max(sla_hours)                                        AS typical_sla_hours
FROM public.v_freshness_sla_status
GROUP BY source_type
ORDER BY breach_count DESC, source_type;

COMMENT ON VIEW public.v_data_freshness_by_table IS
  'One row per source_type with aggregated freshness stats. Pivots '
  'v_freshness_sla_status for the admin dashboard summary view.';

-- ------------------------------------------------------------
-- 5. Migration registration
--
-- Supabase CLI maintains supabase_migrations.schema_migrations
-- automatically when running `supabase db push` / `supabase
-- migration up`; we still insert defensively for direct-psql
-- application paths. ON CONFLICT DO NOTHING keeps this idempotent.
-- ------------------------------------------------------------

INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260424000002')
ON CONFLICT DO NOTHING;
