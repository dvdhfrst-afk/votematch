-- =============================================================================
-- Add resolved_person_id + resolved_candidacy_id to state_cf_events.
--
-- Council 2026-04-25 — the state-cf adapter base.ts has been writing these
-- two FK columns since the office-graph migration, but the live DB schema
-- doesn't have them yet. The new CF strip on /candidate/[id] queries CF
-- rows by resolved_person_id, so this migration is required for that
-- voter-facing surface to display anything.
--
-- Also wires data_source_id + ingestion_run_id (council DE#5 — provenance).
-- =============================================================================

ALTER TABLE state_cf_events
  ADD COLUMN IF NOT EXISTS resolved_candidacy_id UUID REFERENCES candidacies(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS resolved_person_id UUID REFERENCES people(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS data_source_id UUID REFERENCES data_sources(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS ingestion_run_id UUID REFERENCES ingestion_runs(id) ON DELETE SET NULL;

-- Indexes for the candidate page CF strip + lineage queries.
CREATE INDEX IF NOT EXISTS idx_state_cf_events_resolved_person
  ON state_cf_events (resolved_person_id)
  WHERE resolved_person_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_state_cf_events_resolved_candidacy
  ON state_cf_events (resolved_candidacy_id)
  WHERE resolved_candidacy_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_state_cf_events_data_source
  ON state_cf_events (data_source_id)
  WHERE data_source_id IS NOT NULL;

-- Allow the new event_type values that the adapter base writes.
DO $$
BEGIN
  -- The migration that created state_cf_events used a CHECK constraint;
  -- expand it to include the values the adapter framework actually writes.
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname LIKE '%state_cf_events%event_type%'
  ) THEN
    EXECUTE 'ALTER TABLE state_cf_events DROP CONSTRAINT ' ||
      (SELECT conname FROM pg_constraint WHERE conname LIKE '%state_cf_events%event_type%' LIMIT 1);
  END IF;
END $$;

ALTER TABLE state_cf_events ADD CONSTRAINT state_cf_events_event_type_check CHECK (
  event_type IN (
    'contribution','expenditure','loan','in_kind',
    'independent_expenditure','filing','other'
  )
);
