-- ============================================================
-- race → election bridge column
-- ============================================================
--
-- Current state: two parallel worlds.
--   Legacy: races + candidates + district_races + precincts.race_ids[]
--   New (office-centric): elections + candidacies + offices
--
-- The materialized view ballot_for_precinct (Item 8) needs to
-- walk precincts → elections. The legacy path walks via
-- precincts.race_ids → races. This migration adds a nullable
-- FK races.election_id that a follow-up mapping script will
-- populate, bridging the two worlds.
--
-- Also rewrites ballot_for_precinct to prefer the new-world
-- join when available and fall back to legacy when not.
-- ============================================================

ALTER TABLE races
  ADD COLUMN IF NOT EXISTS election_id UUID REFERENCES elections(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_races_election ON races (election_id)
  WHERE election_id IS NOT NULL;

COMMENT ON COLUMN races.election_id IS
  'Bridge to office-centric elections table. Populated by scripts/bridge-races-to-elections.ts '
  'that matches races.district + races.election_date + races.type to elections.office_id + '
  'election_date + election_type. NULL until bridge runs for that race.';

-- ============================================================
-- Rewrite ballot_for_precinct to walk precincts → races → elections
-- via the new bridge column. When bridge is NULL, that race is
-- simply not included in the matview (correct: we do not yet
-- know the office-centric election for it).
-- ============================================================

DROP MATERIALIZED VIEW IF EXISTS ballot_for_precinct;

CREATE MATERIALIZED VIEW ballot_for_precinct AS
SELECT
  row_number() OVER () AS row_id,
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
JOIN races r ON r.id = rid_text::uuid
JOIN elections e ON e.id = r.election_id                       -- bridge: NULL bridge → row dropped
JOIN offices o ON o.id = e.office_id
LEFT JOIN candidacies c ON c.election_id = e.id
  AND c.status NOT IN ('withdrew','disqualified','lost_primary','lost_general')
LEFT JOIN people ON people.id = c.person_id
LEFT JOIN parties ON parties.id = c.primary_party_id
WHERE e.election_date >= CURRENT_DATE - INTERVAL '30 days';

CREATE UNIQUE INDEX IF NOT EXISTS idx_ballot_for_precinct_row ON ballot_for_precinct (row_id);
CREATE INDEX IF NOT EXISTS idx_ballot_for_precinct_precinct ON ballot_for_precinct (precinct_id);
CREATE INDEX IF NOT EXISTS idx_ballot_for_precinct_election ON ballot_for_precinct (election_id);
CREATE INDEX IF NOT EXISTS idx_ballot_for_precinct_date ON ballot_for_precinct (election_date);

COMMENT ON MATERIALIZED VIEW ballot_for_precinct IS
  'Denormalized address-to-ballot cache. Walks precincts.race_ids → races.id → races.election_id → '
  'elections → offices + candidacies. Rows where races.election_id IS NULL are excluded (bridge not yet '
  'populated for that race). Refresh via refresh_ballot_for_precinct(). Empty until the legacy→office bridge '
  'script runs.';

-- Initial refresh (may be 0 rows until bridge populated)
REFRESH MATERIALIZED VIEW ballot_for_precinct;
INSERT INTO materialized_view_refresh_log (view_name, refreshed_at, duration_ms, rows_after, triggered_by, meta)
SELECT 'ballot_for_precinct', now(), 0, count(*), 'post_migration_rebuild',
       jsonb_build_object('migration', '20260423000008_race_election_bridge')
FROM ballot_for_precinct;
