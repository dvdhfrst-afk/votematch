-- ============================================================
-- 20260502000011_extraction_audit_lockdown.sql
-- ============================================================
-- Council security finding: extraction_audit currently has a
-- "Public read extraction_audit" policy with USING (true), exposing
-- the full audit log (model, prompt, raw model response, source URL,
-- confidence, validation_status) to anonymous public reads.
--
-- This data is internal: it includes raw LLM responses (potential PII
-- leak from source documents), prompt versions (operational detail), and
-- validation status of un-published rows. Public transparency for
-- corrections is already served by the /corrections workflow which surfaces
-- a curated subset of audit info.
--
-- Lockdown: drop the public read policy and replace with a deny-by-default
-- policy. Service role bypasses RLS so internal pipelines (extractors,
-- alerters, dashboards using SUPABASE_SERVICE_ROLE_KEY) keep working.
--
-- Idempotent: DROP POLICY IF EXISTS + CREATE POLICY guarded by a DO block
-- so re-running the migration after manual fix-up doesn't error.
-- ============================================================

-- 1. Remove the over-permissive public read policy.
DROP POLICY IF EXISTS "Public read extraction_audit" ON extraction_audit;

-- 2. Drop our replacement too, in case this migration ran partially.
DROP POLICY IF EXISTS "Service role only extraction_audit" ON extraction_audit;

-- 3. Replace with explicit deny-by-default. Service role bypasses RLS,
-- so this only affects anon + authenticated client reads.
CREATE POLICY "Service role only extraction_audit"
  ON extraction_audit
  FOR SELECT
  USING (false);

-- RLS is already enabled on extraction_audit (see migration
-- 20260418000002_retention_engine.sql line 547), but make it explicit
-- and idempotent here in case someone toggled it off out-of-band.
ALTER TABLE extraction_audit ENABLE ROW LEVEL SECURITY;
