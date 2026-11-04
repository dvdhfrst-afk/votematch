-- ============================================================
-- Data sources: lineage + provenance for every ingested fact
-- ============================================================
--
-- Every row imported from an external source must point to a
-- data_sources row. This is the canonical provenance record.
--
-- Why this exists:
--   1. Scraper churn. State SoS sites, editorial pages, and
--      campaign-finance portals change schemas frequently. When
--      a parser breaks, we need to know every row it produced
--      and decide whether to refetch or invalidate.
--   2. Legal defense. "The Ohio SoS site at this URL said X on
--      date Y" is what you need when a claim is disputed.
--   3. Correction workflow. The /corrections page surfaces
--      provenance to voters; reviewers need to see the trail.
--   4. License tracking. Some sources are public domain, some
--      CC-BY, some CC-BY-SA (contaminates derivatives), some
--      proprietary. The license column drives what we can
--      surface and how.
--
-- This migration is ADDITIVE. No existing tables reference
-- data_sources yet; downstream migrations (election_results,
-- state_cf, endorsements, etc.) will add the FK as they land.
--
-- Design principles:
--   1. One row per distinct (url, fetched_at) pair.
--   2. content_hash lets downstream rows dedup on content
--      without re-parsing.
--   3. Public read is allowed for transparency (/methodology
--      surfaces sources); writes are service-role only.
--   4. source_type uses TEXT + CHECK rather than ENUM so we
--      can add new types without pg_attribute rewrite.
-- ============================================================

CREATE TABLE IF NOT EXISTS data_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Provenance
  source_type TEXT NOT NULL CHECK (source_type IN (
    'sos_results_api',         -- state SoS real-time results (NIST XML, JSON, HTML)
    'sos_candidate_filing',    -- state SoS candidate filings
    'sos_campaign_finance',    -- state SoS / ethics commission CF portal
    'federal_api',             -- FEC, Congress.gov, Regulations.gov
    'federal_vote_record',     -- Congress.gov roll-call / senate.gov XML
    'census_tiger',            -- Census TIGER/Line shapefiles
    'census_geocoder',         -- Census geocoding API
    'redistricting_data_hub',  -- redistrictingdatahub.org aggregated precincts
    'state_gis_portal',        -- per-state GIS (UGRC, TX LC, NY, etc.)
    'county_gis_portal',       -- per-county GIS (long tail)
    'openstates',              -- OpenStates bulk + API
    'ballot_measure_official', -- state voter guide, LAO fiscal note, etc.
    'newspaper_editorial',     -- newspaper endorsement scraping
    'editorial_rss',           -- newspaper RSS feed
    'wayback_snapshot',        -- archive.org CDX / memento
    'campaign_website',        -- candidate's own site
    'candidate_questionnaire', -- questionnaire response from candidate
    'ai_extraction',           -- AI-extracted from another source (see meta.derived_from)
    'manual_entry',            -- human-entered; requires meta.verified_by_user_id
    'other'
  )),

  name TEXT NOT NULL,                         -- 'Ohio SoS Live Results', 'FEC OpenAPI', etc.
  url TEXT,                                    -- canonical URL (nullable for manual_entry)
  archive_url TEXT,                            -- Wayback Machine snapshot, if captured
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  content_hash TEXT,                           -- sha256 of the raw response body

  -- License / usage
  license TEXT CHECK (license IN (
    'public_domain',          -- e.g., federal government works
    'cc_by',                  -- free reuse with attribution
    'cc_by_nc',               -- non-commercial only
    'cc_by_sa',               -- share-alike; CONTAMINATES downstream databases
    'cc_by_nc_sa',            -- non-commercial + share-alike
    'mit',                    -- MIT-licensed datasets (e.g., MEDSL)
    'state_open_records',     -- state open-records act (public, reusable)
    'fair_use_excerpt',       -- excerpt + link-back only, not rehost
    'proprietary_licensed',   -- we hold a license (e.g., hypothetical DDHQ)
    'unknown'                 -- flagged for review before public surface
  )),

  -- State scoping (for per-state portals)
  state_fips CHAR(2),

  -- Operational telemetry
  request_count INT NOT NULL DEFAULT 1,        -- bumped on each refetch of same url
  last_successful_fetch_at TIMESTAMPTZ,
  last_failed_fetch_at TIMESTAMPTZ,
  last_error TEXT,
  rate_limit_exceeded_at TIMESTAMPTZ,

  -- Trust
  created_by TEXT NOT NULL DEFAULT 'service_role',  -- identifies the ingest path; checked below
  reviewed_by_user_id UUID REFERENCES users(id),    -- required for manual_entry rows before publish

  -- Free-form
  meta JSONB NOT NULL DEFAULT '{}',

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Manual entries must have a human reviewer before they're trusted.
ALTER TABLE data_sources
  ADD CONSTRAINT data_sources_manual_requires_reviewer
  CHECK (
    source_type <> 'manual_entry'
    OR reviewed_by_user_id IS NOT NULL
    OR meta ? 'pending_review'
  );

CREATE INDEX IF NOT EXISTS idx_data_sources_type ON data_sources (source_type);
CREATE INDEX IF NOT EXISTS idx_data_sources_state ON data_sources (state_fips) WHERE state_fips IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_data_sources_url ON data_sources (url) WHERE url IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_data_sources_hash ON data_sources (content_hash) WHERE content_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_data_sources_fetched ON data_sources (fetched_at DESC);

-- Bump updated_at on every write.
CREATE OR REPLACE FUNCTION data_sources_bump_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_data_sources_bump_updated_at
  BEFORE UPDATE ON data_sources
  FOR EACH ROW EXECUTE FUNCTION data_sources_bump_updated_at();

-- ============================================================
-- RLS: public read (transparency), service-role write
-- ============================================================

ALTER TABLE data_sources ENABLE ROW LEVEL SECURITY;

CREATE POLICY data_sources_public_read
  ON data_sources FOR SELECT
  USING (true);

-- Writes: service_role only. The session_token() pattern does not apply
-- here because data_sources is operational / lineage data, not user data.

-- ============================================================
-- Ingestion runs: per-job audit trail distinct from pipeline_runs
-- ============================================================
--
-- pipeline_runs is the cost-guard sentinel for Claude Batch.
-- ingestion_runs is the lineage record for scrapers — one row
-- per run of a source adapter, linking to the data_sources
-- row(s) it produced. Enables "we lost 12 rows from OH on
-- May 5 at 21:14; here is the scrape, the HTML hash, and the
-- parser commit."
-- ============================================================

CREATE TABLE IF NOT EXISTS ingestion_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  adapter_name TEXT NOT NULL,                  -- 'sos-ohio-results', 'fec-candidates', etc.
  state_fips CHAR(2),                          -- scoping (nullable for federal)
  status TEXT NOT NULL CHECK (status IN (
    'running', 'success', 'partial', 'failed', 'skipped'
  )),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  rows_inserted INT NOT NULL DEFAULT 0,
  rows_updated INT NOT NULL DEFAULT 0,
  rows_skipped INT NOT NULL DEFAULT 0,
  rows_failed INT NOT NULL DEFAULT 0,
  expected_min_rows INT,                       -- if observed < expected, status='partial'/'failed'
  data_source_id UUID REFERENCES data_sources(id) ON DELETE SET NULL,
  error_summary TEXT,                          -- one-line if failed
  git_sha TEXT,                                -- which code version produced this
  meta JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ingestion_runs_adapter ON ingestion_runs (adapter_name, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_ingestion_runs_state ON ingestion_runs (state_fips, started_at DESC) WHERE state_fips IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ingestion_runs_status ON ingestion_runs (status, started_at DESC);

ALTER TABLE ingestion_runs ENABLE ROW LEVEL SECURITY;
-- Service-role only; no public policies. Surface via admin dashboard later.

-- ============================================================
-- Ingestion errors: row-level failure log
-- ============================================================

CREATE TABLE IF NOT EXISTS ingestion_errors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ingestion_run_id UUID NOT NULL REFERENCES ingestion_runs(id) ON DELETE CASCADE,
  raw_input JSONB,                             -- what we tried to insert (truncated if huge)
  error_type TEXT NOT NULL,                    -- 'parse', 'fk_violation', 'check_violation', 'network', 'rate_limit', 'other'
  error_message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ingestion_errors_run ON ingestion_errors (ingestion_run_id);
CREATE INDEX IF NOT EXISTS idx_ingestion_errors_type ON ingestion_errors (error_type);

ALTER TABLE ingestion_errors ENABLE ROW LEVEL SECURITY;
-- Service-role only.

-- ============================================================
-- Materialized view refresh log
-- ============================================================
--
-- Prior review flagged that a staleness guard on the materialized
-- ballot view referenced a "refreshed_at" column that didn't exist
-- anywhere. Solution: a tiny bookkeeping table that the refresh
-- function writes to on success. The read-path can then check
-- max(refreshed_at) per view and fall through to direct query
-- when stale.
--
-- Created now (with Item 7) so Item 8's materialized view wiring
-- has a place to write.
-- ============================================================

CREATE TABLE IF NOT EXISTS materialized_view_refresh_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  view_name TEXT NOT NULL,
  refreshed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  duration_ms INT,
  rows_after INT,
  triggered_by TEXT,                           -- 'cron' | 'post_advancement' | 'manual' | 'trigger'
  meta JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_mvrefresh_view_time
  ON materialized_view_refresh_log (view_name, refreshed_at DESC);

ALTER TABLE materialized_view_refresh_log ENABLE ROW LEVEL SECURITY;
-- Service-role only.

-- ============================================================
-- Documentation
-- ============================================================

COMMENT ON TABLE data_sources IS
  'Canonical lineage record for every externally-sourced fact. Every ingested row '
  'points here via data_source_id FK. Public-read (transparency); service-role write. '
  'License column drives what can be surfaced and how. See 00-inbox/schema-gap-plan-2026-04-23.md Item 7.';

COMMENT ON COLUMN data_sources.license IS
  'cc_by_sa and cc_by_nc_sa are SHARE-ALIKE: including CC-BY-SA content in an aggregated '
  'database may contaminate the whole DB under the viral share-alike clause. Ballotpedia '
  '(CC-BY-SA) and the NYT precinct map (CC-BY-NC) are specifically excluded by this project; '
  'see memory/reference_civic_data_sources.md.';

COMMENT ON COLUMN data_sources.content_hash IS
  'sha256 of raw fetched body. Enables cross-row dedup without re-parsing; mirrors the '
  'candidate_sources.content_hash pattern from 20260419000000_source_content_hash.sql.';

COMMENT ON TABLE ingestion_runs IS
  'One row per scraper / adapter run. Distinct from pipeline_runs (which is Claude-Batch '
  'cost-guard). Adapters MUST set expected_min_rows; observed < expected → status=partial or '
  'failed, not silently "success". See council review 2026-04-23 voice #3 (Sam Reyes) on '
  'silent-failure adapter risk.';

COMMENT ON TABLE materialized_view_refresh_log IS
  'Bookkeeping for REFRESH MATERIALIZED VIEW calls. Read-path uses this to decide whether '
  'to trust the matview or fall through to direct query. Created alongside data_sources so '
  'Item 8 (ballot_for_precinct materialized view) has a home for its refresh timestamps.';
