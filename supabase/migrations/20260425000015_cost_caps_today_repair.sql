-- ============================================================
-- Cost-caps TODAY repair (Council Fix C, 2026-04-25)
-- ============================================================
--
-- Companion to 20260425000014_cost_caps_today_seed.sql.
--
-- Before the seed migration ran, several services had already had today's
-- row auto-inserted by cost_cap_check_and_consume with daily_usd_cap=0.00
-- (see council Fix C). The seed migration uses ON CONFLICT DO NOTHING, so
-- those corrupted $0 rows survive. This UPDATE-only migration restores the
-- canonical caps for paid services where TODAY's row exists with cap=0.
--
-- Idempotent: WHERE clause filters on cap=0.00, so re-running is a no-op
-- after the first apply. Free services (cap=0 by design) are not touched —
-- they're not in this list.
-- ============================================================

UPDATE cost_caps SET daily_usd_cap = 100.00
  WHERE service='claude_api'                AND date=CURRENT_DATE AND daily_usd_cap=0.00;

UPDATE cost_caps SET daily_usd_cap = 300.00
  WHERE service='claude_batch'              AND date=CURRENT_DATE AND daily_usd_cap=0.00;

UPDATE cost_caps SET daily_usd_cap =   5.00
  WHERE service='interpretation-llm-claude' AND date=CURRENT_DATE AND daily_usd_cap=0.00;

UPDATE cost_caps SET daily_usd_cap =   1.00
  WHERE service='geocoding'                 AND date=CURRENT_DATE AND daily_usd_cap=0.00;

UPDATE cost_caps SET daily_usd_cap =  20.00
  WHERE service='resend'                    AND date=CURRENT_DATE AND daily_usd_cap=0.00;

UPDATE cost_caps SET daily_usd_cap =  50.00
  WHERE service='scraperapi'                AND date=CURRENT_DATE AND daily_usd_cap=0.00;

UPDATE cost_caps SET daily_usd_cap =  10.00
  WHERE service='playwright'                AND date=CURRENT_DATE AND daily_usd_cap=0.00;

UPDATE cost_caps SET daily_usd_cap =   1.00
  WHERE service='other'                     AND date=CURRENT_DATE AND daily_usd_cap=0.00;
