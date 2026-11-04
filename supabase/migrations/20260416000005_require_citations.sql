-- blueprint-v6 §7: never impute candidate positions. Every stored position
-- must have at least one source citation. If the signal is too thin to cite,
-- we emit nothing and the UI shows "Candidate has not stated a public
-- position" for that sub-dimension.
--
-- All 190 seed positions already satisfy this (verified 2026-04-16).
ALTER TABLE positions
  ADD CONSTRAINT positions_require_citations
  CHECK (jsonb_typeof(source_citations) = 'array' AND jsonb_array_length(source_citations) > 0);
