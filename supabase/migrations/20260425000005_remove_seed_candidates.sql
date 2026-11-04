-- Council finding #6: seed.ts production-data corruption risk
-- =============================================================
-- The pre-existing seed.ts script upserts 10 fictional candidates with
-- `onConflict: 'name'`. When real ingestion creates a candidate with the
-- same name as one of the fictional seeds, re-running the seed
-- would OVERWRITE the real row's bio, party, and race_id with dummy data.
--
-- This migration:
--   1. Adds a `meta` JSONB column to candidates so future seed runs can
--      tag rows as fictional and use `meta->>'seed_id'` as the upsert key
--      (impossible to collide with real candidates, which have meta=NULL).
--   2. Adds a unique partial index on meta->>'seed_id' to support
--      onConflict targeting via the JSONB key.
--   3. Removes the 10 known-fictional candidate rows from the live DB,
--      cleaning up any prior seed runs that landed in production.
--
-- Cascades: candidate_sources, positions, candidate_contacts, matches all
-- have ON DELETE CASCADE, so deleting a fictional candidate also removes
-- the dummy positions and any test matches that referenced them.

-- Step 1: add meta column (nullable; real candidates leave it NULL)
ALTER TABLE candidates
  ADD COLUMN IF NOT EXISTS meta JSONB;

-- Step 2: unique partial index on the seed_id key. Partial so it only
-- enforces uniqueness for seed rows; real candidates (meta IS NULL or
-- meta->>'seed_id' IS NULL) are unaffected and can have duplicate names
-- across races (a real concern at national scope — multiple "John Smith"s).
CREATE UNIQUE INDEX IF NOT EXISTS candidates_meta_seed_id_unique
  ON candidates ((meta->>'seed_id'))
  WHERE meta->>'seed_id' IS NOT NULL;

-- Step 3: delete the 10 fictional candidates. Match either by the new
-- is_seed flag (for any rows the patched seed.ts may have already written
-- before this migration runs) OR by the literal names used in the prior
-- seed module. Cascade removes positions / matches automatically.
DELETE FROM candidates
WHERE meta->>'is_seed' = 'true'
   OR name IN (
     'Margaret Sampleton',
     'Carlos Fictivo',
     'Dana Exampleson',
     'Sarah Placeholder',
     'Robin Testwell',
     'Linda Mockwood',
     'Jamie Notreal',
     'Priya Demoname',
     'Tom Fixture',
     'Angela Fakerly'
   );

-- Note: the old `candidates_name_key UNIQUE (name)` constraint from
-- migration 20260416000001 is intentionally left in place for now. It
-- continues to serve other paths that rely on name-uniqueness, and the
-- patched seed.ts no longer relies on it as the upsert target.
