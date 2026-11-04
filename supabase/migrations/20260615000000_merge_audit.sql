-- =============================================================================
-- 20260615000000_merge_audit.sql
--
-- Reversibility ledger for the guarded people-merge (scripts/merge-duplicate-people.ts).
--
-- Every merge of a loser person row into a survivor writes exactly ONE row here,
-- capturing precisely what moved so a single merge can be undone later:
--   - which survivor / loser the merge collapsed
--   - per referencing table+column: how many rows were re-pointed loser -> survivor
--   - per referencing table+column: the colliding loser rows that were DELETED
--     (because the survivor already held the equivalent row under a UNIQUE that
--     includes the person column). Each deleted-collision entry stores a FULL
--     row snapshot (to_jsonb of the loser row) so the delete is reversible too,
--     NOT just the primary key -- an FK re-point alone cannot resurrect a deleted
--     row, so the snapshot is the only way back.
--   - the NULL-only people-field backfills applied to the survivor (so undo can
--     restore the survivor's prior values).
--
-- --undo <merge_audit_id> in the runner reads one row, moves the re-pointed rows
-- back to the loser, re-inserts the deleted-collision snapshots onto the loser,
-- clears the loser tombstone, pops the loser id off survivor.merged_from, reverts
-- the survivor backfills, and reopens the dedup_review_queue row. undone_at stamps
-- when that happened so a merge cannot be undone twice.
--
-- ADDITIVE ONLY. Service-role-only via RLS, matching dedup_review_queue /
-- do_not_merge (the admin layer is already gated by users.role). No em-dashes /
-- en-dashes; acronyms spelled out on first use.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.merge_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The two person rows this merge collapsed. We deliberately do NOT add an FK
  -- to people(id) on loser_id: the loser is tombstoned (kept), not deleted, but
  -- keeping the audit row valid even if a future hard-prune removes the loser is
  -- safer than a CASCADE that would erase the only record of the merge. survivor_id
  -- likewise stays FK-free so the ledger outlives any later schema churn on people.
  survivor_id UUID NOT NULL,
  loser_id UUID NOT NULL,

  -- Per-table move record. Shape (one array element per referencing column):
  --   [{ "table": "candidacies",
  --      "column": "person_id",
  --      "moved_count": 3,
  --      "deleted_collisions": [ { "pk": "<row-id>", "snapshot": { ...full row... } }, ... ] },
  --    ...]
  -- moved_count is the number of rows re-pointed loser -> survivor for that column.
  -- deleted_collisions holds the loser rows that were removed because the survivor
  -- already had an equivalent under a UNIQUE that includes the person column; each
  -- carries a full row snapshot so undo can re-insert it onto the loser.
  moved JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- The survivor people-field backfills this merge applied (NULL-only), captured
  -- as { "<column>": { "before": <old>, "after": <new> }, ... } plus the special
  -- keys "merged_from_appended" (the loser id pushed onto survivor.merged_from)
  -- and "name_variants_added" (the variants unioned in) and "meta_merged_in_key"
  -- (the meta.merged_in.<loser_id> path written). Undo uses this to revert.
  people_backfill JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- The dedup_review_queue row closed by this merge (so undo can reopen exactly
  -- that row). NULL when no queue row was matched for the pair.
  dedup_review_queue_id UUID,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Stamped when --undo reverses this merge. A non-NULL value means the merge has
  -- already been undone and must not be undone again.
  undone_at TIMESTAMPTZ
);

-- Hot paths: "find the audit row(s) for a survivor / loser" and "list mergers
-- not yet undone".
CREATE INDEX IF NOT EXISTS idx_merge_audit_survivor ON public.merge_audit (survivor_id);
CREATE INDEX IF NOT EXISTS idx_merge_audit_loser ON public.merge_audit (loser_id);
CREATE INDEX IF NOT EXISTS idx_merge_audit_active
  ON public.merge_audit (created_at DESC) WHERE undone_at IS NULL;

ALTER TABLE public.merge_audit ENABLE ROW LEVEL SECURITY;
-- No public policies: service_role bypasses RLS and the admin layer is gated by
-- users.role. Mirrors dedup_review_queue / do_not_merge.

COMMENT ON TABLE public.merge_audit IS
  'Reversibility ledger for scripts/merge-duplicate-people.ts. One row per loser '
  'merged into a survivor, recording per-table re-point counts and full snapshots '
  'of any deleted unique-collision rows, plus the survivor NULL-only backfills, so '
  'a single merge can be undone with --undo. undone_at marks an already-reversed '
  'merge.';
