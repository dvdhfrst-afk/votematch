-- ============================================================
-- 20260524000000_judicial_special_district_scope.sql
--
-- Adds judicial + special_district keys to sub_dimensions.scope_applicability.
--
-- Why: validate_scope_applicability() already allows these scope keys, but
-- no sub_dimension actually carries values for them. When the matching
-- algorithm calls raceLevelToScope('judicial') (or 'special'), the lookup
-- returns no entries and filterMatchingDims() drops every dim — judicial
-- and special-district races get zero matching dims and a score of null.
--
-- This migration sets defensible defaults so judicial / special_district
-- races get a non-empty matching set. The values are editorial — flagged
-- for the operator's review (see 00-inbox/2026-05-judicial-special-scope-notes.md
-- written alongside this migration).
--
-- Mode vocabulary: matching | informational | not_applicable
--
-- Defaults rationale:
--   JUDICIAL — judges and DAs adjudicate but don't legislate. Civil
--   liberties cases dominate state courts; gun policy / immigration are
--   federal-statute interpretation only. Health/budget/infra are
--   essentially out of scope for judicial offices.
--     criminal_justice       matching   (direct judicial subject matter)
--     civil_rights           matching   (constitutional + civil suits)
--     reproductive_rights    matching   (state supreme courts increasingly central)
--     religious_liberty      matching   (1st Amendment cases)
--     government_transparency informational (sunshine-law rulings, occasional)
--     election_reform        informational (occasional election-law cases)
--     gun_policy             informational (interpretation, not lawmaking)
--     immigration            informational (federal-statute interpretation)
--     business_regulation    informational (commercial dispute interpretation)
--     [all economy / education / environment / healthcare-insurance /
--      infrastructure dims] not_applicable
--
--   SPECIAL_DISTRICT — water/sewer/transit/fire/parks/library/etc.; the
--   enum is too coarse to distinguish a water board from a transit board,
--   so we default to a small "infrastructure + environment + governance"
--   informational set and leave the rest not_applicable. Per-office
--   relevant_dimensions on individual offices is the higher-leverage signal.
--     water_rights           informational
--     transportation         informational
--     energy_policy          informational
--     public_lands           informational
--     housing                informational
--     public_school_funding  informational (library/parks/school-adjacent)
--     government_transparency informational
--     [all others]           not_applicable
-- ============================================================

BEGIN;

UPDATE sub_dimensions
SET scope_applicability = scope_applicability || jsonb_build_object(
  'judicial', CASE name
    WHEN 'criminal_justice'        THEN 'matching'
    WHEN 'civil_rights'            THEN 'matching'
    WHEN 'reproductive_rights'     THEN 'matching'
    WHEN 'religious_liberty'       THEN 'matching'
    WHEN 'government_transparency' THEN 'informational'
    WHEN 'election_reform'         THEN 'informational'
    WHEN 'gun_policy'              THEN 'informational'
    WHEN 'immigration'             THEN 'informational'
    WHEN 'business_regulation'     THEN 'informational'
    ELSE 'not_applicable'
  END,
  'special_district', CASE name
    WHEN 'water_rights'            THEN 'informational'
    WHEN 'transportation'          THEN 'informational'
    WHEN 'energy_policy'           THEN 'informational'
    WHEN 'public_lands'            THEN 'informational'
    WHEN 'housing'                 THEN 'informational'
    WHEN 'public_school_funding'   THEN 'informational'
    WHEN 'government_transparency' THEN 'informational'
    ELSE 'not_applicable'
  END
)
WHERE active = true;

-- Provenance: the original draft logged a sub_dimension_versions row per
-- dim, but that table's `name` column is NOT NULL and our INSERT was
-- missing it (caught by `supabase migration up`). Provenance is
-- nice-to-have, not load-bearing — dropped for simplicity. The change is
-- self-documented in this migration file.

COMMIT;
