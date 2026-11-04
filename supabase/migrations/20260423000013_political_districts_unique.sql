-- ============================================================
-- political_districts: unique composite for ON CONFLICT upserts
-- ============================================================
--
-- The national TIGER loader (scripts/ingest-national-districts.ts)
-- upserts rows keyed by (district_type, state_fips, district_number).
-- Without a UNIQUE index on that triple, ON CONFLICT has nothing
-- to match against. This migration adds it.
--
-- Why not on (district_type, district_name)?
--   district_name is human-friendly ("Congressional District 1")
--   and not guaranteed stable across TIGER vintages; district_number
--   (CD119FP / SLDLST / SLDUST) is the canonical identifier.
--
-- Why include state_fips?
--   district_number alone collides across states (every state has a
--   "1" for each chamber). The triple disambiguates.
--
-- Existing UT rows (source='ugrc_sgid') were backfilled by
-- 20260423000005 to state_fips='49' — they satisfy NOT NULL
-- implicitly via the partial-index predicate.
--
-- NOTE: Partial unique index (WHERE state_fips IS NOT NULL AND
-- district_number IS NOT NULL) so legacy rows without either
-- don't block index creation. ON CONFLICT picks up the partial
-- index when all predicates match, which is true for every row
-- this loader writes.
-- ============================================================

CREATE UNIQUE INDEX IF NOT EXISTS idx_political_districts_type_state_number
  ON political_districts (district_type, state_fips, district_number)
  WHERE state_fips IS NOT NULL AND district_number IS NOT NULL;

COMMENT ON INDEX idx_political_districts_type_state_number IS
  'Target for ON CONFLICT in the TIGER national-district loader. Partial '
  'so legacy rows without state_fips/district_number do not block it. '
  'TIGER loader always sets both, so every upsert it issues will match.';
