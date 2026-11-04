-- ============================================================
-- 20260524000100_office_type_state_overrides.sql
--
-- Tier-2 of the office-relevance hierarchy the operator asked for:
--
--   1. offices.relevant_dimensions       (per-seat; ~1% coverage today)
--   2. office_type_state_overrides[NEW]  (per office_type × state)
--   3. office_types.relevant_dimensions  (national baseline; now 100% covered)
--
-- Rationale: "Mayor of NYC" and "Mayor of a small Utah city" share an office_type
-- but have wildly different scope under their state laws + city charters.
-- Per-seat research (455K offices) is too expensive; office_type alone is too
-- coarse. (office_type × state) is the sweet spot — ~50 states × ~10 types
-- with meaningful state-level variance = 200-500 overrides, manageable for
-- LLM-assisted research with human review.
--
-- City-class overrides (strong-mayor vs council-manager, NYC-class vs
-- mid-size, etc.) are a future tier-2.5 — design omitted for now.
-- ============================================================

CREATE TABLE IF NOT EXISTS office_type_state_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  office_type_id UUID NOT NULL REFERENCES office_types(id) ON DELETE CASCADE,
  fips_state CHAR(2) NOT NULL,
  relevant_dimensions TEXT[] NOT NULL DEFAULT '{}',

  -- Editorial provenance (so future migrations + audits can trace decisions)
  source TEXT NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual', 'llm_research', 'editorial', 'imported')),
  source_notes TEXT,
  data_source_id UUID REFERENCES data_sources(id) ON DELETE SET NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by_role TEXT DEFAULT 'admin',

  UNIQUE (office_type_id, fips_state)
);

CREATE INDEX IF NOT EXISTS idx_office_type_state_overrides_lookup
  ON office_type_state_overrides (office_type_id, fips_state);

-- updated_at trigger (use existing pattern if there's a shared helper, else inline)
CREATE OR REPLACE FUNCTION set_office_type_state_overrides_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS office_type_state_overrides_set_updated_at ON office_type_state_overrides;
CREATE TRIGGER office_type_state_overrides_set_updated_at
  BEFORE UPDATE ON office_type_state_overrides
  FOR EACH ROW
  EXECUTE FUNCTION set_office_type_state_overrides_updated_at();

COMMENT ON TABLE office_type_state_overrides IS
  'Tier-2 of the per-office relevance hierarchy: state-specific overrides for an office_type. Resolution: offices.relevant_dimensions > office_type_state_overrides > office_types.relevant_dimensions. Populated by per-state research (see app/scripts/research/ tier-2 backfill).';

COMMENT ON COLUMN office_type_state_overrides.fips_state IS
  '2-character FIPS state code matching jurisdictions.fips_state.';
COMMENT ON COLUMN office_type_state_overrides.relevant_dimensions IS
  'sub_dimensions.name[] — array of dim names this office_type cares about in this state. Empty array = explicit "no scope variance from baseline" (which is different from NULL/missing row = "no state-specific override").';
