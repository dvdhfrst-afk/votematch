-- ============================================================
-- field_extraction_spans — source-grounded citation verification
-- ============================================================
--
-- Goal: every extracted field (basic-data fields like contact_email or
-- party, and policy positions like score) carries a (source_url,
-- char_start, char_end, snippet) tuple that can be re-verified against
-- the live URL. If the snippet no longer appears verbatim at the URL,
-- the row flips to 'snippet_missing' and the field is treated as stale.
--
-- Polymorphic owner: a span belongs to exactly ONE of:
--   - position_id   (a row in `positions` — policy stance)
--   - candidacy_id  (a row in `candidacies` — race-bound facts)
--   - person_id     (a row in `people` — person-level facts)
-- The CHECK constraint enforces "exactly one is set" so we never get
-- ambiguous owners and never get spans floating with no owner.
--
-- Verification semantics (see src/lib/extraction/citation-verifier.ts):
--   pending          — never been checked, default for new inserts
--   verified         — snippet matched the live URL on verified_at
--   snippet_missing  — URL fetched OK but snippet not present anymore
--                      (page rewritten, candidate removed it, etc.)
--   url_unreachable  — fetch failed (404, timeout, DNS, etc.)
--   stale            — verified historically but verified_at older than
--                      the field's freshness SLA (set by a separate sweep)
--
-- License-aware fast path: if source_url's host is in a known share-alike
-- list (Wikipedia, Ballotpedia), the verifier marks 'verified' with a
-- meta note 'license_pass_through' WITHOUT redistributing the body — the
-- field came from a reference-only source, so the BB DB stores only the
-- URL + claim, not the snippet text from those hosts.
--
-- The (source_url, char_start, char_end) triple lets a UI render
-- "show me where this came from" by deep-linking back into the source.
-- char_start/char_end are nullable because some extractors only know
-- "this URL grounds the claim" without exact offsets.
-- ============================================================

CREATE TABLE IF NOT EXISTS field_extraction_spans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Polymorphic owner: position_id OR candidacy_id OR person_id is set; exactly one.
  position_id UUID REFERENCES positions(id) ON DELETE CASCADE,
  candidacy_id UUID REFERENCES candidacies(id) ON DELETE CASCADE,
  person_id UUID REFERENCES people(id) ON DELETE CASCADE,
  field_name TEXT NOT NULL,                  -- 'contact_email' | 'party' | 'score' | ...
  field_value TEXT,                          -- the extracted value as a string
  source_url TEXT NOT NULL,
  char_start INT,                            -- nullable: span unknown but URL grounds the claim
  char_end INT,
  snippet TEXT,                              -- the verbatim text from the source
  verified_at TIMESTAMPTZ,                   -- last time the snippet was confirmed against the URL
  verification_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (verification_status IN ('pending','verified','snippet_missing','url_unreachable','stale')),
  extractor TEXT,                            -- 'phi4:14b' | 'opus-4.7' | 'manual' | ...
  meta JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Exactly one of position_id/candidacy_id/person_id must be set
ALTER TABLE field_extraction_spans
  DROP CONSTRAINT IF EXISTS field_extraction_spans_owner_check;
ALTER TABLE field_extraction_spans
  ADD CONSTRAINT field_extraction_spans_owner_check CHECK (
    (position_id IS NOT NULL)::int +
    (candidacy_id IS NOT NULL)::int +
    (person_id IS NOT NULL)::int = 1
  );

-- Indexes for lookup by owner and verification work queue
CREATE INDEX IF NOT EXISTS idx_fes_position
  ON field_extraction_spans(position_id) WHERE position_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fes_candidacy
  ON field_extraction_spans(candidacy_id) WHERE candidacy_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fes_person
  ON field_extraction_spans(person_id) WHERE person_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fes_pending
  ON field_extraction_spans(verification_status) WHERE verification_status = 'pending';

ALTER TABLE field_extraction_spans ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public read field_extraction_spans" ON field_extraction_spans;
CREATE POLICY "Public read field_extraction_spans"
  ON field_extraction_spans FOR SELECT
  USING (true);

COMMENT ON TABLE field_extraction_spans IS
  'Source-grounded citation spans for every extracted field on positions / candidacies / people. '
  'Each row is (owner, field_name, field_value, source_url, [char_start, char_end], snippet). '
  'A verifier (src/lib/extraction/citation-verifier.ts) periodically refetches source_url and confirms '
  'snippet still appears verbatim there (with tight regex tolerance for emails / *_url fields). '
  'Status flips to snippet_missing when the page no longer contains the claim — that is the signal '
  'that the field is stale and the voter-facing surface should hide or recheck it. License-aware: '
  'share-alike hosts (Wikipedia, Ballotpedia) are marked verified with meta.license_pass_through=true '
  'without storing redistributable content, since BB never copies CC-BY-SA bodies into its DB.';

-- Migration registration is handled automatically by the Supabase CLI.
