-- Expand subscriber_follows.target_type to cover the office-centric graph.
--
-- The original constraint from 20260418000002_retention_engine.sql only
-- accepts ('federal_member', 'officeholder', 'candidate'). The new graph
-- uses people + offices + bills + ballot_measures + elections as follow
-- targets, so the constraint needs to expand. Legacy types are retained
-- for backward compat with existing retention code.

ALTER TABLE subscriber_follows
  DROP CONSTRAINT IF EXISTS subscriber_follows_target_type_check;

ALTER TABLE subscriber_follows
  ADD CONSTRAINT subscriber_follows_target_type_check
  CHECK (target_type IN (
    'federal_member',   -- legacy; retained
    'officeholder',     -- legacy; retained
    'candidate',        -- legacy; retained
    'person',           -- points at people.id (covers candidates + incumbents + historical holders)
    'office',           -- points at offices.id (notify when this seat turns over)
    'bill',             -- points at federal_bills composite key as text
    'ballot_measure',   -- points at ballot_measures.id
    'election'          -- points at elections.id (notify about a specific primary/general)
  ));

COMMENT ON CONSTRAINT subscriber_follows_target_type_check ON subscriber_follows IS
  'Expanded 2026-04-21 to cover the office-centric graph. Legacy types preserved for back-compat.';
