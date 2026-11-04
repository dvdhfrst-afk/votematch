-- Local roster snapshots: body-level "who currently serves" captured by the
-- $0 local-ingest pipeline (scripts/local-ingest). This is deliberately NOT
-- office_tenures: 82% of office seats use generic 'Seat N' designations that
-- don't line up with the rosters' districts/places, so per-seat attribution is
-- a Claude-grade judgment step. This table holds the verbatim, person-resolved
-- member set per governing body; a later reconciliation pins members to seats.
--
-- Provenance posture: validation_status defaults to 'pending_review'; nothing
-- here is authoritative. source_of_record marks it local/automated.

CREATE TABLE IF NOT EXISTS local_roster_snapshots (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  governing_body_id   UUID NOT NULL REFERENCES governing_bodies(id) ON DELETE CASCADE,
  jurisdiction_name   TEXT NOT NULL,
  chamber_type        TEXT,
  source_url          TEXT,
  source_file         TEXT,
  -- [{ name, role, district, term_start, term_end, person_id, person_status }]
  members             JSONB NOT NULL DEFAULT '[]',
  member_count        INT NOT NULL DEFAULT 0,
  people_matched      INT NOT NULL DEFAULT 0,
  people_created      INT NOT NULL DEFAULT 0,
  people_ambiguous    INT NOT NULL DEFAULT 0,
  validation_status   TEXT NOT NULL DEFAULT 'pending_review',
  source_of_record    TEXT,
  captured_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  meta                JSONB NOT NULL DEFAULT '{}'
);

-- One current snapshot per body (latest replaces prior).
CREATE UNIQUE INDEX IF NOT EXISTS idx_local_roster_snap_body
  ON local_roster_snapshots (governing_body_id);
