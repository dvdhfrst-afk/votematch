-- ============================================================
-- Phase 1 — Staged sunset of the legacy data graph
-- ============================================================
--
-- Architecture council finding (Apr 2026): the legacy candidate-centric
-- graph (`candidates`, `races`, `district_races`, plus the JSONB pin
-- `precincts.race_ids[]` and the FK pin `positions.candidate_id`) is
-- the single highest-leverage architectural change available. The new
-- office-centric graph (`offices`, `people`, `candidacies`, `elections`,
-- `office_tenures`) holds 7,019 incumbents + 12,686 candidacies across
-- all 50 states — but the legacy graph is the only thing the voter
-- surfaces actually read from end-to-end.
--
-- THIS MIGRATION IS PHASE 1 ONLY. It is purely ADDITIVE. We add v2
-- columns that point at the new graph, but the legacy columns stay in
-- place and remain authoritative for the read path. Backfill happens
-- via `app/scripts/backfill-legacy-to-newgraph.ts`. Phase 2 (a future
-- PR) flips the read path off legacy onto these new columns and then
-- drops the legacy tables.
--
-- New columns added here:
--   * precincts.election_ids JSONB    — references elections.id
--                                        (mirrors precincts.race_ids
--                                        which is also JSONB[uuid])
--   * positions.person_id    UUID FK  — references people.id
--
-- Both columns are nullable / defaulted-empty. Existing reads ignore
-- them. New reads can opportunistically prefer them (Phase 2).
--
-- IDEMPOTENT: every statement is IF NOT EXISTS / safe to re-run.
-- NON-DESTRUCTIVE: no DROP, no DELETE, no ALTER COLUMN that loses data.
-- ============================================================

-- ---------------------------------------------------------------
-- precincts.election_ids — JSONB array of elections.id values
-- ---------------------------------------------------------------
-- Type chosen to mirror precincts.race_ids (also JSONB array of UUID
-- strings). Keeping the shapes parallel makes the Phase 2 read-switch
-- a single column-name swap rather than a type-shape conversion.
ALTER TABLE precincts
  ADD COLUMN IF NOT EXISTS election_ids JSONB DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS idx_precincts_election_ids
  ON precincts USING GIN (election_ids);

COMMENT ON COLUMN precincts.election_ids IS
  'Phase 1 sunset: references elections.id (new graph) as a JSONB array '
  'of UUID strings, mirroring precincts.race_ids shape. Backfilled from '
  'precincts.race_ids[] via races.election_id bridge by '
  'scripts/backfill-legacy-to-newgraph.ts. Both columns coexist until '
  'Phase 2 cutover.';

-- ---------------------------------------------------------------
-- positions.person_id — FK into people(id)
-- ---------------------------------------------------------------
-- positions.candidate_id stays the authoritative legacy pin. person_id
-- is the new-graph identity reference. ON DELETE SET NULL because we
-- want a positions row to survive a person-merge on the new graph
-- (the legacy candidate_id still anchors it for the matching engine).
ALTER TABLE positions
  ADD COLUMN IF NOT EXISTS person_id UUID
    REFERENCES people(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_positions_person_id
  ON positions (person_id) WHERE person_id IS NOT NULL;

COMMENT ON COLUMN positions.person_id IS
  'Phase 1 sunset: references people.id (new graph). Backfilled from '
  'positions.candidate_id via people.legacy_candidate_ids overlap by '
  'scripts/backfill-legacy-to-newgraph.ts. Both columns coexist until '
  'Phase 2 cutover.';
