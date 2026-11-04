-- Source content hash + shared-race-coverage flag.
--
-- Motivation (see 14-classifier-baseline/02-source-connector-council.md):
-- the 2026-04-19 spot-check revealed multiple candidates in the same race
-- getting verbatim-identical "source" text from generic race-overview
-- articles. The classifier correctly flagged low confidence, but we want to
-- detect this upstream at ingestion time.
--
-- content_hash: SHA-256 of raw_data at ingestion. Lets the orchestrator
-- query for "same hash across multiple candidates in same race" efficiently.
--
-- shared_race_coverage: set to TRUE when orchestrator finds ≥2 other
-- candidates in the same race already have this content_hash. Lets the UI
-- explain to users why a source was downgraded.

ALTER TABLE candidate_sources
  ADD COLUMN IF NOT EXISTS content_hash TEXT,
  ADD COLUMN IF NOT EXISTS shared_race_coverage BOOLEAN NOT NULL DEFAULT false;

-- Index for orchestrator's cross-candidate dedup query. The typical query
-- joins candidate_sources to candidates to filter by race_id, so we index
-- (content_hash) and let the planner use the existing idx_candidate_sources_candidate
-- for the candidate_id side.
CREATE INDEX IF NOT EXISTS idx_candidate_sources_content_hash
  ON candidate_sources (content_hash)
  WHERE content_hash IS NOT NULL;

-- Backfill is done by a separate script (scripts/backfill-content-hash.ts)
-- to avoid locking the table in prod. New ingestions starting 2026-04-19 will
-- populate content_hash immediately.
