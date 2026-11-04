-- ============================================================
-- political_districts: allow 'county_council' district_type
-- ============================================================
--
-- Why: some county councils are elected from sub-county districts
-- (a council member represents a numbered district WITHIN a county),
-- not countywide. The existing district_type vocabulary had 'county'
-- (the whole-county polygon) but nothing for a sub-county council
-- district, so those seats had no geometry to scope precincts to and
-- were unreachable from any precinct ballot.
--
-- First case driving this: Salt Lake County Council Member - District 5,
-- 2026 general (elections.id 0a9fdbae-e6df-4e4f-90b3-d54ee74ab438). The
-- SLCo Council has 6 numbered district seats (plus 3 at-large seats that
-- ARE countywide and out of scope here). The loader
-- scripts/load-slco-council-districts.ts ingests the 6 district polygons
-- as district_type = 'county_council'.
--
-- district_number convention for 'county_council' rows:
--   '<fips_county>-<n>', e.g. '035-5' for SLCo (fips_county 035) council
--   district 5. The bare number would collide across counties under the
--   unique triple (district_type, state_fips, district_number) from
--   20260423000013, since every county has a district '1', '2', etc.
--   Prefixing with the 3-digit county FIPS disambiguates.
--
-- This migration only widens the CHECK constraint. It drops the existing
-- constraint and re-adds it with the identical value list PLUS
-- 'county_council' inserted right after 'county'. No data is touched.
--
-- IMPORTANT: no BEGIN/COMMIT statements in this file. scripts/_live-write.ts
-- runs a dry-run that is defeated by inner transaction markers (a prior
-- repo incident). Plain ALTER statements only; the runner wraps the whole
-- file in its own transaction.
-- ============================================================

ALTER TABLE political_districts
  DROP CONSTRAINT political_districts_district_type_check;

ALTER TABLE political_districts
  ADD CONSTRAINT political_districts_district_type_check
  CHECK (district_type = ANY (ARRAY[
    'us_congressional'::text,
    'state_senate'::text,
    'state_house'::text,
    'state_assembly'::text,
    'county'::text,
    'county_council'::text,
    'parish'::text,
    'borough'::text,
    'school_board'::text,
    'school_board_at_large'::text,
    'municipal'::text,
    'township'::text,
    'ward'::text,
    'precinct'::text,
    'judicial_circuit'::text,
    'judicial_district'::text,
    'judicial_appellate'::text,
    'judicial_supreme'::text,
    'special_district'::text,
    'special_mosquito_abatement'::text,
    'special_water'::text,
    'special_fire'::text,
    'special_library'::text,
    'special_transit'::text,
    'special_hospital'::text,
    'special_cemetery'::text,
    'special_soil_conservation'::text,
    'special_park_recreation'::text,
    'special_utility'::text,
    'special_port'::text,
    'special_flood_control'::text,
    'special_community_college'::text,
    'special_other'::text
  ]));
