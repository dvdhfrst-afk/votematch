-- ============================================================
-- Federal tables: data_source_id + ingestion_run_id provenance
-- ============================================================
--
-- B3-B5 pilot ports flagged that federal_bills, federal_votes,
-- federal_vote_positions, and fec_alerts lack provenance FKs.
-- Add them so the adapter runner can record lineage at row level,
-- not just at run level.
--
-- All additive + nullable to preserve legacy behavior.
-- ============================================================

ALTER TABLE federal_bills
  ADD COLUMN IF NOT EXISTS data_source_id UUID REFERENCES data_sources(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS ingestion_run_id UUID REFERENCES ingestion_runs(id) ON DELETE SET NULL;

ALTER TABLE federal_votes
  ADD COLUMN IF NOT EXISTS data_source_id UUID REFERENCES data_sources(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS ingestion_run_id UUID REFERENCES ingestion_runs(id) ON DELETE SET NULL;

ALTER TABLE federal_vote_positions
  ADD COLUMN IF NOT EXISTS data_source_id UUID REFERENCES data_sources(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS ingestion_run_id UUID REFERENCES ingestion_runs(id) ON DELETE SET NULL;

ALTER TABLE fec_alerts
  ADD COLUMN IF NOT EXISTS data_source_id UUID REFERENCES data_sources(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS ingestion_run_id UUID REFERENCES ingestion_runs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_federal_bills_data_source ON federal_bills (data_source_id) WHERE data_source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_federal_votes_data_source ON federal_votes (data_source_id) WHERE data_source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_federal_vote_positions_data_source ON federal_vote_positions (data_source_id) WHERE data_source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fec_alerts_data_source ON fec_alerts (data_source_id) WHERE data_source_id IS NOT NULL;

COMMENT ON COLUMN federal_bills.data_source_id IS
  'Lineage FK to data_sources.id. Populated by federalBillsAdapter via runAdapter. NULL for pre-2026-04-23 rows.';
