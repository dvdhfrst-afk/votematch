-- Track B: Two-view positioning (stated vs inferred) — Milestone 1.
--
-- See 12-positioning-engine/00-requirements.md for the full architectural rationale.
--
-- Core insight: voters are best served by seeing BOTH (a) what a candidate says their
-- own position is, from their campaign materials, AND (b) what their full record
-- (votes, media, advocacy ratings) suggests they actually believe. The gap between
-- the two views is itself the product feature.
--
-- Design principles (from council review, documented in 00-requirements.md):
--   1. Stated view is reproduction of the candidate's own words. Source set is
--      restricted to authenticity_tier=1 (primary sources only).
--   2. Inferred view is our analysis across all sources, weighted by authenticity.
--   3. Existing 444 positions are backfilled as 'inferred' — they were classified
--      against mixed-source aggregations, which semantically matches the inferred view.
--   4. We do NOT add a unique constraint on (candidate_id, sub_dim, view_type)
--      because the existing schema tolerates multiple rows per (candidate, sub_dim)
--      and queries via created_at DESC for the latest. Preserving that pattern here.
--   5. Every classification gets an extraction_audit_id for provenance (integrates
--      with the retention engine's extraction_audit table shipped in 20260418000002).
--
-- Migration cost: ~5 seconds on a 444-row table. Fully backward-compatible — code
-- that doesn't pass view_type gets 'inferred' by default.

-- ============================================================
-- 1. Add view_type + extraction_audit_id to positions
-- ============================================================

ALTER TABLE positions
  ADD COLUMN view_type TEXT NOT NULL DEFAULT 'inferred'
    CHECK (view_type IN ('stated', 'inferred')),
  ADD COLUMN extraction_audit_id UUID REFERENCES extraction_audit(id) ON DELETE SET NULL;

COMMENT ON COLUMN positions.view_type IS
  'stated = built from candidate''s own official materials only (website, questionnaire, op-eds). '
  'inferred = built from all sources (votes, media, social, debates, advocacy ratings). '
  'Matching engine defaults to inferred; UI shows both with gap analysis when both exist.';

COMMENT ON COLUMN positions.extraction_audit_id IS
  'FK to extraction_audit row that produced this classification. Enables per-score provenance inspection.';

-- Query index for the latest position per (candidate, sub_dim, view_type)
CREATE INDEX idx_positions_cand_subdim_view_created
  ON positions (candidate_id, sub_dimension_id, view_type, created_at DESC);

-- ============================================================
-- 2. Augment candidate_sources with authenticity + outlet metadata
-- ============================================================

-- authenticity_tier codifies who produced the content:
--   1 = primary source (candidate's own words: website, questionnaire, op-ed, speech transcript)
--   2 = reported with direct quote (journalism capturing candidate's verbatim statement)
--   3 = paraphrased / secondary (analysis, characterization, advocacy group rating)
--
-- stated-view classification filters to tier 1 ONLY.
-- inferred-view classification uses all tiers, weighted by authenticity.
ALTER TABLE candidate_sources
  ADD COLUMN authenticity_tier INT NOT NULL DEFAULT 3
    CHECK (authenticity_tier IN (1, 2, 3)),
  ADD COLUMN outlet_ideology TEXT
    CHECK (outlet_ideology IN ('left', 'center-left', 'center', 'center-right', 'right', 'primary')),
  ADD COLUMN published_at TIMESTAMPTZ,
  ADD COLUMN extraction_audit_id UUID REFERENCES extraction_audit(id) ON DELETE SET NULL;

COMMENT ON COLUMN candidate_sources.authenticity_tier IS
  '1=primary (candidate''s own words), 2=reported with direct quote, 3=paraphrased/secondary. '
  'Stated-view classifier uses tier=1 only; inferred-view uses all tiers with weighted blending.';

COMMENT ON COLUMN candidate_sources.outlet_ideology IS
  'left|center-left|center|center-right|right|primary. "primary" reserved for candidate-authored content. '
  'Used for ideological-balance auditing per candidate (admin-visible, not user-visible).';

-- Backfill authenticity based on existing source_type enum
UPDATE candidate_sources SET authenticity_tier = 1, outlet_ideology = 'primary'
  WHERE source_type IN ('campaign_website', 'questionnaire', 'state_profile');

UPDATE candidate_sources SET authenticity_tier = 2
  WHERE source_type IN ('news_article', 'extracted_positions');

UPDATE candidate_sources SET authenticity_tier = 3
  WHERE source_type IN ('voting_record', 'fec_financials');
  -- Rationale: voting records ARE primary but are interpreted (a vote is an action, not a stated
  -- position); classifier treats them as evidence-for-inferred rather than evidence-of-stated.

-- Fast lookup: stated-view source set per candidate
CREATE INDEX idx_candidate_sources_candidate_tier
  ON candidate_sources (candidate_id, authenticity_tier);

-- ============================================================
-- 3. Helper view: latest position per (candidate, sub_dim, view_type)
-- ============================================================

CREATE OR REPLACE VIEW v_latest_positions AS
SELECT DISTINCT ON (candidate_id, sub_dimension_id, view_type)
  id, candidate_id, sub_dimension_id, view_type, score, confidence,
  source_citations, nuance_notes, ai_summary, extraction_audit_id, created_at
FROM positions
ORDER BY candidate_id, sub_dimension_id, view_type, created_at DESC;

GRANT SELECT ON v_latest_positions TO anon, authenticated;

-- ============================================================
-- 4. Helper view: stated + inferred side-by-side per (candidate, sub_dim)
--    Includes the gap (abs difference) and a directional "agrees" flag.
-- ============================================================

CREATE OR REPLACE VIEW v_position_gap AS
WITH latest AS (
  SELECT DISTINCT ON (candidate_id, sub_dimension_id, view_type)
    candidate_id, sub_dimension_id, view_type, score, confidence, created_at
  FROM positions
  ORDER BY candidate_id, sub_dimension_id, view_type, created_at DESC
)
SELECT
  s.candidate_id,
  s.sub_dimension_id,
  s.score AS stated_score,
  s.confidence AS stated_confidence,
  i.score AS inferred_score,
  i.confidence AS inferred_confidence,
  CASE
    WHEN s.score IS NULL OR i.score IS NULL THEN NULL
    ELSE ABS(s.score - i.score)
  END AS gap,
  CASE
    WHEN s.score IS NULL OR i.score IS NULL THEN NULL
    WHEN ABS(s.score - i.score) <= 0.15 THEN true
    ELSE false
  END AS views_align,
  GREATEST(s.created_at, i.created_at) AS as_of
FROM (SELECT * FROM latest WHERE view_type = 'stated') s
FULL OUTER JOIN (SELECT * FROM latest WHERE view_type = 'inferred') i
  ON s.candidate_id = i.candidate_id AND s.sub_dimension_id = i.sub_dimension_id;

GRANT SELECT ON v_position_gap TO anon, authenticated;

COMMENT ON VIEW v_position_gap IS
  'Per-candidate-per-subdim side-by-side of stated and inferred scores with |gap| computed. '
  'gap > 0.25 is the accountability / product-journalism signal: candidate says X but record shows Y.';
