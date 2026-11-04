-- ============================================================
-- people: state-scoped canonical_key uniqueness
-- ============================================================
--
-- Background (operator, 2026-05-02):
--
-- Migration 20260423000011 added `people.canonical_key` (lower +
-- strip-non-alnum of canonical_name) and TRIED to enforce a UNIQUE
-- INDEX on it. The DO block deferred index creation because 250+
-- duplicate-key groups already existed (see
-- scripts/data/dedup-people-manual-review.json).
--
-- Inspection of those groups (council 2026-04-25 finding DE#3,
-- subsequently re-reviewed by the operator) showed nearly all of them are
-- LEGITIMATELY DIFFERENT PEOPLE who happen to share a normalized
-- name across states, e.g. a US Rep in one state and a state legislator
-- in another with the same name. Treating them as the same person is wrong.
--
-- DECISION (operator, 2026-05-02): cross-state same-canonical-name
-- people are DIFFERENT people, not duplicates. The dedup key is
-- now (canonical_key, state). Same name + same state is still a
-- candidate for merge; same name + different state is two humans.
--
-- Implementation:
--   1. Add `state_fips_primary TEXT` column to people. (We do NOT
--      use a Postgres GENERATED column here because the natural
--      source is `array_agg(state) FROM candidacies/tenures` — a
--      cross-table aggregate, which is not allowed in a generated
--      column expression. So state_fips_primary is a regular column
--      maintained by:
--        - one-time backfill in this migration from candidacies +
--          office_tenures + people.meta.created_for_state_fips +
--          people.meta.fetch_state, in that priority order;
--        - the candidate-resolver and apply scripts on every write.)
--   2. Drop the deferred conditional uq_people_canonical_key index
--      logic — it's superseded by the state-scoped index.
--   3. Create UNIQUE INDEX uq_people_canonical_key_state on
--      (canonical_key, COALESCE(state_fips_primary, '')) so rows
--      with no derived state still get uniquely constrained on
--      canonical_key alone (no two state-less rows can share a key).
--
-- The migration is ADDITIVE: existing data stays valid because
-- backfill assigns each row its earliest-derived state_fips, and
-- the resulting (canonical_key, state_fips_primary) tuples are
-- unique by definition for the 250 manual-review groups (every
-- group's blocker reason lists distinct derived states).
-- ============================================================

-- ------------------------------------------------------------
-- 1. Add the column
-- ------------------------------------------------------------

ALTER TABLE people
  ADD COLUMN IF NOT EXISTS state_fips_primary TEXT;

COMMENT ON COLUMN people.state_fips_primary IS
  'Primary state FIPS for person identity scoping. Derived from candidacies → '
  'office_tenures → meta.created_for_state_fips → meta.fetch_state, in that '
  'priority order. NULL only when no state can be inferred. Maintained by '
  'apply scripts and the candidate-resolver on every people write. Together '
  'with canonical_key forms the dedup key — cross-state same-canonical-name '
  'people are different humans, not duplicates (operator, 2026-05-02).';

-- ------------------------------------------------------------
-- 2. Backfill state_fips_primary
--
-- Priority order, first non-null wins:
--   (a) earliest candidacy → election → office → jurisdiction.fips_state
--   (b) earliest office_tenure → office → jurisdiction.fips_state
--   (c) people.meta->>'created_for_state_fips' (set by candidate-resolver)
--   (d) STATE_FIPS lookup of people.meta->>'fetch_state' (apply-2026 sets this)
--
-- Idempotent: only updates rows where state_fips_primary IS NULL.
-- ------------------------------------------------------------

-- (a) From earliest candidacy
UPDATE people p
SET state_fips_primary = sub.fips_state
FROM (
  SELECT DISTINCT ON (c.person_id)
    c.person_id,
    j.fips_state
  FROM candidacies c
  JOIN elections e ON e.id = c.election_id
  JOIN offices o ON o.id = e.office_id
  JOIN jurisdictions j ON j.id = o.jurisdiction_id
  WHERE j.fips_state IS NOT NULL
  ORDER BY c.person_id, c.created_at ASC, c.id ASC
) sub
WHERE p.id = sub.person_id
  AND p.state_fips_primary IS NULL;

-- (b) From earliest office_tenure (catches incumbents with no candidacy yet)
UPDATE people p
SET state_fips_primary = sub.fips_state
FROM (
  SELECT DISTINCT ON (ot.person_id)
    ot.person_id,
    j.fips_state
  FROM office_tenures ot
  JOIN offices o ON o.id = ot.office_id
  JOIN jurisdictions j ON j.id = o.jurisdiction_id
  WHERE j.fips_state IS NOT NULL
  ORDER BY ot.person_id, ot.started_on ASC NULLS LAST, ot.id ASC
) sub
WHERE p.id = sub.person_id
  AND p.state_fips_primary IS NULL;

-- (c) From meta.created_for_state_fips (resolver writes this on insert)
UPDATE people
SET state_fips_primary = NULLIF(TRIM(meta->>'created_for_state_fips'), '')
WHERE state_fips_primary IS NULL
  AND meta ? 'created_for_state_fips'
  AND NULLIF(TRIM(meta->>'created_for_state_fips'), '') IS NOT NULL
  AND NULLIF(TRIM(meta->>'created_for_state_fips'), '') ~ '^\d{2}$';

-- (d) From meta.fetch_state (apply-2026-candidates writes 2-char state code)
-- Note: jsonb_build_object is capped at 100 arguments (50 pairs); we have 56
-- states + territories. Using a JSON string literal cast avoids that limit.
DO $$
DECLARE
  v_fips_map jsonb := '{
    "AL":"01","AK":"02","AZ":"04","AR":"05","CA":"06","CO":"08","CT":"09","DE":"10","DC":"11","FL":"12",
    "GA":"13","HI":"15","ID":"16","IL":"17","IN":"18","IA":"19","KS":"20","KY":"21","LA":"22","ME":"23",
    "MD":"24","MA":"25","MI":"26","MN":"27","MS":"28","MO":"29","MT":"30","NE":"31","NV":"32","NH":"33",
    "NJ":"34","NM":"35","NY":"36","NC":"37","ND":"38","OH":"39","OK":"40","OR":"41","PA":"42","RI":"44",
    "SC":"45","SD":"46","TN":"47","TX":"48","UT":"49","VT":"50","VA":"51","WA":"53","WV":"54","WI":"55","WY":"56",
    "AS":"60","GU":"66","MP":"69","PR":"72","VI":"78"
  }'::jsonb;
BEGIN
  UPDATE people p
  SET state_fips_primary = v_fips_map->>UPPER(TRIM(p.meta->>'fetch_state'))
  WHERE p.state_fips_primary IS NULL
    AND p.meta ? 'fetch_state'
    AND v_fips_map ? UPPER(TRIM(p.meta->>'fetch_state'));
END $$;

-- ------------------------------------------------------------
-- 3. Drop the deferred state-free unique index (if it ever got
--    created) and the associated conditional logic. The state-
--    scoped index below replaces it.
-- ------------------------------------------------------------

DROP INDEX IF EXISTS uq_people_canonical_key;

-- ------------------------------------------------------------
-- 4. Create the state-scoped unique index.
--
-- COALESCE so NULL state_fips_primary doesn't produce per-row
-- distinct index keys (NULL semantics in unique indexes). Using
-- '' as the sentinel means: among rows with NO derived state,
-- canonical_key still has to be unique. Once any of those rows
-- gets a candidacy/tenure attached, a re-backfill (or a write
-- by apply-2026) fills state_fips_primary and the row joins its
-- proper state bucket.
-- ------------------------------------------------------------

DO $$
DECLARE
  v_dup_count INT;
  v_dup_sample TEXT;
BEGIN
  SELECT count(*) INTO v_dup_count
  FROM (
    SELECT canonical_key, COALESCE(state_fips_primary, '')
    FROM people
    WHERE canonical_key IS NOT NULL
    GROUP BY canonical_key, COALESCE(state_fips_primary, '')
    HAVING count(*) > 1
  ) s;

  IF v_dup_count = 0 THEN
    CREATE UNIQUE INDEX IF NOT EXISTS uq_people_canonical_key_state
      ON people (canonical_key, COALESCE(state_fips_primary, ''))
      WHERE canonical_key IS NOT NULL;
    RAISE NOTICE 'people uq_people_canonical_key_state UNIQUE INDEX created (no (key, state) duplicates).';
  ELSE
    SELECT string_agg(
      canonical_key || '|' || COALESCE(state_fips_primary, '<null>'),
      ', '
    ) INTO v_dup_sample
    FROM (
      SELECT canonical_key, state_fips_primary
      FROM people
      WHERE canonical_key IS NOT NULL
      GROUP BY canonical_key, state_fips_primary
      HAVING count(*) > 1
      LIMIT 20
    ) s;
    RAISE NOTICE 'people has % (key, state) duplicate group(s) — UNIQUE INDEX deferred. Sample: %', v_dup_count, v_dup_sample;
  END IF;
END $$;

-- Plain (non-unique) lookup index on the new column for the
-- (canonical_key, state_fips_primary) lookup path.
CREATE INDEX IF NOT EXISTS idx_people_canonical_key_state
  ON people (canonical_key, state_fips_primary)
  WHERE canonical_key IS NOT NULL;
