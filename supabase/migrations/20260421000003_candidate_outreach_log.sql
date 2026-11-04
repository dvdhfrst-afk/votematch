-- Candidate outreach tracking.
--
-- The June 30, 2026 UT primary launch depends on getting ~45 candidates (40%
-- response rate from ~113 UT 2026 candidacies) to complete the 19-dimension
-- questionnaire. Without candidate self-reports, there are no stated
-- positions to match voters against for 95% of the UT ballot.
--
-- This table is the source of truth for "who has Ballot Bridge reached out to,
-- when, how, and what happened." It links to the magic-link token submitted
-- via `candidate_magic_link_submissions` when a candidate actually responds.

CREATE TABLE candidate_outreach_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Who we contacted. Prefer linking to the new-schema people/candidacies pair;
  -- fall back to legacy candidates.id when the candidate hasn't been migrated.
  person_id UUID REFERENCES people(id) ON DELETE SET NULL,
  candidacy_id UUID REFERENCES candidacies(id) ON DELETE SET NULL,
  candidate_id UUID REFERENCES candidates(id) ON DELETE SET NULL,

  -- Campaign label (e.g. "ut-2026-primary-first-contact", "ut-2026-primary-followup-1")
  -- so we can segment metrics by outreach wave.
  campaign TEXT NOT NULL,

  -- Contact address used for this specific attempt. Stored denormalized because
  -- the candidate record's canonical email may change between attempts.
  contact_email TEXT,
  contact_phone TEXT,
  contact_channel TEXT NOT NULL CHECK (contact_channel IN ('email', 'sms', 'postal', 'in_person')),

  -- Magic-link token fingerprint (SHA-256 of the issued token). Lets us cross-
  -- reference this outreach attempt against `candidate_magic_link_submissions`
  -- to measure response rate per campaign / per attempt.
  token_fingerprint TEXT,

  -- Outcome lifecycle:
  --   'queued'      — row created, not yet sent
  --   'sent'        — email/SMS accepted by provider
  --   'delivered'   — provider confirmed delivery
  --   'opened'      — tracking pixel fired (best-effort)
  --   'clicked'     — magic link followed
  --   'responded'   — candidate submitted a response via the magic link
  --   'bounced'     — permanent delivery failure
  --   'complained'  — recipient marked as spam
  --   'unsubscribed'— opted out
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN (
    'queued', 'sent', 'delivered', 'opened', 'clicked', 'responded',
    'bounced', 'complained', 'unsubscribed'
  )),

  -- Provider metadata (Resend message id, bounce reason, etc.)
  provider_message_id TEXT,
  provider_error TEXT,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Timestamps for the funnel
  queued_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at        TIMESTAMPTZ,
  delivered_at   TIMESTAMPTZ,
  first_opened_at TIMESTAMPTZ,
  first_clicked_at TIMESTAMPTZ,
  responded_at   TIMESTAMPTZ,

  -- Audit
  created_by TEXT NOT NULL DEFAULT 'outreach-pipeline'
);

-- A single candidate can receive multiple attempts within a campaign; we do NOT
-- enforce one-per-candidate-per-campaign uniquely because follow-ups are valid.
-- Do index for fast lookups by campaign + candidate.
CREATE INDEX idx_outreach_log_campaign ON candidate_outreach_log (campaign, status);
CREATE INDEX idx_outreach_log_person ON candidate_outreach_log (person_id) WHERE person_id IS NOT NULL;
CREATE INDEX idx_outreach_log_candidacy ON candidate_outreach_log (candidacy_id) WHERE candidacy_id IS NOT NULL;
CREATE INDEX idx_outreach_log_candidate_legacy ON candidate_outreach_log (candidate_id) WHERE candidate_id IS NOT NULL;
CREATE INDEX idx_outreach_log_email ON candidate_outreach_log (lower(contact_email));
CREATE INDEX idx_outreach_log_token ON candidate_outreach_log (token_fingerprint) WHERE token_fingerprint IS NOT NULL;

ALTER TABLE candidate_outreach_log ENABLE ROW LEVEL SECURITY;
-- Service role only.

COMMENT ON TABLE candidate_outreach_log IS
  'Per-attempt log of candidate outreach for questionnaire completion. Powers the '
  'UT 2026 primary launch funnel: quantify response rate per campaign, detect bounces, '
  'and link magic-link responses back to the specific outreach that triggered them.';

-- Convenience view: outreach funnel per campaign
CREATE OR REPLACE VIEW v_outreach_campaign_stats AS
SELECT
  campaign,
  COUNT(*)                                                            AS attempts,
  COUNT(*) FILTER (WHERE status IN ('sent','delivered','opened','clicked','responded')) AS reached,
  COUNT(*) FILTER (WHERE status IN ('opened','clicked','responded'))  AS opened,
  COUNT(*) FILTER (WHERE status IN ('clicked','responded'))           AS clicked,
  COUNT(*) FILTER (WHERE status = 'responded')                        AS responded,
  COUNT(*) FILTER (WHERE status IN ('bounced','complained','unsubscribed')) AS failed,
  -- Rates as ratios
  ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'responded') / NULLIF(COUNT(*), 0), 1) AS response_rate_pct,
  ROUND(100.0 * COUNT(*) FILTER (WHERE status IN ('clicked','responded')) / NULLIF(COUNT(*) FILTER (WHERE status IN ('sent','delivered','opened','clicked','responded')), 0), 1) AS click_rate_pct,
  MIN(queued_at)  AS first_queued_at,
  MAX(queued_at)  AS last_queued_at
FROM candidate_outreach_log
GROUP BY campaign
ORDER BY MAX(queued_at) DESC;

COMMENT ON VIEW v_outreach_campaign_stats IS
  'Funnel stats per outreach campaign: attempts, reached, opened, clicked, responded, response rate %. Read this daily during the UT 2026 outreach wave.';
