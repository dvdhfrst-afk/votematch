-- ============================================================
-- Council foundation: users.role, cost_caps, extraction_audit link,
-- positions.source_tier NOT NULL, fec_match_ambiguous
-- ============================================================
--
-- Landing the ingestion-council fixes that need schema support
-- before the adapter runner + state adapters can be written.
-- ============================================================

-- ============================================================
-- 1. users.role — editor/admin roles for publish gates
-- ============================================================

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'anon';

ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE public.users
  ADD CONSTRAINT users_role_check
  CHECK (role IN ('anon', 'voter', 'candidate_claimed', 'editor', 'admin'));

CREATE INDEX IF NOT EXISTS idx_users_role ON public.users (role) WHERE role IN ('editor', 'admin');

-- Reviewer gate for endorsements publish: enforce role in ('editor','admin')
CREATE OR REPLACE FUNCTION check_endorsement_reviewer_role() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.published = TRUE AND NEW.reviewed_by_user_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = NEW.reviewed_by_user_id AND u.role IN ('editor','admin')
    ) THEN
      RAISE EXCEPTION 'Endorsement reviewer must have role editor or admin (user_id=%)', NEW.reviewed_by_user_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_endorsement_reviewer_role
  BEFORE INSERT OR UPDATE ON endorsements
  FOR EACH ROW EXECUTE FUNCTION check_endorsement_reviewer_role();

-- Same gate for candidate_events
CREATE OR REPLACE FUNCTION check_candidate_event_reviewer_role() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.published = TRUE AND NEW.reviewed_by_user_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = NEW.reviewed_by_user_id AND u.role IN ('editor','admin')
    ) THEN
      RAISE EXCEPTION 'Candidate event reviewer must have role editor or admin (user_id=%)', NEW.reviewed_by_user_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_candidate_event_reviewer_role
  BEFORE INSERT OR UPDATE ON candidate_events
  FOR EACH ROW EXECUTE FUNCTION check_candidate_event_reviewer_role();

-- ============================================================
-- 2. cost_caps — daily $ budgets per external service
-- ============================================================

CREATE TABLE IF NOT EXISTS cost_caps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service TEXT NOT NULL,                       -- 'claude_api', 'claude_batch', 'census_geocoder', 'nominatim', 'resend', etc.
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  daily_usd_cap NUMERIC(10,2) NOT NULL,        -- dollars/day
  daily_usd_spent NUMERIC(10,2) NOT NULL DEFAULT 0,
  request_count INT NOT NULL DEFAULT 0,
  last_reset_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  alert_at_pct NUMERIC(4,2) NOT NULL DEFAULT 0.80,  -- alert at 80% of cap
  alerted_at TIMESTAMPTZ,
  meta JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (service, date)
);

CREATE INDEX IF NOT EXISTS idx_cost_caps_service_date ON cost_caps (service, date DESC);
CREATE INDEX IF NOT EXISTS idx_cost_caps_over_pct
  ON cost_caps (service) WHERE daily_usd_spent >= daily_usd_cap * 0.8;

CREATE OR REPLACE FUNCTION cost_caps_bump_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_cost_caps_bump_updated_at
  BEFORE UPDATE ON cost_caps FOR EACH ROW EXECUTE FUNCTION cost_caps_bump_updated_at();

ALTER TABLE cost_caps ENABLE ROW LEVEL SECURITY;
-- Service-role only

-- Seed default daily caps for the services we use
INSERT INTO cost_caps (service, date, daily_usd_cap) VALUES
  ('claude_api',       CURRENT_DATE, 100.00),   -- interactive extraction (conservative)
  ('claude_batch',     CURRENT_DATE, 300.00),   -- batch classification
  ('census_geocoder',  CURRENT_DATE, 0.00),     -- free; budget tracked as 0
  ('nominatim',        CURRENT_DATE, 0.00),     -- free
  ('wayback_cdx',      CURRENT_DATE, 0.00),     -- free
  ('resend',           CURRENT_DATE, 20.00),    -- transactional + digest
  ('openfec',          CURRENT_DATE, 0.00),     -- free
  ('congress_gov',     CURRENT_DATE, 0.00),     -- free
  ('regulations_gov',  CURRENT_DATE, 0.00),     -- free
  ('scraperapi',       CURRENT_DATE, 50.00)     -- residential-proxy fallback (if used)
ON CONFLICT DO NOTHING;

-- Helper: check + consume cap atomically. Returns TRUE if the call may proceed.
CREATE OR REPLACE FUNCTION cost_cap_check_and_consume(
  p_service TEXT,
  p_cost_usd NUMERIC
) RETURNS BOOLEAN AS $$
DECLARE
  v_row cost_caps;
BEGIN
  -- Upsert today's row with default cap if missing (use 0 cap to block if service unknown).
  INSERT INTO cost_caps (service, date, daily_usd_cap)
    VALUES (p_service, CURRENT_DATE, 0.00)
    ON CONFLICT (service, date) DO NOTHING;

  SELECT * INTO v_row FROM cost_caps
  WHERE service = p_service AND date = CURRENT_DATE
  FOR UPDATE;

  IF v_row.daily_usd_cap = 0 AND p_cost_usd > 0 THEN
    -- Service has no budget configured; refuse.
    RETURN FALSE;
  END IF;

  IF v_row.daily_usd_spent + p_cost_usd > v_row.daily_usd_cap AND v_row.daily_usd_cap > 0 THEN
    -- Over cap; refuse.
    RETURN FALSE;
  END IF;

  UPDATE cost_caps
  SET daily_usd_spent = daily_usd_spent + p_cost_usd,
      request_count = request_count + 1
  WHERE service = p_service AND date = CURRENT_DATE;

  RETURN TRUE;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION cost_cap_check_and_consume IS
  'Atomic check-and-consume for a service spend. Returns FALSE if over-cap or no-budget-configured. '
  'Free services (cap=0, spend=0) auto-pass because p_cost_usd=0 for free-service calls.';

-- ============================================================
-- 3. extraction_audit.ingestion_run_id — link extractions to the
--    scraper run that produced them
-- ============================================================

-- Skip if extraction_audit doesn't exist yet (it's in retention migration)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='extraction_audit') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='extraction_audit' AND column_name='ingestion_run_id') THEN
      ALTER TABLE extraction_audit
        ADD COLUMN ingestion_run_id UUID REFERENCES ingestion_runs(id) ON DELETE SET NULL;
      CREATE INDEX IF NOT EXISTS idx_extraction_audit_ingestion_run
        ON extraction_audit (ingestion_run_id) WHERE ingestion_run_id IS NOT NULL;
    END IF;
  END IF;
END $$;

-- ============================================================
-- 4. positions.source_tier NOT NULL with default
-- ============================================================

-- Any NULLs still present get 'ml_inferred_from_corpus' (safest honest default).
UPDATE positions SET source_tier = 'ml_inferred_from_corpus' WHERE source_tier IS NULL;

ALTER TABLE positions
  ALTER COLUMN source_tier SET DEFAULT 'ml_inferred_from_corpus',
  ALTER COLUMN source_tier SET NOT NULL;

-- ============================================================
-- 5. fec_match_ambiguous — staging for unresolved FEC matches
-- ============================================================

CREATE TABLE IF NOT EXISTS fec_match_ambiguous (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bb_person_id UUID REFERENCES people(id) ON DELETE CASCADE,
  bb_candidacy_id UUID REFERENCES candidacies(id) ON DELETE SET NULL,
  queried_name TEXT NOT NULL,
  queried_state CHAR(2),
  queried_office TEXT,
  candidate_matches JSONB NOT NULL,            -- array of FEC candidate objects
  resolved_fec_candidate_id TEXT,              -- populated when admin picks one
  resolved_at TIMESTAMPTZ,
  resolved_by_user_id UUID REFERENCES users(id),
  data_source_id UUID REFERENCES data_sources(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fec_match_ambiguous_unresolved
  ON fec_match_ambiguous (created_at DESC) WHERE resolved_at IS NULL;

ALTER TABLE fec_match_ambiguous ENABLE ROW LEVEL SECURITY;
-- Service-role only

-- ============================================================
-- 6. Documentation
-- ============================================================

COMMENT ON TABLE cost_caps IS
  'Daily $ budget per external service. Services call cost_cap_check_and_consume(service, cost_usd) '
  'before making paid API requests; function returns FALSE to refuse. Prevents retry-storm $10K overnight. '
  'Free services carry cap=0 + cost=0 (auto-pass). ';

COMMENT ON TABLE fec_match_ambiguous IS
  'Staging table for FEC name-matches that could not be uniquely resolved. Prevents silently '
  'attaching filings to the wrong person when two candidates share a name. Admin resolves '
  'via /admin/fec-matches page.';

COMMENT ON CONSTRAINT users_role_check ON public.users IS
  'Roles: anon (default; no privileges), voter (authenticated voter), candidate_claimed (verified '
  'candidate with dashboard access), editor (can review + publish endorsements/events), admin (full).';
