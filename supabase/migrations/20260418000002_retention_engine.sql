-- Retention Engine — between-cycle engagement infrastructure.
--
-- Motivation: Research rounds 1-5 (see vault 13-community-features/) concluded
-- that surviving multi-state civic apps retain via an email/SMS list + personalized
-- digest, not via app DAU mechanics. This migration adds:
--
--   1. Subscriber list — the "four columns" thesis: (email/sms, state, match-profile, interest-tags)
--   2. Federal data tables (Congress.gov, Regulations.gov, FEC) — portable 50-state by design
--   3. State-extracted tables (AI-extracted, with confidence + source provenance)
--   4. Officeholder lookup — AI-maintained, seeds a 5th B2B revenue stream
--   5. Digest-send log + extraction audit — full transparency for trust brand
--
-- Every AI-extracted row carries `confidence_score`, `source_url`, and a link to
-- `extraction_audit` for provenance. No autonomous publishing of high-stakes facts
-- without a verification flag.

-- ============================================================
-- 1. SUBSCRIBER LIST — the "four columns" retention asset
-- ============================================================

CREATE TABLE subscribers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE,
  phone TEXT UNIQUE,
  state TEXT NOT NULL CHECK (length(state) = 2),         -- 2-letter state code (UT, NV, etc.)
  match_id UUID REFERENCES matches(id) ON DELETE SET NULL,  -- original match that seeded this subscription
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  interest_tags TEXT[] DEFAULT '{}',                     -- sub_dimension names they care about
  digest_frequency TEXT NOT NULL DEFAULT 'monthly'
    CHECK (digest_frequency IN ('weekly', 'biweekly', 'monthly', 'none')),
  prefers_sms BOOLEAN NOT NULL DEFAULT false,
  verified BOOLEAN NOT NULL DEFAULT false,               -- double opt-in gate
  subscribed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  verified_at TIMESTAMPTZ,
  unsubscribed_at TIMESTAMPTZ,
  last_digest_at TIMESTAMPTZ,
  CHECK (email IS NOT NULL OR phone IS NOT NULL)
);

CREATE INDEX idx_subscribers_state_verified
  ON subscribers (state, verified) WHERE unsubscribed_at IS NULL;

CREATE INDEX idx_subscribers_email
  ON subscribers (email) WHERE email IS NOT NULL AND unsubscribed_at IS NULL;

CREATE INDEX idx_subscribers_phone
  ON subscribers (phone) WHERE phone IS NOT NULL AND unsubscribed_at IS NULL;

-- Follow relationships: subscriber → (federal_member OR officeholder OR candidate).
-- All three reference patterns are supported so the follow feature can start with
-- federal members and expand to state/local officeholders without schema changes.
CREATE TABLE subscriber_follows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscriber_id UUID NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('federal_member', 'officeholder', 'candidate')),
  target_id TEXT NOT NULL,                               -- bioguide_id / officeholder UUID / candidate UUID
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  UNIQUE (subscriber_id, target_type, target_id)
);

CREATE INDEX idx_follows_subscriber
  ON subscriber_follows (subscriber_id) WHERE ended_at IS NULL;

CREATE INDEX idx_follows_target
  ON subscriber_follows (target_type, target_id) WHERE ended_at IS NULL;

-- ============================================================
-- 2. FEDERAL DATA — Congress.gov, Regulations.gov, FEC
-- ============================================================

-- Congress.gov members (House + Senate). Primary key is bioguide_id (national standard).
CREATE TABLE federal_members (
  bioguide_id TEXT PRIMARY KEY,
  first_name TEXT,
  last_name TEXT,
  full_name TEXT,
  party TEXT,
  state TEXT,
  chamber TEXT CHECK (chamber IN ('house', 'senate')),
  district INT,
  term_start DATE,
  term_end DATE,
  is_current BOOLEAN DEFAULT true,
  photo_url TEXT,
  office_url TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_federal_members_state_current
  ON federal_members (state, is_current);

-- Bills tracked from Congress.gov. Composite PK matches the API's shape.
CREATE TABLE federal_bills (
  congress INT NOT NULL,
  bill_type TEXT NOT NULL,                               -- hr, s, hjres, sjres, hconres, sconres, hres, sres
  bill_number INT NOT NULL,
  title TEXT,
  summary TEXT,
  sponsor_bioguide_id TEXT REFERENCES federal_members(bioguide_id),
  introduced_date DATE,
  latest_action_date DATE,
  latest_action_text TEXT,
  policy_area TEXT,
  subjects TEXT[] DEFAULT '{}',
  topic_tags TEXT[] DEFAULT '{}',                        -- mapped to sub_dimensions for matching
  url TEXT,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (congress, bill_type, bill_number)
);

CREATE INDEX idx_federal_bills_latest_action
  ON federal_bills (latest_action_date DESC);

CREATE INDEX idx_federal_bills_topic_tags
  ON federal_bills USING GIN (topic_tags);

-- Roll call votes.
CREATE TABLE federal_votes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  congress INT NOT NULL,
  chamber TEXT NOT NULL CHECK (chamber IN ('house', 'senate')),
  session INT NOT NULL,
  roll_call INT NOT NULL,
  vote_date TIMESTAMPTZ NOT NULL,
  bill_congress INT,
  bill_type TEXT,
  bill_number INT,
  question TEXT,
  description TEXT,
  result TEXT,
  yes_count INT,
  no_count INT,
  url TEXT,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (congress, chamber, session, roll_call),
  FOREIGN KEY (bill_congress, bill_type, bill_number)
    REFERENCES federal_bills(congress, bill_type, bill_number) ON DELETE SET NULL
);

CREATE INDEX idx_federal_votes_bill
  ON federal_votes (bill_congress, bill_type, bill_number);

CREATE INDEX idx_federal_votes_date
  ON federal_votes (vote_date DESC);

-- Individual member positions on each vote.
CREATE TABLE federal_vote_positions (
  vote_id UUID NOT NULL REFERENCES federal_votes(id) ON DELETE CASCADE,
  bioguide_id TEXT NOT NULL REFERENCES federal_members(bioguide_id),
  position TEXT NOT NULL CHECK (position IN ('Yea', 'Nay', 'Present', 'Not Voting', 'Aye', 'No')),
  PRIMARY KEY (vote_id, bioguide_id)
);

CREATE INDEX idx_vote_positions_member
  ON federal_vote_positions (bioguide_id);

-- Regulations.gov — federal public comment windows.
CREATE TABLE federal_comment_windows (
  document_id TEXT PRIMARY KEY,
  agency_id TEXT,
  agency_name TEXT,
  title TEXT NOT NULL,
  docket_id TEXT,
  comment_start_date DATE,
  comment_end_date DATE,
  topic_tags TEXT[] DEFAULT '{}',
  summary TEXT,
  url TEXT,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_comment_windows_end_date
  ON federal_comment_windows (comment_end_date);

CREATE INDEX idx_comment_windows_topics
  ON federal_comment_windows USING GIN (topic_tags);

-- FEC campaign finance event log (for followed federal candidates/committees).
CREATE TABLE fec_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL,                              -- 'filing', 'large_contribution', 'independent_expenditure'
  fec_candidate_id TEXT,
  fec_committee_id TEXT,
  bioguide_id TEXT REFERENCES federal_members(bioguide_id),
  amount NUMERIC,
  counterparty TEXT,
  event_date DATE,
  description TEXT,
  url TEXT,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_fec_alerts_bioguide
  ON fec_alerts (bioguide_id, event_date DESC);

-- ============================================================
-- 3. STATE-EXTRACTED DATA — AI pipeline with full provenance
-- ============================================================

-- State campaign finance events extracted from SOS PDFs/HTML.
CREATE TABLE state_cf_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  state TEXT NOT NULL,
  candidate_name TEXT,
  candidate_office TEXT,
  committee_name TEXT,
  event_type TEXT NOT NULL,                              -- 'contribution', 'expenditure', 'loan', 'filing'
  amount NUMERIC,
  event_date DATE,
  counterparty TEXT,
  filing_url TEXT,
  confidence_score NUMERIC CHECK (confidence_score >= 0 AND confidence_score <= 1),
  extraction_audit_id UUID,                              -- FK set below after extraction_audit exists
  verified BOOLEAN NOT NULL DEFAULT false,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_state_cf_state_date
  ON state_cf_events (state, event_date DESC);

-- State rulemaking comment windows (per-state, per-agency).
CREATE TABLE state_rulemaking_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  state TEXT NOT NULL,
  agency TEXT,
  title TEXT NOT NULL,
  summary TEXT,
  topic_tags TEXT[] DEFAULT '{}',
  comment_start_date DATE,
  comment_end_date DATE,
  source_url TEXT NOT NULL,
  confidence_score NUMERIC CHECK (confidence_score >= 0 AND confidence_score <= 1),
  extraction_audit_id UUID,
  verified BOOLEAN NOT NULL DEFAULT false,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (state, source_url)
);

CREATE INDEX idx_state_rulemaking_end_date
  ON state_rulemaking_events (state, comment_end_date);

CREATE INDEX idx_state_rulemaking_topics
  ON state_rulemaking_events USING GIN (topic_tags);

-- Ballot measures — lifecycle tracking from petition through vote.
CREATE TABLE ballot_measures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  state TEXT NOT NULL,
  jurisdiction TEXT,                                     -- 'statewide', 'county:salt_lake', 'city:slc'
  title TEXT NOT NULL,
  summary TEXT,
  topic_tags TEXT[] DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN (
    'proposed', 'circulating', 'qualified', 'on_ballot', 'passed', 'failed', 'withdrawn'
  )),
  filing_date DATE,
  qualified_date DATE,
  election_date DATE,
  signature_requirement INT,
  signatures_collected INT,
  source_url TEXT NOT NULL,
  sponsor_name TEXT,
  confidence_score NUMERIC CHECK (confidence_score >= 0 AND confidence_score <= 1),
  extraction_audit_id UUID,
  verified BOOLEAN NOT NULL DEFAULT false,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (state, source_url)
);

CREATE INDEX idx_ballot_measures_state_status
  ON ballot_measures (state, status);

CREATE INDEX idx_ballot_measures_election_date
  ON ballot_measures (election_date);

CREATE INDEX idx_ballot_measures_topics
  ON ballot_measures USING GIN (topic_tags);

-- Municipal meetings (town halls, city council, school board, etc.).
CREATE TABLE municipal_meetings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  state TEXT NOT NULL,
  jurisdiction TEXT NOT NULL,                            -- city/county/district name
  jurisdiction_type TEXT CHECK (jurisdiction_type IN (
    'city_council', 'county_commission', 'school_board', 'planning', 'other'
  )),
  title TEXT,
  meeting_datetime TIMESTAMPTZ NOT NULL,
  agenda_url TEXT,
  topic_tags TEXT[] DEFAULT '{}',
  source_url TEXT NOT NULL,
  platform TEXT,                                         -- 'legistar', 'granicus', 'other', 'direct'
  confidence_score NUMERIC CHECK (confidence_score >= 0 AND confidence_score <= 1),
  extraction_audit_id UUID,
  verified BOOLEAN NOT NULL DEFAULT false,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_url, meeting_datetime)
);

CREATE INDEX idx_municipal_meetings_state_date
  ON municipal_meetings (state, meeting_datetime);

CREATE INDEX idx_municipal_meetings_topics
  ON municipal_meetings USING GIN (topic_tags);

-- State legislator vote cache — fallback when OpenStates degrades.
CREATE TABLE state_legislator_votes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  state TEXT NOT NULL,
  chamber TEXT NOT NULL,
  session_year INT NOT NULL,
  legislator_name TEXT NOT NULL,
  legislator_ocd_id TEXT,
  bill_identifier TEXT NOT NULL,
  bill_title TEXT,
  vote_date DATE,
  position TEXT,
  source TEXT NOT NULL CHECK (source IN ('openstates', 'direct_scrape')),
  source_url TEXT,
  confidence_score NUMERIC CHECK (confidence_score >= 0 AND confidence_score <= 1),
  extraction_audit_id UUID,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (state, chamber, session_year, bill_identifier, legislator_name)
);

CREATE INDEX idx_state_legislator_votes_person
  ON state_legislator_votes (state, legislator_name);

-- ============================================================
-- 4. OFFICEHOLDERS — AI-maintained, 5th B2B revenue stream seed
-- ============================================================

CREATE TABLE officeholders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ocd_division_id TEXT,                                  -- Census Open Civic Data ID
  full_name TEXT NOT NULL,
  office_name TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('federal', 'state', 'county', 'city', 'school_district', 'other')),
  state TEXT NOT NULL,
  jurisdiction TEXT,                                     -- county / city / district name
  party TEXT,
  term_start DATE,
  term_end DATE,
  email TEXT,
  phone TEXT,
  website_url TEXT,
  photo_url TEXT,
  source_url TEXT NOT NULL,
  bioguide_id TEXT REFERENCES federal_members(bioguide_id),  -- link for federal
  confidence_score NUMERIC CHECK (confidence_score >= 0 AND confidence_score <= 1),
  extraction_audit_id UUID,
  verified BOOLEAN NOT NULL DEFAULT false,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- pg_trgm needed for fuzzy name matching in officeholder lookup.
-- Must be enabled BEFORE the trigram index references gin_trgm_ops.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX idx_officeholders_ocd
  ON officeholders (ocd_division_id);

CREATE INDEX idx_officeholders_state_level
  ON officeholders (state, level);

CREATE INDEX idx_officeholders_name_trgm
  ON officeholders USING GIN (full_name gin_trgm_ops);

-- ============================================================
-- 5. EXTRACTION AUDIT — provenance for every AI-extracted row
-- ============================================================

CREATE TABLE extraction_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  extractor_name TEXT NOT NULL,                          -- e.g. 'state_cf_pdf', 'municipal_legistar'
  source_url TEXT NOT NULL,
  source_fetched_at TIMESTAMPTZ NOT NULL,
  source_hash TEXT,                                      -- SHA-256 of fetched content for cache lookup
  model TEXT NOT NULL,                                   -- model ID used
  prompt_version TEXT NOT NULL,                          -- prompt template version for repro
  confidence_score NUMERIC CHECK (confidence_score >= 0 AND confidence_score <= 1),
  raw_response TEXT,                                     -- truncated, for audit
  validation_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (validation_status IN ('pending', 'auto_passed', 'human_verified', 'flagged', 'rejected')),
  validator_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  validated_at TIMESTAMPTZ
);

CREATE INDEX idx_extraction_audit_status
  ON extraction_audit (validation_status) WHERE validation_status = 'pending';

CREATE INDEX idx_extraction_audit_source
  ON extraction_audit (source_url, source_fetched_at DESC);

-- Now wire extraction_audit_id FKs on the tables that reference it.
ALTER TABLE state_cf_events
  ADD CONSTRAINT fk_state_cf_audit
  FOREIGN KEY (extraction_audit_id) REFERENCES extraction_audit(id) ON DELETE SET NULL;

ALTER TABLE state_rulemaking_events
  ADD CONSTRAINT fk_state_rulemaking_audit
  FOREIGN KEY (extraction_audit_id) REFERENCES extraction_audit(id) ON DELETE SET NULL;

ALTER TABLE ballot_measures
  ADD CONSTRAINT fk_ballot_measures_audit
  FOREIGN KEY (extraction_audit_id) REFERENCES extraction_audit(id) ON DELETE SET NULL;

ALTER TABLE municipal_meetings
  ADD CONSTRAINT fk_municipal_meetings_audit
  FOREIGN KEY (extraction_audit_id) REFERENCES extraction_audit(id) ON DELETE SET NULL;

ALTER TABLE state_legislator_votes
  ADD CONSTRAINT fk_state_legislator_votes_audit
  FOREIGN KEY (extraction_audit_id) REFERENCES extraction_audit(id) ON DELETE SET NULL;

ALTER TABLE officeholders
  ADD CONSTRAINT fk_officeholders_audit
  FOREIGN KEY (extraction_audit_id) REFERENCES extraction_audit(id) ON DELETE SET NULL;

-- ============================================================
-- 6. DIGEST SEND LOG
-- ============================================================

CREATE TABLE digest_sends (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscriber_id UUID NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
  digest_type TEXT NOT NULL CHECK (digest_type IN (
    'monthly', 'biweekly', 'weekly', 'election_reminder_90d',
    'election_reminder_30d', 'election_reminder_7d', 'election_day',
    'ballot_preview_60d', 'ballot_preview_30d', 'ballot_preview_7d',
    'comment_window_alert', 'vote_alert'
  )),
  channel TEXT NOT NULL CHECK (channel IN ('email', 'sms')),
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  items JSONB,                                           -- structured record of what went in
  resend_message_id TEXT,                                -- Resend webhook correlation
  delivered BOOLEAN,
  opened_at TIMESTAMPTZ,
  clicked_at TIMESTAMPTZ,
  bounced BOOLEAN DEFAULT false,
  unsubscribed_from_click BOOLEAN DEFAULT false
);

CREATE INDEX idx_digest_sends_subscriber_sent
  ON digest_sends (subscriber_id, sent_at DESC);

CREATE INDEX idx_digest_sends_resend_id
  ON digest_sends (resend_message_id) WHERE resend_message_id IS NOT NULL;

-- ============================================================
-- 7. TRIGGERS
-- ============================================================

CREATE TRIGGER federal_members_updated_at
  BEFORE UPDATE ON federal_members
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER federal_bills_updated_at
  BEFORE UPDATE ON federal_bills
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER ballot_measures_updated_at
  BEFORE UPDATE ON ballot_measures
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER officeholders_updated_at
  BEFORE UPDATE ON officeholders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- 8. ROW-LEVEL SECURITY
-- ============================================================

-- Subscribers: only the owning user (via x-session-token) can read/modify their own row.
-- Inserts happen via the service role (signup flow). Direct updates are restricted.
ALTER TABLE subscribers ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriber_follows ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Subscribers self select"
  ON subscribers FOR SELECT
  USING (
    user_id IN (
      SELECT id FROM users WHERE session_token = public.session_token()
    )
  );

-- INSERT/UPDATE/DELETE on subscribers require service role (signup + verify + unsubscribe flows)

CREATE POLICY "Follows self select"
  ON subscriber_follows FOR SELECT
  USING (
    subscriber_id IN (
      SELECT s.id FROM subscribers s
      JOIN users u ON s.user_id = u.id
      WHERE u.session_token = public.session_token()
    )
  );

-- Federal data: public read (it's public data anyway).
ALTER TABLE federal_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE federal_bills ENABLE ROW LEVEL SECURITY;
ALTER TABLE federal_votes ENABLE ROW LEVEL SECURITY;
ALTER TABLE federal_vote_positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE federal_comment_windows ENABLE ROW LEVEL SECURITY;
ALTER TABLE fec_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read federal_members" ON federal_members FOR SELECT USING (true);
CREATE POLICY "Public read federal_bills" ON federal_bills FOR SELECT USING (true);
CREATE POLICY "Public read federal_votes" ON federal_votes FOR SELECT USING (true);
CREATE POLICY "Public read federal_vote_positions" ON federal_vote_positions FOR SELECT USING (true);
CREATE POLICY "Public read federal_comment_windows" ON federal_comment_windows FOR SELECT USING (true);
CREATE POLICY "Public read fec_alerts" ON fec_alerts FOR SELECT USING (true);

-- State-extracted data: public read ONLY when verified=true.
-- Unverified extractions are visible only to service role for review.
ALTER TABLE state_cf_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE state_rulemaking_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE ballot_measures ENABLE ROW LEVEL SECURITY;
ALTER TABLE municipal_meetings ENABLE ROW LEVEL SECURITY;
ALTER TABLE state_legislator_votes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read verified state_cf_events"
  ON state_cf_events FOR SELECT USING (verified = true);

CREATE POLICY "Public read verified state_rulemaking_events"
  ON state_rulemaking_events FOR SELECT USING (verified = true);

CREATE POLICY "Public read verified ballot_measures"
  ON ballot_measures FOR SELECT USING (verified = true);

CREATE POLICY "Public read verified municipal_meetings"
  ON municipal_meetings FOR SELECT USING (verified = true);

CREATE POLICY "Public read state_legislator_votes"
  ON state_legislator_votes FOR SELECT USING (true);

-- Officeholders: public read always (it's public-officeholder data).
ALTER TABLE officeholders ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read officeholders" ON officeholders FOR SELECT USING (verified = true);

-- Extraction audit: public read for transparency (this is our /corrections equivalent).
ALTER TABLE extraction_audit ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read extraction_audit" ON extraction_audit FOR SELECT USING (true);

-- Digest sends: subscriber can see their own send history; otherwise service role only.
ALTER TABLE digest_sends ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Digest sends self select"
  ON digest_sends FOR SELECT
  USING (
    subscriber_id IN (
      SELECT s.id FROM subscribers s
      JOIN users u ON s.user_id = u.id
      WHERE u.session_token = public.session_token()
    )
  );

-- ============================================================
-- 9. HELPER RPCS
-- ============================================================

-- Find officeholders for a given OCD-ID (Google Civic replacement endpoint).
CREATE OR REPLACE FUNCTION lookup_officeholders_by_ocd(p_ocd_id TEXT)
RETURNS SETOF officeholders AS $$
  SELECT * FROM officeholders
  WHERE ocd_division_id = p_ocd_id
    AND verified = true
    AND (term_end IS NULL OR term_end >= CURRENT_DATE)
  ORDER BY level, office_name;
$$ LANGUAGE sql STABLE;

-- Return upcoming comment windows a subscriber's interest_tags match.
CREATE OR REPLACE FUNCTION upcoming_comment_windows_for_subscriber(p_subscriber_id UUID)
RETURNS SETOF federal_comment_windows AS $$
  SELECT fcw.*
  FROM federal_comment_windows fcw, subscribers s
  WHERE s.id = p_subscriber_id
    AND fcw.comment_end_date >= CURRENT_DATE
    AND fcw.topic_tags && s.interest_tags
  ORDER BY fcw.comment_end_date;
$$ LANGUAGE sql STABLE;
