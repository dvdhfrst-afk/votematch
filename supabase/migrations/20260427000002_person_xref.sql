-- ============================================================
-- person_xref — formal external-identifier cross-reference
-- ============================================================
--
-- Council punch-list P1-8.
--
-- Problem: fec_candidate_id, bioguide_id, openstates_id, and per-state
-- SoS filer_ids currently live in people.meta as ad-hoc keys. There's
-- no UNIQUE constraint, no enforcement that one person has at most one
-- FEC id, and no efficient "find the person who has FEC id Hxxxxxxx"
-- lookup. Result: at scale, the same human gets stored as two people
-- when one feed uses canonical_name and another uses an ID.
--
-- Solution: a formal xref table with:
--   - (kind, external_id) UNIQUE → enforces one person per external id
--   - person_id FK → enforces every xref points to a real person
--   - confidence + evidence → so the auto-engine can downgrade a low-
--     confidence FEC↔state match without losing it
--
-- The kinds we care about today (extensible — any TEXT is allowed but
-- the registered set below is what every adapter should use):
--   fec_candidate_id      — FEC candidate ID (e.g. H6CA12345)
--   fec_committee_id      — FEC principal committee ID (Cxxxxxxxx)
--   bioguide_id           — Congress.gov bioguide ID (e.g. M001213)
--   openstates_id         — OpenStates legislator id (license-aware: ref only,
--                           do not redistribute under share-alike)
--   state_filer_id        — per-state SoS filer id (NM, MD, etc.)
--   ballotpedia_url       — Ballotpedia profile URL (CC-BY-SA, ref only)
--   wikipedia_url         — Wikipedia URL (ref only)
--   ocd_id                — OpenCivicData ID (e.g. ocd-person/abc123)
--   linkedin_url          — LinkedIn profile URL
--   campaign_website_url  — primary campaign site (also stored on people
--                           for convenience but indexed here for dedup)
--
-- Backfill: read existing people.meta entries (fec_candidate_id,
-- bioguide_id, etc.) and copy them into person_xref. Source becomes
-- 'meta_backfill_2026_04_27'. After backfill, future writes go through
-- both surfaces; eventually meta keys for IDs can be deprecated.
-- ============================================================

CREATE TABLE IF NOT EXISTS person_xref (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id UUID NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  external_id TEXT NOT NULL,
  confidence TEXT NOT NULL DEFAULT 'high'
    CHECK (confidence IN ('high','medium','low')),
  evidence TEXT,
  source TEXT NOT NULL,                 -- the adapter / script that wrote this
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One person per external id PER kind. (FEC id can map to exactly one
  -- person; if two scripts disagree, the conflict surfaces here, not
  -- silently in meta.)
  UNIQUE (kind, external_id)
);

CREATE INDEX IF NOT EXISTS idx_person_xref_person ON person_xref(person_id);
CREATE INDEX IF NOT EXISTS idx_person_xref_kind   ON person_xref(kind);
CREATE INDEX IF NOT EXISTS idx_person_xref_lookup ON person_xref(kind, external_id);

DROP TRIGGER IF EXISTS trg_person_xref_updated_at ON person_xref;
CREATE TRIGGER trg_person_xref_updated_at BEFORE UPDATE ON person_xref
  FOR EACH ROW EXECUTE FUNCTION bump_updated_at();

ALTER TABLE person_xref ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read person_xref"
  ON person_xref FOR SELECT
  USING (true);

COMMENT ON TABLE person_xref IS
  'Cross-reference of external identifiers (FEC, Bioguide, OpenStates, state SoS filer IDs, etc.) '
  'to canonical people. UNIQUE(kind, external_id) enforces one person per id; conflicts surface '
  'as INSERT failures the auto-engine can route to review_queue. Replaces ad-hoc keys in people.meta.';

-- ------------------------------------------------------------
-- Helper: idempotent upsert that handles "already mapped to a different person"
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION upsert_person_xref(
  p_person_id UUID,
  p_kind TEXT,
  p_external_id TEXT,
  p_confidence TEXT DEFAULT 'high',
  p_evidence TEXT DEFAULT NULL,
  p_source TEXT DEFAULT 'unknown'
) RETURNS TABLE (xref_id UUID, action TEXT)
LANGUAGE plpgsql AS $$
DECLARE
  v_existing person_xref%ROWTYPE;
BEGIN
  SELECT * INTO v_existing
  FROM person_xref
  WHERE kind = p_kind AND external_id = p_external_id;

  IF v_existing.id IS NULL THEN
    -- Brand new mapping
    INSERT INTO person_xref (person_id, kind, external_id, confidence, evidence, source)
    VALUES (p_person_id, p_kind, p_external_id, p_confidence, p_evidence, p_source)
    RETURNING id INTO xref_id;
    action := 'inserted';
    RETURN NEXT;
    RETURN;
  END IF;

  IF v_existing.person_id = p_person_id THEN
    -- Same mapping reasserted; refresh confidence if higher
    IF (p_confidence = 'high' AND v_existing.confidence <> 'high')
       OR (p_confidence = 'medium' AND v_existing.confidence = 'low') THEN
      UPDATE person_xref
         SET confidence = p_confidence,
             evidence   = COALESCE(p_evidence, evidence),
             source     = p_source
       WHERE id = v_existing.id;
      action := 'upgraded';
    ELSE
      action := 'unchanged';
    END IF;
    xref_id := v_existing.id;
    RETURN NEXT;
    RETURN;
  END IF;

  -- Conflict: same external id is already mapped to a *different* person.
  -- Do NOT silently overwrite. Surface the conflict so dedup-people
  -- or review_queue can resolve it.
  RAISE NOTICE 'person_xref conflict: % % already maps to person %, refused to remap to %',
    p_kind, p_external_id, v_existing.person_id, p_person_id;
  xref_id := v_existing.id;
  action := 'conflict';
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION upsert_person_xref IS
  'Idempotent xref upsert. On conflict (same external id, different person), '
  'NOTICEs and returns action=conflict — does NOT silently overwrite. '
  'Caller (apply scripts) should log conflicts for review.';

-- ------------------------------------------------------------
-- Backfill from people.meta
-- ------------------------------------------------------------

INSERT INTO person_xref (person_id, kind, external_id, confidence, source)
SELECT
  p.id,
  'fec_candidate_id',
  p.meta->>'fec_candidate_id',
  'high',
  'meta_backfill_2026_04_27'
FROM people p
WHERE p.meta ? 'fec_candidate_id'
  AND p.meta->>'fec_candidate_id' IS NOT NULL
  AND p.meta->>'fec_candidate_id' <> ''
ON CONFLICT (kind, external_id) DO NOTHING;

INSERT INTO person_xref (person_id, kind, external_id, confidence, source)
SELECT
  p.id,
  'bioguide_id',
  p.meta->>'bioguide_id',
  'high',
  'meta_backfill_2026_04_27'
FROM people p
WHERE p.meta ? 'bioguide_id'
  AND p.meta->>'bioguide_id' IS NOT NULL
  AND p.meta->>'bioguide_id' <> ''
ON CONFLICT (kind, external_id) DO NOTHING;

INSERT INTO person_xref (person_id, kind, external_id, confidence, source)
SELECT
  p.id,
  'openstates_id',
  p.meta->>'openstates_id',
  'medium',  -- OpenStates is share-alike; mapping is reference-only
  'meta_backfill_2026_04_27'
FROM people p
WHERE p.meta ? 'openstates_id'
  AND p.meta->>'openstates_id' IS NOT NULL
  AND p.meta->>'openstates_id' <> ''
ON CONFLICT (kind, external_id) DO NOTHING;

INSERT INTO person_xref (person_id, kind, external_id, confidence, source)
SELECT
  p.id,
  'campaign_website_url',
  p.meta->>'campaign_website_url',
  'medium',  -- websites change; freshness is unknown at backfill time
  'meta_backfill_2026_04_27'
FROM people p
WHERE p.meta ? 'campaign_website_url'
  AND p.meta->>'campaign_website_url' IS NOT NULL
  AND p.meta->>'campaign_website_url' <> ''
ON CONFLICT (kind, external_id) DO NOTHING;

INSERT INTO person_xref (person_id, kind, external_id, confidence, source)
SELECT
  p.id,
  'ballotpedia_url',
  p.meta->>'ballotpedia_url',
  'low',     -- CC-BY-SA — reference only, not for redistribution
  'meta_backfill_2026_04_27'
FROM people p
WHERE p.meta ? 'ballotpedia_url'
  AND p.meta->>'ballotpedia_url' IS NOT NULL
  AND p.meta->>'ballotpedia_url' <> ''
ON CONFLICT (kind, external_id) DO NOTHING;

-- ------------------------------------------------------------
-- v_person_xref_summary — at-a-glance per-person
-- ------------------------------------------------------------

CREATE OR REPLACE VIEW public.v_person_xref_summary AS
SELECT
  p.id           AS person_id,
  p.canonical_name,
  bool_or(px.kind = 'fec_candidate_id')      AS has_fec,
  bool_or(px.kind = 'bioguide_id')           AS has_bioguide,
  bool_or(px.kind = 'openstates_id')         AS has_openstates,
  bool_or(px.kind = 'state_filer_id')        AS has_state_filer,
  bool_or(px.kind = 'campaign_website_url')  AS has_website,
  count(px.id)                                AS xref_count
FROM people p
LEFT JOIN person_xref px ON px.person_id = p.id
GROUP BY p.id, p.canonical_name;

COMMENT ON VIEW public.v_person_xref_summary IS
  'One row per person with boolean flags for which external ID kinds are linked. '
  'Use to find people lacking key cross-references that would help dedup.';

-- Migration registration is handled automatically by the Supabase CLI.

