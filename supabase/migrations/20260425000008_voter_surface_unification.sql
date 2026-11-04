-- ============================================================
-- Voter-surface unification: legacy + office-graph union views
-- ============================================================
--
-- Council finding (2026-04-25): the 12,686-row office-graph
-- candidacies table is dark to voters. /ballot, /candidate/[id],
-- and /api/match all still read the legacy `candidates` table.
-- This migration creates two read-only union views the voter
-- surfaces can query without caring which world a row came from.
--
--   v_voter_races      — legacy races UNION new elections+offices
--   v_voter_candidates — legacy candidates UNION new candidacies
--
-- Lowest common denominator only. UI renders these the same way
-- it renders the existing Race / Candidate types.
--
-- The `is_legacy` discriminator is the routing column: when false,
-- the candidate-page code path falls back to the office-graph
-- /person/[id] rendering for voting record + CF strip.
--
-- Both views are SECURITY INVOKER (default) — they inherit the
-- caller's RLS context. Public-read rows from the underlying
-- tables remain public-read; nothing more is exposed.
-- ============================================================

-- ============================================================
-- v_voter_races
-- ============================================================
--
-- Columns (lowest common denominator):
--   id                    UUID — races.id (legacy) or elections.id (new)
--   name                  TEXT — races.name (legacy) or offices.canonical_name (new)
--   level                 TEXT — federal | state | county | municipal | school | special | judicial
--   district              TEXT — races.district (legacy) or offices.seat_designation (new)
--   election_date         DATE
--   election_type         TEXT — primary | general | etc.
--   state_fips            CHAR(2) — null for legacy (Utah-only and races doesn't track), set for new
--   office_id             UUID — null for legacy
--   election_id           UUID — null for legacy
--   legacy_race_id        UUID — null for new
--   is_legacy             BOOLEAN
-- ============================================================

DROP VIEW IF EXISTS v_voter_races CASCADE;

CREATE VIEW v_voter_races AS
-- LEGACY ARM: races table. UT only because that's all that exists in the
-- legacy world today. district stays text. state_fips is NULL because the
-- legacy schema never tracked it (Utah was the only state).
SELECT
  r.id                                      AS id,
  r.name                                    AS name,
  r.level                                   AS level,
  r.district                                AS district,
  r.election_date                           AS election_date,
  r.type                                    AS election_type,
  NULL::CHAR(2)                             AS state_fips,
  NULL::UUID                                AS office_id,
  NULL::UUID                                AS election_id,
  r.id                                      AS legacy_race_id,
  TRUE                                      AS is_legacy
FROM races r

UNION ALL

-- NEW ARM: elections joined to offices joined to jurisdictions for state.
-- We surface ONE row per election (not per candidacy) — same shape as the
-- legacy races row.
--
-- jurisdictions.fips_state is the source of state_fips. For non-state
-- jurisdictions (county, municipality, etc.), the immediate row's
-- fips_state is populated when the loader knows it. When NULL, we walk
-- up via parent_id with a recursive CTE-substitute via COALESCE on the
-- ancestor-precomputed column. Today's data has fips_state on the state
-- jurisdiction row directly; sub-jurisdictions inherit via COALESCE on
-- the recursive helper. To keep this view non-recursive (faster), we
-- COALESCE through the immediate parent and grandparent — sufficient for
-- federal (national → state) and state (state → state) and county
-- (state → county). Deeper levels (muni → county → state) need the
-- two-hop walk.
SELECT
  e.id                                      AS id,
  o.canonical_name                          AS name,
  o.level                                   AS level,
  o.seat_designation                        AS district,
  e.election_date                           AS election_date,
  -- Coerce the office-graph election_type CHECK values into the legacy
  -- 'primary' | 'general' set so RaceCard's level filtering still works.
  -- 'special_general' / 'special_primary' / 'runoff' / 'retention' /
  -- 'recall' / 'nonpartisan_general' all collapse to the closest legacy
  -- bucket. The exact election_type stays available in joined queries.
  CASE
    WHEN e.election_type IN ('primary', 'special_primary')           THEN 'primary'
    WHEN e.election_type IN ('general', 'special_general',
                             'runoff', 'retention', 'recall',
                             'nonpartisan_general')                  THEN 'general'
    ELSE e.election_type
  END                                       AS election_type,
  -- Walk up to find state fips. For now, immediate jurisdiction OR its parent.
  COALESCE(j.fips_state, jp.fips_state, jpp.fips_state)
                                            AS state_fips,
  o.id                                      AS office_id,
  e.id                                      AS election_id,
  NULL::UUID                                AS legacy_race_id,
  FALSE                                     AS is_legacy
FROM elections e
JOIN offices o          ON o.id = e.office_id
JOIN jurisdictions j    ON j.id = o.jurisdiction_id
LEFT JOIN jurisdictions jp  ON jp.id = j.parent_id
LEFT JOIN jurisdictions jpp ON jpp.id = jp.parent_id;

COMMENT ON VIEW v_voter_races IS
  'Unified voter-facing races view. Combines legacy `races` (UT only) with new '
  'office-graph `elections` joined to `offices`. Filter by is_legacy to '
  'discriminate. Used by /ballot and /api/match.';


-- ============================================================
-- v_voter_candidates
-- ============================================================
--
-- Columns:
--   id                    UUID — candidates.id (legacy) or candidacies.id (new)
--   race_id               UUID — references v_voter_races.id (legacy races.id or new elections.id)
--   name                  TEXT
--   office_name           TEXT — derived
--   office_level          TEXT — federal | state | county | municipal | school | special | judicial
--   state_fips            CHAR(2)
--   district_identifier   TEXT — district / seat designation
--   party                 TEXT — display name (legacy `party` text or party_lines.display_name)
--   party_abbreviation    TEXT
--   party_color           TEXT
--   incumbent             BOOLEAN
--   is_legacy             BOOLEAN
--   legacy_candidate_id   UUID — null for new rows
--   bioguide_id           TEXT — for federal voting-record join
--   person_id             UUID — null for legacy unless people.legacy_candidate_ids resolved
--   photo_url             TEXT
--   bio                   TEXT
--   website_url           TEXT
--   published             BOOLEAN
--   withdrew              BOOLEAN
-- ============================================================

DROP VIEW IF EXISTS v_voter_candidates CASCADE;

CREATE VIEW v_voter_candidates AS
-- LEGACY ARM: candidates joined to races. We try to resolve a person_id
-- by reverse-lookup of people.legacy_candidate_ids — populated for the
-- ~352 UT migrations. NULL otherwise. Used to enable the federal voting
-- record + CF strip on /candidate/[id] for legacy rows that bridge.
SELECT
  c.id                                      AS id,
  c.race_id                                 AS race_id,
  c.name                                    AS name,
  r.name                                    AS office_name,
  r.level                                   AS office_level,
  NULL::CHAR(2)                             AS state_fips,
  r.district                                AS district_identifier,
  c.party                                   AS party,
  -- Derive abbreviation by simple text match. Best-effort; UI tolerates null.
  CASE
    WHEN c.party ILIKE 'Democrat%'          THEN 'D'
    WHEN c.party ILIKE 'Republican%'        THEN 'R'
    WHEN c.party ILIKE 'Libertarian%'       THEN 'L'
    WHEN c.party ILIKE 'Green%'             THEN 'G'
    WHEN c.party ILIKE 'Independent%'       THEN 'I'
    WHEN c.party ILIKE 'United Utah%'       THEN 'UU'
    ELSE NULL
  END                                       AS party_abbreviation,
  -- Color hint for UI. Matches the existing PARTY_COLORS map in
  -- CandidateRow.tsx so legacy and new render consistently.
  CASE
    WHEN c.party ILIKE 'Democrat%'          THEN '#0044AA'
    WHEN c.party ILIKE 'Republican%'        THEN '#AA0000'
    WHEN c.party ILIKE 'Libertarian%'       THEN '#FED105'
    WHEN c.party ILIKE 'Green%'             THEN '#17AA5C'
    ELSE NULL
  END                                       AS party_color,
  FALSE                                     AS incumbent,  -- legacy table doesn't track incumbency
  TRUE                                      AS is_legacy,
  c.id                                      AS legacy_candidate_id,
  -- Best-effort person bridge for federal voting-record join
  pl.meta->>'bioguide_id'                   AS bioguide_id,
  pl.id                                     AS person_id,
  c.photo_url                               AS photo_url,
  c.bio                                     AS bio,
  c.website_url                             AS website_url,
  c.published                               AS published,
  FALSE                                     AS withdrew
FROM candidates c
JOIN races r ON r.id = c.race_id
LEFT JOIN people pl ON c.id = ANY(pl.legacy_candidate_ids)

UNION ALL

-- NEW ARM: candidacies joined through elections → offices → jurisdictions.
-- Party comes from candidacy_party_lines via primary_party_id (denormalized
-- on candidacies). Falls back to candidacies.party text column for rows
-- not yet joined to a parties row.
SELECT
  cdy.id                                    AS id,
  cdy.election_id                           AS race_id,
  ppl.canonical_name                        AS name,
  o.canonical_name                          AS office_name,
  o.level                                   AS office_level,
  COALESCE(j.fips_state, jp.fips_state, jpp.fips_state)
                                            AS state_fips,
  o.seat_designation                        AS district_identifier,
  -- Prefer normalized party display name; fall back to the legacy text col.
  COALESCE(pty.display_name, cdy.party)     AS party,
  pty.abbreviation                          AS party_abbreviation,
  pty.color_hex                             AS party_color,
  -- Incumbency: prefer candidacies.is_incumbent (filed/scraper-set).
  -- Fall back to "person currently holds this office" via office_tenures.
  COALESCE(
    cdy.is_incumbent,
    EXISTS (
      SELECT 1 FROM office_tenures ot
      WHERE ot.office_id = e.office_id
        AND ot.person_id = cdy.person_id
        AND ot.ended_on IS NULL
    )
  )                                         AS incumbent,
  FALSE                                     AS is_legacy,
  cdy.legacy_candidate_id                   AS legacy_candidate_id,
  ppl.meta->>'bioguide_id'                  AS bioguide_id,
  cdy.person_id                             AS person_id,
  ppl.photo_url                             AS photo_url,
  ppl.bio                                   AS bio,
  ppl.website_url                           AS website_url,
  -- Published gate: a new candidacy is "published" when status is not
  -- pending_verification, not withdrew/disqualified. Same defensive logic
  -- as ballot_for_precinct in 20260423000008.
  (cdy.status NOT IN ('pending_verification', 'withdrew',
                      'disqualified', 'lost_primary', 'lost_general'))
                                            AS published,
  (cdy.status = 'withdrew')                 AS withdrew
FROM candidacies cdy
JOIN elections e        ON e.id = cdy.election_id
JOIN offices o          ON o.id = e.office_id
JOIN jurisdictions j    ON j.id = o.jurisdiction_id
LEFT JOIN jurisdictions jp  ON jp.id = j.parent_id
LEFT JOIN jurisdictions jpp ON jpp.id = jp.parent_id
JOIN people ppl         ON ppl.id = cdy.person_id
LEFT JOIN parties pty   ON pty.id = cdy.primary_party_id;

COMMENT ON VIEW v_voter_candidates IS
  'Unified voter-facing candidates view. Combines legacy `candidates` with '
  'new office-graph `candidacies`. is_legacy=true rows route through legacy '
  'positions table for matching. is_legacy=false rows render via /person/[id] '
  'for voting record + CF strip. Used by /ballot, /candidate/[id], /api/match.';

-- ============================================================
-- Smoke-test queries (commented, run manually if curious):
--
--   SELECT is_legacy, count(*) FROM v_voter_candidates GROUP BY is_legacy;
--   SELECT is_legacy, count(*) FROM v_voter_races GROUP BY is_legacy;
--   SELECT * FROM v_voter_candidates WHERE is_legacy=false LIMIT 3;
-- ============================================================
