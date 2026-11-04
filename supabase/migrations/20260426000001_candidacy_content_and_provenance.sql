-- ---------------------------------------------------------------------------
-- 20260426000001_candidacy_content_and_provenance.sql
--
-- Data-quality council 2026-04-26 found two structural gaps blocking the
-- voter-decision flow:
--
--   1. candidacies has no place to store what a candidate is actually running
--      on. The candidacy page has a person, an office, and an election --
--      but nowhere to render a campaign summary, a candidate statement, the
--      campaign website, or a campaign contact email. Adapters that ingest
--      this content (state SoS candidate-filing portals, FEC, candidate
--      questionnaires) have nowhere to put it.
--
--   2. candidacies, people, and ballot_measures have no data_source_id
--      column. Provenance lineage is structurally impossible past
--      candidate_sources -- e.g. a row in `people` from the OpenStates bulk
--      load cannot point at the data_sources row that produced it. Every
--      other ingested table (federal_bills, endorsements, election_results,
--      etc.) carries this FK; adding it here closes the gap.
--
-- All new columns are nullable -- existing rows stay valid. No defaults; the
-- adapter that populates these fields is responsible for setting them.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. candidacies: campaign content fields
-- ---------------------------------------------------------------------------
ALTER TABLE candidacies
  ADD COLUMN IF NOT EXISTS summary        TEXT,
  ADD COLUMN IF NOT EXISTS statement      TEXT,
  ADD COLUMN IF NOT EXISTS website        TEXT,
  ADD COLUMN IF NOT EXISTS campaign_email TEXT;

COMMENT ON COLUMN candidacies.summary IS
  'Short campaign summary (1-3 sentences) for ballot-card / list views. Sourced
   from candidate questionnaires, SoS filings, or AI summarization of the
   candidate''s own materials. Nullable -- not every candidacy has one yet.';

COMMENT ON COLUMN candidacies.statement IS
  'Long-form candidate statement -- the "why I''m running" narrative shown on
   the candidacy detail page. Often pasted from the SoS voter-information
   guide or the candidate''s own submission. Nullable.';

COMMENT ON COLUMN candidacies.website IS
  'Campaign website URL for this candidacy. Distinct from people.website_url,
   which is the person''s lifetime canonical site -- a candidacy may have
   its own dedicated campaign site for one cycle. Nullable.';

COMMENT ON COLUMN candidacies.campaign_email IS
  'Public-facing campaign contact email for this candidacy. Distinct from
   people.contact_email (which is the person''s canonical contact). Nullable.';

-- ---------------------------------------------------------------------------
-- 2. data_source_id provenance FK on candidacies, people, ballot_measures
--
-- ON DELETE SET NULL matches the pattern in 20260426000000 and elsewhere:
-- losing the source row should not cascade-delete the fact row, but the
-- pointer goes away.
-- ---------------------------------------------------------------------------
ALTER TABLE candidacies
  ADD COLUMN IF NOT EXISTS data_source_id UUID
    REFERENCES public.data_sources(id) ON DELETE SET NULL;

ALTER TABLE people
  ADD COLUMN IF NOT EXISTS data_source_id UUID
    REFERENCES public.data_sources(id) ON DELETE SET NULL;

ALTER TABLE ballot_measures
  ADD COLUMN IF NOT EXISTS data_source_id UUID
    REFERENCES public.data_sources(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_candidacies_data_source
  ON candidacies (data_source_id) WHERE data_source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_people_data_source
  ON people (data_source_id) WHERE data_source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ballot_measures_data_source
  ON ballot_measures (data_source_id) WHERE data_source_id IS NOT NULL;

COMMENT ON COLUMN candidacies.data_source_id IS
  'FK to the data_sources row that produced this candidacy (SoS filing,
   FEC, OpenStates, etc.). Nullable for legacy rows ingested before
   provenance was tracked here.';

COMMENT ON COLUMN people.data_source_id IS
  'FK to the data_sources row that produced this person record. Nullable
   for legacy rows merged in from the candidate-centric schema before
   provenance was tracked at the people level.';

COMMENT ON COLUMN ballot_measures.data_source_id IS
  'FK to the data_sources row that produced this ballot-measure row.
   Distinct from extraction_audit_id (which points at the AI-extraction
   audit). data_source_id points at the canonical source URL/fetch.';
