-- Users need to be able to DELETE their own matches so the /api/match route
-- can wipe the previous computation before inserting the new one.
-- Without this policy, the delete silently affects 0 rows under RLS and
-- stale match records accumulate on each re-run.
CREATE POLICY "Matches own delete"
  ON matches FOR DELETE
  USING (
    user_id IN (
      SELECT id FROM users WHERE session_token = public.session_token()
    )
  );
