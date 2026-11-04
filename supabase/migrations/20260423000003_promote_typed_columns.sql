-- ============================================================
-- Promote typed columns off JSONB soup
-- ============================================================
--
-- Four changes:
--
-- 1. people.contact_email, contact_phone, website_url as typed
--    public columns (replacing meta->>'contact_email' access).
--    Public-read because candidate contact info is public-record
--    once filed.
--
-- 2. people.contact_bounced, contact_unsubscribed tracked in a
--    SEPARATE table with service-role-only read. Leaking
--    "your email bounced" in the public API would embarrass
--    candidates (Sam Reyes review, 2026-04-23).
--
-- 3. candidacies.incumbent_of_office_id: FK promotion from
--    candidacies.is_incumbent bool + office_tenures lookup.
--    Backfill is DETERMINISTIC (ORDER BY started_on DESC, office_id).
--    Fixes non-idempotent backfill blocker from prior review.
--
-- 4. candidacies.withdrawal_effective_at, withdrawal_reason:
--    typed columns for the withdrawal flow the
--    candidacy_status_changes trigger (Item 3) writes to.
--
-- Dual-write posture: this migration POPULATES the typed columns
-- from meta. It does NOT null the meta keys. Cutover of readers
-- happens in a separate PR; the meta keys get dropped in a later
-- migration after all call sites are migrated.
-- ============================================================

-- ============================================================
-- 1. people: typed contact columns
-- ============================================================

ALTER TABLE people
  ADD COLUMN IF NOT EXISTS contact_email TEXT,
  ADD COLUMN IF NOT EXISTS contact_phone TEXT,
  ADD COLUMN IF NOT EXISTS contact_email_source TEXT,
  ADD COLUMN IF NOT EXISTS contact_email_verified_at DATE,
  ADD COLUMN IF NOT EXISTS contact_email_discovered_via TEXT;

-- Case-insensitive email index
CREATE INDEX IF NOT EXISTS idx_people_contact_email_lower
  ON people ((lower(contact_email))) WHERE contact_email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_people_contact_phone
  ON people (contact_phone) WHERE contact_phone IS NOT NULL;

-- Backfill from people.meta (dual-write; do NOT null meta keys)
UPDATE people SET
  contact_email = NULLIF(TRIM(meta->>'contact_email'), ''),
  contact_phone = NULLIF(TRIM(meta->>'contact_phone'), ''),
  contact_email_source = NULLIF(TRIM(meta->>'contact_email_source'), ''),
  contact_email_verified_at = NULLIF(TRIM(meta->>'contact_email_verified_at'), '')::DATE,
  contact_email_discovered_via = NULLIF(TRIM(meta->>'contact_email_discovered_via'), '')
WHERE meta ? 'contact_email' OR meta ? 'contact_phone'
   OR meta ? 'contact_email_source' OR meta ? 'contact_email_verified_at'
   OR meta ? 'contact_email_discovered_via';

-- ============================================================
-- 2. person_contact_status: private, service-role only
--
-- Tracks bounce / unsubscribe / block state for candidate and
-- voter contacts. Kept out of the public people table so the
-- public API cannot leak "this candidate's email bounced."
-- ============================================================

CREATE TABLE IF NOT EXISTS person_contact_status (
  person_id UUID PRIMARY KEY REFERENCES people(id) ON DELETE CASCADE,
  email_bounced BOOLEAN NOT NULL DEFAULT FALSE,
  email_bounced_at TIMESTAMPTZ,
  email_bounce_count INT NOT NULL DEFAULT 0,
  email_unsubscribed BOOLEAN NOT NULL DEFAULT FALSE,
  email_unsubscribed_at TIMESTAMPTZ,
  phone_do_not_call BOOLEAN NOT NULL DEFAULT FALSE,
  last_successful_contact_at TIMESTAMPTZ,
  last_send_attempted_at TIMESTAMPTZ,
  meta JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pcs_bounced
  ON person_contact_status (email_bounced) WHERE email_bounced = TRUE;
CREATE INDEX IF NOT EXISTS idx_pcs_unsubscribed
  ON person_contact_status (email_unsubscribed) WHERE email_unsubscribed = TRUE;

ALTER TABLE person_contact_status ENABLE ROW LEVEL SECURITY;
-- Service-role only; no public policies.

-- ============================================================
-- 3. candidacies: incumbency + withdrawal typed columns
-- ============================================================

ALTER TABLE candidacies
  ADD COLUMN IF NOT EXISTS incumbent_of_office_id UUID REFERENCES offices(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS withdrawal_effective_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS withdrawal_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_candidacies_incumbent_of
  ON candidacies (incumbent_of_office_id) WHERE incumbent_of_office_id IS NOT NULL;

-- ============================================================
-- 4. Deterministic incumbent backfill
--
-- Prior review blocker: the old correlated subquery had no
-- ORDER BY, so dual-hat incumbents (people holding 2+ offices)
-- got assigned nondeterministically. Fix: ORDER BY
-- started_on DESC, office_id ASC so repeat runs are idempotent.
-- ============================================================

DO $$
DECLARE
  v_dual_hat_count INT;
BEGIN
  -- Count candidates with >1 active tenure (for observability)
  SELECT count(*) INTO v_dual_hat_count
  FROM (
    SELECT person_id, count(*) as n
    FROM office_tenures
    WHERE ended_on IS NULL
    GROUP BY person_id HAVING count(*) > 1
  ) s;

  RAISE NOTICE 'Dual-hat incumbents (people holding >1 active office): %', v_dual_hat_count;
END $$;

-- Backfill: for each candidacy marked is_incumbent=TRUE, pick the
-- MOST RECENT (started_on DESC) active tenure, tiebreak by office_id.
-- DISTINCT ON picks one deterministic row per person_id; the UPDATE
-- then joins each matching candidacy to that one row. Re-running
-- produces identical data.
UPDATE candidacies c
SET incumbent_of_office_id = sub.office_id
FROM (
  SELECT DISTINCT ON (person_id) person_id, office_id
  FROM office_tenures
  WHERE ended_on IS NULL
  ORDER BY person_id, started_on DESC NULLS LAST, office_id ASC
) sub
WHERE c.person_id = sub.person_id
  AND c.is_incumbent = TRUE
  AND c.incumbent_of_office_id IS NULL;

-- ============================================================
-- 5. Documentation
-- ============================================================

COMMENT ON COLUMN people.contact_email IS
  'Typed replacement for meta->>contact_email. Dual-written during cutover: both locations '
  'stay populated until all readers migrate. Candidate contact email is public-record once '
  'filed; public-read is intentional.';

COMMENT ON TABLE person_contact_status IS
  'Private email/phone deliverability state. Service-role only. Deliberately separate from '
  'people so the public API cannot leak "this candidate email bounced". Updated by the '
  'retention-engine mailer on bounce/unsubscribe callbacks.';

COMMENT ON COLUMN candidacies.incumbent_of_office_id IS
  'FK to the office this candidate currently holds (if is_incumbent=TRUE). Backfill was '
  'deterministic: most recent active tenure, tiebreak by office_id. Re-running the backfill '
  'produces identical data.';

COMMENT ON COLUMN candidacies.withdrawal_effective_at IS
  'When the withdrawal actually takes effect. Paired with candidacy_status_changes row of '
  'status=withdrew. Used by ballot-display logic to hide the candidate after the effective '
  'date even if status was updated later.';
