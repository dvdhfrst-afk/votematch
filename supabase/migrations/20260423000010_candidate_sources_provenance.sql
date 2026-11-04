-- ============================================================
-- candidate_sources provenance: data_source_id + ingestion_run_id
-- ============================================================
--
-- Council F17 (2026-04-23): every candidate_sources row should link
-- back to a `data_sources` row (the canonical provenance record
-- added by 20260423000000_data_sources.sql) and, when produced by
-- an adapter, to an `ingestion_runs` row.
--
-- Why this matters:
--   1. Correction workflow (/corrections). When a reviewer opens
--      a disputed source, they need the full provenance trail:
--      what URL, when fetched, what content hash, which adapter run.
--   2. Connector churn. When we re-run the Utah outlets adapter and
--      the feed schema has changed, every affected candidate_sources
--      row should point to the same data_sources row so we can
--      invalidate in bulk.
--   3. License tracking. data_sources.license drives whether we
--      can surface a quote; candidate_sources inherits via the FK.
--
-- Both columns are NULLABLE (ON DELETE SET NULL) because:
--   - Historical rows ingested before this migration have no FK yet
--   - A legacy-only orchestrator run (pre-F17 logic) may still write
--     candidate_sources without doing the data_sources upsert
--   - The adapter runner that produces ingestion_runs isn't built yet
-- ============================================================

ALTER TABLE candidate_sources
  ADD COLUMN IF NOT EXISTS data_source_id UUID
    REFERENCES data_sources(id) ON DELETE SET NULL;

ALTER TABLE candidate_sources
  ADD COLUMN IF NOT EXISTS ingestion_run_id UUID
    REFERENCES ingestion_runs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_candidate_sources_data_source
  ON candidate_sources (data_source_id)
  WHERE data_source_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_candidate_sources_ingestion_run
  ON candidate_sources (ingestion_run_id)
  WHERE ingestion_run_id IS NOT NULL;

COMMENT ON COLUMN candidate_sources.data_source_id IS
  'FK to the canonical provenance record in data_sources. Populated at ingest '
  'by src/lib/sourcing/orchestrator.ts per (url, content_hash) pair. '
  'Backfillable for historical rows via scripts/backfill-candidate-source-provenance.ts '
  '(not yet built).';

COMMENT ON COLUMN candidate_sources.ingestion_run_id IS
  'FK to the adapter run that produced this row. NULL for rows produced '
  'before the adapter runner was built (council F17 2026-04-23). '
  'Populated once scripts/adapters/ wire up per-run tracking.';
