-- LLM router plumbing: record which backend + model serviced each extraction.
--
-- Motivation (2026-04-24): we are wiring the extraction pipeline through a
-- dispatcher that can route to local Ollama (free) or the Anthropic API (paid)
-- based on a risk-class decision. To measure the impact — and to audit which
-- rows were produced by which backend — we add two small columns to
-- extraction_audit:
--
--   - backend  — 'ollama' or 'claude' (future: 'bedrock', etc.)
--   - model    — already exists (NOT NULL), no change needed
--
-- We also seed a cost_caps row for 'ollama_local' so the same
-- cost_cap_check_and_consume() helper ticks the request_count for local calls,
-- giving us free metrics parity with paid services. Cap stays at 0 because
-- ollama is free; cost_cap_check_and_consume() is called with cost_usd=0 for
-- local calls, and that path is short-circuited by the helper's
-- `v_row.daily_usd_cap = 0 AND p_cost_usd > 0` check to auto-pass.

-- ============================================================
-- 1. extraction_audit.backend
-- ============================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='extraction_audit') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='extraction_audit' AND column_name='backend') THEN
      ALTER TABLE extraction_audit
        ADD COLUMN backend TEXT
          CHECK (backend IN ('ollama', 'claude'));
      CREATE INDEX IF NOT EXISTS idx_extraction_audit_backend
        ON extraction_audit (backend) WHERE backend IS NOT NULL;
    END IF;
  END IF;
END $$;

COMMENT ON COLUMN extraction_audit.backend IS
  'Which LLM served this extraction. NULL for legacy rows created before the router shipped (2026-04-24).';

-- ============================================================
-- 2. cost_caps seed: ollama_local
-- ============================================================

INSERT INTO cost_caps (service, date, daily_usd_cap)
VALUES ('ollama_local', CURRENT_DATE, 0.00)
ON CONFLICT (service, date) DO NOTHING;

COMMENT ON TABLE cost_caps IS
  'Daily $ budget per external service. Services call cost_cap_check_and_consume(service, cost_usd) '
  'before making paid API requests; function returns FALSE to refuse. Prevents retry-storm $10K overnight. '
  'Free services carry cap=0 + cost=0 (auto-pass) — includes ollama_local (2026-04-24).';
