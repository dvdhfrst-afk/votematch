-- Track A: taxonomy versioning, scope applicability, and internationalization-ready schema.
--
-- Adds infrastructure for safely evolving the sub_dimensions taxonomy over time without
-- losing historical validity of past classifications. Prepares the schema for:
--   - Hybrid race-scope filtering (some dims count toward matching, others are informational)
--   - International expansion (country/region-scoped dims)
--   - Editorial salience tracking (distinct from user-chosen weights)
--
-- Design principles:
--   - MINOR changes (rewording, typo fixes, domain relocations) mutate sub_dimensions in
--     place and write a row to sub_dimension_versions as an audit trail. Existing positions
--     remain valid because the dim's identity (id) is unchanged.
--   - MAJOR changes (reversing spectrum direction, splitting a dim into two, removing a dim)
--     must create a NEW sub_dimension row and set active=false on the old one. Old positions
--     stay bound to the old row and remain historically valid. New classifications target
--     the new row. Matching UI hides inactive dims.
--   - Every change is auditable via sub_dimension_versions.
--
-- Counter-argument considered: "why not add a version_id FK on positions so every score
-- is bound to an exact spectrum definition?" Answer: major changes are handled by
-- deprecate-and-create (new id), which already pins positions to their spectrum. Minor
-- changes don't shift score meaning enough to invalidate existing scores. Adding a
-- version FK would complicate every query for zero practical benefit at the current scale.

-- ============================================================
-- 1. New columns on sub_dimensions
-- ============================================================

ALTER TABLE sub_dimensions
  -- Scope applicability: which race scopes this dim applies to, and in what mode.
  -- Values per key: "matching" | "informational" | "not_applicable"
  -- "matching"       → counts toward the voter-candidate match score
  -- "informational"  → shown on profile for context, excluded from matching
  -- "not_applicable" → hidden entirely for this scope
  ADD COLUMN scope_applicability JSONB NOT NULL DEFAULT
    '{"federal": "matching", "state": "matching", "county": "informational"}'::jsonb,

  -- Applicable regions: ISO country codes (US, DE, JP, ...) and sub-national codes (US-UT, ...).
  -- Empty array means universal. Lets us ship the same codebase internationally with
  -- country-specific sub-dims slotted in alongside universal ones.
  ADD COLUMN applicable_regions TEXT[] NOT NULL DEFAULT ARRAY['US']::TEXT[],

  -- Editorial salience: 0.0-1.0 weight representing current-cycle editorial judgment
  -- about how hot this issue is. Used (optionally) in the UI to surface "trending"
  -- issues. DISTINCT from user-chosen salience, which lives at the domain level on
  -- the user profile. Default 0.5 = neutral (no editorial weighting).
  ADD COLUMN editorial_salience NUMERIC NOT NULL DEFAULT 0.5
    CHECK (editorial_salience >= 0.0 AND editorial_salience <= 1.0),

  -- Rationale for editorial_salience != 0.5. Required by trigger below.
  ADD COLUMN salience_rationale TEXT;

-- ============================================================
-- 2. Validation constraints on scope_applicability
-- ============================================================

-- Keys must be known scope names; values must be known modes.
-- Update this function when new scopes are added (e.g., 'judicial', 'school_board', 'municipal').
CREATE OR REPLACE FUNCTION validate_scope_applicability(sa JSONB)
RETURNS BOOLEAN AS $$
DECLARE
  valid_scopes TEXT[] := ARRAY[
    'federal', 'state', 'county', 'municipal',
    'judicial', 'school_board', 'special_district'
  ];
  valid_modes TEXT[] := ARRAY['matching', 'informational', 'not_applicable'];
  k TEXT;
  v TEXT;
BEGIN
  FOR k, v IN SELECT key, value::TEXT FROM jsonb_each_text(sa) LOOP
    IF NOT (k = ANY(valid_scopes)) THEN
      RAISE EXCEPTION 'Invalid scope key: %', k;
    END IF;
    IF NOT (v = ANY(valid_modes)) THEN
      RAISE EXCEPTION 'Invalid scope mode for %: %', k, v;
    END IF;
  END LOOP;
  RETURN TRUE;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

ALTER TABLE sub_dimensions
  ADD CONSTRAINT scope_applicability_valid
    CHECK (validate_scope_applicability(scope_applicability));

-- ============================================================
-- 3. Append-only audit log
-- ============================================================

CREATE TABLE sub_dimension_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sub_dimension_id UUID NOT NULL REFERENCES sub_dimensions(id) ON DELETE CASCADE,
  -- Snapshot of fields that materially affect classification semantics.
  -- If any of these changed on this revision, we log them here.
  domain TEXT NOT NULL,
  name TEXT NOT NULL,
  spectrum_low TEXT NOT NULL,
  spectrum_high TEXT NOT NULL,
  scope_applicability JSONB NOT NULL,
  applicable_regions TEXT[] NOT NULL,
  editorial_salience NUMERIC NOT NULL,
  salience_rationale TEXT,
  active BOOLEAN NOT NULL,
  -- Metadata about the change
  change_reason TEXT, -- operator-supplied ("reworded after Q1 feedback", "split per research")
  changed_by_role TEXT, -- 'service_role' | 'editor' | 'migration' — whoever wrote to sub_dimensions
  revision_type TEXT NOT NULL CHECK (revision_type IN ('initial', 'minor_edit', 'deprecation', 'restoration')),
  effective_from TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_sub_dim_versions_dim_effective
  ON sub_dimension_versions (sub_dimension_id, effective_from DESC);

-- ============================================================
-- 4. Trigger: auto-append version rows on INSERT/UPDATE
-- ============================================================

CREATE OR REPLACE FUNCTION log_sub_dimension_version()
RETURNS TRIGGER AS $$
DECLARE
  rev_type TEXT;
  role_name TEXT;
BEGIN
  -- Identify revision type
  IF TG_OP = 'INSERT' THEN
    rev_type := 'initial';
  ELSIF OLD.active = TRUE AND NEW.active = FALSE THEN
    rev_type := 'deprecation';
  ELSIF OLD.active = FALSE AND NEW.active = TRUE THEN
    rev_type := 'restoration';
  ELSE
    -- Only log when material fields changed
    IF OLD.domain = NEW.domain
       AND OLD.name = NEW.name
       AND OLD.spectrum_low = NEW.spectrum_low
       AND OLD.spectrum_high = NEW.spectrum_high
       AND OLD.scope_applicability = NEW.scope_applicability
       AND OLD.applicable_regions = NEW.applicable_regions
       AND OLD.editorial_salience = NEW.editorial_salience
       AND COALESCE(OLD.salience_rationale, '') = COALESCE(NEW.salience_rationale, '')
    THEN
      RETURN NEW; -- nothing material changed (e.g., display_order tweak) — skip audit
    END IF;
    rev_type := 'minor_edit';
  END IF;

  -- Enforce: if editorial_salience moves away from 0.5, rationale must be provided.
  IF NEW.editorial_salience <> 0.5 AND (NEW.salience_rationale IS NULL OR NEW.salience_rationale = '') THEN
    RAISE EXCEPTION 'editorial_salience % requires salience_rationale', NEW.editorial_salience;
  END IF;

  -- Capture role — best-effort; current_user in Supabase is usually 'authenticator' or
  -- 'service_role' depending on how the write landed.
  role_name := COALESCE(current_setting('request.jwt.claim.role', true), current_user);

  INSERT INTO sub_dimension_versions (
    sub_dimension_id, domain, name, spectrum_low, spectrum_high,
    scope_applicability, applicable_regions, editorial_salience, salience_rationale,
    active, change_reason, changed_by_role, revision_type, effective_from
  ) VALUES (
    NEW.id, NEW.domain, NEW.name, NEW.spectrum_low, NEW.spectrum_high,
    NEW.scope_applicability, NEW.applicable_regions, NEW.editorial_salience, NEW.salience_rationale,
    NEW.active,
    -- change_reason is a per-statement session variable the caller must set before update
    NULLIF(current_setting('ballot_bridge.taxonomy_change_reason', true), ''),
    role_name,
    rev_type,
    now()
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_log_sub_dimension_version
  AFTER INSERT OR UPDATE ON sub_dimensions
  FOR EACH ROW
  EXECUTE FUNCTION log_sub_dimension_version();

-- ============================================================
-- 5. Convenience view: current + version history
-- ============================================================

CREATE OR REPLACE VIEW v_sub_dimension_history AS
SELECT
  sd.id,
  sd.name AS current_name,
  sd.domain AS current_domain,
  sd.active,
  sdv.revision_type,
  sdv.effective_from,
  sdv.name AS at_name,
  sdv.domain AS at_domain,
  sdv.spectrum_low AS at_spectrum_low,
  sdv.spectrum_high AS at_spectrum_high,
  sdv.scope_applicability AS at_scope_applicability,
  sdv.applicable_regions AS at_applicable_regions,
  sdv.editorial_salience AS at_editorial_salience,
  sdv.change_reason,
  sdv.changed_by_role
FROM sub_dimensions sd
LEFT JOIN sub_dimension_versions sdv ON sdv.sub_dimension_id = sd.id
ORDER BY sd.display_order, sdv.effective_from DESC;

-- ============================================================
-- 6. Backfill: write an 'initial' version row for every existing dim
-- ============================================================

-- Running the trigger manually on existing data by setting salience_rationale to NULL
-- and touching updated_at would work, but simpler: direct insert to sub_dimension_versions
-- using current values. This treats the existing 19 dims as their own initial revisions.
INSERT INTO sub_dimension_versions (
  sub_dimension_id, domain, name, spectrum_low, spectrum_high,
  scope_applicability, applicable_regions, editorial_salience, salience_rationale,
  active, change_reason, changed_by_role, revision_type, effective_from
)
SELECT
  id, domain, name, spectrum_low, spectrum_high,
  scope_applicability, applicable_regions, editorial_salience, salience_rationale,
  COALESCE(active, true),
  'backfill: pre-existing taxonomy from initial schema',
  'migration',
  'initial',
  COALESCE(created_at, now())
FROM sub_dimensions;

-- ============================================================
-- 7. Seed defaults: region + scope for each of the existing 19 dims
-- ============================================================

-- All existing dims are US-scoped by default (already set via column default).
-- Tune scope_applicability per dim. Defaults above applied 'informational' to county;
-- for some dims (e.g., education) that should be 'matching' at county; for others
-- (e.g., immigration) that should be 'not_applicable' at county level.

-- Federal-only issues (immigration policy, reproductive_rights federalism, etc. are
-- debated at county level but county candidates rarely have direct authority)
UPDATE sub_dimensions SET scope_applicability = '{
  "federal": "matching",
  "state": "matching",
  "county": "informational",
  "municipal": "informational"
}'::jsonb
WHERE name IN ('immigration', 'reproductive_rights', 'gun_policy', 'civil_rights',
               'religious_liberty', 'election_reform');

-- State-and-local issues (education, housing, transportation, public safety at local level)
UPDATE sub_dimensions SET scope_applicability = '{
  "federal": "informational",
  "state": "matching",
  "county": "matching",
  "municipal": "matching",
  "school_board": "matching"
}'::jsonb
WHERE name IN ('school_choice', 'public_school_funding');

UPDATE sub_dimensions SET scope_applicability = '{
  "federal": "matching",
  "state": "matching",
  "county": "matching",
  "municipal": "matching"
}'::jsonb
WHERE name IN ('housing', 'transportation', 'criminal_justice', 'government_transparency');

-- Environment — all levels matter but with different emphasis
UPDATE sub_dimensions SET scope_applicability = '{
  "federal": "matching",
  "state": "matching",
  "county": "matching",
  "municipal": "informational"
}'::jsonb
WHERE name IN ('energy_policy', 'public_lands', 'water_rights');

-- Economy — fiscal policy is federal-primary, state-secondary, local-informational
UPDATE sub_dimensions SET scope_applicability = '{
  "federal": "matching",
  "state": "matching",
  "county": "informational",
  "municipal": "informational"
}'::jsonb
WHERE name IN ('taxes', 'government_spending', 'business_regulation');

-- Healthcare insurance is federal-primary, state-secondary
UPDATE sub_dimensions SET scope_applicability = '{
  "federal": "matching",
  "state": "matching",
  "county": "informational"
}'::jsonb
WHERE name = 'insurance_coverage';

-- ============================================================
-- 8. RLS — public read for new table + view
-- ============================================================

ALTER TABLE sub_dimension_versions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read sub_dimension_versions"
  ON sub_dimension_versions FOR SELECT
  USING (true);

GRANT SELECT ON v_sub_dimension_history TO anon, authenticated;

-- ============================================================
-- 9. Comments for future readers
-- ============================================================

COMMENT ON COLUMN sub_dimensions.scope_applicability IS
  'Per-scope matching policy. Keys: federal/state/county/municipal/judicial/school_board/special_district. '
  'Values: matching (counts toward match score) / informational (shown but excluded from match) / '
  'not_applicable (hidden). See validate_scope_applicability() for validation.';

COMMENT ON COLUMN sub_dimensions.applicable_regions IS
  'ISO 3166 country and sub-national codes where this dim applies. '
  'Empty array = universal. US-only: {"US"}. Utah-specific: {"US-UT"}. '
  'Enables country-scoped taxonomy extensions for international rollout.';

COMMENT ON COLUMN sub_dimensions.editorial_salience IS
  'Editorial weight in [0,1]; 0.5 is neutral (no editorial emphasis). '
  'Moving from 0.5 requires salience_rationale (enforced by trigger). '
  'Distinct from user-chosen domain salience weights in the matching algorithm.';

COMMENT ON TABLE sub_dimension_versions IS
  'Append-only audit log of every change to sub_dimensions. One row per INSERT + one per '
  'material UPDATE (non-display-only). Used for taxonomy drift accountability and to '
  'answer "what did this dim mean when this candidate was classified against it?"';
