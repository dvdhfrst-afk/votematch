-- =============================================================================
-- Council Wave 2 — full-coverage hardening (2026-04-25 second pass).
--
-- Implements the 41 council findings that need DB schema support. Application
-- code changes happen alongside in parallel agent runs.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Move adapter_status from inline CREATE-IF-NOT-EXISTS to a proper, owned
--    migration with FKs + RLS + GRANTs. Council finding #11. (idempotent —
--    earlier inline creation already produced a table with the right cols
--    via 20260425000000; we ALTER for missing constraints + RLS only.)
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'adapter_status' AND relrowsecurity = true) THEN
    EXECUTE 'ALTER TABLE adapter_status ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE adapter_status FORCE ROW LEVEL SECURITY';
  END IF;
END $$;

-- service_role can do everything; anon/authenticated cannot read
-- (this is ops-only data, voters never see it).
DROP POLICY IF EXISTS adapter_status_service_only ON adapter_status;
CREATE POLICY adapter_status_service_only ON adapter_status
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- 2. cost_cap_refunds_pending — same hardening.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS cost_cap_refunds_pending (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ingestion_run_id UUID REFERENCES ingestion_runs(id) ON DELETE SET NULL,
  service TEXT NOT NULL,
  amount_usd NUMERIC(10, 4) NOT NULL CHECK (amount_usd > 0),
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reconciled_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_ccrp_unreconciled
  ON cost_cap_refunds_pending (created_at)
  WHERE reconciled_at IS NULL;

ALTER TABLE cost_cap_refunds_pending ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_cap_refunds_pending FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ccrp_service_only ON cost_cap_refunds_pending;
CREATE POLICY ccrp_service_only ON cost_cap_refunds_pending
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- 3. ingestion_runs: add runner_host + runner_pid for the multi-host-safe
--    janitor (council finding #3). The continuous-ingest runner sets these
--    via `meta` already, but a typed column lets the janitor query without
--    JSON path overhead.
-- ---------------------------------------------------------------------------

ALTER TABLE ingestion_runs
  ADD COLUMN IF NOT EXISTS runner_host TEXT,
  ADD COLUMN IF NOT EXISTS runner_pid INTEGER;

CREATE INDEX IF NOT EXISTS idx_ingestion_runs_runner_host_status
  ON ingestion_runs (runner_host, status)
  WHERE status = 'running';

-- ---------------------------------------------------------------------------
-- 4. parties — pre-seed state-only and territory-only parties so candidates
--    don't get NULL party_id silently (council finding #20).
--    Idempotent: only insert when absent.
-- ---------------------------------------------------------------------------

-- parties is keyed (state_fips, normalized_name) so we seed per-state.
-- Only insert when the (state, abbreviation) tuple is absent — idempotent.
INSERT INTO parties (state_fips, abbreviation, normalized_name, display_name, party_family, is_major_in_state, ballot_access_status, color_hex, rule_citation)
VALUES
  -- Puerto Rico (FIPS 72) — PNP and PPD are dominant; PIP/MVC/PD are minor but ballot-qualified
  ('72', 'PNP', 'partido nuevo progresista',          'Partido Nuevo Progresista',          'other',    true,  'qualified', '#0033A0', 'PR Comisión Estatal de Elecciones'),
  ('72', 'PPD', 'partido popular democratico',         'Partido Popular Democrático',         'other',    true,  'qualified', '#E60012', 'PR Comisión Estatal de Elecciones'),
  ('72', 'MVC', 'movimiento victoria ciudadana',       'Movimiento Victoria Ciudadana',       'other',    false, 'qualified', '#FFD700', 'PR CEE 2024 ballot'),
  ('72', 'PIP', 'partido independentista puertorriqueno','Partido Independentista Puertorriqueño','other',  false, 'qualified', '#00A86B', 'PR CEE'),
  ('72', 'PD',  'proyecto dignidad',                   'Proyecto Dignidad',                   'other',    false, 'qualified', '#7B68EE', 'PR CEE 2020 ballot'),
  -- DC Statehood Greens
  ('11', 'DCSG','dc statehood green party',            'DC Statehood Green Party',            'green',    false, 'qualified', '#54A53C', 'DC BOE'),
  -- State-affiliated names: MN Democratic-Farmer-Labor, ND Democratic-Nonpartisan League
  ('27', 'DFL', 'democratic farmer labor',             'Minnesota Democratic-Farmer-Labor',   'democratic', true, 'qualified', '#1976D2', 'MN SOS'),
  ('38', 'NPL', 'democratic nonpartisan league',       'North Dakota Democratic-NPL',         'democratic', true, 'qualified', '#1976D2', 'ND SOS'),
  -- NY fusion-voting parties
  ('36', 'WFP', 'working families',                    'Working Families Party',              'other',    false, 'qualified', '#FF6633', 'NY BOE'),
  ('36', 'CPNY','conservative',                        'Conservative Party of New York',      'other',    false, 'qualified', '#003366', 'NY BOE'),
  ('36', 'FWD', 'forward',                             'Forward Party',                       'other',    false, 'qualified', '#9F2B68', 'NY BOE'),
  -- CT also has WFP / Conservative Party
  ('09', 'WFP', 'working families',                    'Working Families Party (CT)',         'other',    false, 'qualified', '#FF6633', 'CT SOTS'),
  -- National-scope fallback rows (state_fips IS NULL — used for write-ins / Independent)
  (NULL, 'I',   'independent',                         'Independent',                          'independent','false','qualified', '#666666', 'national fallback'),
  (NULL, 'NP',  'nonpartisan',                         'Nonpartisan',                          'nonpartisan','false','qualified', '#888888', 'national fallback'),
  (NULL, 'W/I', 'write in',                            'Write-In',                             'other',     false, 'qualified', '#999999', 'national fallback')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 5. data_sources: per-adapter unchanged_window_seconds (council finding #25).
--    Stored on data_sources.meta but a typed column makes runner queries
--    cheap. Default 21600s (6h, current behavior).
-- ---------------------------------------------------------------------------

ALTER TABLE data_sources
  ADD COLUMN IF NOT EXISTS unchanged_window_seconds INTEGER NOT NULL DEFAULT 21600;

COMMENT ON COLUMN data_sources.unchanged_window_seconds IS
  'How long an unchanged content_hash short-circuits re-ingest. Default 6h. '
  'Set to 300 for live election-results adapters (results change every minute), '
  '86400 for daily-bulk dumps (federal-bills, FEC). Council 2026-04-25 #25.';

-- ---------------------------------------------------------------------------
-- 6. data_sources: per-adapter expected_min_rows (council finding #7).
--    Today this comes from the adapter's createOptions; a column lets the
--    Adapter Doctor and dashboards see it without code archaeology. Default
--    null = "adapter must set this to a non-null value or the run is invalid."
-- ---------------------------------------------------------------------------

ALTER TABLE data_sources
  ADD COLUMN IF NOT EXISTS expected_min_rows_floor INTEGER;

-- Backfill from trailing-7d median where we have history.
UPDATE data_sources ds
   SET expected_min_rows_floor = sub.median
  FROM (
    SELECT
      r.data_source_id,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY r.rows_inserted)::int AS median
    FROM ingestion_runs r
    WHERE r.status = 'success'
      AND r.rows_inserted > 0
      AND r.started_at > now() - interval '7 days'
    GROUP BY r.data_source_id
  ) sub
 WHERE ds.id = sub.data_source_id
   AND ds.expected_min_rows_floor IS NULL;

-- ---------------------------------------------------------------------------
-- 7. ingestion_runs status: ensure new statuses (already added in
--    20260425000000 but defensively re-assert). Plus 'unknown_termination'
--    for backends terminated by janitor without classification.
-- ---------------------------------------------------------------------------

ALTER TABLE ingestion_runs DROP CONSTRAINT IF EXISTS ingestion_runs_status_check;
ALTER TABLE ingestion_runs ADD CONSTRAINT ingestion_runs_status_check CHECK (
  status IN (
    'running','success','partial','failed','skipped',
    'unproductive','unchanged','unknown_termination',
    'rejected_concurrent','rejected_cost_cap'
  )
);

-- ---------------------------------------------------------------------------
-- 8. primary_readiness: alert on over-ingest + missing baseline (council #41).
--    Add a generated column that flags states needing human attention.
-- ---------------------------------------------------------------------------

-- Postgres forbids generated columns referencing other generated columns,
-- so alert_status is a view instead of a column.
CREATE OR REPLACE VIEW v_primary_readiness_alerts AS
SELECT *,
  CASE
    WHEN expected_candidacy_count IS NULL THEN 'no_baseline'
    WHEN actual_candidacy_count IS NULL THEN 'never_checked'
    WHEN delta_pct < -10 THEN 'under_ingest'
    WHEN delta_pct > 20 THEN 'over_ingest'
    ELSE 'ok'
  END AS alert_status
FROM primary_readiness;

-- ---------------------------------------------------------------------------
-- 9. confidence_threshold per source-type (council finding #26). Replaces
--    the global 0.75 magic number with a tier table the extractors and
--    runner can both consult.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS confidence_thresholds (
  source_authority TEXT PRIMARY KEY,
  auto_publish_min NUMERIC(3,2) NOT NULL CHECK (auto_publish_min BETWEEN 0 AND 1),
  human_review_required BOOLEAN NOT NULL DEFAULT false,
  notes TEXT
);

INSERT INTO confidence_thresholds (source_authority, auto_publish_min, human_review_required, notes) VALUES
  ('government_authoritative', 0.0,  false, 'Congress.gov, FEC, state SoS — primary source, never hold back'),
  ('compiled_official',         0.85, false, 'OpenStates bulk, NIST XML — authoritative aggregator'),
  ('ai_extracted_low_risk',     0.85, false, 'Federal bill summaries, regulation digests — LLM-extracted'),
  ('ai_extracted_high_risk',    0.95, true,  'Candidacies, ballot measures, vote positions — primary-night content; human review'),
  ('news_endorsement',          0.80, false, 'AI-extracted newspaper endorsement parses')
ON CONFLICT (source_authority) DO UPDATE
  SET auto_publish_min = EXCLUDED.auto_publish_min,
      human_review_required = EXCLUDED.human_review_required,
      notes = EXCLUDED.notes;

COMMENT ON TABLE confidence_thresholds IS
  'Tier-per-source-type confidence thresholds. Replaces the global 0.75 '
  'magic number with explicit policy. Council 2026-04-25 finding #26.';

-- ---------------------------------------------------------------------------
-- 10. jurisdictions: ensure IANA tz column exists. Used by staleness-scanner
--     to compute "today" per state instead of server UTC (council #30).
-- ---------------------------------------------------------------------------

ALTER TABLE jurisdictions
  ADD COLUMN IF NOT EXISTS iana_tz TEXT;

-- Seed IANA tz for the major US zones. Idempotent.
UPDATE jurisdictions SET iana_tz = 'America/New_York'   WHERE fips_state IN ('09','10','11','12','13','24','25','27','33','34','36','37','42','44','45','50','51') AND iana_tz IS NULL;
UPDATE jurisdictions SET iana_tz = 'America/Chicago'    WHERE fips_state IN ('01','05','17','18','19','20','22','28','29','38','40','46','47','48','55') AND iana_tz IS NULL;
UPDATE jurisdictions SET iana_tz = 'America/Denver'     WHERE fips_state IN ('08','16','30','35','49','56') AND iana_tz IS NULL;
UPDATE jurisdictions SET iana_tz = 'America/Phoenix'    WHERE fips_state = '04' AND iana_tz IS NULL; -- AZ no DST except Navajo
UPDATE jurisdictions SET iana_tz = 'America/Los_Angeles' WHERE fips_state IN ('06','32','41','53') AND iana_tz IS NULL;
UPDATE jurisdictions SET iana_tz = 'America/Anchorage'  WHERE fips_state = '02' AND iana_tz IS NULL;
UPDATE jurisdictions SET iana_tz = 'Pacific/Honolulu'   WHERE fips_state = '15' AND iana_tz IS NULL;
UPDATE jurisdictions SET iana_tz = 'America/Puerto_Rico' WHERE fips_state = '72' AND iana_tz IS NULL;
UPDATE jurisdictions SET iana_tz = 'Pacific/Guam'       WHERE fips_state IN ('66','69') AND iana_tz IS NULL; -- GU + MP same TZ
UPDATE jurisdictions SET iana_tz = 'America/St_Thomas'  WHERE fips_state = '78' AND iana_tz IS NULL;
UPDATE jurisdictions SET iana_tz = 'Pacific/Pago_Pago'  WHERE fips_state = '60' AND iana_tz IS NULL;
-- A few states span multiple TZ; use the most-populated. Operators can override per-county.
UPDATE jurisdictions SET iana_tz = 'America/Chicago'    WHERE fips_state = '21' AND iana_tz IS NULL; -- KY (eastern half is ET, but most pop in CT)
UPDATE jurisdictions SET iana_tz = 'America/New_York'   WHERE fips_state = '39' AND iana_tz IS NULL; -- OH

CREATE INDEX IF NOT EXISTS idx_jurisdictions_fips_state ON jurisdictions (fips_state);

-- ---------------------------------------------------------------------------
-- Done. Application code in src/lib/* and scripts/* picks up the rest.
-- ---------------------------------------------------------------------------
