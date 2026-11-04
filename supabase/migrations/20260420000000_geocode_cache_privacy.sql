-- Fix geocode_cache privacy leak.
-- See /15-council/00-initial-review-2026-04-20.md (Lens 1, Critical #1)
-- and /15-council/decisions/005-verify-rls-before-new-features.md.
--
-- Problem: initial schema granted `USING (true)` SELECT to public, and the
-- cache stored plaintext `address_text`. Anyone with the anon key could
-- enumerate every user's home address via a single SELECT.
--
-- Fix: drop the public-read policy (default-deny applies when RLS is on and
-- no policy matches -> anon loses SELECT; service role always bypasses RLS),
-- and drop the plaintext column. Lookups only need (address_hash, lat, lng);
-- the ballot-lookup code is updated in the same commit to stop writing the
-- plaintext column.

DROP POLICY IF EXISTS "Public read geocode_cache" ON geocode_cache;

-- No replacement SELECT policy is created. Supabase default-denies when RLS
-- is enabled and no policy matches; the service role bypasses RLS, so
-- server-side cache reads via the service client continue to work.

ALTER TABLE geocode_cache DROP COLUMN IF EXISTS address_text;
