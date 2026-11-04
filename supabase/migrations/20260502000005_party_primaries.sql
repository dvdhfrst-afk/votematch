-- ============================================================
-- Per-party primary dates
-- ============================================================
--
-- Schema gap (noted by the recent /ballot rework): the `elections`
-- table keys on (office_id, election_date, election_type), so each
-- election row carries exactly ONE date. A state where the
-- Republican primary and the Democratic primary land on different
-- days (e.g. closed-primary states scheduling per-party caucuses
-- separately, or runoffs that fire for one party and not the other)
-- can't be modelled today.
--
-- The party-grouped subsections in RaceCard.tsx render a
-- "[Party] primary in N days · on [date]" chip per party. Today
-- they all reuse race.daysUntilElection / race.election_date.
-- This table lets per-party overrides exist when the data warrants.
--
-- Design notes:
--
--   * Sibling table (not a column on elections). Keeps the existing
--     uniqueness constraint clean. The election row remains the
--     "umbrella" — multi-party primaries stay one election with
--     N party_primaries rows on top.
--
--   * `party` is a normalized short form: "Democratic", "Republican",
--     "Libertarian", "Green", "Constitution", "Working Families",
--     "Independent / Unaffiliated", etc. This MUST match the canonical
--     form produced by canonicalParty() in src/components/ballot/
--     RaceCard.tsx — that's what the UI groups candidates by, so the
--     join from a candidate's party to a party_primaries row only
--     fires when both sides agree.
--
--   * `election_date` may differ from elections.election_date. The
--     view exposes party_primary_date AS NULL when no per-party row
--     exists; the UI then falls back to the race-level date.
--
--   * No FK to a parties table. parties.normalized_name uses the
--     "<Family> Party" form ("Democratic Party"), but the canonical
--     UI form drops the trailing " Party" ("Democratic"). Storing
--     the UI-canonical form here avoids a stripping step on every
--     read AND avoids needing per-state party rows when the same
--     national party schedules per-state primaries.
--
--   * Empty by default. This is purely structural; population will
--     come from per-state ingestion or candidate self-service. The
--     UT-2 race (which has all parties sharing one date) will
--     continue to render unchanged because the view falls back.
-- ============================================================

CREATE TABLE IF NOT EXISTS party_primaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  election_id UUID NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
  party TEXT NOT NULL,
  election_date DATE NOT NULL,
  registration_required BOOLEAN,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (election_id, party)
);

CREATE INDEX IF NOT EXISTS idx_party_primaries_election
  ON party_primaries (election_id);
-- Plain index on election_date (no partial predicate — CURRENT_DATE isn't
-- IMMUTABLE so Postgres rejects it in an index WHERE clause). The table is
-- expected to stay small; full-column index is fine.
CREATE INDEX IF NOT EXISTS idx_party_primaries_date
  ON party_primaries (election_date);

ALTER TABLE party_primaries ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'party_primaries'
      AND policyname = 'Public read party_primaries'
  ) THEN
    EXECUTE 'CREATE POLICY "Public read party_primaries" ON party_primaries FOR SELECT USING (true)';
  END IF;
END $$;

COMMENT ON TABLE party_primaries IS
  'Per-party primary date overrides for cases where R and D primaries fall on '
  'different days. Sibling to elections; presence is optional. The voter view '
  'falls back to elections.election_date when no row exists.';

COMMENT ON COLUMN party_primaries.party IS
  'UI-canonical party name: "Democratic", "Republican", "Libertarian", etc. '
  'Must match canonicalParty() in src/components/ballot/RaceCard.tsx so the '
  'join from a candidate''s party to a per-party date actually fires.';

-- ============================================================
-- Helper: normalize a party label to the UI-canonical form so the
-- view JOIN finds a party_primaries row regardless of which arm of
-- v_voter_candidates produced the candidate (legacy uses bare
-- "Democratic"; new-graph uses parties.display_name "Democratic Party").
-- Mirrors the logic in canonicalParty() in RaceCard.tsx.
-- ============================================================
CREATE OR REPLACE FUNCTION public.canonical_party_name(raw TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  trimmed TEXT;
  lower_v TEXT;
BEGIN
  IF raw IS NULL OR btrim(raw) = '' THEN
    RETURN NULL;
  END IF;
  -- Strip a trailing " Party"
  trimmed := btrim(regexp_replace(raw, '\s+Party$', '', 'i'));
  lower_v := lower(trimmed);
  IF lower_v IN ('democrat', 'democratic') THEN RETURN 'Democratic'; END IF;
  IF lower_v = 'republican' THEN RETURN 'Republican'; END IF;
  IF lower_v = 'libertarian' THEN RETURN 'Libertarian'; END IF;
  IF lower_v = 'green' THEN RETURN 'Green'; END IF;
  IF lower_v = 'independent american' THEN RETURN 'Independent American'; END IF;
  IF lower_v IN ('independent', 'unaffiliated') THEN RETURN 'Independent / Unaffiliated'; END IF;
  RETURN trimmed;
END;
$$;

COMMENT ON FUNCTION public.canonical_party_name(TEXT) IS
  'Server-side mirror of canonicalParty() in RaceCard.tsx. Used by '
  'v_voter_candidates so per-party-date joins work across legacy/new-graph.';

-- ============================================================
-- Recreate v_voter_candidates with the new party_primary_date
-- column. Both arms of the UNION ALL must match shape exactly,
-- so we re-emit the full view (PostgreSQL doesn't allow ALTER VIEW
-- to add columns).
--
-- The lookup is:
--   election_id := race_id when is_legacy=false (new-graph
--     candidacies surface elections.id as race_id)
--   election_id := NULL when is_legacy=true (legacy races aren't
--     elections; party_primaries is keyed off elections only)
--
-- The legacy arm therefore returns NULL party_primary_date — which
-- is correct: per-party date overrides only make sense once a race
-- has been migrated to the office-graph world.
-- ============================================================

DROP VIEW IF EXISTS v_voter_candidates CASCADE;

CREATE VIEW v_voter_candidates AS
-- LEGACY ARM
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
  -- The bridge in races.election_id COULD be walked here, but legacy
  -- races that bridge to a new-graph election are also re-surfaced via
  -- the new arm at the bridge target — we don't want double rows. The
  -- new arm carries the override, the legacy arm stays NULL.
  NULL::DATE                                AS party_primary_date
FROM candidates c
JOIN races r ON r.id = c.race_id
LEFT JOIN people pl ON c.id = ANY(pl.legacy_candidate_ids)

UNION ALL

-- NEW ARM
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
  -- Per-party primary date. Joins party_primaries on the candidate's
  -- election_id and the candidate's normalized party name. Returns
  -- NULL when no override row exists, in which case the UI falls
  -- back to the race-level date.
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
  'new office-graph `candidacies`. Photo URLs are gated on candidate-portal '
  'opt-in (questionnaire_responses.photo_visible). self_attested flag '
  'indicates the candidate has affirmed their own positions via /for-candidates. '
  'party_primary_date carries a per-party primary override when one exists in '
  'party_primaries; NULL means use the race-level date.';
