-- ============================================================
-- Photo opt-in + per-candidate "self-attested" signal in the
-- voter-facing view.
-- ============================================================
--
-- Three changes, all driven by user feedback on the live /ballot:
--
-- 1. `questionnaire_responses.photo_visible BOOLEAN DEFAULT FALSE`
--    Photos are now opt-in per the candidate-portal affirmation.
--    Default false; the affirm flow sets it true when the candidate
--    explicitly checks the "show my photo" box.
--
-- 2. `v_voter_candidates.photo_url` is gated through this flag.
--    The view returns the underlying photo_url ONLY when:
--      - the candidate has an `attested_at IS NOT NULL` questionnaire
--        response on file, AND
--      - that response has `photo_visible = TRUE`.
--    All other rows return NULL for photo_url. Voters fall back to
--    the initials avatar (already implemented in CandidateRow).
--
-- 3. `v_voter_candidates.self_attested BOOLEAN`
--    True when the candidate has at least one `attested_at IS NOT NULL`
--    questionnaire_responses row. This drives the "Verified by candidate"
--    badge in CandidateRow.
--
-- The view is recreated (not altered) because PostgreSQL doesn't allow
-- adding columns to a view in place. Both arms of the UNION ALL must
-- match shape exactly.
--
-- Rollback note: dropping the column also removes the photo_visible
-- defaults; any candidate who opted in would revert to opted-out on
-- restore. Acceptable — they can re-affirm via the portal.
-- ============================================================

ALTER TABLE questionnaire_responses
  ADD COLUMN IF NOT EXISTS photo_visible BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN questionnaire_responses.photo_visible IS
  'Candidate-portal opt-in for showing photo on voter-facing surfaces. '
  'Default FALSE per user feedback (some candidates prefer to omit photos). '
  'Read by v_voter_candidates to gate photo_url exposure.';

-- Recreate v_voter_candidates with photo gating + self-attested signal.
DROP VIEW IF EXISTS v_voter_candidates CASCADE;

CREATE VIEW v_voter_candidates AS
-- LEGACY ARM: candidates joined to races. We try to resolve a person_id
-- by reverse-lookup of people.legacy_candidate_ids. Photo opt-in is
-- read from the most recent attested questionnaire_response for the
-- candidate; absent that, photo_url returns NULL.
SELECT
  c.id                                      AS id,
  c.race_id                                 AS race_id,
  c.name                                    AS name,
  r.name                                    AS office_name,
  r.level                                   AS office_level,
  NULL::CHAR(2)                             AS state_fips,
  r.district                                AS district_identifier,
  c.party                                   AS party,
  CASE
    WHEN c.party ILIKE 'Democrat%'          THEN 'D'
    WHEN c.party ILIKE 'Republican%'        THEN 'R'
    WHEN c.party ILIKE 'Libertarian%'       THEN 'L'
    WHEN c.party ILIKE 'Green%'             THEN 'G'
    WHEN c.party ILIKE 'Independent%'       THEN 'I'
    WHEN c.party ILIKE 'United Utah%'       THEN 'UU'
    ELSE NULL
  END                                       AS party_abbreviation,
  CASE
    WHEN c.party ILIKE 'Democrat%'          THEN '#0044AA'
    WHEN c.party ILIKE 'Republican%'        THEN '#AA0000'
    WHEN c.party ILIKE 'Libertarian%'       THEN '#FED105'
    WHEN c.party ILIKE 'Green%'             THEN '#17AA5C'
    ELSE NULL
  END                                       AS party_color,
  FALSE                                     AS incumbent,
  TRUE                                      AS is_legacy,
  c.id                                      AS legacy_candidate_id,
  pl.meta->>'bioguide_id'                   AS bioguide_id,
  pl.id                                     AS person_id,
  -- Photo gated on opt-in. Sub-select pulls the most recent attested
  -- response and checks its photo_visible flag. NULL collapses to false.
  CASE
    WHEN COALESCE((
      SELECT qr.photo_visible
      FROM questionnaire_responses qr
      WHERE qr.candidate_id = c.id
        AND qr.attested_at IS NOT NULL
      ORDER BY qr.attested_at DESC
      LIMIT 1
    ), FALSE)
    THEN c.photo_url
    ELSE NULL
  END                                       AS photo_url,
  c.bio                                     AS bio,
  c.website_url                             AS website_url,
  c.published                               AS published,
  FALSE                                     AS withdrew,
  -- self_attested: any affirmed questionnaire_response for this candidate.
  EXISTS (
    SELECT 1 FROM questionnaire_responses qr2
    WHERE qr2.candidate_id = c.id
      AND qr2.attested_at IS NOT NULL
  )                                         AS self_attested
FROM candidates c
JOIN races r ON r.id = c.race_id
LEFT JOIN people pl ON c.id = ANY(pl.legacy_candidate_ids)

UNION ALL

-- NEW ARM: candidacies. Photo gating applies via the legacy_candidate_id
-- bridge — a candidacy that maps back to a legacy candidate inherits
-- the same opt-in. New-graph candidacies without a legacy bridge get
-- their photo from people.photo_url unconditionally for now (the candidate
-- hasn't been through the /for-candidates flow because that flow targets
-- legacy candidates.id; documented in 20260502000000_for_candidates_portal.sql).
-- When the portal extends to candidacies directly, the gate moves here too.
SELECT
  cdy.id                                    AS id,
  cdy.election_id                           AS race_id,
  ppl.canonical_name                        AS name,
  o.canonical_name                          AS office_name,
  o.level                                   AS office_level,
  COALESCE(j.fips_state, jp.fips_state, jpp.fips_state)
                                            AS state_fips,
  o.seat_designation                        AS district_identifier,
  COALESCE(pty.display_name, cdy.party)     AS party,
  pty.abbreviation                          AS party_abbreviation,
  pty.color_hex                             AS party_color,
  COALESCE(
    cdy.is_incumbent,
    EXISTS (
      SELECT 1 FROM office_tenures ot
      WHERE ot.office_id = e.office_id
        AND ot.person_id = cdy.person_id
        AND ot.ended_on IS NULL
    )
  )                                         AS incumbent,
  FALSE                                     AS is_legacy,
  cdy.legacy_candidate_id                   AS legacy_candidate_id,
  ppl.meta->>'bioguide_id'                  AS bioguide_id,
  cdy.person_id                             AS person_id,
  -- Same gating logic as legacy arm, applied via legacy_candidate_id when present.
  CASE
    WHEN cdy.legacy_candidate_id IS NOT NULL
     AND COALESCE((
        SELECT qr.photo_visible
        FROM questionnaire_responses qr
        WHERE qr.candidate_id = cdy.legacy_candidate_id
          AND qr.attested_at IS NOT NULL
        ORDER BY qr.attested_at DESC
        LIMIT 1
      ), FALSE)
    THEN ppl.photo_url
    -- No legacy bridge: candidate hasn't claimed via portal yet, so
    -- nothing to opt-into. Suppress photo by default per user feedback.
    ELSE NULL
  END                                       AS photo_url,
  ppl.bio                                   AS bio,
  ppl.website_url                           AS website_url,
  (cdy.status NOT IN ('pending_verification', 'withdrew',
                      'disqualified', 'lost_primary', 'lost_general'))
                                            AS published,
  (cdy.status = 'withdrew')                 AS withdrew,
  -- self_attested via legacy bridge.
  CASE
    WHEN cdy.legacy_candidate_id IS NOT NULL THEN EXISTS (
      SELECT 1 FROM questionnaire_responses qr2
      WHERE qr2.candidate_id = cdy.legacy_candidate_id
        AND qr2.attested_at IS NOT NULL
    )
    ELSE FALSE
  END                                       AS self_attested
FROM candidacies cdy
JOIN elections e        ON e.id = cdy.election_id
JOIN offices o          ON o.id = e.office_id
JOIN jurisdictions j    ON j.id = o.jurisdiction_id
LEFT JOIN jurisdictions jp  ON jp.id = j.parent_id
LEFT JOIN jurisdictions jpp ON jpp.id = jp.parent_id
JOIN people ppl         ON ppl.id = cdy.person_id
LEFT JOIN parties pty   ON pty.id = cdy.primary_party_id;

COMMENT ON VIEW v_voter_candidates IS
  'Unified voter-facing candidates view. Combines legacy `candidates` with '
  'new office-graph `candidacies`. Photo URLs are gated on candidate-portal '
  'opt-in (questionnaire_responses.photo_visible). self_attested flag '
  'indicates the candidate has affirmed their own positions via /for-candidates.';
