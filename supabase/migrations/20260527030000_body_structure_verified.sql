-- Split the verification signal (gap-fix 2026-05-27 / smoke-batch finding).
--
-- BEFORE: `size_authoritative` was the single flag, set TRUE only when the
-- agent self-rated authoritative=true. Agents conservatively set false
-- whenever they saw per-seat ambiguity (mid-term vacancies, surname-only
-- entries, missing salary corroboration), poisoning the body-level fact.
--
-- AFTER: body-level structural verification gets its own flag that only
-- depends on "did the agent fetch the primary source, cite it, and was the
-- citation backed by shim-fetch evidence?" The agent's self-assessment of
-- per-seat completeness goes to a separate concern (roster_verified_at,
-- future ingestion B).
--
-- size_authoritative is preserved as a backwards-compatible alias of
-- body_structure_verified for now (other code reads it). Once consumers
-- migrate, we can deprecate one of them.

ALTER TABLE governing_bodies
  ADD COLUMN body_structure_verified boolean,
  ADD COLUMN body_structure_verified_at timestamptz,
  ADD COLUMN body_structure_verified_by text;

ALTER TABLE offices
  ADD COLUMN structure_verified boolean,
  ADD COLUMN structure_verified_at timestamptz,
  ADD COLUMN structure_verified_by text;

CREATE INDEX IF NOT EXISTS idx_governing_bodies_body_structure_verified
  ON governing_bodies (body_structure_verified)
  WHERE body_structure_verified = true;

COMMENT ON COLUMN governing_bodies.body_structure_verified IS
  'TRUE when the agent fetched the body''s primary source via the shim, extracted body-level structural fields (size, terms, scope), and the primary citation has shim-fetch evidence. Independent of per-seat officeholder completeness. The trustworthy "is this body verified" flag for UI.';

COMMENT ON COLUMN governing_bodies.body_structure_verified_at IS
  'Timestamp the body structure was last verified under the post-2026-05-27 gates.';
