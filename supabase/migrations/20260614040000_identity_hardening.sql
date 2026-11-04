-- =============================================================================
-- 20260614040000_identity_hardening.sql
--
-- Build 5 of the candidate-research ingestion engine: identity-resolution
-- hardening. ADDITIVE ONLY. No destructive change to any existing table.
--
-- What this migration provides for the hardened resolver (identity-resolve.ts):
--
--   1. fuzzystrmatch  - gives us jaro_winkler(a, b) for name comparison. The
--      resolver issues SQL that calls jaro_winkler() server-side (NOT a JS
--      reimplementation), so the comparison stays in one runtime and one place.
--
--   2. pg_trgm        - gives us similarity(a, b) (trigram cosine-ish score) and
--      the gin_trgm_ops operator class so a GIN (Generalized Inverted Index)
--      index can BLOCK candidate-name comparisons (only compare names that share
--      trigrams, instead of scanning every people row).
--
--   3. A GIN trigram index on people.canonical_name. NOTE: an index with the
--      same name (idx_people_name_trgm) was declared in
--      20260420000006_office_centric_graph.sql, but that DDL ran BEFORE pg_trgm
--      was guaranteed installed, so on a fresh stack it may be missing. We
--      CREATE EXTENSION first, then CREATE INDEX IF NOT EXISTS so this is a
--      no-op when the earlier index already exists and a repair when it does
--      not. Either way the blocking index is guaranteed present after this.
--
--   4. do_not_merge - a sticky "these two people are DIFFERENT humans, never
--      propose a merge" table. The resolver and the duplicate scanner both
--      consult it: a pair listed here is never auto-merged and never enqueued as
--      a promotable dedup candidate, no matter how close the names look. This is
--      the human-overrideable namesake guard (e.g. two real "John Smith"s in the
--      same state who were once flagged and confirmed distinct).
--
-- Single TypeScript runtime elsewhere; this is the only place fuzzy matching
-- lives (Postgres-side) per the build brief. No new npm dependency is added.
-- No em-dashes / en-dashes; acronyms spelled out on first use above.
-- =============================================================================

-- ------------------------------------------------------------
-- Extensions (the live DB is a local Postgres; CREATE EXTENSION is allowed).
-- ------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS fuzzystrmatch;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ------------------------------------------------------------
-- Blocking index: GIN trigram on people.canonical_name.
-- Idempotent. Repairs the case where the office-centric-graph migration
-- declared this index before pg_trgm was installed.
-- ------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_people_name_trgm
  ON people USING GIN (canonical_name gin_trgm_ops);

-- ------------------------------------------------------------
-- do_not_merge: sticky non-merge pairs (namesake guard, human-overrideable).
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS do_not_merge (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Ordered pair: person_id_a < person_id_b. The CHECK below makes the pair
  -- canonical (so (X, Y) and (Y, X) cannot both be stored) and the UNIQUE
  -- constraint then makes the pair idempotent.
  person_id_a UUID NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  person_id_b UUID NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (person_id_a < person_id_b),
  UNIQUE (person_id_a, person_id_b)
);

-- Lookup helpers so "is this pair sticky?" is a fast index probe in BOTH
-- directions (the UNIQUE constraint already covers (a) leading; add (b) leading
-- for the symmetric probe).
CREATE INDEX IF NOT EXISTS idx_do_not_merge_b ON do_not_merge (person_id_b);

ALTER TABLE do_not_merge ENABLE ROW LEVEL SECURITY;
-- No public policies: service_role bypasses RLS and the admin layer is already
-- gated by users.role. Matches the dedup_review_queue / endorsement-queue
-- posture (no anon read on review-internal data).

COMMENT ON TABLE do_not_merge IS
  'Sticky non-merge pairs. A (person_id_a, person_id_b) here means a human (or a '
  'guard rule) confirmed the two are DIFFERENT people; identity-resolve never '
  'proposes a merge and detect-duplicate-people never enqueues a promotable '
  'dedup row for the pair. CHECK(person_id_a < person_id_b) keeps the pair '
  'canonical; UNIQUE makes it idempotent.';
