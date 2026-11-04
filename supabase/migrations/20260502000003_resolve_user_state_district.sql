-- Helper RPC for the participation-rank snapshot.
--
-- Resolves a precinct → (state 2-letter abbr, congressional_district number)
-- via spatial intersection with political_districts.
--
-- Used by:
--   * lookupBallotAction (one call per ballot lookup)
--   * scripts/backfill-user-state-district.ts (one call per legacy user row)
--
-- Format choices, matching the existing surface area:
--   * `state` is the 2-letter abbreviation (e.g. "UT", "NY"). The retention
--     `subscribers.state` column already stores 2-letter codes; the
--     participation-rank queries in `invite-actions.ts` group by this column
--     for display, so 2-letter is the right shape.
--   * `congressional_district` is the bare district number ("1", "2", "AL",
--     ...) as TEXT — matches `political_districts.district_number` shape.
--     ("AL" is the post office abbreviation for at-large districts in
--     single-CD states; we round-trip whatever the loader stored.)
--
-- The function is STABLE (read-only) and takes a precinct UUID. It joins
-- precincts → political_districts via ST_Intersects and pulls the first
-- us_congressional district whose state_fips is non-null. The function
-- returns NULL fields if the precinct doesn't intersect any
-- us_congressional district (e.g. coverage gap), so callers can safely
-- skip the UPDATE without surfacing an error.

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
  )
  SELECT
    f.abbr AS state,
    pd.district_number AS congressional_district
  FROM precincts p
  JOIN political_districts pd
    ON pd.district_type = 'us_congressional'
   AND pd.state_fips IS NOT NULL
   AND ST_Intersects(p.geom, pd.geom)
  JOIN fips_to_abbr f ON f.fips = pd.state_fips
  WHERE p.id = p_precinct_id
  ORDER BY ST_Area(ST_Intersection(p.geom, pd.geom)) DESC
  LIMIT 1;
$$;

COMMENT ON FUNCTION public.resolve_user_state_district(UUID) IS
  'Returns (state 2-letter abbr, congressional_district number) for a precinct. '
  'Used by ballot-lookup actions + backfill script to populate users.state + '
  'users.congressional_district for participation-rank queries. Picks the largest-'
  'overlap us_congressional district when a precinct straddles a boundary.';
