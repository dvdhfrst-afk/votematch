-- ============================================================
-- Cost-caps TODAY seed (Council Fix C, 2026-04-25)
-- ============================================================
--
-- The cost_caps table is keyed (service, date). Earlier migrations seeded
-- rows with CURRENT_DATE *at apply time* — so once the calendar rolls past
-- the migration date, today's row no longer exists and
-- cost_cap_check_and_consume auto-inserts a fresh row with daily_usd_cap=0.
-- That cap-zero row then silently refuses every reservation and every
-- cost-capped adapter goes dark.
--
-- Symptoms observed (2026-04-25): ballot-measures and other adapters
-- returning rejected_cost_cap with `service=other estimate=$0.x`. None of
-- those services had a row for 2026-04-25; cost_cap_check_and_consume had
-- silently filled in cap=0.
--
-- This migration is the one-shot fix that unblocks today. The recurring
-- companion is the Inngest function `cost-caps-daily-seed` (cron `5 0 * * *`)
-- which performs the same seed every morning at 00:05 UTC.
--
-- Idempotent: ON CONFLICT (service, date) DO NOTHING.
-- ============================================================

INSERT INTO cost_caps (service, date, daily_usd_cap) VALUES
  -- Anthropic
  ('claude_api',                 CURRENT_DATE, 100.00),
  ('claude_batch',               CURRENT_DATE, 300.00),
  -- Interpretation pipeline
  ('interpretation-llm-claude',  CURRENT_DATE,   5.00),
  ('interpretation-llm-ollama',  CURRENT_DATE,   0.00),
  -- Ingestion
  ('ingestion-fetch',            CURRENT_DATE,   0.00),
  -- Geocoding
  ('geocoding',                  CURRENT_DATE,   1.00),
  ('census_geocoder',            CURRENT_DATE,   0.00),
  ('nominatim',                  CURRENT_DATE,   0.00),
  -- Federal data sources (free)
  ('wayback_cdx',                CURRENT_DATE,   0.00),
  ('openfec',                    CURRENT_DATE,   0.00),
  ('congress_gov',               CURRENT_DATE,   0.00),
  ('regulations_gov',            CURRENT_DATE,   0.00),
  -- Email
  ('resend',                     CURRENT_DATE,  20.00),
  -- Anti-scrape tier 2
  ('scraperapi',                 CURRENT_DATE,  50.00),
  ('playwright',                 CURRENT_DATE,  10.00),
  -- Catch-all
  ('other',                      CURRENT_DATE,   1.00)
ON CONFLICT (service, date) DO NOTHING;
