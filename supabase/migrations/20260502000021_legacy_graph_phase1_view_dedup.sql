-- ============================================================
-- Phase 1 — Read-side dedup in v_voter_candidates
-- ============================================================
--
-- Companion to 20260502000020_legacy_graph_phase1_add_v2_columns.sql.
--
-- The current v_voter_candidates view UNIONs legacy `candidates` rows
-- with new-graph `candidacies` rows. When a legacy candidate has been
-- migrated to the new graph (i.e. a candidacy row has
-- legacy_candidate_id pointing at the legacy candidates.id), BOTH arms
-- of the union surface that human, producing duplicate cards inside
-- the same race. The display-level dedupCandidatesInRace() in
-- src/app/ballot/page.tsx absorbs the visible damage today.
--
-- Phase 1 step 3: collapse the duplication at the view level by
-- excluding legacy rows whose id is already referenced by some
-- candidacy.legacy_candidate_id. This means:
--   * The new-graph arm continues to expose the canonical row
--     (with person_id, bioguide_id, etc.).
--   * The legacy arm only emits rows that have NOT been migrated
--     yet — useful as the long-tail fallback while UT remains the
--     only state with a populated legacy graph.
--
-- The display-level dedupCandidatesInRace() and dedupRaces() stay in
-- place as belt-and-suspenders. Phase 2 (future PR) drops them when
-- the underlying data is provably clean.
--
-- The view shape (column list / order) is preserved exactly — Phase 1
-- doesn't change any consumer signatures. Only the legacy arm's WHERE
-- clause is new.
--
-- IDEMPOTENT: DROP VIEW IF EXISTS + CREATE VIEW.
-- NON-DESTRUCTIVE: only changes which rows are surfaced, not what's
-- stored. Reverts cleanly by re-running the prior migration.
-- ============================================================

DROP VIEW IF EXISTS v_voter_candidates CASCADE;

CREATE VIEW v_voter_candidates AS
-- LEGACY ARM: candidates joined to races. NEW in Phase 1: skip rows
-- whose id is already covered by a candidacies.legacy_candidate_id —
-- those humans are surfaced by the new arm with richer identity.
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
  EXISTS (
    SELECT 1 FROM questionnaire_responses qr2
    WHERE qr2.candidate_id = c.id
      AND qr2.attested_at IS NOT NULL
  )                                         AS self_attested,
  -- Per-party primary date: legacy races aren't in `elections`, so
  -- there's no per-party override to surface. Always NULL on this arm.
  NULL::DATE                                AS party_primary_date
FROM candidates c
JOIN races r ON r.id = c.race_id
LEFT JOIN people pl ON c.id = ANY(pl.legacy_candidate_ids)
-- Phase 1 dedup: drop legacy rows that have been bridged into the new
-- graph. The new arm already emits the same human with better identity.
WHERE NOT EXISTS (
  SELECT 1 FROM candidacies cdy_dup
  WHERE cdy_dup.legacy_candidate_id = c.id
)

UNION ALL

-- NEW ARM: candidacies. Unchanged from 20260502000005.
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
    ELSE NULL
  END                                       AS photo_url,
  ppl.bio                                   AS bio,
  ppl.website_url                           AS website_url,
  (cdy.status NOT IN ('pending_verification', 'withdrew',
                      'disqualified', 'lost_primary', 'lost_general'))
                                            AS published,
  (cdy.status = 'withdrew')                 AS withdrew,
  CASE
    WHEN cdy.legacy_candidate_id IS NOT NULL THEN EXISTS (
      SELECT 1 FROM questionnaire_responses qr2
      WHERE qr2.candidate_id = cdy.legacy_candidate_id
        AND qr2.attested_at IS NOT NULL
    )
    ELSE FALSE
  END                                       AS self_attested,
  pp.election_date                          AS party_primary_date
FROM candidacies cdy
JOIN elections e        ON e.id = cdy.election_id
JOIN offices o          ON o.id = e.office_id
JOIN jurisdictions j    ON j.id = o.jurisdiction_id
LEFT JOIN jurisdictions jp  ON jp.id = j.parent_id
LEFT JOIN jurisdictions jpp ON jpp.id = jp.parent_id
JOIN people ppl         ON ppl.id = cdy.person_id
LEFT JOIN parties pty   ON pty.id = cdy.primary_party_id
LEFT JOIN party_primaries pp
  ON pp.election_id = cdy.election_id
 AND pp.party = public.canonical_party_name(COALESCE(pty.display_name, cdy.party));

COMMENT ON VIEW v_voter_candidates IS
  'Unified voter-facing candidates view. Combines legacy `candidates` with '
  'new office-graph `candidacies`. Phase 1 sunset: the legacy arm now '
  'excludes rows whose id is referenced by candidacies.legacy_candidate_id '
  '(the new arm surfaces them with richer identity). Photo URLs are gated '
  'on candidate-portal opt-in (questionnaire_responses.photo_visible). '
  'self_attested flag indicates the candidate has affirmed their own '
  'positions via /for-candidates. party_primary_date carries a per-party '
  'primary override when one exists in party_primaries; NULL means use the '
  'race-level date.';
