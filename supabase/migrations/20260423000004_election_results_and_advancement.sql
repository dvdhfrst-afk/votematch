-- ============================================================
-- Election results + primary→general advancement
-- ============================================================
--
-- The single most load-bearing schema change for the 2026 launch.
-- Current state: 455K offices; 543 upcoming generals; 419 of
-- those (77%) have ZERO candidacies attached. Primary winners
-- do not auto-promote to the general; this migration provides
-- the bookkeeping so the advancement pipeline can.
--
-- Three tables:
--
-- 1. election_results — one row per (election, candidacy-or-write-in).
--    Populated from AP, Decision Desk HQ (if licensed), or
--    per-state SoS adapters. Tracks partial/unofficial/called/certified
--    distinctly.
--
-- 2. candidacy_advancement — one row per (primary_winner → general/runoff)
--    lineage. Enables "this general candidacy came from that primary"
--    traceability and lets the pipeline skip already-advanced candidacies.
--
-- 3. elections.parent_election_id (new column) — runoff/special
--    elections link back to the qualifying primary.
--
-- Prior review blockers fixed in this file:
--   - RLS uses USING (true) directly, not the tautology
--     USING (... OR true)
--   - UNIQUE idempotency key uses NULLS NOT DISTINCT so write-ins
--     and nonpartisan rows with NULL party don't duplicate.
--   - CHECK (NOT (is_winner AND is_runoff_advancer)) enforced.
--   - called_by_ap_at separate from certified_at.
-- ============================================================

-- ============================================================
-- 1. elections.parent_election_id
-- ============================================================

ALTER TABLE elections
  ADD COLUMN IF NOT EXISTS parent_election_id UUID REFERENCES elections(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_elections_parent ON elections (parent_election_id)
  WHERE parent_election_id IS NOT NULL;

COMMENT ON COLUMN elections.parent_election_id IS
  'For runoffs (GA/AL/MS/TX primary runoffs, LA general runoffs), points to the qualifying '
  'election that produced this contest. For special elections triggered by a vacancy, may '
  'point to the original-seat election. NULL for standalone elections.';

-- ============================================================
-- 2. election_results
-- ============================================================

CREATE TABLE IF NOT EXISTS election_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  election_id UUID NOT NULL REFERENCES elections(id) ON DELETE CASCADE,

  -- Link to candidacy when we can; NULL for write-ins / unmatched rows.
  candidacy_id UUID REFERENCES candidacies(id) ON DELETE SET NULL,
  person_id UUID REFERENCES people(id) ON DELETE SET NULL,
  party_id UUID REFERENCES parties(id) ON DELETE SET NULL,

  -- Raw reporting fields (from the source adapter)
  reported_name TEXT NOT NULL,                  -- exact name from source
  party_abbreviation TEXT,                      -- as reported: 'DEM', 'REP', 'IND', etc.

  vote_count INT,
  vote_percentage NUMERIC(6,3),                 -- 0.000 to 100.000

  -- Outcome flags
  is_winner BOOLEAN NOT NULL DEFAULT FALSE,
  is_runoff_advancer BOOLEAN NOT NULL DEFAULT FALSE,
  is_write_in BOOLEAN NOT NULL DEFAULT FALSE,
  is_certified_write_in BOOLEAN NOT NULL DEFAULT FALSE,

  -- Reporting / certification state
  reporting_level TEXT NOT NULL CHECK (reporting_level IN (
    'unofficial_partial',      -- < 100% reporting; no one has called
    'unofficial_complete',     -- 100% reporting; no one has called
    'ap_called',               -- AP has called the race
    'decision_desk_called',    -- DDHQ has called the race
    'media_called',            -- one or more media outlets called (no AP/DDHQ)
    'state_certified',         -- state canvassing board certified
    'recount_pending',
    'recount_complete',
    'contested',               -- legal dispute in progress
    'overturned'               -- result reversed after certification
  )),
  pct_precincts_reporting NUMERIC(5,2),        -- 0.00 - 100.00

  -- Timing: distinct stamps for distinct events
  first_reported_at TIMESTAMPTZ,               -- when this result first appeared
  called_by_ap_at TIMESTAMPTZ,                 -- AP specifically called
  race_called_at TIMESTAMPTZ,                  -- any caller (AP, DDHQ, media)
  certified_at TIMESTAMPTZ,                    -- state certification

  -- Provenance
  data_source_id UUID REFERENCES data_sources(id) ON DELETE SET NULL,
  ingestion_run_id UUID REFERENCES ingestion_runs(id) ON DELETE SET NULL,

  meta JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- A row cannot be both an outright winner AND a runoff advancer.
  -- (LA jungle: >50% sets is_winner=TRUE; <=50% sets is_runoff_advancer=TRUE.)
  CONSTRAINT election_results_outcome_mutex
    CHECK (NOT (is_winner AND is_runoff_advancer)),

  -- Percentages within [0, 100] when reported
  CONSTRAINT election_results_pct_range
    CHECK (vote_percentage IS NULL OR (vote_percentage >= 0 AND vote_percentage <= 100)),
  CONSTRAINT election_results_reporting_pct_range
    CHECK (pct_precincts_reporting IS NULL OR (pct_precincts_reporting >= 0 AND pct_precincts_reporting <= 100))
);

-- Idempotency: same (election, reported_name, party) can UPSERT cleanly.
-- NULLS NOT DISTINCT prevents two NULL-party write-in rows with same name
-- from duplicating on every AP refresh.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_election_results_ident
  ON election_results (election_id, reported_name, party_abbreviation) NULLS NOT DISTINCT;

CREATE INDEX IF NOT EXISTS idx_er_election ON election_results (election_id);
CREATE INDEX IF NOT EXISTS idx_er_candidacy ON election_results (candidacy_id) WHERE candidacy_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_er_person ON election_results (person_id) WHERE person_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_er_winner ON election_results (election_id) WHERE is_winner = TRUE;
CREATE INDEX IF NOT EXISTS idx_er_runoff_advancer ON election_results (election_id) WHERE is_runoff_advancer = TRUE;
CREATE INDEX IF NOT EXISTS idx_er_reporting_level ON election_results (reporting_level);
CREATE INDEX IF NOT EXISTS idx_er_certified ON election_results (election_id, certified_at) WHERE certified_at IS NOT NULL;

-- Bump updated_at
CREATE OR REPLACE FUNCTION election_results_bump_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_election_results_bump_updated_at
  BEFORE UPDATE ON election_results
  FOR EACH ROW EXECUTE FUNCTION election_results_bump_updated_at();

-- RLS: public read of results (transparent civic data); service-role write.
ALTER TABLE election_results ENABLE ROW LEVEL SECURITY;
CREATE POLICY election_results_public_read ON election_results FOR SELECT USING (true);

-- ============================================================
-- 3. candidacy_advancement
--
-- Records the lineage when a primary winner advances to the
-- general (or a runoff qualifier advances to the runoff).
-- One row per from-to edge.
-- ============================================================

CREATE TABLE IF NOT EXISTS candidacy_advancement (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  from_candidacy_id UUID NOT NULL REFERENCES candidacies(id) ON DELETE CASCADE,
  to_election_id UUID NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
  to_candidacy_id UUID REFERENCES candidacies(id) ON DELETE SET NULL,  -- NULL until general candidacy materialized

  advancement_rule TEXT NOT NULL CHECK (advancement_rule IN (
    'top_vote_getter_per_party',
    'plurality_threshold_or_runoff',
    'top_two_overall',
    'top_four_overall',
    'majority_or_advance_to_general',
    'convention_supermajority_or_primary',
    'instant_runoff'
  )),

  advanced_at TIMESTAMPTZ NOT NULL DEFAULT now(),   -- when our pipeline materialized the advancement
  triggered_by_result_id UUID REFERENCES election_results(id) ON DELETE SET NULL,

  meta JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- A candidate can only advance once from a given primary to a given election.
  UNIQUE (from_candidacy_id, to_election_id)
);

CREATE INDEX IF NOT EXISTS idx_ca_from ON candidacy_advancement (from_candidacy_id);
CREATE INDEX IF NOT EXISTS idx_ca_to_election ON candidacy_advancement (to_election_id);
CREATE INDEX IF NOT EXISTS idx_ca_to_candidacy ON candidacy_advancement (to_candidacy_id)
  WHERE to_candidacy_id IS NOT NULL;

ALTER TABLE candidacy_advancement ENABLE ROW LEVEL SECURITY;
CREATE POLICY ca_public_read ON candidacy_advancement FOR SELECT USING (true);

-- ============================================================
-- 4. Helper view: v_advancement_candidates
--
-- For each upcoming general-or-runoff election, joins the primary
-- results that should produce candidates via advancement. Used by
-- the advancement pipeline (scripts/advance-winners.ts).
-- ============================================================

CREATE OR REPLACE VIEW v_advancement_candidates AS
SELECT
  e_to.id                          AS to_election_id,
  e_to.election_type               AS to_election_type,
  e_to.election_date               AS to_election_date,
  e_from.id                        AS from_election_id,
  e_from.election_type             AS from_election_type,
  e_from.election_date             AS from_election_date,
  rules.effective_primary_advance_rule AS advancement_rule,
  er.id                            AS result_id,
  er.candidacy_id                  AS from_candidacy_id,
  er.reported_name,
  er.vote_percentage,
  er.is_winner,
  er.is_runoff_advancer,
  ca.id                            AS existing_advancement_id
FROM elections e_to
JOIN elections e_from ON e_from.office_id = e_to.office_id
JOIN v_election_effective_rules rules ON rules.election_id = e_from.id
JOIN election_results er ON er.election_id = e_from.id
LEFT JOIN candidacy_advancement ca
  ON ca.from_candidacy_id = er.candidacy_id AND ca.to_election_id = e_to.id
WHERE e_to.election_date >= CURRENT_DATE
  AND e_to.election_type IN ('general','nonpartisan_general','runoff','primary_runoff')
  AND e_from.election_date <= e_to.election_date
  AND e_from.election_type IN ('primary','jungle_primary','top_two_primary','top_four_primary','special_primary','convention')
  AND (er.is_winner OR er.is_runoff_advancer);

COMMENT ON VIEW v_advancement_candidates IS
  'Pre-joined view for the advancement pipeline. existing_advancement_id is non-null when '
  'the candidacy has already been advanced (idempotency guard). Filter WHERE existing_advancement_id IS NULL '
  'to find candidacies needing materialization.';

-- ============================================================
-- 5. Documentation
-- ============================================================

COMMENT ON TABLE election_results IS
  'One row per (election, reported candidate) with vote totals and outcome flags. '
  'UPSERT key is (election_id, reported_name, party_abbreviation) NULLS NOT DISTINCT — '
  'write-ins and nonpartisan rows with NULL party dedup cleanly. '
  'reporting_level distinguishes unofficial-partial → AP-called → certified lifecycle.';

COMMENT ON COLUMN election_results.is_winner IS
  'Outright winner per the effective voting rule. Must NOT be TRUE alongside is_runoff_advancer. '
  'Interpretation depends on primary_advance_rule: single_winner_plurality → top vote getter; '
  'plurality_threshold_or_runoff → >50% only; jungle_open_primary → >50% wins outright.';

COMMENT ON COLUMN election_results.is_runoff_advancer IS
  'This candidate did not win outright but advanced to a runoff (GA/AL/MS/TX primary runoff '
  'when no one hit 50%+1, LA jungle when no one hit majority). Mutually exclusive with is_winner.';

COMMENT ON COLUMN election_results.called_by_ap_at IS
  'Distinct from certified_at. AP or DDHQ can call a race hours after polls close; state '
  'certification takes 2-4 weeks. UI copy should match the reporting_level, not conflate the two.';

COMMENT ON TABLE candidacy_advancement IS
  'Primary → general/runoff lineage. UNIQUE (from_candidacy_id, to_election_id) prevents '
  'double-advancement. to_candidacy_id is NULL until the advancement pipeline materializes '
  'the general candidacy (handled in scripts/advance-winners.ts).';
