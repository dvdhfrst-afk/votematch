-- ---------------------------------------------------------------------------
-- 20260427000000_extraction_audit_fk_indexes.sql
--
-- Backfills 10 reverse-FK indexes that were created directly against the live
-- Supabase DB on 2026-04-26 to fix a chronic DELETE performance bug on
-- extraction_audit. Captured here so the schema can be rebuilt from migrations.
--
-- extraction_audit has 12 referencing tables with ON DELETE SET NULL. Without
-- these indexes, every DELETE triggers a full sequential scan of each
-- referencing table per row deleted. The 24K transient-error cleanup on
-- 2026-04-26 took 2.6s with the indexes vs. 12+ min without (~270x speedup).
--
-- Partial-index (WHERE extraction_audit_id IS NOT NULL) keeps the index small
-- since most rows in these tables don't carry an extraction_audit_id.
--
-- Not using CONCURRENTLY: migrations run inside a transaction and these
-- indexes are small enough that the brief ACCESS EXCLUSIVE lock is fine.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_ballot_measures_extraction_audit_id
  ON ballot_measures (extraction_audit_id)
  WHERE extraction_audit_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_candidate_magic_link_submissions_extraction_audit_id
  ON candidate_magic_link_submissions (extraction_audit_id)
  WHERE extraction_audit_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_candidate_sources_extraction_audit_id
  ON candidate_sources (extraction_audit_id)
  WHERE extraction_audit_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_federal_bills_extraction_audit_id
  ON federal_bills (extraction_audit_id)
  WHERE extraction_audit_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_municipal_meetings_extraction_audit_id
  ON municipal_meetings (extraction_audit_id)
  WHERE extraction_audit_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_officeholders_extraction_audit_id
  ON officeholders (extraction_audit_id)
  WHERE extraction_audit_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_positions_extraction_audit_id
  ON positions (extraction_audit_id)
  WHERE extraction_audit_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_state_cf_events_extraction_audit_id
  ON state_cf_events (extraction_audit_id)
  WHERE extraction_audit_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_state_legislator_votes_extraction_audit_id
  ON state_legislator_votes (extraction_audit_id)
  WHERE extraction_audit_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_state_rulemaking_events_extraction_audit_id
  ON state_rulemaking_events (extraction_audit_id)
  WHERE extraction_audit_id IS NOT NULL;
