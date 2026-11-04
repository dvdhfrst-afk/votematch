-- Candidate identity claims — explicit "I am also this candidate" attestations
-- collected via the /for-candidates portal.
--
-- Background
-- ----------
-- A single human can have multiple `candidates` rows (and, downstream, multiple
-- `people` rows) because we ingest from many state/federal feeds with no
-- shared key. The `canonical_key` derivation in 20260423000011 catches
-- name-only matches; `dedup-people.ts` does conservative auto-merges based on
-- corroborating fields (birth_year, bioguide_id, FEC id, derived state).
--
-- The "identity-default-split" principle says: when in doubt, KEEP records
-- separate. The candidate themselves is the highest-trust signal for whether
-- two records are the same human. This table captures those self-claims.
--
-- A row here is the candidate's attestation: "I, the person who authenticated
-- via candidate_questionnaire_tokens row X, am also the candidate at
-- candidates.id = claimed_candidate_id." It does NOT itself merge `people`
-- rows — that's a downstream step (admin review or extension to
-- dedup-people.ts). Until then, claims accumulate in status='pending'.
--
-- Public read so the eventual /corrections page or candidate profile can show
-- "this candidate has self-attested they are also X, Y, Z" as a voter-trust
-- signal. Writes are service-role only (the server action uses the service
-- client after token validation).

CREATE TABLE IF NOT EXISTS candidate_identity_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The candidate identity that did the claiming (their primary candidate
  -- row — the one their token was issued for).
  primary_candidate_id UUID NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  primary_person_id UUID REFERENCES people(id) ON DELETE SET NULL,

  -- The candidate identity being claimed AS-ALSO-ME.
  claimed_candidate_id UUID NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  claimed_person_id UUID REFERENCES people(id) ON DELETE SET NULL,

  -- Which questionnaire_responses row carried the attestation. Lets the
  -- downstream merge processor walk back to the signed signature text.
  attesting_questionnaire_response_id UUID REFERENCES questionnaire_responses(id),
  attested_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- pending: logged but people rows not merged yet.
  -- merged:  people rows have been merged via dedup-people.ts merge mechanics.
  -- rejected: admin overrode (false positive / misrepresentation).
  -- dismissed: the candidate themselves clicked "no, different person"; we keep
  --            the row so we don't keep prompting them about the same pair.
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'merged', 'rejected', 'dismissed')),
  resolved_at TIMESTAMPTZ,
  resolved_by_user_id UUID,
  notes TEXT,
  meta JSONB NOT NULL DEFAULT '{}',

  UNIQUE (primary_candidate_id, claimed_candidate_id)
);

CREATE INDEX IF NOT EXISTS idx_identity_claims_primary
  ON candidate_identity_claims (primary_candidate_id);
CREATE INDEX IF NOT EXISTS idx_identity_claims_claimed
  ON candidate_identity_claims (claimed_candidate_id);
CREATE INDEX IF NOT EXISTS idx_identity_claims_status
  ON candidate_identity_claims (status) WHERE status = 'pending';

ALTER TABLE candidate_identity_claims ENABLE ROW LEVEL SECURITY;

-- Public read for transparency. The pair (primary, claimed) is voter-relevant:
-- it lets a voter see "this candidate has confirmed these prior candidacies
-- belong to them" without needing admin tools.
DROP POLICY IF EXISTS "Public read identity claims" ON candidate_identity_claims;
CREATE POLICY "Public read identity claims"
  ON candidate_identity_claims FOR SELECT USING (true);
-- No INSERT/UPDATE/DELETE policies — service role only.

COMMENT ON TABLE candidate_identity_claims IS
  'Candidate self-attestations of "I am also this other candidate". Captured '
  'via /for-candidates/profile/[token]/related. Rows accumulate in pending '
  'state; downstream merge processor (future Inngest fn or extension to '
  'dedup-people.ts) reads pending rows, applies merge_people() mechanics, and '
  'flips status to merged. See dedup-people.ts for merge mechanics.';
