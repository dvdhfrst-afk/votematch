-- v2 rebuild of v_person_vote_based_positions procedural filter.
--
-- Previous migration was too strict (only 7 votes matched) because:
--  - House votes have question=NULL (we have to parse description like "HR 1234: Yea-and-Nay")
--  - Senate amendment votes have question stored as JSON: {"measure":"S.Amdt. 3937","#text":"On the Amendment"}
--  - Senate "On Passage of the Bill" differs from our whitelist "On Passage"
--
-- Correct classification:
--  House substantive = description has a bill/res prefix AND is NOT a "2/3 Yea-And-Nay" suspension-calendar vote
--  Senate substantive = question matches or JSON-contains one of: On Passage, On the Amendment,
--    On the Joint Resolution, On the Resolution, On Concurring, On Overriding the Veto
--  Both chambers: drop if winning_side_fraction >= 0.95 (no discriminative power)

DROP VIEW IF EXISTS v_person_vote_confidence;
DROP VIEW IF EXISTS v_person_vote_based_positions;
DROP VIEW IF EXISTS v_federal_votes_substantive;

CREATE OR REPLACE VIEW v_federal_votes_substantive AS
SELECT
  fv.id AS vote_id,
  fv.chamber,
  fv.question,
  fv.description,
  u.winning_side_fraction,
  CASE
    -- HOUSE: substantive if description starts with a bill/res prefix AND not 2/3 suspension vote
    WHEN fv.chamber = 'house' THEN
      fv.description IS NOT NULL
      AND fv.description ~* '^(H\s?R|HRES|HJRES|S|HCONRES|HR)\s*\d+:'
      AND fv.description NOT ILIKE '%2/3 Yea-And-Nay%'
      AND fv.description NOT ILIKE '%Suspension%'
    -- SENATE: substantive if question matches a substantive type (raw OR JSON-wrapped)
    WHEN fv.chamber = 'senate' THEN
      fv.question IS NOT NULL AND (
        fv.question ILIKE 'On Passage%'
        OR fv.question ILIKE 'On the Joint Resolution%'
        OR fv.question ILIKE 'On the Resolution%'
        OR fv.question ILIKE '%"On the Amendment"%'         -- JSON-wrapped
        OR fv.question ILIKE '%"On Passage%'
        OR fv.question ILIKE 'On Concurring%'
        OR fv.question ILIKE 'On Overriding the Veto%'
      )
    ELSE false
  END AS is_substantive,
  (u.winning_side_fraction IS NOT NULL AND u.winning_side_fraction < 0.95) AS is_discriminative
FROM federal_votes fv
LEFT JOIN v_federal_vote_unanimity u ON u.vote_id = fv.id;

COMMENT ON VIEW v_federal_votes_substantive IS
  'Flags each federal vote as substantive vs procedural. House uses description-pattern match; Senate uses question field including JSON-wrapped amendment votes. is_discriminative = winning side < 95%.';

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

CREATE OR REPLACE VIEW v_person_vote_confidence AS
SELECT
  person_id, dimension, vote_count, score_0_1,
  CASE
    WHEN vote_count >= 10 THEN 'high'
    WHEN vote_count >= 5  THEN 'medium'
    WHEN vote_count >= 1  THEN 'low'
    ELSE 'insufficient'
  END AS confidence_tier
FROM v_person_vote_based_positions;
