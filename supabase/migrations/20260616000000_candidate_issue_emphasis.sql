-- Candidate per-issue EMPHASIS / IMPORTANCE (doc 09 extension), 2026-06-15.
--
-- Separate from a candidate's DIRECTION on an issue (positions) and the per-axis
-- rhetorical INTENSITY of a single statement (positions.intensity_band, doc 07),
-- this records HOW MUCH THE WHOLE ISSUE MATTERS to the candidate, inferred from
-- engagement: a campaign headline they return to constantly (high emphasis) vs a
-- single offhand comment from years ago (low emphasis). Same direction can carry
-- very different emphasis, and voters want to see that.
--
-- One row per (candidate, issue). The candidate may be keyed by the canonical
-- person_id or the legacy candidate_id (the person-native and legacy paths both
-- exist in this schema); at least one must be present.
--
-- This is DERIVED, voter-facing data (like positions): public-read, service-role
-- write. It is recomputed by scripts/compute-candidate-emphasis.ts from the
-- positions and evidence_signals layers; it is never hand-edited per candidate.
--
-- NOT modeled here: the VOTER's self-declared per-issue importance. That is
-- personal, session-scoped data and lives in the voter's own answer payload
-- (users.quick_match_answers.issue_importance), never in a public table.
--
-- Additive only: no existing table, the matching engine, or any voter-facing
-- output is changed by this migration. Importance is a per-issue MAGNITUDE; it
-- must never be written into the positions vector the weighted L1 distance runs
-- over (that would corrupt direction matching).

CREATE TABLE IF NOT EXISTS candidate_issue_emphasis (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id          UUID REFERENCES people(id) ON DELETE CASCADE,
  candidate_id       UUID,                 -- legacy bridge; one of person_id / candidate_id required
  sub_dimension_id   UUID NOT NULL REFERENCES sub_dimensions(id) ON DELETE CASCADE,
  emphasis           NUMERIC(4,3) NOT NULL CHECK (emphasis BETWEEN 0 AND 1),
  engagement_level   TEXT NOT NULL DEFAULT 'silent'
                       CHECK (engagement_level IN ('headline','platform','mention','incidental','silent')),
  signal_count       INT NOT NULL DEFAULT 0,
  axis_coverage      NUMERIC(4,3) CHECK (axis_coverage IS NULL OR axis_coverage BETWEEN 0 AND 1),
  first_signal_at    TIMESTAMPTZ,
  last_signal_at     TIMESTAMPTZ,
  may_be_stale       BOOLEAN NOT NULL DEFAULT FALSE,
  rationale          TEXT,
  calibration_version TEXT NOT NULL DEFAULT 'emphasis-v1',
  computed_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT candidate_issue_emphasis_subject_present
    CHECK (person_id IS NOT NULL OR candidate_id IS NOT NULL)
);

COMMENT ON TABLE candidate_issue_emphasis IS
  'Per (candidate, issue) emphasis: how central the whole issue is to the candidate, inferred from engagement (frequency, recency, axis coverage). NOT a direction; never enters the position vector. Derived by scripts/compute-candidate-emphasis.ts; public-read, service-role write.';
COMMENT ON COLUMN candidate_issue_emphasis.emphasis IS
  '0..1. 0 = never addressed (silent); 1 = campaign centerpiece. computeIssueEmphasis() in src/lib/positioning/issue-emphasis.ts.';
COMMENT ON COLUMN candidate_issue_emphasis.engagement_level IS
  'Readable bucket of emphasis: headline / platform / mention / incidental / silent.';
COMMENT ON COLUMN candidate_issue_emphasis.may_be_stale IS
  'True when last_signal_at is older than the staleness window, so the UI can caveat a position as based on a dated statement.';

-- Natural key: one row per subject per issue. person_id and candidate_id are
-- each nullable (one is present); COALESCE both to sentinels so a subject cannot
-- get two rows for the same issue.
CREATE UNIQUE INDEX IF NOT EXISTS candidate_issue_emphasis_natkey_uidx
  ON candidate_issue_emphasis (
    COALESCE(person_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(candidate_id, '00000000-0000-0000-0000-000000000000'::uuid),
    sub_dimension_id
  );
CREATE INDEX IF NOT EXISTS candidate_issue_emphasis_person_idx ON candidate_issue_emphasis (person_id);
CREATE INDEX IF NOT EXISTS candidate_issue_emphasis_sub_dim_idx ON candidate_issue_emphasis (sub_dimension_id);

-- Voter-facing emphasis view: join the issue label for display.
CREATE OR REPLACE VIEW v_candidate_issue_emphasis AS
  SELECT e.person_id, e.candidate_id, e.sub_dimension_id,
         s.name AS issue_name, s.domain,
         e.emphasis, e.engagement_level, e.signal_count, e.axis_coverage,
         e.first_signal_at, e.last_signal_at, e.may_be_stale, e.calibration_version
  FROM candidate_issue_emphasis e
  JOIN sub_dimensions s ON s.id = e.sub_dimension_id;
COMMENT ON VIEW v_candidate_issue_emphasis IS
  'candidate_issue_emphasis with the issue name/domain joined, for the candidate-profile and match-explanation UI.';

-- RLS: voter-facing, so public-read; writes are service-role only (bypass RLS).
ALTER TABLE candidate_issue_emphasis ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS candidate_issue_emphasis_public_read ON candidate_issue_emphasis;
CREATE POLICY candidate_issue_emphasis_public_read ON candidate_issue_emphasis FOR SELECT USING (true);
