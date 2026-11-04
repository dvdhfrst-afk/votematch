-- ============================================================
-- people.canonical_key: state-free dedup key for person identity
-- ============================================================
--
-- Background (Council silent-drop review, 2026-04-23):
--
-- apply-2026-candidates.ts keyed people on
--   (canonical_name, meta->>'fetch_state')
-- The fetch_state tiebreaker was added to avoid cross-state
-- collisions, but it over-corrected: a single person who appears
-- in TWO state feeds (e.g. a federal candidate filed with both
-- FEC and NY SoS) produced TWO people rows. Enrich passes then
-- fill one row but not the other, downstream fan-out splits
-- contact info and match votes.
--
-- Fix: derive a state-free `canonical_key` from canonical_name:
--   lower, strip every non-alphanumeric, trim.
-- Use (canonical_key, birth_year?) as the resolution key. When
-- birth_year is unknown, canonical_key alone is the match.
--
-- Enforcement: UNIQUE INDEX on canonical_key IFF no existing
-- duplicates. If duplicates exist, the DO block emits a NOTICE
-- listing them and SKIPS creating the unique index. A follow-up
-- cleanup PR will merge the dup rows, then add the unique index.
-- ============================================================

ALTER TABLE people
  ADD COLUMN IF NOT EXISTS canonical_key TEXT;

-- Backfill from canonical_name. Deliberately lower+strip-non-alnum
-- (no diacritic folding here — Postgres unaccent requires the
-- extension; apply-side TS implements the same transform for
-- incoming rows so the two match).
UPDATE people
SET canonical_key = lower(regexp_replace(canonical_name, '[^a-zA-Z0-9]', '', 'g'))
WHERE canonical_key IS NULL AND canonical_name IS NOT NULL;

-- Always-present lookup index (not unique — see below)
CREATE INDEX IF NOT EXISTS idx_people_canonical_key
  ON people (canonical_key) WHERE canonical_key IS NOT NULL;

-- Composite index matching the (canonical_key, birth_year) lookup
-- path in apply-2026-candidates.ts. Partial (canonical_key IS NOT
-- NULL) so it stays small for the pre-backfill window.
CREATE INDEX IF NOT EXISTS idx_people_canonical_key_birth_year
  ON people (canonical_key, birth_year) WHERE canonical_key IS NOT NULL;

-- Attempt UNIQUE INDEX — only if dup-free. This is defensive:
-- if past runs left duplicates, creating UNIQUE blindly would
-- fail this whole migration and block all subsequent ones.
DO $$
DECLARE
  v_dup_count INT;
  v_dup_sample TEXT;
BEGIN
  SELECT count(*) INTO v_dup_count
  FROM (
    SELECT canonical_key
    FROM people
    WHERE canonical_key IS NOT NULL
    GROUP BY canonical_key
    HAVING count(*) > 1
  ) s;

  IF v_dup_count = 0 THEN
    CREATE UNIQUE INDEX IF NOT EXISTS uq_people_canonical_key
      ON people (canonical_key) WHERE canonical_key IS NOT NULL;
    RAISE NOTICE 'people.canonical_key UNIQUE INDEX created (no pre-existing duplicates).';
  ELSE
    SELECT string_agg(canonical_key, ', ') INTO v_dup_sample
    FROM (
      SELECT canonical_key FROM people
      WHERE canonical_key IS NOT NULL
      GROUP BY canonical_key HAVING count(*) > 1
      LIMIT 20
    ) s;
    RAISE NOTICE 'people.canonical_key has % duplicate group(s). UNIQUE INDEX deferred. Sample keys: %', v_dup_count, v_dup_sample;
  END IF;
END $$;

-- Keep canonical_key aligned with canonical_name on future writes.
-- Any INSERT/UPDATE that sets canonical_name will derive the key
-- automatically. Scripts can also write canonical_key explicitly
-- (idempotent — trigger overwrites to the derived value).
CREATE OR REPLACE FUNCTION people_set_canonical_key()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.canonical_name IS NOT NULL THEN
    NEW.canonical_key := lower(regexp_replace(NEW.canonical_name, '[^a-zA-Z0-9]', '', 'g'));
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_people_set_canonical_key ON people;
CREATE TRIGGER trg_people_set_canonical_key
  BEFORE INSERT OR UPDATE OF canonical_name ON people
  FOR EACH ROW EXECUTE FUNCTION people_set_canonical_key();

COMMENT ON COLUMN people.canonical_key IS
  'Normalized state-free dedup key: lower(regexp_replace(canonical_name, ''[^a-zA-Z0-9]'', '''', ''g'')). '
  'Derived via trigger on INSERT/UPDATE. Paired with optional birth_year for person resolution. '
  'Was added to fix silent-drop pipeline bug where same person in two state feeds created two rows '
  '(Council review, 2026-04-23).';
