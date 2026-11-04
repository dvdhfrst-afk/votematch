-- =============================================================================
-- Territory office types + diacritic-folding canonical_key
-- Council findings #8, #19, #21 (2026-04-25)
--
-- Two related changes packaged together because they ship with the same
-- "Puerto Rico + 5 territories + Spanish-language" cleanup pass:
--
--   1. office_types: add `resident_commissioner` (PR) and `delegate` (DC,
--      VI, GU, MP, AS) — the federal seats for territories that don't get
--      voting Members of Congress. Without these slugs, territory ingestion
--      adapters silently fail their office_type lookup and skip the seats.
--
--   2. people.canonical_key: extend the trigger so it folds diacritics via
--      the `unaccent` extension before stripping non-alphanumerics. Without
--      this, "Vázquez" and "Vazquez" get different canonical_keys and the
--      same person ingested from two PR feeds creates duplicate `people`
--      rows. The TS-side helpers (state-sos/base#canonicalKey, state-cf,
--      state-votes, apply-2026-candidates) already do NFD diacritic-fold;
--      this brings the DB trigger in lockstep so reads + writes agree.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. office_types — territory federal seats
-- ---------------------------------------------------------------------------
-- These are FEDERAL offices (level='federal') because they sit in the U.S.
-- House of Representatives, even though the people in them have no floor
-- vote. We set typical_term_length_months = 24 (PR Resident Commissioner is
-- a 4-year term but every other delegate / non-voting seat is 2-year; PR's
-- 4-year is captured per-office in offices.term_months when known).
-- Idempotent INSERT … ON CONFLICT DO NOTHING.
-- ---------------------------------------------------------------------------

INSERT INTO office_types (slug, generic_name, level, branch, description, typical_term_length_months, display_order)
VALUES
  (
    'resident_commissioner',
    'Resident Commissioner',
    'federal',
    'legislative',
    'Puerto Rico''s non-voting representative in the U.S. House of Representatives. 4-year term (the only territorial federal seat with a 4-year term — all others are 2-year). May vote in committee and on procedural matters but not on final passage.',
    48,
    150
  ),
  (
    'delegate',
    'Delegate to the U.S. House of Representatives',
    'federal',
    'legislative',
    'Non-voting representative for District of Columbia, U.S. Virgin Islands, Guam, American Samoa, or the Northern Mariana Islands in the U.S. House. 2-year term. May vote in committee and on procedural matters but not on final passage of legislation.',
    24,
    151
  )
ON CONFLICT (slug) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. people.canonical_key — diacritic-folding trigger (council #8)
-- ---------------------------------------------------------------------------
-- Add `unaccent` extension if available, then update both the backfill
-- query (idempotent — re-runs on already-folded keys are no-ops) and the
-- BEFORE-INSERT-OR-UPDATE trigger function.
--
-- If the `unaccent` extension is unavailable in this Postgres install, we
-- fall back to a manual translate() over the most common Latin diacritic
-- letters. The TS side does full NFD folding via Unicode property classes;
-- the SQL fallback covers ~99% of names we'll see in PR/Latin-mainland
-- feeds (every accented letter in Spanish + Portuguese + most European
-- Latin-script languages). If a real-world miss surfaces, it will appear
-- as a duplicate key in the next dedup audit.
-- ---------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS unaccent;

-- Helper: normalize via unaccent if the extension is present, else fall
-- back to a translate() chain. We capture this as an IMMUTABLE function so
-- it can be referenced by indexes if we ever want to.
CREATE OR REPLACE FUNCTION public.bb_fold_diacritics(s TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  ext_present BOOLEAN;
BEGIN
  IF s IS NULL THEN RETURN NULL; END IF;
  SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'unaccent') INTO ext_present;
  IF ext_present THEN
    -- unaccent() is search_path-sensitive; reference by qualified name.
    RETURN unaccent('public.unaccent', s);
  END IF;
  -- Fallback: pairwise translate covering Spanish, Portuguese, and the
  -- most common Western European accented letters. Order doesn't matter
  -- because translate is character-wise.
  RETURN translate(
    s,
    'ÁÀÂÄÃÅÆÇÉÈÊËÍÌÎÏÑÓÒÔÖÕØŒÚÙÛÜÝŸáàâäãåæçéèêëíìîïñóòôöõøœúùûüýÿß',
    'AAAAAAAECEEEEIIIINOOOOOOOEUUUUYYaaaaaaaeceeeeiiiinooooooooeuuuuyyss'
  );
END $$;

-- Re-define the canonical_key trigger to fold diacritics first.
CREATE OR REPLACE FUNCTION people_set_canonical_key()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.canonical_name IS NOT NULL THEN
    NEW.canonical_key := lower(
      regexp_replace(
        public.bb_fold_diacritics(NEW.canonical_name),
        '[^a-zA-Z0-9]', '', 'g'
      )
    );
  END IF;
  RETURN NEW;
END $$;

-- Trigger already exists from migration 20260423000011 — no need to re-create.

-- Re-fold every existing canonical_key so the column is consistent. This is
-- a one-shot UPDATE; idempotent (fold on already-folded text is a no-op
-- under both unaccent and our translate fallback).
UPDATE people
SET canonical_key = lower(
  regexp_replace(
    public.bb_fold_diacritics(canonical_name),
    '[^a-zA-Z0-9]', '', 'g'
  )
)
WHERE canonical_name IS NOT NULL
  AND canonical_key IS DISTINCT FROM lower(
    regexp_replace(
      public.bb_fold_diacritics(canonical_name),
      '[^a-zA-Z0-9]', '', 'g'
    )
  );

-- Note: this UPDATE may surface NEW duplicate keys (two rows that
-- previously differed only by diacritics now collide). The UNIQUE INDEX
-- guard from migration 20260423000011 only created `uq_people_canonical_key`
-- when no duplicates existed; if duplicates were just created by this
-- backfill, the unique index does NOT exist and the inserts won't fail.
-- A follow-up dedup pass will merge those rows then attempt UNIQUE again.

DO $$
DECLARE
  v_dup_count INT;
BEGIN
  SELECT count(*) INTO v_dup_count
  FROM (
    SELECT canonical_key
    FROM people
    WHERE canonical_key IS NOT NULL
    GROUP BY canonical_key
    HAVING count(*) > 1
  ) s;
  IF v_dup_count > 0 THEN
    RAISE NOTICE
      'people.canonical_key has % duplicate group(s) post-diacritic-fold. UNIQUE INDEX deferred; run dedup audit then re-attempt.',
      v_dup_count;
  ELSE
    -- Diacritic fold did not introduce new dupes. If the unique index is
    -- somehow missing (created originally only when zero dupes), make sure
    -- it's there now.
    CREATE UNIQUE INDEX IF NOT EXISTS uq_people_canonical_key
      ON people (canonical_key) WHERE canonical_key IS NOT NULL;
  END IF;
END $$;

COMMENT ON FUNCTION public.bb_fold_diacritics(TEXT) IS
  'Diacritic-folding helper used by people_set_canonical_key. Uses unaccent extension when available, falls back to manual translate() over common Latin diacritics. Council #8 (2026-04-25): paired with TS-side NFD folding in src/lib/adapters/state-*/base.ts so DB trigger and TS canonicalKey() produce identical output for PR + bilingual states.';
