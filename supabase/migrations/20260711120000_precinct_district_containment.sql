-- ============================================================================
-- PREPARED MIGRATION FILE -- coordinator must copy this file, verbatim, to:
--   app/supabase/migrations/20260711120000_precinct_district_containment.sql
-- (a hard deny rule in .claude/settings.local.json blocks Edit/Write/Bash
-- writes into app/supabase/migrations/ from this session -- protects against
-- an agent silently modifying migration history. Coordinator must do the
-- copy + apply + repair steps below manually.)
--
-- Durability fix: single-winner district assignment must use interior-point
-- containment, not polygon-overlap (ST_Intersects).
-- ============================================================================
--
-- THE BUG THIS CLOSES (verified 2026-07-11, see
-- scripts/_g1-fix-precinct-cd-overlink.sql for the data-side repair)
-- ----------------------------------------------------------------------------
-- 224 Utah precincts were linked to MORE THAN ONE US House race on the Nov 3,
-- 2026 ballot. Root cause: populate_precinct_races() (defined in
-- 20260416000000_initial_schema.sql) joins precincts to political_districts
-- with ST_Intersects (polygon-overlaps-polygon). The Utah precinct shapefile
-- was drawn to the OLD congressional map; 224 precincts clip across the NEW
-- court-ordered district lines, so ST_Intersects matches them to two (a few,
-- three) congressional districts at once.
--
-- A remove-only DATA fix was already applied to the live DB
-- (scripts/_g1-fix-precinct-cd-overlink.sql). That fix does not touch this
-- function, so re-running populate_precinct_races() -- or
-- resolve_user_state_district(), which has the identical bug for a
-- single-precinct RPC lookup -- would silently reintroduce the over-linkage.
-- This migration is the durable code-level fix.
--
-- THE FIX
-- ----------------------------------------------------------------------------
-- For SINGLE-WINNER district types -- ones where a precinct belongs to
-- exactly ONE district (the seat represents one non-overlapping geography) --
-- membership is now decided by interior-point containment:
--   ST_Contains(district.geom, ST_PointOnSurface(precinct.geom))
-- ST_PointOnSurface always returns a point strictly inside the precinct
-- polygon, so at most one single-winner district of a given type can contain
-- it (barring a literal topology error at that exact point).
--
-- Single-winner types covered here: us_congressional, state_senate,
-- state_house, county, county_council, and the SBOE (State Board of
-- Education) layer, which is stored as district_type = 'school_board' with a
-- meta marker (district_role = 'state_education_board') -- see
-- scripts/lib/sboe-districts.ts, which already uses exactly this
-- containment-first / overlap-fallback pattern for the standalone SBOE repair
-- scripts. A precinct genuinely belongs to exactly one district of each of
-- these types -- county and county_council are different district_type
-- values, each single-winner within its own type.
--
-- school_board rows WITHOUT the state_education_board marker (a hypothetical
-- future LOCAL school-board district layer) are deliberately LEFT ON THE
-- ST_INTERSECTS PATH until reviewed -- it is not yet known whether that layer
-- will be single-winner per precinct.
--
-- Genuinely-overlapping types (the 20 special_* district types, and any
-- district_type not explicitly listed as single-winner above) KEEP the
-- original ST_Intersects behavior unchanged -- a precinct can legitimately
-- carry more than one special district (e.g. a water district and a fire
-- district covering the same ground).
--
-- DOCUMENTED FALLBACK: for a (precinct, single-winner district_type) pair
-- where containment matches NOTHING (the rep-point lands in a gap/sliver at a
-- boundary -- e.g. a digitizing seam between two source shapefiles), the
-- function falls back to ST_Intersects for that type only, so the precinct is
-- never silently left with zero districts of a type it should have exactly
-- one of. This mirrors sboe-districts.ts computeTrueDistricts() two-pass
-- design (containment, then largest-overlap for the leftovers).
--
-- FUNCTIONS CHANGED (both CREATE OR REPLACE; no data touched)
-- ----------------------------------------------------------------------------
--   1. populate_precinct_races()      -- bulk precinct -> race_ids / district_info
--      (originally 20260416000000_initial_schema.sql)
--   2. resolve_user_state_district()  -- single-precinct state+CD RPC lookup,
--      used by lookupBallotAction (src/app/actions.ts) and
--      scripts/backfill-user-state-district.ts
--      (originally 20260502000003_resolve_user_state_district.sql)
--      Same ST_Intersects-only bug, different failure mode: instead of
--      over-linking, it can silently pick the WRONG congressional district
--      for a straddling precinct (largest-overlap-area tiebreak, not
--      interior-point containment).
--
-- NOT changed, evaluated and left as-is:
--   - map-districts-to-races.ts: no spatial query at all (matches race to
--     district by parsed name/number), nothing to fix here.
--   - link-precinct-generals.ts: no spatial query; derives its match keys
--     from precincts.race_ids, which is itself fixed by (1) above.
--   - link-precinct-county-generals.ts / link-precinct-council-district-
--     generals.ts: ALREADY use ST_Contains(geom, ST_PointOnSurface(...)) for
--     their own independent county / county-council-district membership
--     checks (with a dual county_id arithmetic guard). No ST_Intersects
--     present; nothing to change.
--
-- IMPORTANT: no BEGIN/COMMIT/ROLLBACK in this file. scripts/_live-write.ts
-- wraps it in one transaction; an inner transaction marker defeats its
-- dry-run (a prior repo incident -- see 20260706000000_county_council_
-- district_type.sql for the same note). Plain CREATE OR REPLACE statements
-- only.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. populate_precinct_races() -- bulk precinct -> race_ids / district_info
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION populate_precinct_races()
RETURNS void AS $$
BEGIN
  UPDATE precincts p
  SET
    race_ids = sub.race_ids,
    district_info = sub.district_info
  FROM (
    WITH single_winner AS (
      -- district_type values (plus the SBOE meta-marked school_board subset)
      -- where a precinct belongs to exactly ONE district. See header comment
      -- for the full rationale.
      SELECT pd.id AS district_id
        FROM political_districts pd
       WHERE pd.district_type IN
               ('us_congressional', 'state_senate', 'state_house', 'county', 'county_council')
          OR (pd.district_type = 'school_board'
              AND pd.meta ->> 'district_role' = 'state_education_board')
    ),
    contains_hits AS (
      -- Primary rule for single-winner types: interior-point containment.
      SELECT p2.id AS precinct_id, pd.id AS district_id, pd.district_type
        FROM precincts p2
        JOIN political_districts pd
          ON pd.id IN (SELECT district_id FROM single_winner)
         AND ST_Contains(pd.geom, ST_PointOnSurface(p2.geom))
    ),
    fallback_hits AS (
      -- Documented fallback: only for a (precinct, district_type) pair with
      -- ZERO containment hits above (rep-point in a gap/sliver). Falls back
      -- to polygon overlap for that type only.
      SELECT p2.id AS precinct_id, pd.id AS district_id, pd.district_type
        FROM precincts p2
        JOIN political_districts pd
          ON pd.id IN (SELECT district_id FROM single_winner)
         AND ST_Intersects(p2.geom, pd.geom)
       WHERE NOT EXISTS (
         SELECT 1 FROM contains_hits ch
          WHERE ch.precinct_id = p2.id AND ch.district_type = pd.district_type
       )
    ),
    overlap_hits AS (
      -- Genuinely-overlapping district types: unchanged ST_Intersects
      -- behavior. A precinct can legitimately carry more than one.
      SELECT p2.id AS precinct_id, pd.id AS district_id, pd.district_type
        FROM precincts p2
        JOIN political_districts pd
          ON pd.id NOT IN (SELECT district_id FROM single_winner)
         AND ST_Intersects(p2.geom, pd.geom)
    ),
    all_hits AS (
      SELECT precinct_id, district_id, district_type FROM contains_hits
      UNION
      SELECT precinct_id, district_id, district_type FROM fallback_hits
      UNION
      SELECT precinct_id, district_id, district_type FROM overlap_hits
    )
    SELECT
      h.precinct_id,
      jsonb_agg(DISTINCT dr.race_id) AS race_ids,
      jsonb_build_object(
        'congressional', max(CASE WHEN h.district_type = 'us_congressional' THEN pd.district_name END),
        'state_senate',  max(CASE WHEN h.district_type = 'state_senate'     THEN pd.district_name END),
        'state_house',   max(CASE WHEN h.district_type = 'state_house'      THEN pd.district_name END),
        'county',        max(CASE WHEN h.district_type = 'county'           THEN pd.district_name END)
      ) AS district_info
    FROM all_hits h
    JOIN political_districts pd ON pd.id = h.district_id
    JOIN district_races dr ON dr.district_id = h.district_id
    GROUP BY h.precinct_id
  ) sub
  WHERE p.id = sub.precinct_id;
END;
$$ LANGUAGE plpgsql;


-- ----------------------------------------------------------------------------
-- 2. resolve_user_state_district() -- single-precinct state+CD RPC lookup
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resolve_user_state_district(p_precinct_id UUID)
RETURNS TABLE (state TEXT, congressional_district TEXT)
LANGUAGE sql
STABLE
AS $$
  WITH fips_to_abbr AS (
    SELECT * FROM (VALUES
      ('01','AL'),('02','AK'),('04','AZ'),('05','AR'),('06','CA'),('08','CO'),
      ('09','CT'),('10','DE'),('11','DC'),('12','FL'),('13','GA'),('15','HI'),
      ('16','ID'),('17','IL'),('18','IN'),('19','IA'),('20','KS'),('21','KY'),
      ('22','LA'),('23','ME'),('24','MD'),('25','MA'),('26','MI'),('27','MN'),
      ('28','MS'),('29','MO'),('30','MT'),('31','NE'),('32','NV'),('33','NH'),
      ('34','NJ'),('35','NM'),('36','NY'),('37','NC'),('38','ND'),('39','OH'),
      ('40','OK'),('41','OR'),('42','PA'),('44','RI'),('45','SC'),('46','SD'),
      ('47','TN'),('48','TX'),('49','UT'),('50','VT'),('51','VA'),('53','WA'),
      ('54','WV'),('55','WI'),('56','WY'),('60','AS'),('66','GU'),('69','MP'),
      ('72','PR'),('78','VI')
    ) AS t(fips, abbr)
  ),
  contained AS (
    -- Primary rule: interior-point containment. A precinct belongs to
    -- exactly one us_congressional district, so this is deterministic --
    -- no largest-overlap tiebreak needed for the normal case.
    SELECT pd.state_fips, pd.district_number
      FROM precincts p
      JOIN political_districts pd
        ON pd.district_type = 'us_congressional'
       AND pd.state_fips IS NOT NULL
       AND ST_Contains(pd.geom, ST_PointOnSurface(p.geom))
     WHERE p.id = p_precinct_id
  ),
  overlap_fallback AS (
    -- Documented fallback: only reached when the precinct interior
    -- rep-point (ST_PointOnSurface) is not contained in ANY us_congressional
    -- polygon (a gap/sliver at a boundary). Picks the largest-overlap
    -- district -- the pre-fix behavior, now scoped to just this edge case.
    SELECT pd.state_fips, pd.district_number
      FROM precincts p
      JOIN political_districts pd
        ON pd.district_type = 'us_congressional'
       AND pd.state_fips IS NOT NULL
       AND ST_Intersects(p.geom, pd.geom)
     WHERE p.id = p_precinct_id
       AND NOT EXISTS (SELECT 1 FROM contained)
     ORDER BY ST_Area(ST_Intersection(p.geom, pd.geom)) DESC
     LIMIT 1
  ),
  resolved AS (
    SELECT * FROM contained
    UNION ALL
    SELECT * FROM overlap_fallback
  )
  SELECT f.abbr AS state, r.district_number AS congressional_district
    FROM resolved r
    JOIN fips_to_abbr f ON f.fips = r.state_fips
   LIMIT 1;
$$;

COMMENT ON FUNCTION public.resolve_user_state_district(UUID) IS
  'Returns (state 2-letter abbr, congressional_district number) for a precinct. '
  'Used by ballot-lookup actions + backfill script to populate users.state + '
  'users.congressional_district for participation-rank queries. Interior-point '
  'containment (ST_Contains + ST_PointOnSurface) is the primary rule; falls back '
  'to largest-overlap ST_Intersects only when the rep-point matches no district '
  '(2026-07-11 durability fix, see 20260711120000_precinct_district_containment.sql).';
