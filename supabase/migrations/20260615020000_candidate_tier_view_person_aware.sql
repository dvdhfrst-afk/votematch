-- ============================================================
-- candidate_tier_view -> person-aware (additive redefinition)
-- ============================================================
--
-- Problem this fixes (verified, June 2026):
--   candidate_tier_view (20260420000001) computed a candidate's source
--   count / source-type count ONLY from candidate_sources keyed by
--   candidate_id, and joined FROM the legacy `candidates` table. A
--   new-graph candidacy (a person with NO legacy candidate_id) therefore
--   had ZERO rows in the view, so the candidate page's tier lookup missed
--   and the page fell back to the hard-coded Tier C default. That forced
--   genuinely well-sourced new-graph candidates (people who DO have
--   raw_evidence / candidate_sources rows keyed by person_id) into the
--   Tier C "we don't have enough sources" stub purely because of a
--   legacy-id miss, NOT because their sourcing was actually thin.
--
-- Fix:
--   Compute each candidate's source / source-type / position counts from
--   the UNION of:
--     - candidate_sources keyed by candidate_id (legacy rows), AND
--     - candidate_sources keyed by person_id    (new-graph rows;
--       candidate_sources.person_id added in 20260603130000),
--   and emit BOTH a candidate_id AND a person_id on each view row so the
--   candidate page can look the tier up by EITHER identity.
--
-- THRESHOLDS ARE UNCHANGED. Tier A = >=20 sources AND >=3 types,
--   Tier B = >=10 sources AND >=2 types, else Tier C. The shared_race_coverage
--   exclusion is preserved verbatim. The ONLY change is the IDENTITY KEYING:
--   we count a candidate's sources under both of its identities instead of
--   only its legacy candidate_id. A genuinely thin candidate (few sources
--   under either identity) still resolves to Tier C.
--
-- Identity model of the output rows:
--   - One row per legacy candidate (candidate_id non-null, person_id from
--     people.legacy_candidate_ids reverse-lookup when one exists).
--   - One row per new-graph person that has NO legacy candidate id
--     (candidate_id NULL, person_id non-null). People that DO have a legacy
--     candidate id are represented by the legacy row above (no double count),
--     and that legacy row already aggregates the person-keyed sources via the
--     UNION below, so its tier reflects the full evidence set.
--
-- Additive + reversible: CREATE OR REPLACE VIEW only. No table changes, no
-- threshold changes, no consumer is forced to migrate (the candidate_id
-- column keeps the same name and meaning).
-- ============================================================

-- DROP + CREATE (not CREATE OR REPLACE): the new definition adds person_id as
-- a second column, and CREATE OR REPLACE cannot rename/reorder existing view
-- columns. Wrapped in the applier's transaction, so a dependency failure rolls
-- back cleanly. Re-GRANTed below.
DROP VIEW IF EXISTS candidate_tier_view;

CREATE VIEW candidate_tier_view AS
WITH
-- Map every person to a single legacy candidate id (the first / canonical
-- one), when they have one. Used to (a) attach person_id to legacy rows and
-- (b) decide which persons are "person-only" (no legacy id => own row).
person_legacy AS (
  SELECT
    p.id AS person_id,
    -- first legacy candidate id, NULL when the person has none
    (NULLIF(p.legacy_candidate_ids, '{}'::uuid[]))[1] AS legacy_candidate_id
  FROM people p
),
-- Unified per-candidate-identity source feed. Each candidate_sources row is
-- attributed to its candidate_id (legacy key) AND, independently, to its
-- person_id (new-graph key). The two arms are UNIONed so a candidate is
-- counted under whichever identity its source rows carry. DISTINCT on the
-- source row id within each identity bucket prevents a row that carries BOTH
-- a candidate_id and a person_id pointing at the SAME human from inflating
-- that human's count when we later resolve to one identity.
--
-- shared_race_coverage exclusion preserved verbatim from 20260420000001.
sources_by_identity AS (
  -- Legacy identity: sources keyed by candidate_id.
  SELECT
    cs.candidate_id   AS candidate_id,
    NULL::uuid        AS person_id,
    cs.id             AS source_id,
    cs.source_type    AS source_type
  FROM candidate_sources cs
  WHERE cs.shared_race_coverage = false
    AND cs.candidate_id IS NOT NULL
  UNION
  -- New-graph identity: sources keyed by person_id.
  SELECT
    NULL::uuid        AS candidate_id,
    cs.person_id      AS person_id,
    cs.id             AS source_id,
    cs.source_type    AS source_type
  FROM candidate_sources cs
  WHERE cs.shared_race_coverage = false
    AND cs.person_id IS NOT NULL
),
-- Latest position per (identity, sub_dim, view_type), counted under BOTH
-- the candidate_id and person_id the positions row carries. Mirrors the
-- original DISTINCT ON dedupe; just adds the person_id arm.
positions_by_identity AS (
  SELECT candidate_id AS candidate_id, NULL::uuid AS person_id,
         sub_dimension_id, view_type, confidence, created_at, id
  FROM positions
  WHERE candidate_id IS NOT NULL
  UNION
  SELECT NULL::uuid AS candidate_id, person_id AS person_id,
         sub_dimension_id, view_type, confidence, created_at, id
  FROM positions
  WHERE person_id IS NOT NULL
),

-- Roll up sources for the LEGACY identity (by candidate_id), folding in any
-- person-keyed sources for the SAME human via people.legacy_candidate_ids.
legacy_source_rollup AS (
  SELECT
    cand.candidate_id,
    COUNT(DISTINCT s.source_id)               AS source_count,
    COUNT(DISTINCT s.source_type)             AS source_type_count
  FROM (SELECT DISTINCT candidate_id FROM sources_by_identity WHERE candidate_id IS NOT NULL) cand
  -- the person (if any) bridged to this legacy candidate
  LEFT JOIN person_legacy pl ON pl.legacy_candidate_id = cand.candidate_id
  LEFT JOIN sources_by_identity s
    ON s.candidate_id = cand.candidate_id
    OR (pl.person_id IS NOT NULL AND s.person_id = pl.person_id)
  GROUP BY cand.candidate_id
),
legacy_position_rollup AS (
  SELECT
    cand.candidate_id,
    COUNT(*) FILTER (WHERE latest.confidence = 'high') AS high_conf_position_count,
    CASE WHEN COUNT(*) = 0 THEN false
         ELSE bool_and(latest.view_type = 'stated') END AS has_stated_positions_only
  FROM (SELECT DISTINCT candidate_id FROM positions_by_identity WHERE candidate_id IS NOT NULL) cand
  LEFT JOIN person_legacy pl ON pl.legacy_candidate_id = cand.candidate_id
  LEFT JOIN LATERAL (
    SELECT DISTINCT ON (sub_dimension_id, view_type)
      sub_dimension_id, view_type, confidence
    FROM positions_by_identity pbi
    WHERE pbi.candidate_id = cand.candidate_id
       OR (pl.person_id IS NOT NULL AND pbi.person_id = pl.person_id)
    ORDER BY sub_dimension_id, view_type, created_at DESC
  ) latest ON true
  GROUP BY cand.candidate_id
),

-- Roll up sources for PERSON-ONLY identities (persons with NO legacy
-- candidate id). These get their own view row keyed by person_id.
person_only AS (
  SELECT person_id FROM person_legacy WHERE legacy_candidate_id IS NULL
),
person_source_rollup AS (
  SELECT
    po.person_id,
    COUNT(DISTINCT s.source_id)   AS source_count,
    COUNT(DISTINCT s.source_type) AS source_type_count
  FROM person_only po
  LEFT JOIN sources_by_identity s ON s.person_id = po.person_id
  GROUP BY po.person_id
),
person_position_rollup AS (
  SELECT
    po.person_id,
    COUNT(*) FILTER (WHERE latest.confidence = 'high') AS high_conf_position_count,
    CASE WHEN COUNT(*) = 0 THEN false
         ELSE bool_and(latest.view_type = 'stated') END AS has_stated_positions_only
  FROM person_only po
  LEFT JOIN LATERAL (
    SELECT DISTINCT ON (sub_dimension_id, view_type)
      sub_dimension_id, view_type, confidence
    FROM positions_by_identity pbi
    WHERE pbi.person_id = po.person_id
    ORDER BY sub_dimension_id, view_type, created_at DESC
  ) latest ON true
  GROUP BY po.person_id
)

-- Arm 1: one row per LEGACY candidate (every row in `candidates`),
-- person_id attached when a person bridges to it.
SELECT
  c.id AS candidate_id,
  pl.person_id AS person_id,
  COALESCE(sr.source_count, 0)      AS source_count,
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
LEFT JOIN person_legacy pl ON pl.legacy_candidate_id = c.id
LEFT JOIN legacy_source_rollup sr ON sr.candidate_id = c.id
LEFT JOIN legacy_position_rollup pr ON pr.candidate_id = c.id

UNION ALL

-- Arm 2: one row per PERSON-ONLY identity (no legacy candidate id).
SELECT
  NULL::uuid AS candidate_id,
  po.person_id AS person_id,
  COALESCE(psr.source_count, 0)      AS source_count,
  COALESCE(psr.source_type_count, 0) AS source_type_count,
  CASE
    WHEN COALESCE(psr.source_count, 0) >= 20
     AND COALESCE(psr.source_type_count, 0) >= 3 THEN 'A'
    WHEN COALESCE(psr.source_count, 0) >= 10
     AND COALESCE(psr.source_type_count, 0) >= 2 THEN 'B'
    ELSE 'C'
  END AS tier,
  COALESCE(ppr.high_conf_position_count, 0) AS high_conf_position_count,
  COALESCE(ppr.has_stated_positions_only, false) AS has_stated_positions_only
FROM person_only po
LEFT JOIN person_source_rollup psr ON psr.person_id = po.person_id
LEFT JOIN person_position_rollup ppr ON ppr.person_id = po.person_id;

GRANT SELECT ON candidate_tier_view TO anon, authenticated;

COMMENT ON VIEW candidate_tier_view IS
  'Per-candidate Phase-A source-floor audit, person-aware (20260615020000). '
  'Tier A=>=20/>=3, B=>=10/>=2, else C (UNCHANGED). Counts candidate_sources '
  'under BOTH candidate_id (legacy) and person_id (new graph), so a new-graph '
  'candidacy is evaluated on its real sources instead of defaulting to Tier C '
  'on a legacy-id miss. Excludes candidate_sources.shared_race_coverage=true. '
  'Each row exposes candidate_id AND/OR person_id; look up by either identity. '
  'See 15-council/decisions/002-source-floor-enforcement-blocks-phase-a.md.';
