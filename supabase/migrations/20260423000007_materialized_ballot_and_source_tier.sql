-- ============================================================
-- Materialized ballot view + positions source_tier
-- ============================================================
--
-- Two related additions:
--
-- 1. positions.source_tier — distinguishes "candidate stated on
--    campaign website" from "inferred from one tweet we scraped."
--    The matching product's defensibility depends on surfacing this.
--    Mirrors candidate_sources.authenticity_tier (1/2/3) but as a
--    semantic classifier rather than a pure tier number.
--
-- 2. Materialized view ballot_for_precinct — the address→ballot
--    hot path. Joining precincts → race_ids → elections →
--    candidacies → people on every voter request at 350K+ precinct
--    scale will saturate PG. Pre-compute the join nightly and on
--    candidacy-change triggers.
--
-- Refresh function writes to materialized_view_refresh_log (created
-- in Item 7). Read-path guard can check max(refreshed_at) and fall
-- through to direct query when stale.
--
-- Prior review fixes baked in:
--   - No UUID::text cast in the MV join (Hana's point about
--     JSONB UUID strings breaking index use at scale). Cast
--     JSONB element to UUID instead.
--   - Refresh function writes a log row on success.
-- ============================================================

-- ============================================================
-- 1. positions.source_tier
-- ============================================================

ALTER TABLE positions
  ADD COLUMN IF NOT EXISTS source_tier TEXT;

ALTER TABLE positions DROP CONSTRAINT IF EXISTS positions_source_tier_check;
ALTER TABLE positions
  ADD CONSTRAINT positions_source_tier_check
  CHECK (source_tier IS NULL OR source_tier IN (
    'candidate_stated_current',       -- on campaign website / questionnaire now
    'candidate_stated_prior',         -- on campaign website but for a prior cycle
    'candidate_direct_response',      -- responded to our questionnaire
    'voting_record_authoritative',    -- Congress.gov, OpenStates official votes
    'voting_record_scraped',          -- per-state legislature scrape
    'org_affiliation_explicit',       -- "member of Sierra Club" → inferred positions
    'media_paraphrase_high_quality',  -- NYT/WaPo/AP reported statement
    'media_paraphrase_low_quality',   -- partisan-source paraphrase
    'social_media_verified',          -- candidate's verified social account
    'ml_inferred_from_corpus'         -- AI inferred from gathered sources
  ));

CREATE INDEX IF NOT EXISTS idx_positions_source_tier ON positions (source_tier)
  WHERE source_tier IS NOT NULL;

-- Backfill heuristic:
--   view_type='stated' + citations include campaign_website → candidate_stated_current
--   view_type='inferred' with any voting_record citation → voting_record_authoritative
--   everything else → ml_inferred_from_corpus
UPDATE positions p
SET source_tier = CASE
  WHEN view_type = 'stated' THEN 'candidate_stated_current'
  WHEN EXISTS (
    SELECT 1 FROM jsonb_array_elements(source_citations) sc
    WHERE sc->>'source_type' = 'voting_record'
       OR sc->>'source_type' = 'congress_gov'
       OR sc->>'source_type' = 'federal_vote'
  ) THEN 'voting_record_authoritative'
  ELSE 'ml_inferred_from_corpus'
END
WHERE source_tier IS NULL;

-- ============================================================
-- 2. positions_current view — best-confidence row per (candidate, dim, view)
--
-- Not materialized; it's a query helper. Downstream code should
-- query this view rather than `positions` directly for display.
-- ============================================================

CREATE OR REPLACE VIEW positions_current AS
SELECT DISTINCT ON (candidate_id, sub_dimension_id, view_type)
  id,
  candidate_id,
  sub_dimension_id,
  view_type,
  score,
  confidence,
  source_tier,
  source_citations,
  nuance_notes,
  ai_summary,
  created_at
FROM positions
ORDER BY
  candidate_id,
  sub_dimension_id,
  view_type,
  CASE confidence
    WHEN 'candidate_direct' THEN 1
    WHEN 'high' THEN 2
    WHEN 'medium' THEN 3
    WHEN 'low' THEN 4
    WHEN 'no_data' THEN 5
    ELSE 6
  END,
  created_at DESC;

COMMENT ON VIEW positions_current IS
  'Best-confidence row per (candidate, sub_dimension, view_type). Display code should '
  'query this view. Ordering prioritizes candidate_direct > high > medium > low, '
  'tiebreak by newest created_at.';

-- ============================================================
-- 3. Materialized view: ballot_for_precinct
--
-- The address→ballot pipeline's hot cache. One row per
-- (precinct, upcoming race, candidacy). Refreshed nightly +
-- on candidacy change.
--
-- Design notes:
--   - precincts.race_ids is JSONB array of UUID strings. We cast
--     the JSONB element to UUID (not elections.id to text). This
--     preserves index usage on elections.id.
--   - Filters withdrawn candidates via status NOT IN (...).
--   - Includes denormalized person and party display for the UI.
-- ============================================================

DROP MATERIALIZED VIEW IF EXISTS ballot_for_precinct;

CREATE MATERIALIZED VIEW ballot_for_precinct AS
SELECT
  row_number() OVER () AS row_id,             -- for CONCURRENTLY-refresh unique index
  p.id                 AS precinct_id,
  p.county_id          AS county_id,
  e.id                 AS election_id,
  e.election_date      AS election_date,
  e.election_type      AS election_type,
  o.id                 AS office_id,
  o.canonical_name     AS office_name,
  o.level              AS office_level,
  c.id                 AS candidacy_id,
  c.person_id          AS person_id,
  people.canonical_name AS candidate_name,
  people.photo_url     AS candidate_photo_url,
  parties.abbreviation AS party_abbrev,
  parties.display_name AS party_display,
  parties.color_hex    AS party_color,
  c.is_incumbent       AS is_incumbent,
  c.status             AS candidacy_status
FROM precincts p
JOIN LATERAL jsonb_array_elements_text(p.race_ids) AS rid_text ON TRUE
JOIN elections e ON e.id = rid_text::uuid
JOIN offices o ON o.id = e.office_id
LEFT JOIN candidacies c ON c.election_id = e.id
  AND c.status NOT IN ('withdrew','disqualified','lost_primary','lost_general')
LEFT JOIN people ON people.id = c.person_id
LEFT JOIN parties ON parties.id = c.primary_party_id
WHERE e.election_date >= CURRENT_DATE - INTERVAL '30 days';  -- include just-passed primaries so results surface

CREATE UNIQUE INDEX IF NOT EXISTS idx_ballot_for_precinct_row ON ballot_for_precinct (row_id);
CREATE INDEX IF NOT EXISTS idx_ballot_for_precinct_precinct ON ballot_for_precinct (precinct_id);
CREATE INDEX IF NOT EXISTS idx_ballot_for_precinct_election ON ballot_for_precinct (election_id);
CREATE INDEX IF NOT EXISTS idx_ballot_for_precinct_date ON ballot_for_precinct (election_date);

COMMENT ON MATERIALIZED VIEW ballot_for_precinct IS
  'Denormalized address-to-ballot cache. Refresh nightly + post-advancement + post-candidacy-status-change. '
  'Includes races whose election_date is within 30 days past (so post-primary results still render). '
  'Read path: precincts.race_ids (JSONB) → elections.id via UUID cast — NOT via string cast, '
  'which would break index usage at national scale.';

-- ============================================================
-- 4. Refresh function + log
-- ============================================================

CREATE OR REPLACE FUNCTION refresh_ballot_for_precinct()
RETURNS VOID AS $$
DECLARE
  v_start TIMESTAMPTZ := clock_timestamp();
  v_elapsed_ms INT;
  v_row_count INT;
  v_triggered_by TEXT;
BEGIN
  v_triggered_by := current_setting('ballot_bridge.refresh_trigger', true);
  IF v_triggered_by IS NULL OR v_triggered_by = '' THEN
    v_triggered_by := 'manual';
  END IF;

  REFRESH MATERIALIZED VIEW CONCURRENTLY ballot_for_precinct;

  SELECT count(*)::int INTO v_row_count FROM ballot_for_precinct;
  v_elapsed_ms := EXTRACT(MILLISECONDS FROM clock_timestamp() - v_start)::int;

  INSERT INTO materialized_view_refresh_log (view_name, refreshed_at, duration_ms, rows_after, triggered_by)
  VALUES ('ballot_for_precinct', now(), v_elapsed_ms, v_row_count, v_triggered_by);
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION refresh_ballot_for_precinct IS
  'Refreshes the ballot_for_precinct materialized view CONCURRENTLY and writes a log row '
  'to materialized_view_refresh_log. Caller can set session var ballot_bridge.refresh_trigger '
  'to classify the source (cron/post_advancement/post_candidacy_change/manual).';

-- ============================================================
-- 5. Staleness helper view
-- ============================================================

CREATE OR REPLACE VIEW v_matview_staleness AS
SELECT
  view_name,
  max(refreshed_at) AS last_refreshed_at,
  now() - max(refreshed_at) AS age,
  (now() - max(refreshed_at)) > INTERVAL '4 hours' AS is_stale
FROM materialized_view_refresh_log
GROUP BY view_name;

COMMENT ON VIEW v_matview_staleness IS
  'Read-path guard. Query this view to check whether ballot_for_precinct is fresh '
  'enough to trust (age < 4h). If is_stale=TRUE, app code should fall through to '
  'direct joins on precincts/elections/candidacies instead.';

-- ============================================================
-- 6. Initial refresh
-- ============================================================

-- First refresh cannot use CONCURRENTLY (no existing data). Manual refresh.
REFRESH MATERIALIZED VIEW ballot_for_precinct;
INSERT INTO materialized_view_refresh_log (view_name, refreshed_at, duration_ms, rows_after, triggered_by, meta)
SELECT 'ballot_for_precinct', now(), 0, count(*), 'initial_create', '{}'::jsonb FROM ballot_for_precinct;
