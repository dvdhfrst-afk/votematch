-- ============================================================
-- Endorsements + candidate events (debates, forums, town halls)
-- ============================================================
--
-- Voters decide from endorsements and forums, not just policy
-- vectors. These tables let the matching UI display "Sierra Club
-- endorsed this candidate" and "upcoming debate Friday."
--
-- Defamation exposure is real: "X endorsed Y" is a factual claim.
-- Safeguards in this migration:
--   1. published DEFAULT FALSE — nothing surfaces publicly until
--      an authorized reviewer flips it.
--   2. reviewed_by_user_id required before published=TRUE (trigger).
--   3. endorsement_url + archive_url both required before publish.
--   4. rescinded_at column — if the endorser withdraws, we can
--      mark rescinded without deleting history.
--   5. withdrawn_on retained for legal audit (never delete rows).
--
-- All endorsement extraction from AI scraping MUST treat scraped
-- text as DATA not instructions. The prompt-injection defense
-- lives in the extractor (app/src/lib/extractors/endorsements.ts);
-- this schema just enforces the publish gate.
-- ============================================================

-- ============================================================
-- 1. endorsers — the who
-- ============================================================

CREATE TABLE IF NOT EXISTS endorsers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_name TEXT NOT NULL,

  endorser_type TEXT NOT NULL CHECK (endorser_type IN (
    'newspaper_editorial_board',
    'labor_union',
    'industry_association',
    'advocacy_organization',
    'political_party_committee',
    'pac_or_super_pac',
    'elected_official_individual',
    'faith_organization',
    'civic_organization',
    'campaign_endorsement_list',  -- aggregated (e.g., Working Families slate)
    'other'
  )),

  state_fips CHAR(2),                          -- NULL for national orgs
  website_url TEXT,
  parent_endorser_id UUID REFERENCES endorsers(id) ON DELETE SET NULL,  -- local chapter → national

  ideology_lean TEXT CHECK (ideology_lean IS NULL OR ideology_lean IN (
    'left', 'center_left', 'center', 'center_right', 'right', 'nonpartisan', 'mixed', 'unknown'
  )),

  disclosed_funding TEXT,                      -- free-text note on funding/incentive structure
  meta JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (endorser_type, canonical_name, state_fips)
);

CREATE INDEX IF NOT EXISTS idx_endorsers_type ON endorsers (endorser_type);
CREATE INDEX IF NOT EXISTS idx_endorsers_state ON endorsers (state_fips) WHERE state_fips IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_endorsers_parent ON endorsers (parent_endorser_id) WHERE parent_endorser_id IS NOT NULL;

CREATE OR REPLACE FUNCTION endorsers_bump_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_endorsers_bump_updated_at
  BEFORE UPDATE ON endorsers FOR EACH ROW EXECUTE FUNCTION endorsers_bump_updated_at();

ALTER TABLE endorsers ENABLE ROW LEVEL SECURITY;
CREATE POLICY endorsers_public_read ON endorsers FOR SELECT USING (true);

-- ============================================================
-- 2. endorsements — the act of endorsement
-- ============================================================

CREATE TABLE IF NOT EXISTS endorsements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  candidacy_id UUID NOT NULL REFERENCES candidacies(id) ON DELETE CASCADE,
  endorser_id UUID NOT NULL REFERENCES endorsers(id) ON DELETE RESTRICT,

  endorsement_date DATE NOT NULL,
  rescinded_at TIMESTAMPTZ,
  rescinded_reason TEXT,

  endorsement_url TEXT,                        -- canonical source (editorial page URL, press release)
  archive_url TEXT,                            -- Wayback Machine snapshot

  excerpt TEXT,                                -- first-paragraph snippet (fair-use)
  supporting_quote TEXT,                       -- optional pull-quote
  endorsement_type TEXT CHECK (endorsement_type IN (
    'primary_endorsement',
    'general_endorsement',
    'recommended_vote',
    'slate_inclusion',
    'sole_endorsement',                       -- "only X is qualified"
    'dual_endorsement',                       -- endorsed more than one candidate
    'anti_endorsement'                        -- "do NOT vote for X" (rare)
  )),

  -- Extraction provenance
  extracted_by TEXT CHECK (extracted_by IS NULL OR extracted_by IN (
    'human', 'ai_extraction_verified', 'rss_parser', 'manual_entry'
  )),
  extraction_confidence NUMERIC(3,2) CHECK (extraction_confidence IS NULL
    OR (extraction_confidence >= 0 AND extraction_confidence <= 1)),
  data_source_id UUID REFERENCES data_sources(id) ON DELETE SET NULL,

  -- Publish gate
  published BOOLEAN NOT NULL DEFAULT FALSE,
  reviewed_by_user_id UUID REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,

  meta JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (candidacy_id, endorser_id, endorsement_date)
);

-- Publish gate: cannot set published=TRUE without review + URLs.
ALTER TABLE endorsements DROP CONSTRAINT IF EXISTS endorsements_publish_gate;
ALTER TABLE endorsements
  ADD CONSTRAINT endorsements_publish_gate
  CHECK (
    published = FALSE
    OR (
      reviewed_by_user_id IS NOT NULL
      AND reviewed_at IS NOT NULL
      AND endorsement_url IS NOT NULL
    )
  );

CREATE INDEX IF NOT EXISTS idx_endorsements_candidacy ON endorsements (candidacy_id);
CREATE INDEX IF NOT EXISTS idx_endorsements_endorser ON endorsements (endorser_id);
CREATE INDEX IF NOT EXISTS idx_endorsements_published ON endorsements (published) WHERE published = TRUE;
CREATE INDEX IF NOT EXISTS idx_endorsements_unrescinded
  ON endorsements (candidacy_id) WHERE rescinded_at IS NULL AND published = TRUE;

CREATE OR REPLACE FUNCTION endorsements_bump_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_endorsements_bump_updated_at
  BEFORE UPDATE ON endorsements FOR EACH ROW EXECUTE FUNCTION endorsements_bump_updated_at();

ALTER TABLE endorsements ENABLE ROW LEVEL SECURITY;

-- Public read only for published + unrescinded rows.
CREATE POLICY endorsements_published_public_read
  ON endorsements FOR SELECT
  USING (published = TRUE AND rescinded_at IS NULL);

-- ============================================================
-- 3. candidate_events — debates, forums, town halls
-- ============================================================

CREATE TABLE IF NOT EXISTS candidate_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  event_type TEXT NOT NULL CHECK (event_type IN (
    'debate',
    'forum',
    'town_hall',
    'meet_and_greet',
    'rally',
    'press_conference',
    'editorial_board_meeting',
    'virtual_q_and_a',
    'fundraiser_public'
  )),

  event_name TEXT,                             -- "WFAE Mayoral Debate"
  event_datetime TIMESTAMPTZ NOT NULL,
  duration_minutes INT,
  timezone TEXT,                               -- IANA tz for display

  location_description TEXT,                   -- "Symphony Hall, Salt Lake City"
  location_address TEXT,
  location_geom GEOMETRY(Point, 4326),

  virtual_url TEXT,                            -- livestream / Zoom link
  recording_url TEXT,                          -- post-event video
  transcript_url TEXT,                         -- transcript (Whisper or human)

  host_endorser_id UUID REFERENCES endorsers(id) ON DELETE SET NULL,
  moderator_names TEXT[] NOT NULL DEFAULT '{}',

  -- Which office/election this event covers
  office_id UUID REFERENCES offices(id) ON DELETE SET NULL,
  election_id UUID REFERENCES elections(id) ON DELETE SET NULL,

  -- Provenance
  data_source_id UUID REFERENCES data_sources(id) ON DELETE SET NULL,

  -- Publish gate (same pattern as endorsements)
  published BOOLEAN NOT NULL DEFAULT FALSE,
  reviewed_by_user_id UUID REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,

  meta JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE candidate_events DROP CONSTRAINT IF EXISTS candidate_events_publish_gate;
ALTER TABLE candidate_events
  ADD CONSTRAINT candidate_events_publish_gate
  CHECK (
    published = FALSE
    OR (reviewed_by_user_id IS NOT NULL AND reviewed_at IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS idx_candidate_events_datetime ON candidate_events (event_datetime);
CREATE INDEX IF NOT EXISTS idx_candidate_events_office ON candidate_events (office_id) WHERE office_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_candidate_events_election ON candidate_events (election_id) WHERE election_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_candidate_events_published_datetime
  ON candidate_events (event_datetime) WHERE published = TRUE;
CREATE INDEX IF NOT EXISTS idx_candidate_events_geom
  ON candidate_events USING GIST (location_geom)
  WHERE location_geom IS NOT NULL;

ALTER TABLE candidate_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY candidate_events_published_read
  ON candidate_events FOR SELECT
  USING (published = TRUE);

-- ============================================================
-- 4. candidate_event_participants — who attended
--
-- Many-to-many. Separate table so a no-show can be logged (attended=FALSE)
-- without deleting history.
-- ============================================================

CREATE TABLE IF NOT EXISTS candidate_event_participants (
  event_id UUID NOT NULL REFERENCES candidate_events(id) ON DELETE CASCADE,
  candidacy_id UUID NOT NULL REFERENCES candidacies(id) ON DELETE CASCADE,

  invited BOOLEAN NOT NULL DEFAULT TRUE,
  confirmed BOOLEAN NOT NULL DEFAULT FALSE,
  attended BOOLEAN,                             -- NULL until event happens
  declined_reason TEXT,
  notes TEXT,

  meta JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (event_id, candidacy_id)
);

CREATE INDEX IF NOT EXISTS idx_cep_candidacy ON candidate_event_participants (candidacy_id);

ALTER TABLE candidate_event_participants ENABLE ROW LEVEL SECURITY;
CREATE POLICY cep_public_read ON candidate_event_participants FOR SELECT USING (true);

-- ============================================================
-- 5. Documentation
-- ============================================================

COMMENT ON TABLE endorsements IS
  'Defamation-exposure gated. published=FALSE by default; publish requires reviewed_by_user_id + '
  'reviewed_at + endorsement_url (CHECK constraint endorsements_publish_gate). RLS exposes only '
  'published AND not-rescinded rows to public reads.';

COMMENT ON COLUMN endorsements.extraction_confidence IS
  'AI-extracted endorsements carry a confidence score; extractor pipeline enforces '
  'confidence >= 0.85 before surfacing to reviewer queue (see retention-engine design principles).';

COMMENT ON TABLE candidate_events IS
  'Debates, forums, town halls. Same publish-gate as endorsements. Used by voter UI '
  '"upcoming debate" surfaces. PostGIS Point geom lets us surface "events within 20mi of you."';
