-- Multivariable axis registry (doc 09 Part 4.1), 2026-06-14.
--
-- Turns each issue from a single scalar into a small subspace of calibrated
-- scalar axes: the issue's primary directional axis (the existing sub_dimension),
-- plus shared BACKBONE axes (B1 role, B2 level, B3 funding, B5 enforcement),
-- plus issue-specific PROPOSITION axes. Weighted L1 (Manhattan) is unchanged;
-- the vector just gets longer and is keyed by a composite axis_uid.
--
-- Design constraints:
--   - Additive only. positions.score / .confidence / .view_type are untouched,
--     so the live matcher and the 444 legacy rows keep working.
--   - An axis a candidate never addressed is simply not written as a positions
--     row; the engine drops absent axes (same effect as a null score), so we do
--     NOT need to relax positions.score NOT NULL for the abstains_governing case.
--   - Red-team C1: the axis view is a fresh DISTINCT ON over positions that
--     INCLUDES the axis columns in its key. It must NOT wrap v_latest_positions
--     (whose axis-blind DISTINCT ON would collapse an issue's axes to one row).
--   - Red-team M1: the overlap floor stays per-ISSUE; see matcher code, not here.

-- ── PROPOSITIONS (issue-specific extension axes) ───────────────────────────

CREATE TABLE IF NOT EXISTS propositions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                TEXT UNIQUE NOT NULL,
  sub_dimension_id    UUID NOT NULL REFERENCES sub_dimensions(id) ON DELETE CASCADE,
  display_label       TEXT NOT NULL,
  spectrum_low        TEXT NOT NULL,
  spectrum_high       TEXT NOT NULL,
  rubric_anchors      JSONB,                 -- 07 section 2.5 anchored-band template + per-prop cutoffs
  calibration_version TEXT NOT NULL DEFAULT 'rubric-v1',
  activation_phase    TEXT NOT NULL DEFAULT 'A',
  active              BOOLEAN NOT NULL DEFAULT FALSE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE propositions IS
  'Issue-specific extension axes (doc 09 Part 1.4). One calibrated 0-1 scalar per proposition, scored by the 07 rubric. Belongs to exactly one sub_dimension (the issue).';
CREATE INDEX IF NOT EXISTS idx_propositions_sub_dimension ON propositions (sub_dimension_id);
CREATE INDEX IF NOT EXISTS idx_propositions_active ON propositions (active) WHERE active;

-- ── BACKBONE AXES (shared, scored per issue) ───────────────────────────────

CREATE TABLE IF NOT EXISTS backbone_axes (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code                TEXT UNIQUE NOT NULL,  -- 'B1','B2','B3','B5'
  display_label       TEXT NOT NULL,
  pole_low            TEXT NOT NULL,         -- symmetric pole naming (doc 09 Part 1.2 test 3)
  pole_high           TEXT NOT NULL,
  rubric_anchors      JSONB,                 -- generic anchors; per-issue specialization lives on the activation row
  calibration_version TEXT NOT NULL DEFAULT 'rubric-v1',
  active              BOOLEAN NOT NULL DEFAULT TRUE
);
COMMENT ON TABLE backbone_axes IS
  'The fixed backbone B1/B2/B3/B5 (doc 09 Part 1.3). B4 (pace) and B6 (individual-vs-collective) were demoted to per-issue extension axes after the red-team and are NOT seeded here.';

-- ── PER-ISSUE BACKBONE ACTIVATION (the hybrid: shared defs, per-issue on/off) ─

CREATE TABLE IF NOT EXISTS issue_backbone_activation (
  sub_dimension_id  UUID NOT NULL REFERENCES sub_dimensions(id) ON DELETE CASCADE,
  backbone_axis_id  UUID NOT NULL REFERENCES backbone_axes(id) ON DELETE CASCADE,
  mode              TEXT NOT NULL DEFAULT 'matching'
                      CHECK (mode IN ('matching','informational','not_applicable')),
  anchor_overrides  JSONB,                 -- optional issue-specialized anchors for this backbone axis
  collinearity_with_primary NUMERIC(4,3),  -- filled by the collinearity gate (doc 09 1.3.1); >0.8 => demote
  PRIMARY KEY (sub_dimension_id, backbone_axis_id)
);
COMMENT ON COLUMN issue_backbone_activation.collinearity_with_primary IS
  'Cross-candidate correlation of this backbone axis against the issue primary (doc 09 1.3.1). An axis above the gate threshold is set mode=not_applicable for this issue.';

-- ── POSITIONS: generalize the axis key (additive) ──────────────────────────

ALTER TABLE positions
  ADD COLUMN IF NOT EXISTS axis_kind TEXT NOT NULL DEFAULT 'sub_dimension'
    CHECK (axis_kind IN ('sub_dimension','backbone','proposition')),
  ADD COLUMN IF NOT EXISTS axis_id UUID;  -- backbone_axes.id or propositions.id; NULL = the primary sub_dimension axis

-- Intensity/strength metadata the fusion produces (doc 07 section 2.7). Doc 07's
-- own migration has not shipped, and the axis scorer (score-axes.ts) writes these
-- columns, so they are added here. Additive + IF NOT EXISTS, so it is idempotent
-- and harmless if a later 07 migration re-adds them. position_strength is NOT
-- added (07 deferred it; fusion stores it in the interpretations audit value).
ALTER TABLE positions
  ADD COLUMN IF NOT EXISTS position_kind TEXT NOT NULL DEFAULT 'graded'
    CHECK (position_kind IN ('graded','balanced','abstains_governing')),
  ADD COLUMN IF NOT EXISTS intensity_band TEXT
    CHECK (intensity_band IS NULL OR intensity_band IN ('neutral','lean','support','strong')),
  ADD COLUMN IF NOT EXISTS signal_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS signal_concordance NUMERIC(4,3)
    CHECK (signal_concordance IS NULL OR signal_concordance BETWEEN 0 AND 1),
  ADD COLUMN IF NOT EXISTS may_be_outdated BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS calibration_version TEXT;

COMMENT ON COLUMN positions.axis_kind IS
  'Which axis of the issue this row scores: sub_dimension (the primary), backbone, or proposition. sub_dimension_id always carries the issue context (doc 09 Part 4.1).';
COMMENT ON COLUMN positions.axis_id IS
  'backbone_axes.id or propositions.id. NULL means the primary sub_dimension axis (axis_kind=sub_dimension).';
-- Existing rows take the DEFAULT 'sub_dimension' / NULL automatically: they remain the primary axis.

CREATE INDEX IF NOT EXISTS idx_positions_axis
  ON positions (candidate_id, sub_dimension_id, view_type, axis_kind, axis_id);

-- ── AXIS-AWARE VIEWS (red-team C1: fresh DISTINCT ON over positions) ────────

CREATE OR REPLACE VIEW v_axis_positions AS
  SELECT DISTINCT ON (candidate_id, sub_dimension_id, view_type, axis_kind, axis_id)
         id, candidate_id, sub_dimension_id, axis_kind, axis_id, view_type,
         score, confidence, source_citations, nuance_notes, created_at,
         sub_dimension_id::text || ':' || axis_kind || ':' || COALESCE(axis_id::text, 'primary') AS axis_uid
  FROM positions
  ORDER BY candidate_id, sub_dimension_id, view_type, axis_kind, axis_id, created_at DESC;
COMMENT ON VIEW v_axis_positions IS
  'Latest position per (candidate, issue, view, AXIS). Replaces v_latest_positions for multivariable scoring; v_latest_positions stays for legacy single-axis reads.';

CREATE OR REPLACE VIEW v_axis_position_gap AS
  SELECT s.candidate_id, s.sub_dimension_id, s.axis_kind, s.axis_id, s.axis_uid,
         s.score AS stated_score, i.score AS inferred_score,
         abs(s.score - i.score) AS gap
  FROM v_axis_positions s
  JOIN v_axis_positions i
    USING (candidate_id, sub_dimension_id, axis_kind, axis_id)
  WHERE s.view_type = 'stated' AND i.view_type = 'inferred';
COMMENT ON VIEW v_axis_position_gap IS
  'Axis-aware stated-vs-inferred gap (doc 09 Part 4.1). The journalism "says X / record shows Y" signal, per axis instead of per issue.';

-- ── RLS: voter-facing taxonomy is public-read, service-role writes ─────────

ALTER TABLE propositions ENABLE ROW LEVEL SECURITY;
ALTER TABLE backbone_axes ENABLE ROW LEVEL SECURITY;
ALTER TABLE issue_backbone_activation ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS propositions_public_read ON propositions;
CREATE POLICY propositions_public_read ON propositions FOR SELECT USING (true);
DROP POLICY IF EXISTS backbone_axes_public_read ON backbone_axes;
CREATE POLICY backbone_axes_public_read ON backbone_axes FOR SELECT USING (true);
DROP POLICY IF EXISTS issue_backbone_activation_public_read ON issue_backbone_activation;
CREATE POLICY issue_backbone_activation_public_read ON issue_backbone_activation FOR SELECT USING (true);
-- No INSERT/UPDATE/DELETE policies: writes are service-role only (service role bypasses RLS).
