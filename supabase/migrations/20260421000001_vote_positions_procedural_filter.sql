-- Rebuild v_person_vote_based_positions with two filters the methodology reviewer flagged:
--
-- 1) Procedural-vote filter. Motion-to-table, motion-to-recommit, cloture-on-motion-
--    to-proceed etc. invert the meaning of Yea/Nay relative to the substantive bill.
--    Treating them as substantive votes silently flips a legislator's score to the
--    opposite pole. We whitelist substantive question types.
--
-- 2) Near-unanimous filter. Votes with >95% one-sided outcome (post-office naming,
--    suspension calendar, etc.) carry zero discriminative information but dominate
--    the denominator of the confidence-weighted score.
--
-- Both filters apply by computing flags on federal_votes and joining. We compute
-- the percent-yes via federal_vote_positions aggregation.

DROP VIEW IF EXISTS v_person_vote_confidence;
DROP VIEW IF EXISTS v_person_vote_based_positions;

-- Per-vote aggregate used to detect near-unanimous votes.
CREATE OR REPLACE VIEW v_federal_vote_unanimity AS
SELECT
  fv.id AS vote_id,
  fv.roll_call,
  fv.chamber,
  COUNT(*) FILTER (WHERE fvp.position IN ('Yea','Aye')) AS yea_count,
  COUNT(*) FILTER (WHERE fvp.position IN ('Nay','No'))  AS nay_count,
  COUNT(*) FILTER (WHERE fvp.position IN ('Yea','Aye','Nay','No')) AS total_decisive,
  -- fraction on the winning side; 1.0 = unanimous, 0.5 = evenly split
  CASE
    WHEN COUNT(*) FILTER (WHERE fvp.position IN ('Yea','Aye','Nay','No')) = 0 THEN NULL
    ELSE GREATEST(
      COUNT(*) FILTER (WHERE fvp.position IN ('Yea','Aye')),
      COUNT(*) FILTER (WHERE fvp.position IN ('Nay','No'))
    )::numeric / COUNT(*) FILTER (WHERE fvp.position IN ('Yea','Aye','Nay','No'))
  END AS winning_side_fraction
FROM federal_votes fv
LEFT JOIN federal_vote_positions fvp ON fvp.vote_id = fv.id
GROUP BY fv.id, fv.roll_call, fv.chamber;

COMMENT ON VIEW v_federal_vote_unanimity IS
  'Per-vote aggregate of yea/nay counts and winning-side fraction. Used by inference layer to drop near-unanimous votes (no discriminative power).';

-- Flag per vote whether it is (a) substantive (not procedural) and (b) discriminative (< 95% unanimity).
-- federal_votes.question is the Clerk/Senate standardized question label:
--   "On Passage"
--   "On Agreeing to the Resolution"
--   "On Agreeing to the Conference Report"
--   "On the Amendment"
--   "On Motion to Table"         <-- drop (inverts meaning)
--   "On Motion to Recommit"      <-- drop (inverts meaning)
--   "On the Motion to Proceed"   <-- drop (procedural)
--   "On Cloture on the Motion to Proceed" <-- drop (procedural)
--   "Quorum"                     <-- drop
CREATE OR REPLACE VIEW v_federal_votes_substantive AS
SELECT
  fv.id AS vote_id,
  fv.question,
  fv.description,
  u.winning_side_fraction,
  -- substantive if question is on-passage / on-the-amendment / conference-report family
  (
    fv.question ILIKE 'On Passage%'
    OR fv.question ILIKE 'On Agreeing to the Resolution%'
    OR fv.question ILIKE 'On Agreeing to the Conference Report%'
    OR fv.question ILIKE 'On the Amendment%'
    OR fv.question ILIKE 'On Concurring in the Senate Amendment%'
    OR fv.question ILIKE 'On Overriding the Veto%'
  ) AS is_substantive,
  -- discriminative if winning side < 95%
  (u.winning_side_fraction IS NOT NULL AND u.winning_side_fraction < 0.95) AS is_discriminative
FROM federal_votes fv
LEFT JOIN v_federal_vote_unanimity u ON u.vote_id = fv.id;

COMMENT ON VIEW v_federal_votes_substantive IS
  'Flags each federal vote as substantive vs procedural (based on federal_votes.question whitelist) and discriminative vs near-unanimous (< 95% winning side). Vote-based position inference only aggregates votes where BOTH flags are true.';

-- Rebuild the core view using only substantive + discriminative votes.
CREATE OR REPLACE VIEW v_person_vote_based_positions AS
WITH
  person_votes AS (
    SELECT
      p.id AS person_id,
      p.canonical_name,
      (p.meta->>'bioguide_id') AS bioguide_id,
      fvp.position,
      fv.id AS vote_id,
      fv.congress,
      fv.description,
      lower(substring(fv.description FROM '^([A-Z]+)'))::text AS bill_type_from_desc,
      NULLIF(substring(fv.description FROM '^[A-Z]+\s+(\d+)'), '')::int AS bill_number_from_desc
    FROM people p
    JOIN federal_vote_positions fvp ON fvp.bioguide_id = (p.meta->>'bioguide_id')
    JOIN federal_votes fv ON fv.id = fvp.vote_id
    WHERE p.meta->>'bioguide_id' IS NOT NULL
  ),
  matched AS (
    SELECT
      pv.person_id,
      pv.canonical_name,
      pv.bioguide_id,
      pv.position,
      bdm.dimension,
      bdm.yea_direction,
      bdm.confidence,
      CASE
        WHEN bdm.yea_direction = 'high' AND pv.position IN ('Yea', 'Aye') THEN 1
        WHEN bdm.yea_direction = 'high' AND pv.position IN ('Nay', 'No')  THEN -1
        WHEN bdm.yea_direction = 'low'  AND pv.position IN ('Yea', 'Aye') THEN -1
        WHEN bdm.yea_direction = 'low'  AND pv.position IN ('Nay', 'No')  THEN 1
        ELSE 0
      END AS signed_direction
    FROM person_votes pv
    JOIN bill_dimension_map bdm
      ON bdm.congress = pv.congress
     AND bdm.bill_type = pv.bill_type_from_desc
     AND bdm.bill_number = pv.bill_number_from_desc
    JOIN v_federal_votes_substantive vs
      ON vs.vote_id = pv.vote_id
     AND vs.is_substantive IS TRUE
     AND vs.is_discriminative IS TRUE
  )
SELECT
  person_id,
  canonical_name,
  bioguide_id,
  dimension,
  COUNT(*) AS vote_count,
  SUM(CASE WHEN signed_direction = 1  THEN 1 ELSE 0 END) AS aligned_high_votes,
  SUM(CASE WHEN signed_direction = -1 THEN 1 ELSE 0 END) AS aligned_low_votes,
  ROUND(
    0.5 + (
      SUM(signed_direction * confidence) /
      NULLIF(SUM(confidence) * 2, 0)
    )::numeric,
    3
  ) AS score_0_1,
  ROUND(AVG(confidence)::numeric, 3) AS avg_map_confidence
FROM matched
WHERE signed_direction != 0
GROUP BY person_id, canonical_name, bioguide_id, dimension;

COMMENT ON VIEW v_person_vote_based_positions IS
  'Per-person per-dimension inferred policy score (0–1) derived from substantive, discriminative roll-call votes only. Procedural votes (motion-to-table/recommit/cloture) and near-unanimous votes (>95% one side) are dropped because they produce noise or invert the signal.';

-- Rebuild the convenience confidence-tier view
CREATE OR REPLACE VIEW v_person_vote_confidence AS
SELECT
  person_id,
  dimension,
  vote_count,
  score_0_1,
  CASE
    WHEN vote_count >= 10 THEN 'high'
    WHEN vote_count >= 5  THEN 'medium'
    WHEN vote_count >= 1  THEN 'low'
    ELSE 'insufficient'
  END AS confidence_tier
FROM v_person_vote_based_positions;

COMMENT ON VIEW v_person_vote_confidence IS
  'Adds a confidence tier to each (person, dimension). Tier cutoffs match the UI publish gate: only vote_count >= 10 should be surfaced publicly as a numeric score.';
