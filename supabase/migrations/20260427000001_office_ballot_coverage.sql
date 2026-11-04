-- ============================================================
-- Office ballot coverage + freshness columns + views
-- ============================================================
--
-- Council punch-list P0-1, P1-7, P2-14.
--
-- Goal: make "is this office on a 2026 ballot, do we have candidates,
-- when was it last verified, and what's the realistic sourcing tier"
-- first-class queryable state on the offices spine — not derived
-- from joins every time, and not silently invented.
--
-- Changes:
--   1. offices.last_verified_at        — adapter heartbeat per office
--   2. offices.last_candidate_check_at — last time any adapter looked
--                                        for candidates for this office
--   3. offices.candidate_count_cached  — nightly-refreshed count of
--                                        active candidacies in the
--                                        next election for this office
--   4. offices.sourcing_tier           — 'sos_state' | 'sos_county' |
--                                        'fec_federal' | 'filing_direct' |
--                                        'unsourced' — the realistic source
--                                        tier for *enrolling candidates*
--                                        for this office. Special
--                                        districts get 'unsourced' or
--                                        'filing_direct' so the launch
--                                        denominator does not silently
--                                        pretend they are coverable.
--
--   5. v_offices_on_ballot_2026        — derived view: offices that have
--                                        ≥1 election with a 2026 election_date
--   6. v_offices_coverage              — per-office coverage summary:
--                                        candidate count, freshness,
--                                        sourcing tier, on-ballot flag
--   7. v_coverage_dashboard_2026       — denominator + numerator by
--                                        (level, fips_state) for the
--                                        public coverage dashboard
--
-- Backfill:
--   - sourcing_tier seeded by office level (federal=fec_federal,
--     state=sos_state, county=sos_county, municipal=filing_direct,
--     school=filing_direct, special=unsourced, judicial=sos_state)
--   - last_verified_at left NULL on existing rows; adapters will
--     populate as they run. last_verified_at IS NULL means "never"
--     in dashboards.
-- ============================================================

ALTER TABLE offices
  ADD COLUMN IF NOT EXISTS last_verified_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_candidate_check_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS candidate_count_cached  INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sourcing_tier           TEXT;

ALTER TABLE offices
  ADD CONSTRAINT offices_sourcing_tier_check
  CHECK (sourcing_tier IS NULL OR sourcing_tier IN (
    'fec_federal',
    'sos_state',
    'sos_county',
    'filing_direct',
    'unsourced'
  ));

COMMENT ON COLUMN offices.last_verified_at IS
  'Most recent adapter heartbeat that confirmed this office row is still valid '
  '(district unchanged, seat still elected, etc.). NULL = never verified. '
  'Surfaced in voter UI as "last verified MM/DD" so missing data reads as integrity, not bug.';

COMMENT ON COLUMN offices.last_candidate_check_at IS
  'Most recent run of any candidate-enrollment adapter that *looked* for candidates '
  'for this office (regardless of whether any were found). Used by the staleness '
  'scanner to detect offices we have not even tried to populate.';

COMMENT ON COLUMN offices.candidate_count_cached IS
  'Cached count of active candidacies in the next upcoming election for this office. '
  'Refreshed nightly by a cron; may lag by up to 24h. Use COUNT(*) on candidacies '
  'directly when freshness matters more than performance.';

COMMENT ON COLUMN offices.sourcing_tier IS
  'Realistic candidate-enrollment source tier for this office. '
  'fec_federal: federal candidates filed with FEC. '
  'sos_state: state-level seats filed with the SoS (we have 50 SoS adapters). '
  'sos_county: county-level seats filed with the SoS in some states. '
  'filing_direct: only available from a direct municipal/county clerk filing — '
  'requires per-jurisdiction adapter work. '
  'unsourced: no nationally-comprehensive license-safe feed exists '
  '(most special districts). Counted out of the launch denominator.';

CREATE INDEX IF NOT EXISTS idx_offices_sourcing_tier
  ON offices (sourcing_tier);

CREATE INDEX IF NOT EXISTS idx_offices_last_verified_at
  ON offices (last_verified_at);

-- ------------------------------------------------------------
-- Backfill sourcing_tier from level + jurisdiction type
-- ------------------------------------------------------------

UPDATE offices o SET sourcing_tier = CASE
  WHEN o.level = 'federal'   THEN 'fec_federal'
  WHEN o.level = 'state'     THEN 'sos_state'
  WHEN o.level = 'judicial'  THEN 'sos_state'
  WHEN o.level = 'county'    THEN 'sos_county'
  WHEN o.level = 'municipal' THEN 'filing_direct'
  WHEN o.level = 'school'    THEN 'filing_direct'
  WHEN o.level = 'special'   THEN 'unsourced'
  ELSE 'unsourced'
END
WHERE sourcing_tier IS NULL;

-- ------------------------------------------------------------
-- v_offices_on_ballot_2026 — derived from elections (not denormalized)
-- ------------------------------------------------------------

CREATE OR REPLACE VIEW public.v_offices_on_ballot_2026 AS
SELECT DISTINCT
  o.id              AS office_id,
  o.canonical_name,
  o.level,
  o.sourcing_tier,
  j.fips_state,
  j.name            AS jurisdiction_name,
  ot.slug           AS office_type_slug,
  o.last_verified_at,
  o.candidate_count_cached
FROM offices o
JOIN office_types ot   ON ot.id = o.office_type_id
JOIN jurisdictions j   ON j.id  = o.jurisdiction_id
JOIN elections e       ON e.office_id = o.id
WHERE e.election_date >= '2026-01-01'
  AND e.election_date <  '2027-01-01'
  AND o.is_active = TRUE;

COMMENT ON VIEW public.v_offices_on_ballot_2026 IS
  'Offices with at least one election scheduled in 2026. The launch denominator. '
  'Excludes offices whose next election is off-cycle. Use for coverage dashboards '
  'and the "every office × all candidates" DoD query.';

-- ------------------------------------------------------------
-- v_offices_coverage — per-office coverage summary
-- ------------------------------------------------------------

CREATE OR REPLACE VIEW public.v_offices_coverage AS
SELECT
  o.id                              AS office_id,
  o.canonical_name,
  o.level,
  o.sourcing_tier,
  o.last_verified_at,
  o.last_candidate_check_at,
  j.fips_state,
  ot.slug                           AS office_type_slug,
  EXISTS (
    SELECT 1 FROM elections e
    WHERE e.office_id = o.id
      AND e.election_date >= '2026-01-01'
      AND e.election_date <  '2027-01-01'
  )                                 AS on_ballot_2026,
  (
    SELECT count(*) FROM candidacies c
    JOIN elections e ON e.id = c.election_id
    WHERE e.office_id = o.id
      AND e.election_date >= '2026-01-01'
      AND e.election_date <  '2027-01-01'
      AND c.status NOT IN ('withdrew','disqualified','lost_primary','lost_general')
  )                                 AS candidate_count_2026,
  o.candidate_count_cached,
  CASE
    WHEN o.last_verified_at IS NULL THEN 'never_verified'
    WHEN o.last_verified_at < now() - INTERVAL '30 days' THEN 'stale'
    WHEN o.last_verified_at < now() - INTERVAL '7 days'  THEN 'aging'
    ELSE 'fresh'
  END                               AS freshness_status
FROM offices o
JOIN office_types  ot ON ot.id = o.office_type_id
JOIN jurisdictions j  ON j.id  = o.jurisdiction_id
WHERE o.is_active = TRUE;

COMMENT ON VIEW public.v_offices_coverage IS
  'One row per active office with on_ballot_2026 flag, current candidate count, '
  'cached count, sourcing tier, freshness status. Source-of-truth for the public '
  'coverage dashboard.';

-- ------------------------------------------------------------
-- v_coverage_dashboard_2026 — top-level metrics
-- ------------------------------------------------------------

CREATE OR REPLACE VIEW public.v_coverage_dashboard_2026 AS
SELECT
  level,
  fips_state,
  sourcing_tier,
  count(*)                                                     AS offices_total,
  count(*) FILTER (WHERE on_ballot_2026)                       AS offices_on_ballot,
  count(*) FILTER (WHERE on_ballot_2026 AND candidate_count_2026 >= 1)
                                                               AS offices_with_candidates,
  count(*) FILTER (WHERE on_ballot_2026 AND candidate_count_2026 = 0)
                                                               AS offices_missing_candidates,
  round(
    100.0 * count(*) FILTER (WHERE on_ballot_2026 AND candidate_count_2026 >= 1)
    / NULLIF(count(*) FILTER (WHERE on_ballot_2026), 0)
  , 1)                                                          AS pct_covered,
  count(*) FILTER (WHERE on_ballot_2026 AND freshness_status = 'fresh')
                                                                AS offices_fresh,
  count(*) FILTER (WHERE on_ballot_2026 AND freshness_status IN ('stale','never_verified'))
                                                                AS offices_stale_or_never
FROM public.v_offices_coverage
GROUP BY level, fips_state, sourcing_tier
ORDER BY level, fips_state, sourcing_tier;

COMMENT ON VIEW public.v_coverage_dashboard_2026 IS
  'Coverage rollup by (level, state, sourcing_tier). The denominator is offices '
  'on a 2026 ballot — NOT all 452K offices. Special-district / unsourced offices '
  'show up as their own tier so the dashboard tells the truth about what we can '
  'realistically populate.';

-- ------------------------------------------------------------
-- Refresh function for candidate_count_cached
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION refresh_office_candidate_counts()
RETURNS INT
LANGUAGE plpgsql AS $$
DECLARE
  affected INT;
BEGIN
  WITH counts AS (
    SELECT
      e.office_id,
      count(*) FILTER (
        WHERE c.status NOT IN ('withdrew','disqualified','lost_primary','lost_general')
      ) AS active_count
    FROM candidacies c
    JOIN elections e ON e.id = c.election_id
    WHERE e.election_date >= '2026-01-01'
      AND e.election_date <  '2027-01-01'
    GROUP BY e.office_id
  ),
  updated AS (
    UPDATE offices o
       SET candidate_count_cached = COALESCE(counts.active_count, 0)
      FROM counts
     WHERE o.id = counts.office_id
       AND o.candidate_count_cached IS DISTINCT FROM COALESCE(counts.active_count, 0)
    RETURNING o.id
  )
  SELECT count(*) INTO affected FROM updated;
  RETURN affected;
END;
$$;

COMMENT ON FUNCTION refresh_office_candidate_counts() IS
  'Recompute offices.candidate_count_cached from current candidacies × 2026 elections. '
  'Returns the number of rows whose count changed. Run nightly via Inngest.';

-- Migration registration is handled automatically by the Supabase CLI
-- when running `supabase migration up`; no manual INSERT needed here.

