-- ============================================================
-- positions.candidate_id -> nullable (person-native write path)
-- ============================================================
--
-- Context: the project is migrating from the legacy candidate-centric
-- graph (candidates, candidate_id) to the person/office graph (people,
-- candidacies, person_id). positions already carries BOTH candidate_id
-- and person_id (person_id added additive in 20260502000020). Until now,
-- candidate_id was NOT NULL (initial_schema 20260416000000), so a
-- newly-rostered Utah candidacy that has a person_id but NO legacy
-- candidate_id could not own a positions row at all. The promoter
-- (promote-signals-to-positions.ts) therefore SKIPPED those persons, and
-- 73 of 93 uncovered Utah candidates showed "no positions".
--
-- This migration drops the NOT NULL constraint on positions.candidate_id
-- so a position can be keyed by person_id alone (candidate_id left NULL)
-- for person-only candidacies. Legacy rows keep their candidate_id pin.
--
-- WHY SAFE / ADDITIVE:
--   - Dropping NOT NULL only LOOSENS the constraint. Every existing row
--     already has a non-null candidate_id, so no data changes and no
--     existing read path that filters by candidate_id is affected.
--   - The FK (candidate_id REFERENCES candidates(id) ON DELETE CASCADE)
--     is UNCHANGED: a NULL candidate_id satisfies the FK trivially, and a
--     non-null one still references a real candidate.
--   - The person_id FK and its partial index (20260502000020) already
--     support person-keyed reads.
--
-- INTEGRITY GUARD: a positions row must be reachable by SOMETHING. Add a
-- CHECK that at least one of (candidate_id, person_id) is non-null, so we
-- never write an orphan row keyed by neither identity.
--
-- IDEMPOTENT: DROP NOT NULL is a no-op if already dropped; the CHECK is
-- guarded by DROP CONSTRAINT IF EXISTS.
-- ============================================================

ALTER TABLE positions
  ALTER COLUMN candidate_id DROP NOT NULL;

ALTER TABLE positions
  DROP CONSTRAINT IF EXISTS positions_identity_present_check;

ALTER TABLE positions
  ADD CONSTRAINT positions_identity_present_check
  CHECK (candidate_id IS NOT NULL OR person_id IS NOT NULL);

-- Partial index for the person-only read path (person_id set, no legacy
-- candidate_id). Complements idx_positions_person_id from 20260502000020,
-- which indexes person_id generally; this one is tuned for the
-- "person-native, no legacy pin" lookup the new read path performs.
CREATE INDEX IF NOT EXISTS idx_positions_person_only
  ON positions (person_id)
  WHERE candidate_id IS NULL AND person_id IS NOT NULL;

COMMENT ON COLUMN positions.candidate_id IS
  'Legacy pin (nullable as of 20260615010000). Non-null for legacy rows '
  'and for person rows that also have a legacy candidate. NULL for '
  'person-native candidacies that have a person_id but no legacy '
  'candidate_id. At least one of candidate_id / person_id is enforced '
  'non-null by positions_identity_present_check.';
