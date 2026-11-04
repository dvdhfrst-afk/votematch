-- ============================================================
-- 20260525000000_governing_bodies.sql
--
-- Phase 1 of the governing-bodies refactor (design doc:
-- 00-inbox/2026-05-24-governing-bodies-refactor.md).
--
-- Adds the `governing_bodies` table to model multi-seat institutions
-- (legislatures, councils, boards, multi-judge courts) as a first-class
-- entity between jurisdictions and offices.
--
-- Body-member offices (city council members, school board members,
-- state senators / reps, US senators / reps, etc.) get parented to a
-- body via offices.governing_body_id. The body holds structural facts
-- (size, term length, election cycle, vacancy rules, editorial content);
-- offices hold seat-specific overrides + current-state.
--
-- Standalone offices (governors, mayors, sheriffs, DAs, clerks) keep
-- governing_body_id = NULL.
--
-- For executives who preside over a body but are not members of it
-- (Lt Governor over State Senate; VP over US Senate), an additional
-- offices.presides_over_body_id link.
--
-- Phase 1 is schema-only. No data is populated; offices.governing_body_id
-- remains NULL until Phase 2 (separate migration / script).
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS governing_bodies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identity
  canonical_name TEXT NOT NULL,
    -- e.g., "United States Senate", "Salt Lake County Council",
    -- "Utah State Senate", "Salt Lake City Council",
    -- "Salt Lake City School District Board of Education"
  short_name TEXT,
  slug TEXT UNIQUE,

  -- Anchor
  jurisdiction_id UUID NOT NULL REFERENCES jurisdictions(id) ON DELETE CASCADE,

  -- Taxonomy — chamber_type enum (kept as TEXT with a CHECK so we can extend
  -- without an ALTER TYPE in Postgres).
  chamber_type TEXT NOT NULL CHECK (chamber_type IN (
    'legislative_upper',         -- US Senate, State Senates
    'legislative_lower',         -- US House, State Houses, State Assemblies
    'legislative_unicameral',    -- Nebraska Legislature
    'city_council',
    'city_commission',
    'town_council',
    'township_board',
    'selectboard',               -- New England-style
    'county_commission',         -- traditional county form
    'county_council',            -- mayor-council form (SLCo, Cuyahoga, etc.)
    'school_board',
    'special_district_board',    -- water / fire / library / cemetery / hospital / drainage / etc.
    'state_supreme_court',
    'appellate_court',
    'municipal_court',
    'state_board_of_education',
    'public_service_commission',
    'state_board_of_regents',
    'other'
  )),

  -- Structural facts
  size_total SMALLINT,                          -- N of seats
  size_authoritative BOOLEAN NOT NULL DEFAULT FALSE,
    -- false: derived from existing office count (compiled tier); may be wrong
    -- true:  verified against a primary source

  -- Seat structure — array of groups within the body, each group has a count
  -- and shared attributes. JSONB validated at the API layer (Zod schema).
  -- Example for SLCo Council:
  --   [
  --     {"count": 3, "designation_kind": "at_large", "term_length_years": 6,
  --      "stagger_offset_years": 2},
  --     {"count": 6, "designation_kind": "district", "term_length_years": 4,
  --      "stagger_offset_years": 2}
  --   ]
  -- Example for US Senate (Senate Classes I, II, III):
  --   [
  --     {"count": 100, "designation_kind": "state_pair", "term_length_years": 6,
  --      "classes": [1, 2, 3], "stagger_offset_years": 2}
  --   ]
  seat_structure JSONB NOT NULL DEFAULT '[]',

  -- Selection / cycle
  selection_method TEXT CHECK (selection_method IS NULL OR selection_method IN (
    'elected_partisan','elected_nonpartisan','appointed','retention_election',
    'merit_selection','mixed'
  )),
  primary_required BOOLEAN,
  runoff_rules JSONB,
    -- e.g., {"threshold": "majority", "format": "runoff_top2"}
  on_cycle_pattern TEXT,
    -- "presidential cycle" / "midterm cycle" / "odd years" / "even years"
    -- / "annual" / "every-2-years-half-stagger" / etc.

  -- Editorial content (the wiki layer)
  description TEXT,
  powers_summary TEXT,
  meeting_schedule TEXT,
    -- "Tuesdays at 7pm at City Hall" / "Annual session Jan-Mar" / etc.

  -- Standalone presiding officer (links to an office row)
  -- (added on offices too — see below — but recording here for symmetry)
  presiding_officer_office_id UUID REFERENCES offices(id) ON DELETE SET NULL,

  -- Vacancy / special-election rules
  vacancy_appointment_authority TEXT,
  vacancy_triggers_special TEXT[],
  special_election_timing_rule TEXT,

  -- Voter info
  voter_qualifications_summary TEXT,

  -- Provenance
  meta JSONB NOT NULL DEFAULT '{}',
    -- { data_quality_tier: 'authoritative'|'compiled', source_citations: [...] }
  citations JSONB NOT NULL DEFAULT '[]',
    -- [{ url, title, kind, accessed_at }, ...]
  last_verified_at TIMESTAMPTZ,
  verified_by TEXT,
    -- 'manual:david' / 'agent:wikipedia-bootstrap-v1' / 'phase2:derived'

  -- Audit
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (jurisdiction_id, canonical_name)
);

CREATE INDEX IF NOT EXISTS idx_governing_bodies_jurisdiction
  ON governing_bodies (jurisdiction_id);
CREATE INDEX IF NOT EXISTS idx_governing_bodies_chamber_type
  ON governing_bodies (chamber_type);
CREATE INDEX IF NOT EXISTS idx_governing_bodies_verified
  ON governing_bodies (size_authoritative);

-- Trigger to bump updated_at
CREATE OR REPLACE FUNCTION set_governing_bodies_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS governing_bodies_set_updated_at ON governing_bodies;
CREATE TRIGGER governing_bodies_set_updated_at
  BEFORE UPDATE ON governing_bodies
  FOR EACH ROW
  EXECUTE FUNCTION set_governing_bodies_updated_at();

-- offices gets the FK columns
ALTER TABLE offices
  ADD COLUMN IF NOT EXISTS governing_body_id UUID REFERENCES governing_bodies(id) ON DELETE SET NULL;
  -- SET NULL (not CASCADE): if a body is deleted by mistake, offices become
  -- unparented rather than destroyed. Manual cleanup is preferable to
  -- silent data loss.

ALTER TABLE offices
  ADD COLUMN IF NOT EXISTS presides_over_body_id UUID REFERENCES governing_bodies(id) ON DELETE SET NULL;
  -- For Lt Governor over State Senate, VP over US Senate, etc.

CREATE INDEX IF NOT EXISTS idx_offices_governing_body
  ON offices (governing_body_id);
CREATE INDEX IF NOT EXISTS idx_offices_presides_over_body
  ON offices (presides_over_body_id);

-- Comments for future readers
COMMENT ON TABLE governing_bodies IS
  'Multi-seat governmental institutions (legislatures, councils, boards, multi-judge courts). Holds structural + editorial facts that body-member offices inherit. Standalone offices (governor, mayor, sheriff, DA, clerk) have governing_body_id IS NULL.';

COMMENT ON COLUMN governing_bodies.seat_structure IS
  'JSONB array of seat groups. Each group: {count, designation_kind ("at_large"/"district"/"state_pair"), term_length_years, stagger_offset_years, classes (optional)}. Handles bodies with mixed-term-length seat groups (e.g., Salt Lake County Council = 3 at-large 6-year + 6 district 4-year).';

COMMENT ON COLUMN governing_bodies.size_authoritative IS
  'false: size_total derived from existing office count (compiled tier; may not match the real body charter). true: verified against a primary source (Wikipedia/.gov/Census of Governments).';

COMMENT ON COLUMN offices.governing_body_id IS
  'FK to the governing body this office is a member of (e.g., a US Senator''s body is the US Senate). NULL for standalone offices (governors, mayors, sheriffs, DAs, etc.).';

COMMENT ON COLUMN offices.presides_over_body_id IS
  'FK for executives who preside over a body without being members of it: Lt Governor presides over State Senate; VP presides over US Senate.';

COMMIT;
