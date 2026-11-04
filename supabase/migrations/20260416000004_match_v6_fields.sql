-- v6 match-result fields (blueprint-v6 §7 + §9 data model).
--
-- Added so /api/match can persist the richer output: per-race rank,
-- tied-with-top flag, answer-coverage counts, per-domain breakdown, and
-- disagreement hotspots. Results page consumes these.
ALTER TABLE matches
  ADD COLUMN rank INT NOT NULL DEFAULT 0,
  ADD COLUMN tied_with_top BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN answered_both_count INT NOT NULL DEFAULT 0,
  ADD COLUMN applicable_count INT NOT NULL DEFAULT 0;
-- per_domain + disagreement_hotspots already live in the `explanation` JSONB
-- column — no separate columns needed.

CREATE INDEX idx_matches_user_race_rank
  ON matches (user_id, race_id, rank);
