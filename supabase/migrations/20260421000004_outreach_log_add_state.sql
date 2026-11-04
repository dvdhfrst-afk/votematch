-- Add state_code to candidate_outreach_log so the funnel view segments by state.
--
-- The original migration (20260421000003) scoped outreach as a per-campaign label
-- (e.g. "ut-2026-primary-first-contact") but strategy shifted on 2026-04-21 to
-- "national day-one, every state primary gets a wave." We now run one first-contact
-- campaign per state per primary date, and we need per-state funnel stats to know
-- which states are converting.

ALTER TABLE candidate_outreach_log
  ADD COLUMN IF NOT EXISTS state_code CHAR(2);

CREATE INDEX IF NOT EXISTS idx_outreach_log_state_campaign
  ON candidate_outreach_log (state_code, campaign, status);

COMMENT ON COLUMN candidate_outreach_log.state_code IS
  'Two-letter US state code for this outreach attempt. Denormalized from the '
  'candidate''s jurisdiction for funnel segmentation and per-state deliverability analysis.';

-- Backfill: the UT-2026 first-contact rows inserted earlier today all target UT candidates
UPDATE candidate_outreach_log
  SET state_code = 'UT'
  WHERE campaign = 'ut-2026-primary-first-contact'
    AND state_code IS NULL;

-- Rebuild the funnel view with state segmentation
DROP VIEW IF EXISTS v_outreach_campaign_stats;

CREATE OR REPLACE VIEW v_outreach_campaign_stats AS
SELECT
  campaign,
  state_code,
  COUNT(*)                                                                           AS attempts,
  COUNT(*) FILTER (WHERE status IN ('sent','delivered','opened','clicked','responded'))
                                                                                      AS reached,
  COUNT(*) FILTER (WHERE status IN ('opened','clicked','responded'))                 AS opened,
  COUNT(*) FILTER (WHERE status IN ('clicked','responded'))                          AS clicked,
  COUNT(*) FILTER (WHERE status = 'responded')                                       AS responded,
  COUNT(*) FILTER (WHERE status IN ('bounced','complained','unsubscribed'))          AS failed,
  COUNT(*) FILTER (WHERE meta->>'missing_contact' = 'true')                          AS missing_contact,
  ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'responded') / NULLIF(COUNT(*), 0), 1) AS response_rate_pct,
  ROUND(100.0 * COUNT(*) FILTER (WHERE status IN ('clicked','responded'))
    / NULLIF(COUNT(*) FILTER (WHERE status IN ('sent','delivered','opened','clicked','responded')), 0), 1)
                                                                                      AS click_rate_pct,
  MIN(queued_at)  AS first_queued_at,
  MAX(queued_at)  AS last_queued_at
FROM candidate_outreach_log
GROUP BY campaign, state_code
ORDER BY MAX(queued_at) DESC;

COMMENT ON VIEW v_outreach_campaign_stats IS
  'Outreach funnel segmented by (campaign, state_code). Read daily during primary-election waves to spot stalled states.';

-- Also create a per-state roll-up across campaigns (for "how is state X doing overall")
CREATE OR REPLACE VIEW v_outreach_state_rollup AS
SELECT
  state_code,
  COUNT(DISTINCT campaign) AS campaigns_run,
  COUNT(*)                 AS total_attempts,
  COUNT(DISTINCT person_id) AS distinct_people_reached,
  COUNT(*) FILTER (WHERE status = 'responded') AS total_responses,
  COUNT(*) FILTER (WHERE meta->>'missing_contact' = 'true') AS still_missing_contact,
  ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'responded') / NULLIF(COUNT(*), 0), 1) AS response_rate_pct,
  MAX(responded_at) AS most_recent_response
FROM candidate_outreach_log
WHERE state_code IS NOT NULL
GROUP BY state_code
ORDER BY response_rate_pct DESC NULLS LAST;

COMMENT ON VIEW v_outreach_state_rollup IS
  'Per-state outreach roll-up across all campaigns. Useful for ranking states by engagement.';
