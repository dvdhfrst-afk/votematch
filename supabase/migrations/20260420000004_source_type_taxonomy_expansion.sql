-- Sprint S1.11 / council decision 007 §1 — expand candidate_sources.source_type
-- from the 7-value enum to the 11-value taxonomy the two-view positioning
-- engine needs, and add `source_subtype TEXT` to preserve the old granular
-- string when the new enum compresses detail.
--
-- Taxonomy (per 007 §1 and 12-positioning-engine/00-requirements.md §128-141):
--   website, op_ed, press_release, speech, interview, social, news, scorecard,
--   filing, questionnaire, voting_record
--
-- Mapping from today's 5-value live set to the 11-value taxonomy:
--   campaign_website    -> source_type='website',         source_subtype='campaign_site'
--   state_profile       -> source_type='website',         source_subtype='state_profile'
--   news_article        -> source_type='news',            source_subtype=NULL
--   extracted_positions -> source_type='news',            source_subtype='extracted_positions'
--   fec_financials      -> source_type='filing',          source_subtype='fec_financials'
--   questionnaire       -> source_type='questionnaire'    (preserved)
--   voting_record       -> source_type='voting_record'    (preserved)
--
-- Invariant check at end: every row must land on a valid new enum value.
-- Precedent for the DROP-then-ADD CHECK pattern: 20260417000001 line 12.
--
-- Safety: append-only — no existing column is removed. `authenticity_tier`
-- and `outlet_ideology` are untouched; the backfill in 20260418000003 still
-- applies (it keyed on the OLD enum values). New connectors (op_ed,
-- press_release, speech, interview, social, scorecard) ship empty — the
-- tier-default for new rows stays 3 conservative until a connector sets it.
--
-- Cost: ~seconds on a 2,755-row table.

-- ============================================================
-- 1. Add source_subtype column (nullable — default = NULL)
-- ============================================================

ALTER TABLE candidate_sources
  ADD COLUMN source_subtype TEXT;

COMMENT ON COLUMN candidate_sources.source_subtype IS
  'Granular sub-type preserved from the pre-007 taxonomy (e.g. "campaign_site", '
  '"state_profile", "fec_financials"). NULL when the parent source_type is '
  'self-describing. Used for filtering + analytics without coarsening the enum.';

-- ============================================================
-- 2. Backfill new values while the OLD check constraint still permits them
--    (the CHECK accepts the existing enum; we write BOTH columns, and the
--     source_type update uses values still legal under the old constraint
--     for a brief interval via a two-step replace).
-- ============================================================

-- Step 2a: populate source_subtype from today's source_type values. This is
-- pure read-and-write, no CHECK violation because we're only writing
-- source_subtype.
UPDATE candidate_sources SET source_subtype = 'campaign_site'
  WHERE source_type = 'campaign_website';

UPDATE candidate_sources SET source_subtype = 'state_profile'
  WHERE source_type = 'state_profile';

UPDATE candidate_sources SET source_subtype = 'extracted_positions'
  WHERE source_type = 'extracted_positions';

UPDATE candidate_sources SET source_subtype = 'fec_financials'
  WHERE source_type = 'fec_financials';

-- Step 2b: drop the old CHECK so we can rewrite source_type to the new enum.
ALTER TABLE candidate_sources DROP CONSTRAINT candidate_sources_source_type_check;

-- Step 2c: rewrite source_type to the new taxonomy.
UPDATE candidate_sources SET source_type = 'website'
  WHERE source_type IN ('campaign_website', 'state_profile');

UPDATE candidate_sources SET source_type = 'news'
  WHERE source_type IN ('news_article', 'extracted_positions');

UPDATE candidate_sources SET source_type = 'filing'
  WHERE source_type = 'fec_financials';

-- questionnaire and voting_record stay put — they are first-class in the new
-- taxonomy per plan 007 §1.

-- Step 2d: attach the new 11-value CHECK.
ALTER TABLE candidate_sources
  ADD CONSTRAINT candidate_sources_source_type_check
  CHECK (source_type IN (
    'website',
    'op_ed',
    'press_release',
    'speech',
    'interview',
    'social',
    'news',
    'scorecard',
    'filing',
    'questionnaire',
    'voting_record'
  ));

-- ============================================================
-- 3. Sanity check — every row must be valid under the new enum.
-- ============================================================

DO $$
DECLARE
  bad_count INT;
BEGIN
  SELECT COUNT(*) INTO bad_count FROM candidate_sources
  WHERE source_type NOT IN (
    'website', 'op_ed', 'press_release', 'speech', 'interview',
    'social', 'news', 'scorecard', 'filing', 'questionnaire', 'voting_record'
  );
  IF bad_count > 0 THEN
    RAISE EXCEPTION 'taxonomy expansion left % rows on illegal source_type values', bad_count;
  END IF;
END
$$;

COMMENT ON COLUMN candidate_sources.source_type IS
  'Top-level provenance category (11-value taxonomy per council decision 007 §1). '
  'Pair with source_subtype for the granular classification where more detail '
  'matters (e.g., website+campaign_site vs website+state_profile).';
