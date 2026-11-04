-- 20260528010000_federal_supreme_court.sql
-- Add 'federal_supreme_court' to governing_bodies chamber_type CHECK constraint,
-- INSERT US Supreme Court row, seed its primary_source_urls.
--
-- Context (2026-05-28 daylight): US House + US Senate already exist in
-- governing_bodies tied to the USA jurisdiction (chamber_type=
-- 'legislative_upper'/'legislative_lower'). SCOTUS was the only federal body
-- missing from the catalog. The existing CHECK constraint did not allow any
-- 'federal_*' chamber_type values, so this migration extends the allow-list
-- to include 'federal_supreme_court' specifically.
--
-- Followup (not in this migration — code change): add 'federal_supreme_court'
-- to QUEUE_CHAMBER_TYPES in app/scripts/overnight-ingest.ts so the orchestrator
-- picks SCOTUS up on the next dispatch.

BEGIN;

-- 1. Extend the CHECK constraint to allow 'federal_supreme_court'.
ALTER TABLE governing_bodies
  DROP CONSTRAINT governing_bodies_chamber_type_check;

ALTER TABLE governing_bodies
  ADD CONSTRAINT governing_bodies_chamber_type_check
  CHECK (chamber_type = ANY (ARRAY[
    'legislative_upper'::text,
    'legislative_lower'::text,
    'legislative_unicameral'::text,
    'city_council'::text,
    'city_commission'::text,
    'town_council'::text,
    'township_board'::text,
    'selectboard'::text,
    'county_commission'::text,
    'county_council'::text,
    'school_board'::text,
    'special_district_board'::text,
    'state_supreme_court'::text,
    'appellate_court'::text,
    'municipal_court'::text,
    'state_board_of_education'::text,
    'public_service_commission'::text,
    'state_board_of_regents'::text,
    'federal_supreme_court'::text,
    'other'::text
  ]));

-- 2. INSERT US Supreme Court (idempotent — skip if a row already exists for the USA jurisdiction with this chamber_type).
INSERT INTO governing_bodies (
  canonical_name,
  short_name,
  slug,
  jurisdiction_id,
  chamber_type,
  size_total,
  size_authoritative,
  body_structure_verified,
  selection_method,
  on_cycle_pattern,
  has_upcoming_election,
  description,
  statute_url
)
SELECT
  'Supreme Court of the United States',
  'US Supreme Court',
  'us-supreme-court',
  '410b9342-4c4d-4b6e-8987-a8768a93c6bc',  -- United States of America jurisdiction
  'federal_supreme_court',
  9,
  false,
  false,
  'appointed',
  'none',
  false,  -- SCOTUS justices aren't elected
  'The highest court in the federal judiciary of the United States. Nine justices appointed by the President with Senate confirmation, serving for life.',
  'https://www.law.cornell.edu/constitution/articleiii'
WHERE NOT EXISTS (
  SELECT 1 FROM governing_bodies
  WHERE jurisdiction_id = '410b9342-4c4d-4b6e-8987-a8768a93c6bc'
    AND chamber_type = 'federal_supreme_court'
);

-- 3. Seed primary_source_urls for SCOTUS (idempotent).
INSERT INTO primary_source_urls (body_kind, jurisdiction_name, primary_url, url_kind, source, notes)
SELECT 'federal_supreme_court', 'United States of America',
       'https://www.supremecourt.gov/about/biographies.aspx', 'roster', 'manual_canonical',
       'SCOTUS Justices biographies (canonical roster)'
WHERE NOT EXISTS (
  SELECT 1 FROM primary_source_urls
  WHERE body_kind = 'federal_supreme_court'
    AND primary_url = 'https://www.supremecourt.gov/about/biographies.aspx'
);

INSERT INTO primary_source_urls (body_kind, jurisdiction_name, primary_url, url_kind, source, notes)
SELECT 'federal_supreme_court', 'United States of America',
       'https://www.supremecourt.gov/about/justices.aspx', 'roster_alt', 'manual_canonical',
       'SCOTUS Justices summary page (alternate roster)'
WHERE NOT EXISTS (
  SELECT 1 FROM primary_source_urls
  WHERE body_kind = 'federal_supreme_court'
    AND primary_url = 'https://www.supremecourt.gov/about/justices.aspx'
);

COMMIT;
