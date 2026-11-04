-- =============================================================================
-- Interpretation provenance (one-hop) + state-level interpretation_status
--
-- Closes two gaps from the interpretation pipeline as designed in
-- 20260425000011_interpretation_pipeline.sql:
--
--   1. Published-cache rows (bill_dimension_map, positions, endorsements)
--      stuffed audit_id and interpretation references into JSONB / text
--      columns instead of as real FKs. Walking back from a published score
--      to the model decision required string parsing.
--
--   2. Three state-level AI-extraction targets (state_rulemaking_events,
--      ballot_measures, municipal_meetings) had no interpretation_status
--      flag. Workers couldn't pick up pending rows the way they do for
--      federal_bills / state_cf_events / candidates.
--
-- Coverage note: dimension-classification today is federal-only because
--   - bill_dimension_map is keyed on (congress, bill_type, bill_number)
--   - federal_vote_dimension_scores is keyed on bioguide_id
--   - state_legislator_votes is empty (no source data ingested)
--   - There is no canonical state_bills table yet
-- The structural twins (state_legislation_dimension_map,
-- vote_dimension_scores keyed on people.id) wait on actual state ingestion.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Provenance FKs on published caches
-- ---------------------------------------------------------------------------

-- bill_dimension_map → interpretations (which decision produced this row?)
ALTER TABLE bill_dimension_map
  ADD COLUMN IF NOT EXISTS interpretation_id UUID
    REFERENCES interpretations(id) ON DELETE SET NULL;

-- bill_dimension_map → extraction_audit (one hop to raw LLM, vs two via interp)
ALTER TABLE bill_dimension_map
  ADD COLUMN IF NOT EXISTS extraction_audit_id UUID
    REFERENCES extraction_audit(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_bdm_interpretation
  ON bill_dimension_map (interpretation_id) WHERE interpretation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bdm_audit
  ON bill_dimension_map (extraction_audit_id) WHERE extraction_audit_id IS NOT NULL;

COMMENT ON COLUMN bill_dimension_map.interpretation_id IS
  'FK to the interpretations row that produced this dimension assignment.';
COMMENT ON COLUMN bill_dimension_map.extraction_audit_id IS
  'FK to the raw LLM call (extraction_audit) that produced this row. One hop '
  'to model_id + prompt_version + raw_response. Redundant with interpretation_id '
  'but kept for query-time speed.';

-- federal_bills → extraction_audit (latest audit row for this bill)
ALTER TABLE federal_bills
  ADD COLUMN IF NOT EXISTS extraction_audit_id UUID
    REFERENCES extraction_audit(id) ON DELETE SET NULL;

COMMENT ON COLUMN federal_bills.extraction_audit_id IS
  'FK to the latest extraction_audit row produced for this bill by the '
  'classifier. Re-bumped on each version. Older audits remain in '
  'extraction_audit (filterable by source_hash).';

-- endorsements → both
ALTER TABLE endorsements
  ADD COLUMN IF NOT EXISTS extraction_audit_id UUID
    REFERENCES extraction_audit(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS interpretation_id UUID
    REFERENCES interpretations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_endorsements_audit
  ON endorsements (extraction_audit_id) WHERE extraction_audit_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_endorsements_interp
  ON endorsements (interpretation_id) WHERE interpretation_id IS NOT NULL;

COMMENT ON COLUMN endorsements.extraction_audit_id IS
  'FK to extraction_audit row (raw LLM call from extract-endorsements-batch).';
COMMENT ON COLUMN endorsements.interpretation_id IS
  'FK to interpretations row (kind=endorsement_link).';

-- positions already has extraction_audit_id; add interpretation_id
ALTER TABLE positions
  ADD COLUMN IF NOT EXISTS interpretation_id UUID
    REFERENCES interpretations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_positions_interp
  ON positions (interpretation_id) WHERE interpretation_id IS NOT NULL;

COMMENT ON COLUMN positions.interpretation_id IS
  'FK to interpretations row (kind=position_extraction).';

-- ---------------------------------------------------------------------------
-- 2. State-level interpretation_status flags
--
-- Three tables receive AI-extracted rows today (topic_tags arrays from the
-- corresponding extractors) but have no pipeline-state flag. Adding it now
-- so the structural surface is ready for dimension classifiers to come
-- online — no behavior change for current ingestion (default = 0 = new).
-- ---------------------------------------------------------------------------
ALTER TABLE state_rulemaking_events
  ADD COLUMN IF NOT EXISTS interpretation_status SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE ballot_measures
  ADD COLUMN IF NOT EXISTS interpretation_status SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE municipal_meetings
  ADD COLUMN IF NOT EXISTS interpretation_status SMALLINT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_state_rulemaking_pending
  ON state_rulemaking_events (interpretation_status, ingested_at)
  WHERE interpretation_status = 0;
CREATE INDEX IF NOT EXISTS idx_ballot_measures_pending
  ON ballot_measures (interpretation_status, ingested_at)
  WHERE interpretation_status = 0;
CREATE INDEX IF NOT EXISTS idx_municipal_meetings_pending
  ON municipal_meetings (interpretation_status, ingested_at)
  WHERE interpretation_status = 0;

COMMENT ON COLUMN state_rulemaking_events.interpretation_status IS
  'Pipeline state for rulemaking-dimension classification: 0=new, 1=resolved, 2=unresolvable, 3=stale.';
COMMENT ON COLUMN ballot_measures.interpretation_status IS
  'Pipeline state for ballot-measure-dimension classification: 0=new, 1=resolved, 2=unresolvable, 3=stale.';
COMMENT ON COLUMN municipal_meetings.interpretation_status IS
  'Pipeline state for meeting-dimension classification: 0=new, 1=resolved, 2=unresolvable, 3=stale.';

-- ---------------------------------------------------------------------------
-- 3. Backlog view — extend to cover the 3 new surfaces
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_interpretation_backlog AS
SELECT 'cf_resolution'::text AS kind,
       count(*)::bigint AS pending
  FROM state_cf_events WHERE interpretation_status = 0
UNION ALL
SELECT 'bill_dimension', count(*)::bigint
  FROM federal_bills WHERE interpretation_status = 0
UNION ALL
SELECT 'positions', count(*)::bigint
  FROM candidates WHERE positions_interpretation_status = 0 AND published = true
UNION ALL
SELECT 'rulemaking_dimension', count(*)::bigint
  FROM state_rulemaking_events WHERE interpretation_status = 0
UNION ALL
SELECT 'ballot_measure_dimension', count(*)::bigint
  FROM ballot_measures WHERE interpretation_status = 0
UNION ALL
SELECT 'meeting_dimension', count(*)::bigint
  FROM municipal_meetings WHERE interpretation_status = 0;

COMMENT ON VIEW v_interpretation_backlog IS
  'Pending-interpretation counts per resolver kind. Federal + state coverage. '
  'Workers for rulemaking_dimension / ballot_measure_dimension / '
  'meeting_dimension are not yet implemented; their backlog entries will read '
  'as the count of unprocessed rows once those tables receive ingestion.';

-- ---------------------------------------------------------------------------
-- 4. Backfill: link existing bdm rows to their interpretations rows
--
-- billKey() in classify-bills-batch.ts encodes target_id as
-- '${congress}-${bill_type}-${bill_number}'. We pick the latest non-superseded
-- bill_dimension interpretation per bill key.
--
-- Some interpretations.value->>'audit_id' values reference extraction_audit
-- rows that have since been pruned (audit retention is shorter than interp
-- retention). LEFT JOIN extraction_audit to filter those out — populate
-- audit_id only when the audit row still exists, but always set interp_id.
-- ---------------------------------------------------------------------------
WITH latest_interp AS (
  SELECT DISTINCT ON (target_id)
    target_id,
    id AS interp_id,
    NULLIF(value->>'audit_id', '')::uuid AS raw_audit_id
  FROM interpretations
  WHERE target_table = 'federal_bills'
    AND kind = 'bill_dimension'
    AND superseded_at IS NULL
  ORDER BY target_id, version DESC, created_at DESC
),
resolved AS (
  SELECT li.target_id,
         li.interp_id,
         CASE WHEN ea.id IS NOT NULL THEN li.raw_audit_id END AS audit_id
    FROM latest_interp li
    LEFT JOIN extraction_audit ea ON ea.id = li.raw_audit_id
)
UPDATE bill_dimension_map bdm
   SET interpretation_id   = COALESCE(bdm.interpretation_id, r.interp_id),
       extraction_audit_id = COALESCE(bdm.extraction_audit_id, r.audit_id)
  FROM resolved r
 WHERE r.target_id = bdm.congress::text || '-' || bdm.bill_type || '-' || bdm.bill_number::text
   AND (bdm.interpretation_id IS NULL OR bdm.extraction_audit_id IS NULL);

-- federal_bills.extraction_audit_id — same source, picks the latest audit per bill.
-- Filters out audit_ids that no longer exist in extraction_audit.
WITH latest_interp AS (
  SELECT DISTINCT ON (target_id)
    target_id,
    NULLIF(value->>'audit_id', '')::uuid AS raw_audit_id
  FROM interpretations
  WHERE target_table = 'federal_bills'
    AND kind = 'bill_dimension'
    AND superseded_at IS NULL
    AND value ? 'audit_id'
  ORDER BY target_id, version DESC, created_at DESC
),
resolved AS (
  SELECT li.target_id, li.raw_audit_id AS audit_id
    FROM latest_interp li
    JOIN extraction_audit ea ON ea.id = li.raw_audit_id
)
UPDATE federal_bills fb
   SET extraction_audit_id = r.audit_id
  FROM resolved r
 WHERE r.target_id = fb.congress::text || '-' || fb.bill_type || '-' || fb.bill_number::text
   AND fb.extraction_audit_id IS NULL;

-- positions: link from value->'audit_id' inside the position_extraction
-- interpretations row keyed on candidates.<id>. One interp row per candidate
-- spans multiple positions; all rows from a candidate share the same audit.
WITH latest_interp AS (
  SELECT DISTINCT ON (target_id)
    target_id, id AS interp_id
  FROM interpretations
  WHERE target_table = 'candidates'
    AND kind = 'position_extraction'
    AND superseded_at IS NULL
  ORDER BY target_id, version DESC, created_at DESC
)
UPDATE positions p
   SET interpretation_id = li.interp_id
  FROM latest_interp li
 WHERE li.target_id = p.candidate_id::text
   AND p.interpretation_id IS NULL;

-- endorsements: backfill is best-effort. The interp row's target_id is the
-- paper slug (not the endorsement row id), so there's no clean per-row link
-- from history. Leave NULL on existing rows; new rows from
-- extract-endorsements-batch will populate going forward.
