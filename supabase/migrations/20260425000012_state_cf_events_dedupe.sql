-- =============================================================================
-- state_cf_events: row_uid content hash + supporting index.
--
-- Council 2026-04-25 — `state_cf_events` has accumulated mass duplicates and
-- (in LA) parser garbage from HTML scrapers that fell through <script> tags.
-- The two structural fixes:
--
--   1. A `row_uid` content hash so future inserts can ON CONFLICT DO NOTHING
--      against the canonical (state, event_date, amount, candidate_name,
--      counterparty, committee_name, event_type) tuple. This ends the
--      "duplicates land every retry because there's no upsert key" failure
--      mode (IN CFA: 314x duplication of single tuples; WA PDC: 2x).
--
--   2. The actual UNIQUE constraint is *not* added by this migration. The
--      existing 12.1M rows are not yet deduped, so a UNIQUE on row_uid would
--      fail. Constraint is added by `scripts/dedupe-state-cf-events.ts`
--      AFTER it has finished its transactional purge + dedup pass. That
--      script is operator-run with the service-role key and enforces the
--      ">= 50% duplicate rate" safety gate before deleting anything.
--
-- This migration is intentionally additive-only and reversible:
--   ALTER TABLE state_cf_events DROP COLUMN row_uid;
-- =============================================================================

-- 1. Add the column. Nullable so the backfill can populate it.
ALTER TABLE state_cf_events
  ADD COLUMN IF NOT EXISTS row_uid TEXT;

-- 2. Backfill existing rows. md5() of the canonical tuple. Idempotent —
--    re-running picks up only the rows still NULL.
--    Pipe-delimiter chosen so a stray '|' in candidate_name can't collide
--    with the field separator in any natural way (md5 absorbs it either way,
--    but the visual separator helps debugging when staring at a row in psql).
UPDATE state_cf_events
   SET row_uid = md5(
         COALESCE(state, '') || '|' ||
         COALESCE(event_date::text, '') || '|' ||
         COALESCE(amount::text, '') || '|' ||
         COALESCE(candidate_name, '') || '|' ||
         COALESCE(counterparty, '') || '|' ||
         COALESCE(committee_name, '') || '|' ||
         COALESCE(event_type, '')
       )
 WHERE row_uid IS NULL;

-- 3. Non-unique index on row_uid for the dedup script to scan efficiently.
--    Made UNIQUE later (by the dedupe script) once duplicates are gone.
CREATE INDEX IF NOT EXISTS idx_state_cf_events_row_uid
  ON state_cf_events (row_uid);

-- =============================================================================
-- The UNIQUE constraint that this migration deliberately does NOT add:
--
--   ALTER TABLE state_cf_events
--     ADD CONSTRAINT state_cf_events_row_uid_unique UNIQUE (row_uid);
--
-- It is added by the post-dedup operator script. Once the constraint exists,
-- the adapter `INSERT ... ON CONFLICT (row_uid) DO NOTHING` path becomes
-- a true idempotent upsert.
-- =============================================================================
