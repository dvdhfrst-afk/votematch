-- =============================================================================
-- dedup_review_queue — DB-backed people-dedup review surface (2026-05-26).
--
-- Migrates the static `scripts/data/dedup-people-manual-review.json` file
-- into a real table so /admin/morning-review (dedup count) and the new
-- /admin/dedup-queue page can read live state and an editor can resolve
-- clusters (merge / split / defer) from the UI without hand-editing JSON.
--
-- Each row represents one cluster of `people` rows that the dedup pass
-- flagged as ambiguous — same canonical_key + state, but the heuristic
-- couldn't decide whether they're truly the same human. Editor picks an
-- outcome; we record reviewed_at + resolution so the queue clears.
--
-- The JSON file remains as the source-of-truth produced by
-- `scripts/dedup-people.ts`; `scripts/load-dedup-review-queue.ts` upserts
-- it into this table (idempotent on (canonical_key, state_fips)).
--
-- Service-role-only via RLS — admin layout has already gated by users.role.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.dedup_review_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Dedup-pass identifiers (canonical_key is the slug used by the dedup
  -- heuristic; e.g. "aaronffallahi". state is FIPS — string to keep
  -- leading zeros for FIPS codes like "01" / "06").
  canonical_key TEXT NOT NULL,
  state_fips TEXT,

  blocker_category TEXT NOT NULL CHECK (blocker_category IN (
    'insufficient_evidence',
    'different_offices_same_state',
    'conflicting_strong_id'
  )),
  blocker_explanation TEXT NOT NULL,

  -- Snapshot of the `people` rows the dedup pass clustered together,
  -- kept as JSONB so we don't have to refetch + refresh names + signals
  -- on every page render. Loader replaces this on every load.
  candidate_people JSONB NOT NULL DEFAULT '[]'::jsonb,
  people_count INT NOT NULL DEFAULT 0,

  -- Review state (mirrors the corrections / endorsement_queue patterns).
  reviewed_by_user_id UUID REFERENCES public.users(id),
  reviewed_at TIMESTAMPTZ,
  resolution TEXT CHECK (resolution IS NULL OR resolution IN (
    'merge',     -- editor confirmed cluster is one human; merged into target_person_id
    'split',     -- editor confirmed cluster is multiple humans; left as-is
    'defer',     -- editor needs more evidence; revisit later
    'skipped'    -- low-value cluster, won't review
  )),
  resolution_target_person_id UUID REFERENCES public.people(id) ON DELETE SET NULL,
  resolution_note TEXT,

  -- Provenance: which dedup run produced this cluster.
  source_file TEXT NOT NULL DEFAULT 'scripts/data/dedup-people-manual-review.json',

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (canonical_key, state_fips)
);

-- Trigger: keep updated_at fresh on every UPDATE.
CREATE OR REPLACE FUNCTION public.tg_dedup_review_queue_touch()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_dedup_review_queue_touch ON public.dedup_review_queue;
CREATE TRIGGER trg_dedup_review_queue_touch
  BEFORE UPDATE ON public.dedup_review_queue
  FOR EACH ROW EXECUTE FUNCTION public.tg_dedup_review_queue_touch();

-- Hot-path index for the queue dashboard: "show me unresolved clusters,
-- oldest first" matches reviewed_at IS NULL + order by created_at.
CREATE INDEX IF NOT EXISTS idx_dedup_review_queue_unresolved
  ON public.dedup_review_queue (created_at ASC) WHERE reviewed_at IS NULL;

-- Secondary index for filtering by blocker_category in the queue page.
CREATE INDEX IF NOT EXISTS idx_dedup_review_queue_blocker_category
  ON public.dedup_review_queue (blocker_category) WHERE reviewed_at IS NULL;

ALTER TABLE public.dedup_review_queue ENABLE ROW LEVEL SECURITY;
-- No explicit policies — service_role bypasses RLS and the admin layout
-- already gated by users.role ∈ ('editor','admin'). Matches the pattern
-- used for fec_match_ambiguous + endorsements review.

COMMENT ON TABLE public.dedup_review_queue IS
  'People-dedup ambiguous-cluster review queue. Hydrated by '
  'scripts/load-dedup-review-queue.ts from the dedup-pass JSON output. '
  'Editor resolves each row from /admin/dedup-queue (merge / split / '
  'defer). Replaces the file-only v1 surface that morning-review used '
  'before 2026-05-26.';
