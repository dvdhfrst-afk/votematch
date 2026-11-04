-- ---------------------------------------------------------------------------
-- 20260425000016_dormant_quiescent.sql
--
-- Council 2026-04-25 finding: 199 adapters labeled `productive`, 0 marked
-- `dormant`. Many "productive" adapters return 0 inserts in 12/12 cycles —
-- chronic empty-yielders that should be skipped most cycles.
--
-- Add a new `dormant_quiescent` adapter_status value: adapters that ARE
-- reaching their source successfully (no errors), but consistently produce
-- zero new rows over a long window. They get demoted to skip most cycles
-- with periodic probes (handled in continuous-ingest like 'dormant').
--
-- This is distinct from:
--   - 'dormant'         — same idea but historically applied by older code,
--                         keep separate so we can audit the demotion source.
--   - 'circuit_broken'  — chronic FAILURE, not chronic emptiness.
--   - 'quarantined'     — flapped enough times to require manual review.
-- ---------------------------------------------------------------------------

ALTER TABLE adapter_status DROP CONSTRAINT IF EXISTS adapter_status_status_check;
ALTER TABLE adapter_status ADD CONSTRAINT adapter_status_status_check CHECK (
  status IN ('productive','dormant','dormant_quiescent','circuit_broken','quarantined','unknown')
);

COMMENT ON COLUMN adapter_status.status IS
  'productive | dormant | dormant_quiescent | circuit_broken | quarantined | unknown.
   dormant_quiescent = adapter reaches source OK but yields 0 rows persistently
   (≥20 recent runs, all success/unproductive/unchanged, total rows_inserted=0).
   Skipped on most cycles by continuous-ingest, probed every Nth cycle.';
