-- ============================================================
-- National district ingestion: state scoping + status tracker
-- ============================================================
--
-- Current state: 137 political_districts rows, ALL source='ugrc_sgid'
-- (Utah only). For national ballot lookup we need districts for
-- 49 more states + DC + territories.
--
-- This migration adds:
--   1. political_districts.state_fips — required scoping column
--   2. political_districts.election_year — which redistricting
--      vintage (2022/2024/etc.) this row belongs to
--   3. political_districts.ingested_from_data_source_id — provenance
--   4. CHECK constraint ensuring geom is EPSG:4326 (matches existing
--      SRID; makes it immutable at the DB level — council Mira's
--      point about TIGER being EPSG:4269 and the easy-to-ship
--      transform bug)
--   5. Expanded district_type vocabulary for national coverage
--   6. district_ingestion_status tracker so per-state coverage
--      gaps are visible as data, not hidden in scraper logs.
-- ============================================================

-- ============================================================
-- 1. Add scoping + provenance columns
-- ============================================================

ALTER TABLE political_districts
  ADD COLUMN IF NOT EXISTS state_fips CHAR(2),
  ADD COLUMN IF NOT EXISTS election_year INT,
  ADD COLUMN IF NOT EXISTS ingested_from_data_source_id UUID REFERENCES data_sources(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS meta JSONB NOT NULL DEFAULT '{}';

-- Backfill existing UT rows
UPDATE political_districts
  SET state_fips = '49', election_year = 2024
  WHERE state_fips IS NULL AND source = 'ugrc_sgid';

CREATE INDEX IF NOT EXISTS idx_political_districts_state
  ON political_districts (state_fips, district_type)
  WHERE state_fips IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_political_districts_year
  ON political_districts (election_year, state_fips)
  WHERE election_year IS NOT NULL;

-- ============================================================
-- 2. SRID enforcement
--
-- Makes it impossible to insert a wrongly-projected polygon.
-- Existing rows are already 4326 (verified via Find_SRID).
-- ============================================================

ALTER TABLE political_districts DROP CONSTRAINT IF EXISTS political_districts_srid_4326;
ALTER TABLE political_districts
  ADD CONSTRAINT political_districts_srid_4326
  CHECK (geom IS NULL OR ST_SRID(geom) = 4326);

-- Same for precincts table
ALTER TABLE precincts DROP CONSTRAINT IF EXISTS precincts_srid_4326;
ALTER TABLE precincts
  ADD CONSTRAINT precincts_srid_4326
  CHECK (geom IS NULL OR ST_SRID(geom) = 4326);

-- ============================================================
-- 3. Expand district_type vocabulary
--
-- Adds judicial, special, and finer-grained political district
-- types for national coverage (e.g., NY assembly, LA parish).
-- ============================================================

ALTER TABLE political_districts DROP CONSTRAINT IF EXISTS political_districts_district_type_check;
ALTER TABLE political_districts
  ADD CONSTRAINT political_districts_district_type_check
  CHECK (district_type IN (
    'us_congressional',
    'state_senate',
    'state_house',                -- general-purpose lower chamber
    'state_assembly',             -- NY/CA/NJ/WI terminology
    'county',
    'parish',                     -- LA terminology
    'borough',                    -- AK terminology
    'school_board',
    'school_board_at_large',
    'municipal',
    'township',
    'ward',
    'precinct',                   -- sub-precinct jurisdictions
    'judicial_circuit',
    'judicial_district',
    'judicial_appellate',
    'judicial_supreme',
    'special_district',           -- water, fire, library, transit, etc.
    'special_mosquito_abatement', -- subclass (long tail)
    'special_water',
    'special_fire',
    'special_library',
    'special_transit',
    'special_hospital',
    'special_cemetery',
    'special_soil_conservation',
    'special_park_recreation',
    'special_utility',
    'special_port',
    'special_flood_control',
    'special_community_college',
    'special_other'
  ));

-- ============================================================
-- 4. district_ingestion_status — visibility tracker
--
-- One row per (state_fips, district_type) pair. Populated by
-- the ingest script on start + end. Read by UI admin coverage
-- dashboard to show the 49-state gap as data.
-- ============================================================

CREATE TABLE IF NOT EXISTS district_ingestion_status (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  state_fips CHAR(2) NOT NULL,
  district_type TEXT NOT NULL,
  election_year INT NOT NULL,

  status TEXT NOT NULL CHECK (status IN (
    'not_started',
    'in_progress',
    'success',
    'partial',
    'failed',
    'skipped',
    'blocked_license',      -- data exists but license incompatible (Ballotpedia, NYT)
    'no_data_available'     -- source genuinely doesn't publish this
  )),

  expected_district_count INT,
  observed_district_count INT NOT NULL DEFAULT 0,

  last_attempted_at TIMESTAMPTZ,
  last_successful_at TIMESTAMPTZ,
  last_error TEXT,

  source_description TEXT,       -- 'Census TIGER 2024', 'UT UGRC SGID', etc.
  data_source_id UUID REFERENCES data_sources(id) ON DELETE SET NULL,
  ingestion_run_id UUID REFERENCES ingestion_runs(id) ON DELETE SET NULL,

  meta JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (state_fips, district_type, election_year)
);

CREATE INDEX IF NOT EXISTS idx_dis_state ON district_ingestion_status (state_fips);
CREATE INDEX IF NOT EXISTS idx_dis_status ON district_ingestion_status (status);

CREATE OR REPLACE FUNCTION dis_bump_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_dis_bump_updated_at
  BEFORE UPDATE ON district_ingestion_status
  FOR EACH ROW EXECUTE FUNCTION dis_bump_updated_at();

ALTER TABLE district_ingestion_status ENABLE ROW LEVEL SECURITY;
CREATE POLICY dis_public_read ON district_ingestion_status FOR SELECT USING (true);

-- Seed: mark Utah as success, all 49 others + DC + territories as not_started.
-- 55 state-ish fips: 50 states + DC(11) + AS(60) + GU(66) + MP(69) + PR(72) + VI(78)
INSERT INTO district_ingestion_status (state_fips, district_type, election_year, status,
                                       source_description, observed_district_count)
SELECT fips, 'us_congressional', 2024,
       CASE WHEN fips = '49' THEN 'success' ELSE 'not_started' END,
       CASE WHEN fips = '49' THEN 'UT UGRC SGID' ELSE NULL END,
       CASE WHEN fips = '49' THEN (SELECT count(*)::int FROM political_districts WHERE state_fips='49' AND district_type='us_congressional') ELSE 0 END
FROM (VALUES
  ('01'),('02'),('04'),('05'),('06'),('08'),('09'),('10'),('11'),('12'),
  ('13'),('15'),('16'),('17'),('18'),('19'),('20'),('21'),('22'),('23'),
  ('24'),('25'),('26'),('27'),('28'),('29'),('30'),('31'),('32'),('33'),
  ('34'),('35'),('36'),('37'),('38'),('39'),('40'),('41'),('42'),('44'),
  ('45'),('46'),('47'),('48'),('49'),('50'),('51'),('53'),('54'),('55'),
  ('56'),('60'),('66'),('69'),('72'),('78')
) AS s(fips)
ON CONFLICT DO NOTHING;

-- Seed state_house + state_senate same way
INSERT INTO district_ingestion_status (state_fips, district_type, election_year, status,
                                       source_description, observed_district_count)
SELECT fips, dt, 2024,
       CASE WHEN fips = '49' THEN 'success' ELSE 'not_started' END,
       CASE WHEN fips = '49' THEN 'UT UGRC SGID' ELSE NULL END,
       CASE WHEN fips = '49'
            THEN (SELECT count(*)::int FROM political_districts WHERE state_fips='49' AND district_type=dt)
            ELSE 0
       END
FROM (VALUES
  ('01'),('02'),('04'),('05'),('06'),('08'),('09'),('10'),('11'),('12'),
  ('13'),('15'),('16'),('17'),('18'),('19'),('20'),('21'),('22'),('23'),
  ('24'),('25'),('26'),('27'),('28'),('29'),('30'),('31'),('32'),('33'),
  ('34'),('35'),('36'),('37'),('38'),('39'),('40'),('41'),('42'),('44'),
  ('45'),('46'),('47'),('48'),('49'),('50'),('51'),('53'),('54'),('55'),
  ('56'),('60'),('66'),('69'),('72'),('78')
) AS s(fips)
CROSS JOIN (VALUES ('state_house'),('state_senate')) AS d(dt)
ON CONFLICT DO NOTHING;

-- ============================================================
-- 5. Helper view: national coverage summary
-- ============================================================

CREATE OR REPLACE VIEW v_district_coverage_summary AS
SELECT
  state_fips,
  count(*) FILTER (WHERE status = 'success') AS types_succeeded,
  count(*) FILTER (WHERE status IN ('partial','failed')) AS types_failed,
  count(*) FILTER (WHERE status = 'not_started') AS types_pending,
  count(*) AS types_total,
  sum(observed_district_count) AS total_districts,
  max(last_successful_at) AS last_success
FROM district_ingestion_status
GROUP BY state_fips
ORDER BY state_fips;

COMMENT ON VIEW v_district_coverage_summary IS
  'One row per state fips with ingestion progress. Drives the admin /coverage dashboard. '
  'Before launch, every fips row should have types_succeeded >= 3 (us_congressional + '
  'state_house + state_senate at minimum).';

-- ============================================================
-- 6. Documentation
-- ============================================================

COMMENT ON COLUMN political_districts.state_fips IS
  '2-char FIPS state code. Required for national scoping; existing UT rows backfilled to 49. '
  'Composite with election_year lets multiple redistricting vintages coexist without conflict.';

COMMENT ON COLUMN political_districts.election_year IS
  'Redistricting vintage year (e.g., 2024 TIGER, 2022 state-legislative). A state may have '
  'multiple years present concurrently during transitions; downstream queries filter.';

COMMENT ON CONSTRAINT political_districts_srid_4326 ON political_districts IS
  'Enforces EPSG:4326 at the DB layer. TIGER ships as EPSG:4269 (NAD83); loaders MUST call '
  'ST_Transform(geom, 4326) before INSERT. This constraint makes forgetting impossible.';

COMMENT ON TABLE district_ingestion_status IS
  'Per-(state, district_type, year) tracker. Read by admin dashboard to render the '
  '49-state gap as honest data rather than hiding failure. Adapters update status from '
  'not_started → in_progress → success/partial/failed.';
