/**
 * Retention-engine types. Mirrors the schema in
 * supabase/migrations/20260418000002_retention_engine.sql.
 *
 * The "four columns" retention thesis: (email/sms, state, match-profile, interest-tags).
 * Every surviving multi-state civic app (Vote.org, GovTrack, Resistbot, 5 Calls, MoveOn)
 * retains via this pattern. The app is acquisition; the list is the product.
 */

// ============================================================
// SUBSCRIBERS + FOLLOWS
// ============================================================

export type DigestFrequency = 'weekly' | 'biweekly' | 'monthly' | 'none';

export type Subscriber = {
  id: string;
  email: string | null;
  phone: string | null;
  state: string;
  match_id: string | null;
  user_id: string | null;
  interest_tags: string[];
  digest_frequency: DigestFrequency;
  prefers_sms: boolean;
  verified: boolean;
  subscribed_at: string;
  verified_at: string | null;
  unsubscribed_at: string | null;
  last_digest_at: string | null;
};

export type FollowTargetType = 'federal_member' | 'officeholder' | 'candidate';

export type SubscriberFollow = {
  id: string;
  subscriber_id: string;
  target_type: FollowTargetType;
  target_id: string;
  started_at: string;
  ended_at: string | null;
};

// ============================================================
// FEDERAL (Congress.gov, Regulations.gov, FEC)
// ============================================================

export type Chamber = 'house' | 'senate';

export type FederalMember = {
  bioguide_id: string;
  first_name: string | null;
  last_name: string | null;
  full_name: string | null;
  party: string | null;
  state: string | null;
  chamber: Chamber | null;
  district: number | null;
  term_start: string | null;
  term_end: string | null;
  is_current: boolean;
  photo_url: string | null;
  office_url: string | null;
  updated_at: string;
};

export type FederalBill = {
  congress: number;
  bill_type: string;
  bill_number: number;
  title: string | null;
  summary: string | null;
  sponsor_bioguide_id: string | null;
  introduced_date: string | null;
  latest_action_date: string | null;
  latest_action_text: string | null;
  policy_area: string | null;
  subjects: string[];
  topic_tags: string[];
  url: string | null;
  ingested_at: string;
  updated_at: string;
};

export type VotePosition = 'Yea' | 'Nay' | 'Present' | 'Not Voting' | 'Aye' | 'No';

export type FederalVote = {
  id: string;
  congress: number;
  chamber: Chamber;
  session: number;
  roll_call: number;
  vote_date: string;
  bill_congress: number | null;
  bill_type: string | null;
  bill_number: number | null;
  question: string | null;
  description: string | null;
  result: string | null;
  yes_count: number | null;
  no_count: number | null;
  url: string | null;
  ingested_at: string;
};

export type FederalVotePosition = {
  vote_id: string;
  bioguide_id: string;
  position: VotePosition;
};

export type FederalCommentWindow = {
  document_id: string;
  agency_id: string | null;
  agency_name: string | null;
  title: string;
  docket_id: string | null;
  comment_start_date: string | null;
  comment_end_date: string | null;
  topic_tags: string[];
  summary: string | null;
  url: string | null;
  ingested_at: string;
};

export type FecAlertEventType = 'filing' | 'large_contribution' | 'independent_expenditure';

export type FecAlert = {
  id: string;
  event_type: FecAlertEventType;
  fec_candidate_id: string | null;
  fec_committee_id: string | null;
  bioguide_id: string | null;
  amount: number | null;
  counterparty: string | null;
  event_date: string | null;
  description: string | null;
  url: string | null;
  ingested_at: string;
};

// ============================================================
// STATE-EXTRACTED (AI pipeline with provenance)
// ============================================================

export type StateCfEventType = 'contribution' | 'expenditure' | 'loan' | 'filing';

export type StateCfEvent = {
  id: string;
  state: string;
  candidate_name: string | null;
  candidate_office: string | null;
  committee_name: string | null;
  event_type: StateCfEventType;
  amount: number | null;
  event_date: string | null;
  counterparty: string | null;
  filing_url: string | null;
  confidence_score: number | null;
  extraction_audit_id: string | null;
  verified: boolean;
  ingested_at: string;
};

export type StateRulemakingEvent = {
  id: string;
  state: string;
  agency: string | null;
  title: string;
  summary: string | null;
  topic_tags: string[];
  comment_start_date: string | null;
  comment_end_date: string | null;
  source_url: string;
  confidence_score: number | null;
  extraction_audit_id: string | null;
  verified: boolean;
  ingested_at: string;
};

export type BallotMeasureStatus =
  | 'proposed'
  | 'circulating'
  | 'qualified'
  | 'on_ballot'
  | 'passed'
  | 'failed'
  | 'withdrawn';

export type BallotMeasure = {
  id: string;
  state: string;
  jurisdiction: string | null;
  title: string;
  summary: string | null;
  topic_tags: string[];
  status: BallotMeasureStatus;
  filing_date: string | null;
  qualified_date: string | null;
  election_date: string | null;
  signature_requirement: number | null;
  signatures_collected: number | null;
  source_url: string;
  sponsor_name: string | null;
  confidence_score: number | null;
  extraction_audit_id: string | null;
  verified: boolean;
  ingested_at: string;
  updated_at: string;
};

export type MunicipalJurisdictionType =
  | 'city_council'
  | 'county_commission'
  | 'school_board'
  | 'planning'
  | 'other';

export type MunicipalMeeting = {
  id: string;
  state: string;
  jurisdiction: string;
  jurisdiction_type: MunicipalJurisdictionType | null;
  title: string | null;
  meeting_datetime: string;
  agenda_url: string | null;
  topic_tags: string[];
  source_url: string;
  platform: 'legistar' | 'granicus' | 'other' | 'direct' | null;
  confidence_score: number | null;
  extraction_audit_id: string | null;
  verified: boolean;
  ingested_at: string;
};

export type StateLegislatorVoteSource = 'openstates' | 'direct_scrape';

export type StateLegislatorVote = {
  id: string;
  state: string;
  chamber: string;
  session_year: number;
  legislator_name: string;
  legislator_ocd_id: string | null;
  bill_identifier: string;
  bill_title: string | null;
  vote_date: string | null;
  position: string | null;
  source: StateLegislatorVoteSource;
  source_url: string | null;
  confidence_score: number | null;
  extraction_audit_id: string | null;
  ingested_at: string;
};

// ============================================================
// OFFICEHOLDERS (5th B2B stream)
// ============================================================

export type OfficeholderLevel = 'federal' | 'state' | 'county' | 'city' | 'school_district' | 'other';

export type Officeholder = {
  id: string;
  ocd_division_id: string | null;
  full_name: string;
  office_name: string;
  level: OfficeholderLevel;
  state: string;
  jurisdiction: string | null;
  party: string | null;
  term_start: string | null;
  term_end: string | null;
  email: string | null;
  phone: string | null;
  website_url: string | null;
  photo_url: string | null;
  source_url: string;
  bioguide_id: string | null;
  confidence_score: number | null;
  extraction_audit_id: string | null;
  verified: boolean;
  last_seen_at: string;
  updated_at: string;
};

// ============================================================
// EXTRACTION AUDIT
// ============================================================

export type ExtractionValidationStatus =
  | 'pending'
  | 'auto_passed'
  | 'human_verified'
  | 'flagged'
  | 'rejected';

export type ExtractionAudit = {
  id: string;
  extractor_name: string;
  source_url: string;
  source_fetched_at: string;
  source_hash: string | null;
  model: string;
  prompt_version: string;
  confidence_score: number | null;
  raw_response: string | null;
  validation_status: ExtractionValidationStatus;
  validator_notes: string | null;
  created_at: string;
  validated_at: string | null;
};

// ============================================================
// DIGEST SENDS
// ============================================================

export type DigestType =
  | 'monthly'
  | 'biweekly'
  | 'weekly'
  | 'election_reminder_90d'
  | 'election_reminder_30d'
  | 'election_reminder_7d'
  | 'election_day'
  | 'ballot_preview_60d'
  | 'ballot_preview_30d'
  | 'ballot_preview_7d'
  | 'comment_window_alert'
  | 'vote_alert';

export type DigestChannel = 'email' | 'sms';

export type DigestSend = {
  id: string;
  subscriber_id: string;
  digest_type: DigestType;
  channel: DigestChannel;
  sent_at: string;
  items: Record<string, unknown> | null;
  resend_message_id: string | null;
  delivered: boolean | null;
  opened_at: string | null;
  clicked_at: string | null;
  bounced: boolean;
  unsubscribed_from_click: boolean;
};

/**
 * Items included in a digest — a union type so we can render each kind cleanly.
 */
export type DigestItem =
  | {
      kind: 'federal_vote';
      member_name: string;
      bioguide_id: string;
      position: VotePosition;
      bill_identifier: string;
      bill_title: string;
      vote_date: string;
      url: string | null;
    }
  | {
      kind: 'comment_window';
      agency: string;
      title: string;
      comment_end_date: string;
      topic_tags: string[];
      url: string | null;
    }
  | {
      kind: 'ballot_measure_update';
      state: string;
      title: string;
      old_status: BallotMeasureStatus;
      new_status: BallotMeasureStatus;
      url: string | null;
    }
  | {
      kind: 'state_rulemaking';
      state: string;
      agency: string;
      title: string;
      comment_end_date: string;
      url: string;
    }
  | {
      kind: 'municipal_meeting';
      jurisdiction: string;
      title: string;
      meeting_datetime: string;
      topic_tags: string[];
      url: string;
    }
  | {
      kind: 'election_reminder';
      days_until: number;
      election_date: string;
      state: string;
      election_type: string;
    }
  | {
      kind: 'ballot_preview';
      election_date: string;
      race_count: number;
      top_matches: Array<{ candidate_name: string; race_name: string; match_score: number }>;
    }
  | {
      // Question-of-the-day/week POINTER (work-order Phase 2B). Contains NO
      // opinion and requests none: it is a link back to the on-device guide,
      // where the question is fetched and answered locally. `period` frames the
      // copy ("today's" vs "this week's").
      kind: 'daily_prompt';
      period: string;
      url: string;
    };
