-- Unified ingestion pipeline schema (per notes/unified-ingestion-plan.md rev 3)
--
-- Operator decision 2026-05-27 (Option A): approve the full schema (8 items)
-- now, no file-based interim. This migration adds everything the merged
-- body-research + SOS-candidate coordinator needs to operate.
--
-- Items in this migration:
--   1. ENUM verification_tier (gold/silver/bronze/tin/exhausted)
--   2. ENUMs workplan_stage + workplan_status
--   3. TABLE jurisdiction_workplan (the coordinator's work queue)
--   4. TABLE sos_staging (raw SOS rows pre-promotion, with source_sha256)
--   5. TABLE state_roster_sources (runtime mirror of notes/state-roster-sources.md)
--   6. COLUMN governing_bodies.has_upcoming_election (boolean)
--   7. COLUMN governing_bodies.body_verification_tactic_log (jsonb)
--   8. COLUMN citations.cited_for_fact_kind (text)
--   9. INDEX candidacies.meta->>'natural_key' (partial unique index, for loader idempotency)
--
-- Safe to apply: all ADD COLUMN are nullable; tables are new (no name collisions
-- expected — verified against existing migrations); enums are new. The partial
-- unique index on natural_key is the only item that could fail at apply time
-- IF there are pre-existing duplicate natural_keys in candidacies (which there
-- shouldn't be — the WY loader is the first to write this field).

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────
-- 1. verification_tier enum
-- ─────────────────────────────────────────────────────────────────────────
-- Per rev 2 / rev 3 of the plan: replace today's binary
-- body_structure_verified flag with an explicit 5-level tier on every body
-- and every candidacy. Tier semantics:
--   gold      = verified_count_matches_statute (statute seat count matches
--               SOS roster count; both primary-tier, both shim-fetched)
--   silver    = verified_count_no_cross_check (two primary signals, ambiguous
--               cross-check — redistricting year, multi-member districts)
--   bronze    = verified_primary_only (one primary citation with shim-fetch
--               evidence asserts the seat count; no SOS cross-check possible)
--   tin       = verified_structurally_only_no_count (primary cite describes
--               the body but contains no number)
--   exhausted = tactics_exhausted_awaiting_human (≥3 tactics tried, all failed)
--
-- For candidates, similar tiers but anchored on SOS-as-registrar:
--   gold = SOS primary + ≥1 independent corroborator
--   silver = SOS primary, contact info partial
--   bronze = SOS primary minimum fields only
--   exhausted = SOS parser couldn't disambiguate
CREATE TYPE verification_tier AS ENUM (
  'gold',
  'silver',
  'bronze',
  'tin',
  'exhausted'
);
COMMENT ON TYPE verification_tier IS
  'Quality tier for a body or candidate verification, per notes/unified-ingestion-plan.md rev 2. Replaces binary verified flag. gold is best, exhausted means we tried and failed (needs human).';

-- ─────────────────────────────────────────────────────────────────────────
-- 2. workplan stage + status enums
-- ─────────────────────────────────────────────────────────────────────────
CREATE TYPE workplan_stage AS ENUM (
  'roster_fetch',           -- SOS adapter pulls the source bytes
  'office_resolution',      -- map office_label_raw → offices.id
  'body_structure',         -- body-research worker verifies the body
  'candidate_load',         -- transactional upsert of persons + candidacies
  'contact_verify',         -- structural validation of phone/email/address
  'positions_research'      -- DOWNSTREAM (out of unified-pipeline scope; tracked for visibility)
);
COMMENT ON TYPE workplan_stage IS
  'Stages of a jurisdiction''s lifecycle through the unified pipeline. positions_research is downstream (Stage 6) and tracked for dashboard visibility only — it is not driven by this pipeline.';

CREATE TYPE workplan_status AS ENUM (
  'untouched',              -- never attempted
  'enqueued',               -- in queue, waiting for a slot
  'in_flight',              -- worker is currently processing
  'completed',              -- stage finished successfully
  'failed_recoverable',     -- failed but can retry on next pass (transient)
  'failed_blocked',         -- failed permanently for this attempt (needs external action)
  'awaiting_human'          -- tactics exhausted, queued for operator review
);
COMMENT ON TYPE workplan_status IS
  'Per-stage status for a jurisdiction''s workplan row. failed_recoverable retries automatically; failed_blocked + awaiting_human surface in morning report.';

-- ─────────────────────────────────────────────────────────────────────────
-- 3. jurisdiction_workplan table — the coordinator's persistent work queue
-- ─────────────────────────────────────────────────────────────────────────
-- One row per (jurisdiction_id, stage, cycle). The coordinator reads this
-- to decide what to dispatch next; the workers write back outcomes.
-- Partial unique index ensures at most one active row per jurisdiction-stage
-- in a cycle (multiple historical rows OK once status reaches terminal state).
CREATE TABLE jurisdiction_workplan (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  jurisdiction_id uuid NOT NULL REFERENCES jurisdictions(id) ON DELETE CASCADE,
  cycle           text NOT NULL,          -- e.g. '2026'; matches election cycle convention
  stage           workplan_stage NOT NULL,
  status          workplan_status NOT NULL DEFAULT 'untouched',
  priority        integer NOT NULL DEFAULT 0,   -- higher = run first
  attempt_count   integer NOT NULL DEFAULT 0,
  last_attempt_at timestamptz,
  last_outcome    text,                   -- free-form one-line summary
  blocking_reason text,                   -- present when status IN ('failed_blocked','awaiting_human')
  meta            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE jurisdiction_workplan IS
  'Coordinator''s persistent work queue. One row per (jurisdiction, stage, cycle). Updated by workers as they progress through stages.';

-- One active row per (jurisdiction, stage, cycle). Historical attempts in
-- terminal states (completed / failed_blocked) are allowed to accumulate so
-- we can show history in the dashboard.
CREATE UNIQUE INDEX idx_workplan_active_unique
  ON jurisdiction_workplan (jurisdiction_id, stage, cycle)
  WHERE status IN ('untouched', 'enqueued', 'in_flight', 'failed_recoverable', 'awaiting_human');

CREATE INDEX idx_workplan_priority_pending
  ON jurisdiction_workplan (priority DESC, created_at ASC)
  WHERE status IN ('untouched', 'enqueued', 'failed_recoverable');

CREATE INDEX idx_workplan_cycle_stage
  ON jurisdiction_workplan (cycle, stage, status);

-- Auto-update updated_at on row change.
CREATE OR REPLACE FUNCTION touch_jurisdiction_workplan_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_jurisdiction_workplan_updated_at
  BEFORE UPDATE ON jurisdiction_workplan
  FOR EACH ROW EXECUTE FUNCTION touch_jurisdiction_workplan_updated_at();

-- ─────────────────────────────────────────────────────────────────────────
-- 4. sos_staging table — raw SOS rows pre-promotion
-- ─────────────────────────────────────────────────────────────────────────
-- SOS adapters write here first. The coordinator then runs office-resolution,
-- dedup, and promotion. source_sha256 enables idempotency: re-fetching the
-- same SOS file and discovering matching hash means skip the promotion phase.
CREATE TABLE sos_staging (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  jurisdiction_id uuid NOT NULL REFERENCES jurisdictions(id) ON DELETE CASCADE,
  source_tag     text NOT NULL,           -- e.g. 'sos-wyoming-candidacies'
  source_url     text NOT NULL,
  source_sha256  text NOT NULL,           -- hash of the raw fetched bytes
  fetched_at     timestamptz NOT NULL DEFAULT now(),
  row_index      integer NOT NULL,        -- ordinal within the fetched file
  raw            jsonb NOT NULL,          -- the structured parsed row as adapter produced
  natural_key    text,                    -- computed by adapter for downstream dedup
  promotion_status text NOT NULL DEFAULT 'pending', -- pending|promoted|rejected|superseded
  promoted_candidacy_id uuid REFERENCES candidacies(id) ON DELETE SET NULL,
  promotion_error text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE sos_staging IS
  'Raw SOS-loader output pre-promotion. source_sha256 makes re-fetches idempotent. promotion_status tracks each row''s journey from staging to candidacies.';

CREATE INDEX idx_sos_staging_jurisdiction_cycle
  ON sos_staging (jurisdiction_id, source_tag, fetched_at DESC);

CREATE INDEX idx_sos_staging_pending
  ON sos_staging (jurisdiction_id, promotion_status)
  WHERE promotion_status = 'pending';

-- Idempotency: same source_sha256 from same source_tag means same fetched file
-- — adapter can early-exit without re-promoting if a previous run completed.
CREATE INDEX idx_sos_staging_sha
  ON sos_staging (source_tag, source_sha256);

-- ─────────────────────────────────────────────────────────────────────────
-- 5. state_roster_sources table — runtime mirror of notes/state-roster-sources.md
-- ─────────────────────────────────────────────────────────────────────────
-- The markdown file is the human-curated source of truth; this table is the
-- runtime-readable copy. Updated by a sync script (not in this migration).
-- Lets the coordinator query "which states have an easy-tier loader" without
-- parsing markdown at runtime.
CREATE TABLE state_roster_sources (
  fips             text PRIMARY KEY,        -- state FIPS code, e.g. '56' for WY
  jurisdiction_name text NOT NULL,
  url              text NOT NULL,
  format           text NOT NULL,           -- 'PDF' | 'CSV' | 'XLSX' | 'HTML' | 'TSV' | etc
  difficulty       text NOT NULL,           -- 'easy' | 'medium' | 'hard'
  loader_status    text NOT NULL DEFAULT 'planned', -- 'planned' | 'drafted' | 'smoketested' | 'in_production' | 'deprecated'
  loader_script_path text,                  -- e.g. 'app/scripts/load-sos-wyoming.ts'
  publishes_email  boolean DEFAULT NULL,    -- true if SOS export includes candidate email
  publishes_phone  boolean DEFAULT NULL,
  publishes_address boolean DEFAULT NULL,
  publishes_website boolean DEFAULT NULL,   -- almost always false; see notes/sos-loader-url-coverage.md
  filing_period_start date,
  filing_period_end   date,
  last_synced_at   timestamptz NOT NULL DEFAULT now(),
  notes            text,
  meta             jsonb NOT NULL DEFAULT '{}'::jsonb
);
COMMENT ON TABLE state_roster_sources IS
  'Runtime-queryable mirror of notes/state-roster-sources.md. Updated by a sync script that reads the markdown registry. The markdown remains source-of-truth.';

CREATE INDEX idx_state_roster_sources_loader_status
  ON state_roster_sources (loader_status, difficulty);

-- ─────────────────────────────────────────────────────────────────────────
-- 6. governing_bodies.has_upcoming_election (boolean)
-- ─────────────────────────────────────────────────────────────────────────
-- Driven by a nightly refresh: true iff this body has at least one office
-- with an election in the current cycle. Replaces a runtime computation
-- the coordinator's priority function would otherwise have to do every
-- queue rebuild.
ALTER TABLE governing_bodies
  ADD COLUMN has_upcoming_election boolean,
  ADD COLUMN has_upcoming_election_refreshed_at timestamptz;

COMMENT ON COLUMN governing_bodies.has_upcoming_election IS
  'TRUE iff this body has at least one office with an election in the current cycle (2026). Refreshed nightly. Drives the coordinator''s priority function (soft priority, not a gate).';

CREATE INDEX idx_governing_bodies_upcoming_election
  ON governing_bodies (has_upcoming_election)
  WHERE has_upcoming_election = true;

-- ─────────────────────────────────────────────────────────────────────────
-- 7. governing_bodies.body_verification_tactic_log (jsonb)
-- ─────────────────────────────────────────────────────────────────────────
-- Append-only log of verification attempts per body. Feeds the tactic-cost
-- ledger (rev 3 mechanism #1) — coordinator can compute per-(chamber, state)
-- success rates from this column without joining a separate table.
-- Shape: {attempts: [{ts, tactic, model, backend, outcome, cost_usd, duration_ms, ...}, ...]}
ALTER TABLE governing_bodies
  ADD COLUMN body_verification_tactic_log jsonb NOT NULL DEFAULT '{"attempts":[]}'::jsonb;

COMMENT ON COLUMN governing_bodies.body_verification_tactic_log IS
  'Append-only log of verification attempts. Each attempt: {ts, tactic, model, backend, outcome, cost_usd, duration_ms}. Feeds the tactic-cost ledger for cost-aware tactic ordering.';

-- ─────────────────────────────────────────────────────────────────────────
-- 8. Verification tier columns on bodies + candidacies
-- ─────────────────────────────────────────────────────────────────────────
-- Co-exist with the existing body_structure_verified boolean for now.
-- Migration plan (separate, post-coordinator-ship): backfill tier from
-- existing data, then deprecate the boolean.
ALTER TABLE governing_bodies
  ADD COLUMN verification_tier verification_tier,
  ADD COLUMN verification_tier_set_at timestamptz;

COMMENT ON COLUMN governing_bodies.verification_tier IS
  'Quality tier (gold/silver/bronze/tin/exhausted). Set by the coordinator''s verification logic, separate from the older body_structure_verified boolean. Once dashboards migrate, the boolean can be deprecated.';

CREATE INDEX idx_governing_bodies_verification_tier
  ON governing_bodies (verification_tier)
  WHERE verification_tier IS NOT NULL;

ALTER TABLE candidacies
  ADD COLUMN verification_tier verification_tier,
  ADD COLUMN verification_tier_set_at timestamptz;

COMMENT ON COLUMN candidacies.verification_tier IS
  'Quality tier for the candidate''s verification (gold/silver/bronze/exhausted). gold = SOS primary + ≥1 corroborator; silver = SOS primary with partial contact; bronze = SOS primary minimum fields; exhausted = SOS parser couldn''t disambiguate.';

CREATE INDEX idx_candidacies_verification_tier
  ON candidacies (verification_tier)
  WHERE verification_tier IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────
-- 9. Citations: cited_for_fact_kind (JSONB field convention, no DDL needed)
-- ─────────────────────────────────────────────────────────────────────────
-- Citations are stored as a JSONB array on governing_bodies.citations (not
-- a separate table). Adding "cited_for_fact_kind" support means writers
-- populate a new key on each citation element:
--   { url, title, fetched_at, source_tier, cited_for_fact_kind, ... }
-- No schema change required. Common values for cited_for_fact_kind:
--   'body_seat_count'        — body's structural seat count
--   'body_authority_domain'  — body's policy authority domains
--   'body_voter_facing_scope'— body's voter-facing scope per measurement primitives
--   'candidate_filing'       — candidate filing record
--   'candidate_contact_email'— candidate email (campaign-derived)
--   'office_term_length'     — office term/cycle attributes
-- Writers should set this field; readers should default to NULL = 'unspecified'
-- (legacy citations without the field).
--
-- No DDL here — this item is recorded for documentation and search-grep purposes.

-- ─────────────────────────────────────────────────────────────────────────
-- 10. candidacies natural_key partial unique index (for loader idempotency)
-- ─────────────────────────────────────────────────────────────────────────
-- The WY loader proved we need this: 5 duplicate persons were created
-- because the upsert lookup used a different normalization than the source.
-- A natural_key (state | office_code | normalized_person_name | cycle)
-- stored in meta with a unique partial index makes upsert idempotent.
-- Partial WHERE clause means existing candidacies without natural_key are
-- unaffected — the constraint only fires on rows that opt in.
CREATE UNIQUE INDEX idx_candidacies_natural_key
  ON candidacies ((meta->>'natural_key'))
  WHERE meta ? 'natural_key';

COMMENT ON INDEX idx_candidacies_natural_key IS
  'Loader idempotency: SOS-loader-written candidacies set meta.natural_key to (state|office_code|normalized_name|cycle). The partial unique index ensures re-running a loader updates rather than duplicates. Existing rows without natural_key are unconstrained.';

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────
-- Rollback guidance (separate file — DO NOT include in this migration)
-- ─────────────────────────────────────────────────────────────────────────
-- To roll back this migration manually:
--   BEGIN;
--   DROP INDEX IF EXISTS idx_candidacies_natural_key;
--   DROP INDEX IF EXISTS idx_candidacies_verification_tier;
--   ALTER TABLE candidacies
--     DROP COLUMN verification_tier_set_at,
--     DROP COLUMN verification_tier;
--   DROP INDEX IF EXISTS idx_governing_bodies_verification_tier;
--   ALTER TABLE governing_bodies
--     DROP COLUMN verification_tier_set_at,
--     DROP COLUMN verification_tier,
--     DROP COLUMN body_verification_tactic_log,
--     DROP COLUMN has_upcoming_election_refreshed_at,
--     DROP COLUMN has_upcoming_election;
--   DROP INDEX IF EXISTS idx_governing_bodies_upcoming_election;
--   DROP INDEX IF EXISTS idx_state_roster_sources_loader_status;
--   DROP TABLE state_roster_sources;
--   DROP INDEX IF EXISTS idx_sos_staging_sha;
--   DROP INDEX IF EXISTS idx_sos_staging_pending;
--   DROP INDEX IF EXISTS idx_sos_staging_jurisdiction_cycle;
--   DROP TABLE sos_staging;
--   DROP TRIGGER IF EXISTS trg_jurisdiction_workplan_updated_at ON jurisdiction_workplan;
--   DROP FUNCTION IF EXISTS touch_jurisdiction_workplan_updated_at();
--   DROP INDEX IF EXISTS idx_workplan_cycle_stage;
--   DROP INDEX IF EXISTS idx_workplan_priority_pending;
--   DROP INDEX IF EXISTS idx_workplan_active_unique;
--   DROP TABLE jurisdiction_workplan;
--   DROP TYPE workplan_status;
--   DROP TYPE workplan_stage;
--   DROP TYPE verification_tier;
--   COMMIT;
