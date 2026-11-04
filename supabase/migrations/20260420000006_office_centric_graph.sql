-- ============================================================
-- Office-Centric Graph
-- ============================================================
-- Introduces a persistent, queryable graph of every elected
-- office in the US. Offices are the stable primary entity;
-- candidates, elections, and voting records attach to them.
--
-- This migration is ADDITIVE. Existing tables (candidates, races,
-- political_districts, etc.) remain functional while the new
-- office graph is populated in parallel. A later migration will
-- deprecate the legacy candidate-centric tables once the new
-- graph is fully populated.
--
-- Design principles:
--   1. Jurisdictions form a geographic hierarchy (US → state →
--      county → municipality → sub-district) via parent_id self-ref.
--   2. Office types are generic templates (mayor, commissioner, etc.);
--      specific offices override responsibilities per jurisdiction.
--   3. People are identity; candidacies are a person × election
--      event; tenures are a person × office × time interval.
--   4. Office relationships form a directed graph (supervises,
--      appoints, confirms, peer_of, etc.).
--   5. Every table supports public read of published data;
--      writes require service role (pipeline) or authenticated
--      candidate claim (dashboard).
-- ============================================================

-- ============================================================
-- Jurisdictions: geographic + political hierarchy
-- ============================================================

CREATE TABLE IF NOT EXISTS jurisdictions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,                         -- "Summit County, UT" or "State of California"
  short_name TEXT,                            -- "Summit" or "CA"
  type TEXT NOT NULL CHECK (type IN (
    'nation', 'state', 'territory', 'federal_district',
    'county', 'municipality', 'township', 'borough',
    'school_district', 'special_district',
    'congressional_district', 'state_senate_district',
    'state_house_district', 'judicial_district',
    'ward', 'precinct', 'at_large'
  )),
  parent_id UUID REFERENCES jurisdictions(id) ON DELETE CASCADE,
  geoid TEXT,                                 -- FIPS / GEOID for canonical reference
  fips_state CHAR(2),
  fips_county CHAR(3),
  fips_place TEXT,
  legal_basis_citation TEXT,                  -- state constitution / charter
  charter_url TEXT,
  population INT,
  boundary GEOMETRY(MultiPolygon, 4326),      -- PostGIS; optional for non-geographic
  meta JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (type, geoid)
);

CREATE INDEX IF NOT EXISTS idx_jurisdictions_parent ON jurisdictions (parent_id);
CREATE INDEX IF NOT EXISTS idx_jurisdictions_type ON jurisdictions (type);
CREATE INDEX IF NOT EXISTS idx_jurisdictions_geoid ON jurisdictions (geoid) WHERE geoid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_jurisdictions_boundary ON jurisdictions USING GIST (boundary)
  WHERE boundary IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_jurisdictions_fips ON jurisdictions (fips_state, fips_county, fips_place);
CREATE INDEX IF NOT EXISTS idx_jurisdictions_name_trgm ON jurisdictions USING GIN (name gin_trgm_ops)
  WHERE name IS NOT NULL;

-- Enable trigram search for office / jurisdiction name lookups
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ============================================================
-- Office types: generic templates
-- ============================================================

CREATE TABLE IF NOT EXISTS office_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,                  -- 'mayor' | 'county_commissioner' | 'us_senator'
  generic_name TEXT NOT NULL,                 -- "Mayor" | "County Commissioner"
  level TEXT NOT NULL CHECK (level IN (
    'federal', 'state', 'county', 'municipal', 'school', 'special', 'judicial'
  )),
  branch TEXT CHECK (branch IN ('executive', 'legislative', 'judicial', 'administrative')),
  description TEXT,                           -- "what this type of office does" — editorial
  typical_powers TEXT[],                      -- ['budget_authority', 'land_use_zoning', ...]
  typical_term_length_months INT,
  typical_term_limits JSONB,
  relevant_dimensions TEXT[],                 -- which of the 19 sub-dimensions apply
  display_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_office_types_level ON office_types (level);

-- ============================================================
-- Offices: every specific seat that exists
-- ============================================================

CREATE TABLE IF NOT EXISTS offices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_name TEXT NOT NULL,               -- "Mayor of Park City, UT"
  office_type_id UUID NOT NULL REFERENCES office_types(id) ON DELETE RESTRICT,
  jurisdiction_id UUID NOT NULL REFERENCES jurisdictions(id) ON DELETE CASCADE,
  level TEXT NOT NULL CHECK (level IN (
    'federal', 'state', 'county', 'municipal', 'school', 'special', 'judicial'
  )),
  seat_designation TEXT,                      -- "At-Large" | "District 3" | "4th CD"
  district_jurisdiction_id UUID REFERENCES jurisdictions(id),
    -- When the seat is tied to a sub-jurisdiction (e.g., council member for Ward 4)
  legal_basis_citation TEXT,                  -- specific statute / charter section
  term_length_months INT,
  term_limits JSONB,
  election_cycle TEXT CHECK (election_cycle IN (
    'even_year', 'odd_year', 'presidential', 'midterm',
    'special_only', 'quadrennial', 'biennial', 'annual'
  )),
  seats_per_election INT NOT NULL DEFAULT 1,
  selection_method TEXT CHECK (selection_method IN (
    'partisan', 'nonpartisan', 'retention', 'appointment_elected',
    'primary_runoff', 'ranked_choice', 'at_large', 'district'
  )),
  responsibilities_md TEXT,                   -- editorial, overrides generic type
  relevant_dimensions TEXT[],                 -- overrides office_types.relevant_dimensions
  salary_amount INT,                          -- annual salary in USD, if known
  salary_currency CHAR(3) DEFAULT 'USD',
  is_partisan BOOLEAN,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,    -- for historical offices no longer extant
  meta JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_offices_type ON offices (office_type_id);
CREATE INDEX IF NOT EXISTS idx_offices_jurisdiction ON offices (jurisdiction_id);
CREATE INDEX IF NOT EXISTS idx_offices_level ON offices (level);
CREATE INDEX IF NOT EXISTS idx_offices_active ON offices (is_active) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_offices_name_trgm ON offices USING GIN (canonical_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_offices_district_jurisdiction ON offices (district_jurisdiction_id)
  WHERE district_jurisdiction_id IS NOT NULL;

-- Prevent duplicate office rows for the same (jurisdiction, type, seat).
-- NULLS NOT DISTINCT (Postgres 15+) lets rows with NULL seat_designation be
-- treated as equal for uniqueness, so Pres/VP-style national offices work with
-- ON CONFLICT upserts.
CREATE UNIQUE INDEX IF NOT EXISTS idx_offices_unique_seat
  ON offices (jurisdiction_id, office_type_id, seat_designation) NULLS NOT DISTINCT;

-- ============================================================
-- Office relationships: directed graph edges
-- ============================================================

CREATE TABLE IF NOT EXISTS office_relationships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_office_id UUID NOT NULL REFERENCES offices(id) ON DELETE CASCADE,
  target_office_id UUID NOT NULL REFERENCES offices(id) ON DELETE CASCADE,
  relationship TEXT NOT NULL CHECK (relationship IN (
    'supervises', 'appoints', 'confirms', 'peer_of', 'reports_to',
    'checks_balances', 'succeeds', 'overlaps_jurisdiction_with'
  )),
  source_citation TEXT,                       -- statute / charter reference
  meta JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (source_office_id <> target_office_id),
  UNIQUE (source_office_id, target_office_id, relationship)
);

CREATE INDEX IF NOT EXISTS idx_office_rel_source ON office_relationships (source_office_id);
CREATE INDEX IF NOT EXISTS idx_office_rel_target ON office_relationships (target_office_id);
CREATE INDEX IF NOT EXISTS idx_office_rel_type ON office_relationships (relationship);

-- ============================================================
-- People: identity, separate from candidacy
-- ============================================================

CREATE TABLE IF NOT EXISTS people (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_name TEXT NOT NULL,               -- normalized "Firstname Lastname"
  full_legal_name TEXT,
  name_variants TEXT[],                       -- aka's, maiden names, etc.
  birth_year INT,
  died_on DATE,
  party_history JSONB NOT NULL DEFAULT '[]',  -- [{party, started, ended}]
  bio TEXT,
  photo_url TEXT,
  website_url TEXT,
  wikipedia_url TEXT,
  merged_from UUID[] NOT NULL DEFAULT '{}',   -- disambiguation trail
  legacy_candidate_ids UUID[] NOT NULL DEFAULT '{}',  -- links to old candidates table
  meta JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_people_name_trgm ON people USING GIN (canonical_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_people_legacy_candidates ON people USING GIN (legacy_candidate_ids);

-- ============================================================
-- Office tenures: historical and current incumbency
-- ============================================================

CREATE TABLE IF NOT EXISTS office_tenures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  office_id UUID NOT NULL REFERENCES offices(id) ON DELETE CASCADE,
  person_id UUID NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  started_on DATE NOT NULL,
  ended_on DATE,                              -- NULL = current
  is_current BOOLEAN GENERATED ALWAYS AS (ended_on IS NULL) STORED,
  party_at_tenure TEXT,
  departure_reason TEXT CHECK (departure_reason IN (
    'term_ended', 'resigned', 'recalled', 'died_in_office',
    'expelled', 'promoted', 'lost_reelection', 'term_limited', 'other'
  )),
  source_of_record TEXT,
  meta JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tenures_office ON office_tenures (office_id);
CREATE INDEX IF NOT EXISTS idx_tenures_person ON office_tenures (person_id);
CREATE INDEX IF NOT EXISTS idx_tenures_current ON office_tenures (is_current) WHERE is_current = TRUE;
CREATE INDEX IF NOT EXISTS idx_tenures_started ON office_tenures (started_on);

-- Ensure only one current tenure per office
CREATE UNIQUE INDEX IF NOT EXISTS idx_tenures_one_current_per_office
  ON office_tenures (office_id) WHERE ended_on IS NULL;

-- ============================================================
-- Elections: contests for offices
-- ============================================================

CREATE TABLE IF NOT EXISTS elections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  office_id UUID NOT NULL REFERENCES offices(id) ON DELETE CASCADE,
  election_date DATE NOT NULL,
  election_type TEXT NOT NULL CHECK (election_type IN (
    'general', 'primary', 'primary_runoff', 'special_general',
    'special_primary', 'runoff', 'retention', 'recall', 'nonpartisan_general'
  )),
  filing_opens_on DATE,
  filing_deadline DATE,
  results_certified_at TIMESTAMPTZ,
  is_write_in_only BOOLEAN NOT NULL DEFAULT FALSE,
  meta JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (office_id, election_date, election_type)
);

CREATE INDEX IF NOT EXISTS idx_elections_office ON elections (office_id);
CREATE INDEX IF NOT EXISTS idx_elections_date ON elections (election_date);
CREATE INDEX IF NOT EXISTS idx_elections_type ON elections (election_type);

-- ============================================================
-- Candidacies: person × election event
-- ============================================================

CREATE TABLE IF NOT EXISTS candidacies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  election_id UUID NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
  person_id UUID NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  party TEXT,
  ballot_designation TEXT,                    -- "Retired Teacher" / incumbent vs. challenger
  is_incumbent BOOLEAN NOT NULL DEFAULT FALSE,
  filed_on DATE,
  qualified_for_ballot_on DATE,
  withdrew_on DATE,
  disqualified_on DATE,
  disqualification_reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending_verification' CHECK (status IN (
    'pending_verification', 'active', 'withdrew',
    'disqualified', 'won_primary', 'lost_primary',
    'won_general', 'lost_general', 'advanced_to_runoff'
  )),
  vote_count INT,
  vote_percentage NUMERIC(5, 2),
  profile_claimed BOOLEAN NOT NULL DEFAULT FALSE,
  profile_claimed_at TIMESTAMPTZ,
  legacy_candidate_id UUID,                   -- links to old candidates.id
  meta JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (election_id, person_id)
);

CREATE INDEX IF NOT EXISTS idx_candidacies_election ON candidacies (election_id);
CREATE INDEX IF NOT EXISTS idx_candidacies_person ON candidacies (person_id);
CREATE INDEX IF NOT EXISTS idx_candidacies_status ON candidacies (status);
CREATE INDEX IF NOT EXISTS idx_candidacies_claimed ON candidacies (profile_claimed)
  WHERE profile_claimed = TRUE;
CREATE INDEX IF NOT EXISTS idx_candidacies_legacy ON candidacies (legacy_candidate_id)
  WHERE legacy_candidate_id IS NOT NULL;

-- ============================================================
-- Historical issues attached to offices (civic context)
-- ============================================================

CREATE TABLE IF NOT EXISTS office_historical_issues (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  office_id UUID NOT NULL REFERENCES offices(id) ON DELETE CASCADE,
  issue_title TEXT NOT NULL,
  issue_description TEXT,
  dimension_slug TEXT,                        -- maps to the 19-dim taxonomy
  period_started_on DATE,
  period_ended_on DATE,
  source_urls TEXT[],
  meta JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_historical_issues_office ON office_historical_issues (office_id);
CREATE INDEX IF NOT EXISTS idx_historical_issues_dimension ON office_historical_issues (dimension_slug);

-- ============================================================
-- Helper functions
-- ============================================================

-- Returns all ancestor jurisdictions for a given jurisdiction_id (self included)
CREATE OR REPLACE FUNCTION jurisdiction_ancestors(jid UUID)
RETURNS TABLE (id UUID, depth INT, name TEXT, type TEXT)
LANGUAGE SQL STABLE AS $$
  WITH RECURSIVE ancestors AS (
    SELECT j.id, 0 AS depth, j.name, j.type, j.parent_id
    FROM jurisdictions j WHERE j.id = jid
    UNION ALL
    SELECT j.id, a.depth + 1, j.name, j.type, j.parent_id
    FROM jurisdictions j
    JOIN ancestors a ON j.id = a.parent_id
  )
  SELECT id, depth, name, type FROM ancestors ORDER BY depth;
$$;

-- Returns all descendant jurisdictions
CREATE OR REPLACE FUNCTION jurisdiction_descendants(jid UUID)
RETURNS TABLE (id UUID, depth INT, name TEXT, type TEXT)
LANGUAGE SQL STABLE AS $$
  WITH RECURSIVE descendants AS (
    SELECT j.id, 0 AS depth, j.name, j.type
    FROM jurisdictions j WHERE j.id = jid
    UNION ALL
    SELECT j.id, d.depth + 1, j.name, j.type
    FROM jurisdictions j
    JOIN descendants d ON j.parent_id = d.id
  )
  SELECT id, depth, name, type FROM descendants ORDER BY depth, name;
$$;

-- Current incumbent for an office (if any)
CREATE OR REPLACE FUNCTION current_incumbent(oid UUID)
RETURNS TABLE (person_id UUID, canonical_name TEXT, started_on DATE, party TEXT)
LANGUAGE SQL STABLE AS $$
  SELECT p.id, p.canonical_name, ot.started_on, ot.party_at_tenure
  FROM office_tenures ot
  JOIN people p ON p.id = ot.person_id
  WHERE ot.office_id = oid AND ot.ended_on IS NULL
  LIMIT 1;
$$;

-- ============================================================
-- Triggers: keep updated_at current
-- ============================================================

CREATE OR REPLACE FUNCTION bump_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_jurisdictions_updated_at ON jurisdictions;
CREATE TRIGGER trg_jurisdictions_updated_at BEFORE UPDATE ON jurisdictions
  FOR EACH ROW EXECUTE FUNCTION bump_updated_at();

DROP TRIGGER IF EXISTS trg_office_types_updated_at ON office_types;
CREATE TRIGGER trg_office_types_updated_at BEFORE UPDATE ON office_types
  FOR EACH ROW EXECUTE FUNCTION bump_updated_at();

DROP TRIGGER IF EXISTS trg_offices_updated_at ON offices;
CREATE TRIGGER trg_offices_updated_at BEFORE UPDATE ON offices
  FOR EACH ROW EXECUTE FUNCTION bump_updated_at();

DROP TRIGGER IF EXISTS trg_people_updated_at ON people;
CREATE TRIGGER trg_people_updated_at BEFORE UPDATE ON people
  FOR EACH ROW EXECUTE FUNCTION bump_updated_at();

DROP TRIGGER IF EXISTS trg_elections_updated_at ON elections;
CREATE TRIGGER trg_elections_updated_at BEFORE UPDATE ON elections
  FOR EACH ROW EXECUTE FUNCTION bump_updated_at();

DROP TRIGGER IF EXISTS trg_candidacies_updated_at ON candidacies;
CREATE TRIGGER trg_candidacies_updated_at BEFORE UPDATE ON candidacies
  FOR EACH ROW EXECUTE FUNCTION bump_updated_at();

-- ============================================================
-- RLS: public read, service-role write
-- ============================================================

ALTER TABLE jurisdictions ENABLE ROW LEVEL SECURITY;
ALTER TABLE office_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE offices ENABLE ROW LEVEL SECURITY;
ALTER TABLE office_relationships ENABLE ROW LEVEL SECURITY;
ALTER TABLE people ENABLE ROW LEVEL SECURITY;
ALTER TABLE office_tenures ENABLE ROW LEVEL SECURITY;
ALTER TABLE elections ENABLE ROW LEVEL SECURITY;
ALTER TABLE candidacies ENABLE ROW LEVEL SECURITY;
ALTER TABLE office_historical_issues ENABLE ROW LEVEL SECURITY;

-- Public read policies (civic data is public by design)
DO $$
DECLARE t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'jurisdictions', 'office_types', 'offices', 'office_relationships',
    'people', 'office_tenures', 'elections', 'candidacies',
    'office_historical_issues'
  ]) LOOP
    EXECUTE format(
      'CREATE POLICY "Public read %I" ON %I FOR SELECT USING (true);',
      t, t
    );
  END LOOP;
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;

-- ============================================================
-- Convenience views
-- ============================================================

CREATE OR REPLACE VIEW v_offices_with_incumbent AS
SELECT
  o.id                AS office_id,
  o.canonical_name    AS office_name,
  o.level,
  o.seat_designation,
  ot_type.slug        AS office_type_slug,
  ot_type.generic_name AS office_type_name,
  j.id                AS jurisdiction_id,
  j.name              AS jurisdiction_name,
  j.type              AS jurisdiction_type,
  j.fips_state,
  tenure.person_id    AS incumbent_person_id,
  p.canonical_name    AS incumbent_name,
  tenure.started_on   AS incumbent_started_on,
  tenure.party_at_tenure AS incumbent_party
FROM offices o
JOIN office_types ot_type ON ot_type.id = o.office_type_id
JOIN jurisdictions j ON j.id = o.jurisdiction_id
LEFT JOIN office_tenures tenure ON tenure.office_id = o.id AND tenure.ended_on IS NULL
LEFT JOIN people p ON p.id = tenure.person_id
WHERE o.is_active = TRUE;

CREATE OR REPLACE VIEW v_upcoming_elections AS
SELECT
  e.id                    AS election_id,
  e.election_date,
  e.election_type,
  o.id                    AS office_id,
  o.canonical_name        AS office_name,
  o.level,
  j.name                  AS jurisdiction_name,
  j.fips_state,
  (SELECT COUNT(*) FROM candidacies c WHERE c.election_id = e.id
    AND c.status IN ('active', 'pending_verification')) AS active_candidacies
FROM elections e
JOIN offices o ON o.id = e.office_id
JOIN jurisdictions j ON j.id = o.jurisdiction_id
WHERE e.election_date >= CURRENT_DATE
ORDER BY e.election_date, j.name;

COMMENT ON TABLE jurisdictions IS
  'Geographic + political hierarchy. Nation → state → county → municipality → sub-district. Self-referential via parent_id.';
COMMENT ON TABLE offices IS
  'Every elected seat in the US. Stable across cycles; incumbents and candidacies attach via office_tenures and elections.';
COMMENT ON TABLE people IS
  'Canonical person identity. Separate from candidates (who are people × elections). Enables cross-cycle tracking.';
COMMENT ON TABLE candidacies IS
  'A specific person running in a specific election. Links people to elections to offices.';
