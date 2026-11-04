-- Unique constraints required by the idempotent seed (upsert onConflict: 'name').
-- sub_dimensions.name is a natural key (19 fixed policy dimensions).
-- races.name + candidates.name: seed-scale uniqueness for Phase A (hand-curated roster).
-- If real data later has name collisions we will disambiguate with a composite key.
ALTER TABLE sub_dimensions ADD CONSTRAINT sub_dimensions_name_key UNIQUE (name);
ALTER TABLE races ADD CONSTRAINT races_name_key UNIQUE (name);
ALTER TABLE candidates ADD CONSTRAINT candidates_name_key UNIQUE (name);
