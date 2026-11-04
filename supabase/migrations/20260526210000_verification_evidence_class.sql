-- Add verification_evidence_class to governing_bodies + standalone offices.
--
-- Why: after the 2026-05-26 audit found 64/99 "authoritative=true" bodies had
-- zero web fetches (pure training-data hallucination), we need a per-row
-- evidence tier so the UI + downstream consumers can distinguish:
--
--   - 'enforced': verified under the new shim+primary-citation gate
--                 (post 2026-05-26 enforcement). Trustworthy.
--   - 'legacy_unverified': pre-enforcement run with no debug capture; could
--                          be real, could be hallucinated. Show with caveat;
--                          do not power "verified by Ballot Bridge" UI.
--   - 'unverified': either never researched, or revoked after the audit
--                   showed the run made zero fetches.
--   - NULL: never touched by the research pipeline (catalog placeholder).

CREATE TYPE verification_evidence_class_t AS ENUM (
  'enforced',
  'legacy_unverified',
  'unverified'
);

ALTER TABLE governing_bodies
  ADD COLUMN verification_evidence_class verification_evidence_class_t;

-- Same column on offices for standalone-office research path.
-- (Some columns on `offices` use `meta.research_extracted.authoritative`;
-- this column gives us a first-class equivalent.)
ALTER TABLE offices
  ADD COLUMN verification_evidence_class verification_evidence_class_t;

-- Backfill governing_bodies:
--   1. Bodies revoked in the 2026-05-26 audit (meta.authoritative_revoked=true)
--      → 'unverified'.
--   2. Bodies still authoritative=true with no _lastcli evidence (the 35
--      "SUSPECT_NO_CLI_LOG" ones) → 'legacy_unverified'. We can't tell
--      apart at SQL-time; the dispatcher script will tag them.
--   3. All other auth=true bodies → 'enforced' (will be re-evaluated on
--      next run anyway; this is best-effort backfill).
--   4. Everything else → NULL (untouched).

UPDATE governing_bodies
SET verification_evidence_class = 'unverified'
WHERE meta->>'authoritative_revoked' = 'true';

UPDATE governing_bodies
SET verification_evidence_class = 'legacy_unverified'
WHERE size_authoritative = TRUE
  AND verification_evidence_class IS NULL;

-- Index for fast filtering ("show me unverified bodies")
CREATE INDEX IF NOT EXISTS idx_governing_bodies_verification_evidence_class
  ON governing_bodies (verification_evidence_class)
  WHERE verification_evidence_class IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_offices_verification_evidence_class
  ON offices (verification_evidence_class)
  WHERE verification_evidence_class IS NOT NULL;

COMMENT ON COLUMN governing_bodies.verification_evidence_class IS
  'Evidence tier for size_authoritative. enforced = post-2026-05-26 gate, legacy_unverified = pre-enforcement (caveat in UI), unverified = revoked or never verified.';
COMMENT ON COLUMN offices.verification_evidence_class IS
  'Evidence tier for meta.research_extracted.authoritative. enforced = post-2026-05-26 gate, legacy_unverified = pre-enforcement (caveat in UI), unverified = revoked or never verified.';
