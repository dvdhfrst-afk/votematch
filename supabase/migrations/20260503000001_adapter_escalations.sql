-- =====================================================================
-- Adapter escalations + host playbook (council #44, 2026-05-03)
-- =====================================================================
--
-- Replaces the extended-backoff approach (which would have just slowed
-- down the same dumb failures forever). New rule: an adapter that
-- accumulates 2 consecutive `no_data` outcomes (failed | unproductive |
-- 0-row success) is taken out of rotation and routed into an escalation
-- queue for higher-tier triage.
--
-- Two complementary tables:
--
--   adapter_escalations
--     One row per failure incident. Records the last few runs' status
--     codes / response samples / error summaries, the source URL the
--     adapter was hitting, and a slot for the higher-tier diagnosis +
--     suggested fix. When resolved, the resolution_pr URL plus an
--     optional `lesson` get persisted.
--
--   host_playbook
--     Cross-adapter knowledge base. When the higher LLM identifies a
--     class of failure that applies to a whole host (e.g. "elections.ny.gov
--     returns 403 to undici — preempt with curl"), it writes a row here.
--     The runner reads host_playbook on startup so future adapters
--     touching that host apply the lesson preemptively. This is how the
--     higher LLM "teaches" the runner.
--
-- Both tables are admin-only (service-role-RLS). Voters never see them.

BEGIN;

-- ---------------------------------------------------------------------
-- adapter_escalations
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS adapter_escalations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  adapter_name TEXT NOT NULL,
  state_fips TEXT,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Triage state machine.
  --   open          : just enqueued; no triage started yet
  --   investigating : a triage agent has claimed it
  --   resolved      : a fix has been applied (resolution_pr filled in)
  --   wontfix       : upstream is permanently dead; mark adapter dormant
  --   transient     : transient blip; retry after triage_resolution_at
  triage_status TEXT NOT NULL DEFAULT 'open' CHECK (triage_status IN (
    'open','investigating','resolved','wontfix','transient'
  )),

  -- Last N (~3) failure runs as JSON array. Each element:
  --   {
  --     ingestion_run_id: uuid,
  --     status: 'failed'|'unproductive'|'partial',
  --     status_code: 403,                 -- HTTP code if extractable
  --     error_summary: 'state-cf fetch: HTTP 403 for ...',
  --     response_sample: '<body snippet, max 2KB>',
  --     finished_at: timestamptz
  --   }
  failure_history JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Best-effort extraction from failure_history for indexing / UI.
  source_url TEXT,
  -- Path inside the repo where the adapter source lives.
  --   e.g. 'src/lib/adapters/state-cf/ny.ts'
  -- Filled in by the triage agent when known.
  adapter_source_path TEXT,

  -- Higher-tier diagnosis. NULL until investigation runs.
  root_cause TEXT CHECK (root_cause IS NULL OR root_cause IN (
    'url_drift','schema_change','waf_block','upstream_dead',
    'auth_required','transient','rate_limit','content_changed','other'
  )),
  diagnosis TEXT,                    -- the agent's narrative writeup
  suggested_fix TEXT,                -- machine-readable summary or PR description

  -- Resolution outputs.
  resolution_pr TEXT,                -- GitHub PR URL when fix is drafted/merged
  lesson TEXT,                       -- one-liner promoted to host_playbook
  resolved_at TIMESTAMPTZ,
  resolved_by_user_id UUID REFERENCES users(id),

  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Single-open invariant: at most one row per adapter in a non-terminal
-- triage state. Prevents the runner from creating duplicate escalations
-- for an adapter that's already in the queue.
CREATE UNIQUE INDEX IF NOT EXISTS uq_adapter_escalations_open_per_adapter
  ON adapter_escalations (adapter_name)
  WHERE triage_status IN ('open','investigating');

CREATE INDEX IF NOT EXISTS idx_adapter_escalations_status_opened
  ON adapter_escalations (triage_status, opened_at DESC);

CREATE INDEX IF NOT EXISTS idx_adapter_escalations_state
  ON adapter_escalations (state_fips, triage_status)
  WHERE state_fips IS NOT NULL;

ALTER TABLE adapter_escalations ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE adapter_escalations IS
  'Council #44 (2026-05-03): replaces extended-backoff. After 2 consecutive '
  'failure outcomes an adapter is parked here for higher-tier triage and the '
  'continuous-ingest runner skips it (next_check_at far future) until '
  'triage_status moves to resolved/wontfix/transient.';

-- ---------------------------------------------------------------------
-- host_playbook
-- ---------------------------------------------------------------------
--
-- Generalized lessons that apply to a whole host, written by the triage
-- agent when a fix should be applied preemptively across adapters. The
-- runner reads this table on startup and uses entries to short-circuit
-- known failure modes.
--
-- Example seed entry the triage agent might produce after the NY/RI
-- escalations resolve:
--
--   host: 'elections.ny.gov'
--   pattern: 'undici_403_use_curl'
--   description: 'Returns 403 to Node undici TLS fingerprint regardless
--                 of headers. System curl + Python requests both work.'
--   mitigation: 'Use politeFetch (curl fallback already wired). No
--                adapter-side change needed. If you see 403 here in a
--                non-politeFetch path, that is a bug — fix the path.'

CREATE TABLE IF NOT EXISTS host_playbook (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  host TEXT NOT NULL,                -- e.g. 'elections.ny.gov'
  pattern TEXT NOT NULL,             -- short id, e.g. 'undici_403_use_curl'

  description TEXT NOT NULL,         -- the diagnosis
  mitigation TEXT NOT NULL,          -- what to do (operational)
  applies_to TEXT[],                 -- adapter families this applies to,
                                     -- e.g. ['state-cf','candidacies'].
                                     -- NULL = applies to any adapter on this host.

  enabled BOOLEAN NOT NULL DEFAULT true,
  applied_count INT NOT NULL DEFAULT 0,        -- bumped whenever a runner
                                               -- consults this entry
  last_applied_at TIMESTAMPTZ,

  -- Provenance: which escalation produced this entry.
  source_escalation_id UUID REFERENCES adapter_escalations(id) ON DELETE SET NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_host_playbook_host_pattern
  ON host_playbook (host, pattern)
  WHERE enabled = true;

CREATE INDEX IF NOT EXISTS idx_host_playbook_host
  ON host_playbook (host)
  WHERE enabled = true;

ALTER TABLE host_playbook ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE host_playbook IS
  'Council #44 (2026-05-03): cross-adapter lessons. The triage agent writes '
  'rows here when a failure mode generalizes across adapters touching the '
  'same host. The runner consults the table on startup so future requests '
  'apply the mitigation preemptively.';

-- ---------------------------------------------------------------------
-- Updated-at triggers (lightweight)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at_now() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_adapter_escalations_updated_at ON adapter_escalations;
CREATE TRIGGER trg_adapter_escalations_updated_at
  BEFORE UPDATE ON adapter_escalations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at_now();

DROP TRIGGER IF EXISTS trg_host_playbook_updated_at ON host_playbook;
CREATE TRIGGER trg_host_playbook_updated_at
  BEFORE UPDATE ON host_playbook
  FOR EACH ROW EXECUTE FUNCTION set_updated_at_now();

COMMIT;
