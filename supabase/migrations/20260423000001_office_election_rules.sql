-- ============================================================
-- Office + election voting rules
-- ============================================================
--
-- Adds per-office "typical rules" + per-election override rules
-- that let the schema represent every state's election code,
-- not just single-winner plurality.
--
-- This is foundational for Item 1 (election_results + advancement):
-- advancement logic keys off primary_advance_rule and voting_rule
-- to decide who wins and who advances.
--
-- Why NOW: first 2026 primary (IN + OH) is 12 days out and
-- advancement cannot ship without these rules seeded.
--
-- Why TEXT + CHECK instead of ENUM: Postgres enums can only
-- be ADD VALUE'd, never removed or renamed cleanly. Matching
-- the existing convention (elections.election_type, offices.level,
-- offices.selection_method) which all use TEXT + CHECK.
--
-- Timezone awareness: existing elections.filing_opens_on and
-- filing_deadline are DATE. In many states the deadline is
-- 5pm LOCAL. For accurate deadline reminders we need TIMESTAMPTZ
-- columns. The DATE columns stay populated (legacy readers still
-- work); new readers should prefer the TIMESTAMPTZ columns.
-- ============================================================

-- ============================================================
-- 1. Expand elections.election_type to include jungle_primary
--    (Louisiana) and open_primary variants.
-- ============================================================

ALTER TABLE elections DROP CONSTRAINT IF EXISTS elections_election_type_check;

ALTER TABLE elections
  ADD CONSTRAINT elections_election_type_check
  CHECK (election_type IN (
    'general',
    'primary',
    'primary_runoff',           -- GA/AL/MS/TX runoff 4 weeks after primary
    'special_general',
    'special_primary',
    'runoff',                   -- general-election runoff (LA, GA)
    'retention',                -- judicial retention (up-or-down vote)
    'recall',                   -- recall elections
    'nonpartisan_general',      -- local nonpartisan races
    'jungle_primary',           -- LA jungle: >50% wins outright, else runoff
    'top_two_primary',          -- CA / WA top-two nonpartisan blanket
    'top_four_primary',         -- AK top-four → RCV general
    'convention'                -- UT SB54 convention path, VA conventions
  ));

COMMENT ON CONSTRAINT elections_election_type_check ON elections IS
  'Expanded 2026-04-23 to include jungle_primary (LA), top_two_primary (CA/WA), '
  'top_four_primary (AK), convention (UT/VA). See Item 5 of schema-gap-plan-2026-04-23.md.';

-- ============================================================
-- 2. Add per-office rule columns
--
-- These are "typical" rules that defaults inherit from. The
-- per-election columns (below) override when a specific
-- election uses a different rule.
-- ============================================================

ALTER TABLE offices
  ADD COLUMN IF NOT EXISTS typical_voting_rule TEXT,
  ADD COLUMN IF NOT EXISTS typical_primary_advance_rule TEXT,
  ADD COLUMN IF NOT EXISTS rule_citation TEXT,
  ADD COLUMN IF NOT EXISTS rule_source_data_source_id UUID REFERENCES data_sources(id) ON DELETE SET NULL;

-- Voting-rule check (shared with elections via trigger below).
-- Values cover: plurality variants, RCV variants, multi-winner variants,
-- and the three nonstandard nonpartisan cases (blanket, retention, jungle).
ALTER TABLE offices DROP CONSTRAINT IF EXISTS offices_typical_voting_rule_check;
ALTER TABLE offices
  ADD CONSTRAINT offices_typical_voting_rule_check
  CHECK (typical_voting_rule IS NULL OR typical_voting_rule IN (
    'single_winner_plurality',
    'plurality_with_majority_runoff',    -- 50%+1 required; GA/AL for primaries
    'plurality_at_large',                -- multi-winner plurality (most school boards)
    'limited_voting',
    'cumulative_voting',
    'rcv_single_winner',                 -- Maine, NYC, Alaska general
    'rcv_multi_winner_stv',              -- NYC Community Boards, Cambridge MA
    'approval_voting',                   -- Fargo, St. Louis (municipal-only)
    'top_two_nonpartisan_primary',       -- CA / WA
    'top_four_nonpartisan_primary',      -- AK
    'nonpartisan_blanket',
    'nonpartisan_plurality',
    'partisan_nomination_then_general',
    'retention_yes_no',                  -- judicial retention
    'jungle_open_primary',               -- LA: all-candidates-on-ballot, majority-or-runoff
    'convention_plus_primary',           -- UT SB54 dual-path
    'unopposed_automatic'                -- auto-advance when no opposition filed
  ));

ALTER TABLE offices DROP CONSTRAINT IF EXISTS offices_typical_primary_advance_rule_check;
ALTER TABLE offices
  ADD CONSTRAINT offices_typical_primary_advance_rule_check
  CHECK (typical_primary_advance_rule IS NULL OR typical_primary_advance_rule IN (
    'top_vote_getter_per_party',         -- standard partisan primary
    'plurality_threshold_or_runoff',     -- 50%+1 or runoff (GA/AL/MS/TX)
    'top_two_overall',                   -- CA/WA jungle top-two
    'top_four_overall',                  -- AK top-four
    'majority_or_advance_to_general',    -- LA jungle: >50% wins outright; else runoff
    'convention_supermajority_or_primary', -- UT SB54
    'instant_runoff',                    -- RCV tabulation in the primary itself
    'no_primary'                         -- offices with only general elections
  ));

CREATE INDEX IF NOT EXISTS idx_offices_typical_voting_rule ON offices (typical_voting_rule) WHERE typical_voting_rule IS NOT NULL;

-- ============================================================
-- 3. Add per-election override columns
-- ============================================================

ALTER TABLE elections
  ADD COLUMN IF NOT EXISTS voting_rule TEXT,
  ADD COLUMN IF NOT EXISTS primary_advance_rule TEXT,
  ADD COLUMN IF NOT EXISTS filing_opens_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS filing_closes_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS filing_fee_cents INT,
  ADD COLUMN IF NOT EXISTS signature_requirement INT,
  ADD COLUMN IF NOT EXISTS filing_status TEXT,
  ADD COLUMN IF NOT EXISTS rule_citation TEXT,
  ADD COLUMN IF NOT EXISTS rule_source_data_source_id UUID REFERENCES data_sources(id) ON DELETE SET NULL;

ALTER TABLE elections DROP CONSTRAINT IF EXISTS elections_voting_rule_check;
ALTER TABLE elections
  ADD CONSTRAINT elections_voting_rule_check
  CHECK (voting_rule IS NULL OR voting_rule IN (
    'single_winner_plurality',
    'plurality_with_majority_runoff',
    'plurality_at_large',
    'limited_voting',
    'cumulative_voting',
    'rcv_single_winner',
    'rcv_multi_winner_stv',
    'approval_voting',
    'top_two_nonpartisan_primary',
    'top_four_nonpartisan_primary',
    'nonpartisan_blanket',
    'nonpartisan_plurality',
    'partisan_nomination_then_general',
    'retention_yes_no',
    'jungle_open_primary',
    'convention_plus_primary',
    'unopposed_automatic'
  ));

ALTER TABLE elections DROP CONSTRAINT IF EXISTS elections_primary_advance_rule_check;
ALTER TABLE elections
  ADD CONSTRAINT elections_primary_advance_rule_check
  CHECK (primary_advance_rule IS NULL OR primary_advance_rule IN (
    'top_vote_getter_per_party',
    'plurality_threshold_or_runoff',
    'top_two_overall',
    'top_four_overall',
    'majority_or_advance_to_general',
    'convention_supermajority_or_primary',
    'instant_runoff',
    'no_primary'
  ));

ALTER TABLE elections DROP CONSTRAINT IF EXISTS elections_filing_status_check;
ALTER TABLE elections
  ADD CONSTRAINT elections_filing_status_check
  CHECK (filing_status IS NULL OR filing_status IN (
    'not_yet_open',       -- filing window has not started
    'open',               -- currently accepting candidates
    'closed',             -- window closed, candidate list is final unless substitutions allowed
    'extended',           -- deadline extended (court order, pandemic, etc.)
    'no_filing_required', -- automatic placement (e.g., incumbent auto-filed)
    'reopened'            -- rare: reopened by court or ballot-access ruling
  ));

-- Ensure filing window makes sense: if both dates are set, opens < closes.
ALTER TABLE elections DROP CONSTRAINT IF EXISTS elections_filing_window_order;
ALTER TABLE elections
  ADD CONSTRAINT elections_filing_window_order
  CHECK (
    filing_opens_at IS NULL
    OR filing_closes_at IS NULL
    OR filing_opens_at < filing_closes_at
  );

CREATE INDEX IF NOT EXISTS idx_elections_filing_status ON elections (filing_status) WHERE filing_status IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_elections_filing_closes_at ON elections (filing_closes_at) WHERE filing_closes_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_elections_voting_rule ON elections (voting_rule) WHERE voting_rule IS NOT NULL;

-- ============================================================
-- 4. Backfill TIMESTAMPTZ filing columns from legacy DATE columns
--
-- For existing rows: use noon America/New_York as a "safe within
-- the day" default. Real per-state times (e.g., "5pm local") will
-- be overwritten by the seed-office-rules.ts script per state.
-- ============================================================

UPDATE elections
SET filing_opens_at = (filing_opens_on::text || ' 12:00:00-05')::timestamptz
WHERE filing_opens_at IS NULL AND filing_opens_on IS NOT NULL;

UPDATE elections
SET filing_closes_at = (filing_deadline::text || ' 17:00:00-05')::timestamptz
WHERE filing_closes_at IS NULL AND filing_deadline IS NOT NULL;

-- ============================================================
-- 5. Helper view: effective voting rule per election
--    (election override > office typical > fallback).
-- ============================================================

CREATE OR REPLACE VIEW v_election_effective_rules AS
SELECT
  e.id AS election_id,
  e.office_id,
  e.election_type,
  e.election_date,
  e.filing_opens_at,
  e.filing_closes_at,
  e.filing_status,
  COALESCE(e.voting_rule, o.typical_voting_rule) AS effective_voting_rule,
  COALESCE(e.primary_advance_rule, o.typical_primary_advance_rule) AS effective_primary_advance_rule,
  COALESCE(e.rule_citation, o.rule_citation) AS effective_rule_citation,
  (e.voting_rule IS NOT NULL) AS voting_rule_is_override,
  (e.primary_advance_rule IS NOT NULL) AS primary_advance_rule_is_override
FROM elections e
JOIN offices o ON o.id = e.office_id;

COMMENT ON VIEW v_election_effective_rules IS
  'Resolves per-election override against per-office typical rules. '
  'Downstream code (Item 1 advancement logic, ballot lookup) should '
  'query this view rather than the raw columns. Null effective rule '
  'means the seed script has not classified this office type yet.';

-- ============================================================
-- 6. Documentation
-- ============================================================

COMMENT ON COLUMN offices.typical_voting_rule IS
  'Default voting rule for this office. Per-election overrides live on elections.voting_rule. '
  'See app/scripts/seed-office-rules.ts for the 50-state classification source.';

COMMENT ON COLUMN offices.typical_primary_advance_rule IS
  'Default primary→general advancement rule. Drives Item 1 advancement pipeline. '
  'no_primary covers offices with only general elections (e.g., many municipal).';

COMMENT ON COLUMN elections.filing_closes_at IS
  'TIMESTAMPTZ replacement for filing_deadline (DATE). Many states close filing at 5pm '
  'LOCAL, not end-of-day UTC. Populate per-state from state-rules.ts; fallback backfill '
  'was 17:00 America/New_York for existing rows. Real deadline reminders must read this '
  'column, not filing_deadline.';

COMMENT ON COLUMN elections.filing_status IS
  'State of the filing window at read time. not_yet_open → open → closed is the happy '
  'path. extended and reopened are edge cases. no_filing_required applies to automatic '
  'ballot placement (some uncontested incumbents, some retention).';
