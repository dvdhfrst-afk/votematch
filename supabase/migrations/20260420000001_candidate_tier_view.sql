-- Candidate tier view — Phase A source-floor enforcement.
--
-- See 15-council/decisions/002-source-floor-enforcement-blocks-phase-a.md
-- and 12-positioning-engine/00-requirements.md § Coverage floors.
--
-- Thresholds (MVP):
--   Tier A : >=20 sources AND >=3 source types
--   Tier B : >=10 sources AND >=2 source types
--   Tier C : below Tier B
--
-- Exclusions:
--   Rows flagged shared_race_coverage=true are excluded from source counts
--   and source_type counts. Those rows are generic race-overview articles
--   that got sprayed across every candidate in the race; they add no
--   candidate-specific signal, so they don't count toward the floor.
--
-- Consumers:
--   - candidate profile UI (Tier C stubs instead of position cards)
--   - /methodology Phase A Coverage section
--   - scripts/report-candidate-tiers.ts audit
--
-- Public read the view (no PII — aggregates only).

CREATE OR REPLACE VIEW candidate_tier_view AS
WITH source_rollup AS (
  SELECT
    cs.candidate_id,
    COUNT(*) AS source_count,
    COUNT(DISTINCT cs.source_type) AS source_type_count
  FROM candidate_sources cs
  WHERE cs.shared_race_coverage = false
  GROUP BY cs.candidate_id
),
position_rollup AS (
  -- Only count the latest position per (candidate, sub_dim, view_type) so
  -- historical re-classifications don't inflate the high-confidence count.
  SELECT
    candidate_id,
    COUNT(*) FILTER (
      WHERE confidence = 'high'
    ) AS high_conf_position_count,
    -- True when every classified position came from stated-only sources
    -- (candidate's own words). If there are no positions at all, false —
    -- "has_stated_positions_only" is meaningless when the set is empty.
    CASE
      WHEN COUNT(*) = 0 THEN false
      ELSE bool_and(view_type = 'stated')
    END AS has_stated_positions_only
  FROM (
    SELECT DISTINCT ON (candidate_id, sub_dimension_id, view_type)
      candidate_id, sub_dimension_id, view_type, confidence
    FROM positions
    ORDER BY candidate_id, sub_dimension_id, view_type, created_at DESC
  ) latest
  GROUP BY candidate_id
)
SELECT
  c.id AS candidate_id,
  COALESCE(sr.source_count, 0) AS source_count,
  COALESCE(sr.source_type_count, 0) AS source_type_count,
  CASE
    WHEN COALESCE(sr.source_count, 0) >= 20
     AND COALESCE(sr.source_type_count, 0) >= 3 THEN 'A'
    WHEN COALESCE(sr.source_count, 0) >= 10
     AND COALESCE(sr.source_type_count, 0) >= 2 THEN 'B'
    ELSE 'C'
  END AS tier,
  COALESCE(pr.high_conf_position_count, 0) AS high_conf_position_count,
  COALESCE(pr.has_stated_positions_only, false) AS has_stated_positions_only
FROM candidates c
LEFT JOIN source_rollup sr ON sr.candidate_id = c.id
LEFT JOIN position_rollup pr ON pr.candidate_id = c.id;

GRANT SELECT ON candidate_tier_view TO anon, authenticated;

COMMENT ON VIEW candidate_tier_view IS
  'Per-candidate Phase-A source-floor audit. Tier A=>=20/>=3, B=>=10/>=2, else C. '
  'Excludes candidate_sources.shared_race_coverage=true from the counts. '
  'See 15-council/decisions/002-source-floor-enforcement-blocks-phase-a.md.';
