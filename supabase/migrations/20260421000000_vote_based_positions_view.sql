-- Vote-based position scoring view
--
-- For each (person × dimension) pair, computes a 0-1 score based on how
-- they've voted on bills tagged with that dimension.
--
-- Score = 0.5 + (weighted_sum_of_direction_votes / max_possible) / 2
-- Where each Yea/Nay is weighted by the bill_dimension_map's confidence,
-- and the direction (high/low) flips the sign.
--
-- Also returns vote_count per dimension so UI can gate on "enough data."

CREATE OR REPLACE VIEW v_person_vote_based_positions AS
WITH
  person_votes AS (
    SELECT
      p.id AS person_id,
      p.canonical_name,
      (p.meta->>'bioguide_id') AS bioguide_id,
      fvp.position,
      fv.congress,
      fv.description,
      -- Extract bill reference from description (e.g., "HR 1234: Yea-and-Nay")
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
      -- Signed direction: +1 if person's position aligns with "high"
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
  )
SELECT
  person_id,
  canonical_name,
  bioguide_id,
  dimension,
  COUNT(*) AS vote_count,
  SUM(CASE WHEN signed_direction = 1  THEN 1 ELSE 0 END) AS aligned_high_votes,
  SUM(CASE WHEN signed_direction = -1 THEN 1 ELSE 0 END) AS aligned_low_votes,
  -- Confidence-weighted score: +1/-1 per vote weighted by map confidence, normalized to 0-1
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

-- Convenience: confidence tier based on vote count
CREATE OR REPLACE VIEW v_person_vote_confidence AS
SELECT
  person_id,
  dimension,
  vote_count,
  score_0_1,
  CASE
    WHEN vote_count >= 8 THEN 'high'
    WHEN vote_count >= 3 THEN 'medium'
    WHEN vote_count >= 1 THEN 'low'
    ELSE 'insufficient'
  END AS confidence_tier
FROM v_person_vote_based_positions;
