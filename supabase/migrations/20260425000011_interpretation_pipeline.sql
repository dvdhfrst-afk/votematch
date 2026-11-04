-- =============================================================================
-- Interpretation pipeline (foundational)
--
-- Council worst-mistake-to-avoid: "letting interpretation write directly to
-- canonical columns with no version row and no confidence gate."
--
-- This migration introduces a versioned write target (`interpretations`) so
-- every resolver decision is recorded with model_id, confidence, inputs_hash,
-- and resolver_git_sha. Canonical tables get a small `interpretation_status`
-- smallint that tracks pipeline state without coupling to the resolver.
--
-- Tables / changes:
--   1. interpretations           — versioned, append-only resolver output
--   2. *.interpretation_status   — added to state_cf_events, federal_bills,
--                                   candidates (positions_interpretation_status)
--   3. cost_caps                  — three new resolver/ingestion service rows
--   4. federal_vote_dimension_scores — nightly rollup target for the
--                                   federal_vote_positions × bill_dimension_map
--                                   aggregation
--   5. v_interpretation_backlog  — helper view that returns pending counts
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. interpretations — versioned write target
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS interpretations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target_table TEXT NOT NULL,           -- 'state_cf_events'|'federal_bills'|'candidates'|'endorsements'
  target_id TEXT NOT NULL,              -- UUID/PK of the row being interpreted (text for non-UUID keys)
  kind TEXT NOT NULL,                   -- 'cf_resolution'|'bill_dimension'|'position_extraction'|'endorsement_link'|'vote_dimension'
  version INTEGER NOT NULL DEFAULT 1,
  value JSONB NOT NULL,                 -- resolver-specific payload
  confidence NUMERIC(3,2) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  resolver_git_sha TEXT,
  model_id TEXT,                        -- 'phi4:14b'|'claude-sonnet-4.6'|'sql-fuzzy-v1'
  inputs_hash TEXT,                     -- sha256 of the inputs; lets us detect re-running same input
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  superseded_at TIMESTAMPTZ,            -- set when a higher-version row arrives
  CONSTRAINT interpretations_unique_target_kind_version UNIQUE (target_table, target_id, kind, version)
);

CREATE INDEX IF NOT EXISTS idx_interpretations_target
  ON interpretations (target_table, target_id, kind, version DESC);

CREATE INDEX IF NOT EXISTS idx_interpretations_kind_confidence
  ON interpretations (kind, confidence DESC);

CREATE INDEX IF NOT EXISTS idx_interpretations_pending
  ON interpretations (kind, created_at) WHERE superseded_at IS NULL;

-- RLS: service-role only (no anon/authenticated read — interpretation rows are
-- a write log; published canonical columns are the public surface).
ALTER TABLE interpretations ENABLE ROW LEVEL SECURITY;
ALTER TABLE interpretations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS interp_service ON interpretations;
CREATE POLICY interp_service ON interpretations
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

COMMENT ON TABLE interpretations IS
  'Versioned write target for the interpretation pipeline. Every resolver '
  'decision (cf_resolution, bill_dimension, position_extraction, '
  'endorsement_link, vote_dimension) lands here with model_id + confidence + '
  'inputs_hash before any canonical column is touched. Higher versions set '
  'superseded_at on lower versions; readers should select the latest '
  'non-superseded row per (target_table, target_id, kind).';

-- ---------------------------------------------------------------------------
-- 2. interpretation_status smallint columns on canonical tables
--    0 = new (needs resolution)
--    1 = resolved
--    2 = unresolvable
--    3 = stale-after-resolver-bump (force re-resolution)
-- ---------------------------------------------------------------------------

-- state_cf_events: needs cf_resolution (person + candidacy linkage)
ALTER TABLE state_cf_events
  ADD COLUMN IF NOT EXISTS interpretation_status SMALLINT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_state_cf_events_pending
  ON state_cf_events (interpretation_status, id)
  WHERE interpretation_status = 0;

COMMENT ON COLUMN state_cf_events.interpretation_status IS
  'Interpretation pipeline state: 0=new, 1=resolved, 2=unresolvable, 3=stale.';

-- federal_bills: needs bill_dimension (mapping bill -> BB sub-dimensions)
ALTER TABLE federal_bills
  ADD COLUMN IF NOT EXISTS interpretation_status SMALLINT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_federal_bills_pending
  ON federal_bills (interpretation_status, ingested_at)
  WHERE interpretation_status = 0;

COMMENT ON COLUMN federal_bills.interpretation_status IS
  'Interpretation pipeline state for bill-dimension mapping: 0=new, 1=resolved, 2=unresolvable, 3=stale.';

-- candidates: needs position_extraction
ALTER TABLE candidates
  ADD COLUMN IF NOT EXISTS positions_interpretation_status SMALLINT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_candidates_positions_pending
  ON candidates (positions_interpretation_status, id)
  WHERE positions_interpretation_status = 0 AND published = true;

COMMENT ON COLUMN candidates.positions_interpretation_status IS
  'Interpretation pipeline state for position extraction: 0=new, 1=resolved, 2=unresolvable, 3=stale.';

-- ---------------------------------------------------------------------------
-- 3. cost_caps — split resolver/ingestion services
--
-- The existing cost_caps table is keyed on (service, date) with columns
-- (daily_usd_cap, daily_usd_spent, ...). Adapting the spec to match.
-- 'ingestion-fetch' likely lives under 'other' currently; ON CONFLICT
-- DO NOTHING is safe.
-- ---------------------------------------------------------------------------
INSERT INTO cost_caps (service, date, daily_usd_cap) VALUES
  ('ingestion-fetch',           CURRENT_DATE,  0.00),
  ('interpretation-llm-claude', CURRENT_DATE,  5.00),
  ('interpretation-llm-ollama', CURRENT_DATE,  0.00),
  ('geocoding',                 CURRENT_DATE,  1.00)
ON CONFLICT (service, date) DO NOTHING;

COMMENT ON COLUMN cost_caps.service IS
  'External service id. Known values: claude_api, claude_batch, census_geocoder, '
  'nominatim, wayback_cdx, resend, openfec, congress_gov, regulations_gov, '
  'scraperapi, playwright, ingestion-fetch, interpretation-llm-claude, '
  'interpretation-llm-ollama, geocoding.';

-- ---------------------------------------------------------------------------
-- 4. federal_vote_dimension_scores — rollup of federal_vote_positions
--    × bill_dimension_map (populated nightly by the vote-dimension-rollup
--    script).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS federal_vote_dimension_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bioguide_id TEXT NOT NULL,
  dimension_key TEXT NOT NULL,
  vote_count INTEGER NOT NULL,
  agreement_score NUMERIC(4,3) NOT NULL CHECK (agreement_score BETWEEN 0 AND 1),
  -- 0.0 = always voted opposite to dimension intent; 1.0 = always voted aligned
  last_vote_at TIMESTAMPTZ,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (bioguide_id, dimension_key)
);

CREATE INDEX IF NOT EXISTS idx_fvds_bioguide
  ON federal_vote_dimension_scores (bioguide_id);

ALTER TABLE federal_vote_dimension_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE federal_vote_dimension_scores FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS fvds_public_read ON federal_vote_dimension_scores;
CREATE POLICY fvds_public_read ON federal_vote_dimension_scores
  FOR SELECT TO anon, authenticated
  USING (true);

DROP POLICY IF EXISTS fvds_service_write ON federal_vote_dimension_scores;
CREATE POLICY fvds_service_write ON federal_vote_dimension_scores
  FOR INSERT TO service_role
  WITH CHECK (true);

DROP POLICY IF EXISTS fvds_service_update ON federal_vote_dimension_scores;
CREATE POLICY fvds_service_update ON federal_vote_dimension_scores
  FOR UPDATE TO service_role
  USING (true);

COMMENT ON TABLE federal_vote_dimension_scores IS
  'Per-(bioguide_id, dimension_key) agreement score rolled up from '
  'federal_vote_positions x bill_dimension_map. Populated nightly by the '
  'vote-dimension-rollup script. Drives the federal officeholder voting '
  'surface and feeds the matching engine for federal incumbents.';

-- ---------------------------------------------------------------------------
-- 5. Helper view: pending-interpretation work (for the ops dashboard +
--    backlog reporting).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_interpretation_backlog AS
SELECT 'cf_resolution'::text AS kind,
       count(*)::bigint     AS pending
FROM state_cf_events
WHERE interpretation_status = 0
UNION ALL
SELECT 'bill_dimension'::text,
       count(*)::bigint
FROM federal_bills
WHERE interpretation_status = 0
UNION ALL
SELECT 'positions'::text,
       count(*)::bigint
FROM candidates
WHERE positions_interpretation_status = 0 AND published = true;

COMMENT ON VIEW v_interpretation_backlog IS
  'Pending-interpretation counts per resolver kind. Used by the ops dashboard '
  'and the interpretation-pipeline workers to size batches.';
