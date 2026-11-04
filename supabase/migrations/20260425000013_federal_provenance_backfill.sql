-- ============================================================
-- Federal provenance backfill: insert canonical data_sources rows
-- and retrofit federal_bills / federal_votes / federal_vote_positions
-- with their data_source_id.
-- ============================================================
--
-- Council finding (2026-04-25): all 5,826 federal_bills, all 105,317
-- federal_vote_positions, and the parent federal_votes rows had
-- data_source_id = NULL. Lineage couldn't be proven; /corrections
-- couldn't trace any row back to its source.
--
-- Root cause: the federal-bills and federal-votes adapters use the
-- shared runAdapter framework (which DOES upsert data_sources rows
-- and links them on ingestion_runs), but their `insert()` methods
-- explicitly `void refs` and never write data_source_id onto the
-- domain rows. ingest-senate-votes.ts bypasses runAdapter entirely
-- as a one-off script. Both bugs are fixed in the same change-set
-- as this migration (see federal-bills-adapter.ts /
-- federal-votes-adapter.ts / ingest-senate-votes.ts).
--
-- This migration:
--   1. Inserts three canonical data_sources rows (House bills,
--      House votes, Senate votes) with content_hash = md5(url)
--      placeholders. Real fetches will produce real sha256 hashes
--      via runAdapter; these are retrofit markers only and are
--      flagged via meta.retrofit = true.
--   2. Backfills federal_bills.data_source_id, federal_votes.data_source_id,
--      and federal_vote_positions.data_source_id for all NULL rows.
--
-- Idempotent: ON CONFLICT DO NOTHING + WHERE data_source_id IS NULL.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Canonical data_sources rows
-- ------------------------------------------------------------
-- Use a unique partial index trick via a CTE so we don't double-insert
-- on re-run. Existing schema has no UNIQUE constraint on (name), so
-- we guard with NOT EXISTS.

INSERT INTO data_sources (
  source_type, name, url, content_hash, license, fetched_at,
  last_successful_fetch_at, meta
)
SELECT
  'federal_api',
  'congress-gov-bills',
  'https://api.congress.gov/v3/bill/119',
  md5('https://api.congress.gov/v3/bill/119'),  -- retrofit placeholder; future runs compute sha256
  'public_domain',
  now(),
  now(),
  jsonb_build_object(
    'retrofit', true,
    'note', 'inserted by 2026-04-25 backfill - original ingestion did not write data_source_id',
    'congress', 119,
    'placeholder_hash', true
  )
WHERE NOT EXISTS (
  SELECT 1 FROM data_sources WHERE name = 'congress-gov-bills'
);

INSERT INTO data_sources (
  source_type, name, url, content_hash, license, fetched_at,
  last_successful_fetch_at, meta
)
SELECT
  'federal_vote_record',
  'congress-gov-house-votes',
  'https://api.congress.gov/v3/house-vote/119/1',
  md5('https://api.congress.gov/v3/house-vote/119/1'),
  'public_domain',
  now(),
  now(),
  jsonb_build_object(
    'retrofit', true,
    'note', 'inserted by 2026-04-25 backfill - original ingestion did not write data_source_id',
    'congress', 119,
    'session', 1,
    'placeholder_hash', true
  )
WHERE NOT EXISTS (
  SELECT 1 FROM data_sources WHERE name = 'congress-gov-house-votes'
);

INSERT INTO data_sources (
  source_type, name, url, content_hash, license, fetched_at,
  last_successful_fetch_at, meta
)
SELECT
  'federal_vote_record',
  'senate-gov-rollcall-xml',
  'https://www.senate.gov/legislative/LIS/roll_call_lists/vote_menu_119_1.xml',
  md5('https://www.senate.gov/legislative/LIS/roll_call_lists/vote_menu_119_1.xml'),
  'public_domain',
  now(),
  now(),
  jsonb_build_object(
    'retrofit', true,
    'note', 'inserted by 2026-04-25 backfill - original ingestion did not write data_source_id (script bypassed runAdapter)',
    'congress', 119,
    'session', 1,
    'placeholder_hash', true
  )
WHERE NOT EXISTS (
  SELECT 1 FROM data_sources WHERE name = 'senate-gov-rollcall-xml'
);

-- ------------------------------------------------------------
-- 2. federal_bills backfill
-- ------------------------------------------------------------
-- All 5,826 rows currently have NULL. House (hr*) and Senate (s*) bills
-- both came from Congress.gov v3 /bill/{congress} endpoints. We attribute
-- both to the canonical 'congress-gov-bills' row -- the URL pattern is
-- identical for both chambers (just different bill_type filter), so a
-- single source row is faithful to lineage.

UPDATE federal_bills
   SET data_source_id = (SELECT id FROM data_sources WHERE name = 'congress-gov-bills' LIMIT 1)
 WHERE data_source_id IS NULL;

-- ------------------------------------------------------------
-- 3. federal_votes backfill (parent table)
-- ------------------------------------------------------------
-- Split by chamber: house -> congress-gov-house-votes,
-- senate -> senate-gov-rollcall-xml.

UPDATE federal_votes
   SET data_source_id = CASE
     WHEN chamber = 'house'  THEN (SELECT id FROM data_sources WHERE name = 'congress-gov-house-votes' LIMIT 1)
     WHEN chamber = 'senate' THEN (SELECT id FROM data_sources WHERE name = 'senate-gov-rollcall-xml' LIMIT 1)
     ELSE NULL
   END
 WHERE data_source_id IS NULL;

-- ------------------------------------------------------------
-- 4. federal_vote_positions backfill
-- ------------------------------------------------------------
-- Join through federal_votes.chamber to pick the right source per row.

UPDATE federal_vote_positions fvp
   SET data_source_id = CASE
     WHEN fv.chamber = 'house'  THEN (SELECT id FROM data_sources WHERE name = 'congress-gov-house-votes' LIMIT 1)
     WHEN fv.chamber = 'senate' THEN (SELECT id FROM data_sources WHERE name = 'senate-gov-rollcall-xml' LIMIT 1)
     ELSE NULL
   END
  FROM federal_votes fv
 WHERE fvp.vote_id = fv.id
   AND fvp.data_source_id IS NULL;

-- ------------------------------------------------------------
-- 5. Verification (raises NOTICE; does not fail if non-zero so the
-- migration is idempotent and re-runnable).
-- ------------------------------------------------------------

DO $$
DECLARE
  n_bills INT;
  n_votes INT;
  n_positions INT;
BEGIN
  SELECT count(*) INTO n_bills FROM federal_bills WHERE data_source_id IS NULL;
  SELECT count(*) INTO n_votes FROM federal_votes WHERE data_source_id IS NULL;
  SELECT count(*) INTO n_positions FROM federal_vote_positions WHERE data_source_id IS NULL;

  RAISE NOTICE 'Federal provenance backfill: federal_bills NULL=%, federal_votes NULL=%, federal_vote_positions NULL=%',
    n_bills, n_votes, n_positions;

  IF n_bills > 0 OR n_votes > 0 OR n_positions > 0 THEN
    RAISE WARNING 'Some federal rows still have NULL data_source_id after backfill. Investigate before relying on /corrections.';
  END IF;
END $$;

COMMENT ON COLUMN federal_bills.data_source_id IS 'Lineage FK to data_sources.id. Pre-2026-04-25 rows were backfilled by migration 20260425000013 to canonical congress-gov-bills source row (placeholder content_hash). Future inserts populate via runAdapter -> federalBillsAdapter.insert().';
