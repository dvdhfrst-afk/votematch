-- Dynamic questions architecture.
--
-- The taxonomy (sub_dimensions) is the *what* — stable policy axes. Questions
-- are the *how we ask about them* — phrasing, options, audience. Splitting them
-- lets us evolve questions without schema migrations, deprecate old ones, and
-- keep versioned history.

-- 1. Lifecycle columns on sub_dimensions. If a topic stops mattering (or a new
--    one emerges), we flip `active` instead of deleting.
ALTER TABLE sub_dimensions
  ADD COLUMN active BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN deprecated_at TIMESTAMPTZ;

-- 2. Questions table. One sub_dimension can have multiple questions (e.g. a
--    voter short-form version and a candidate long-form version), all versioned
--    via append-only history + the `active` flag.
CREATE TABLE questions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sub_dimension_id UUID NOT NULL REFERENCES sub_dimensions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('voter', 'candidate')),
  prompt TEXT NOT NULL,
  -- options is an array of { label, description, score } where score is 0..1
  -- on the sub_dimension spectrum (0 = spectrum_low, 1 = spectrum_high).
  options JSONB NOT NULL,
  priority INT NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_questions_kind_active_priority
  ON questions (kind, active, priority DESC);
CREATE INDEX idx_questions_sub_dimension
  ON questions (sub_dimension_id, kind);

-- 3. RLS. Public read for active questions; writes go through service role.
ALTER TABLE questions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read active questions"
  ON questions FOR SELECT
  USING (active = true);
