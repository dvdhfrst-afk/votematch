-- 20260614010000_evidence_signals.sql
-- The DERIVED-SIGNAL extraction layer for Ballot Bridge.
-- ADDITIVE ONLY: one new table; no changes to existing tables, the matching
-- engine, or any voter-facing output.
--
-- This sits one stage downstream of the raw-evidence ingest pipeline
-- (migration 20260614000000): raw_evidence holds immutable, normalized,
-- boilerplate-stripped source text; evidence_seen_ledger marks each unique
-- piece of NORMALIZED content (keyed on normalized_hash) with a `classified`
-- boolean. The extractor reads unclassified content, asks a classifier to emit
-- zero-or-more per-signal records, writes them here, and flips the ledger's
-- `classified` flag so each piece of content is processed exactly once.
--
-- TAXONOMY-INDEPENDENCE (founder hard rule). The issue taxonomy is being
-- finalized in a SEPARATE workstream. This table and the extractor must stay
-- DECOUPLED from it so the real classifier (phi4 / Claude, bound to the final
-- taxonomy) can be swapped in later WITHOUT touching this plumbing. Concretely:
--   * `signal` is jsonb (the doc-07 section-1.6 per-signal shape), and the
--     taxonomy-keyed fields inside it (proposition_key / sub_dimension_key /
--     direction / intensity_band) are NULLABLE. A stub classifier that knows no
--     taxonomy stores rows with those keys null; a future taxonomy-bound
--     classifier fills them in. No column here names a specific taxonomy.
--   * `taxonomy_version` is null until a taxonomy is bound. When the real
--     classifier ships, it stamps the taxonomy version it resolved against, so
--     signals are filterable by which taxonomy produced them.
--   * `classifier_model` records which model produced the signal ('stub' for
--     now; later 'phi4:14b' / 'claude-...'). `extractor_version` records the
--     pipeline-code version, independent of the model.
--
-- Provenance discipline: every signal traces back to exactly one raw_evidence
-- row (FK, cascade delete) and carries the source_url + authenticity_tier so a
-- displayed position can be audited to its source. No row here auto-publishes;
-- publish gating lives downstream in the aggregation/positions layer, not here.

create table if not exists evidence_signals (
  id uuid primary key default gen_random_uuid(),
  raw_evidence_id uuid not null references raw_evidence(id) on delete cascade,
  person_id uuid references people(id) on delete set null,  -- copied from raw_evidence when bound; null until identity resolution binds it
  extractor_version text not null,        -- pipeline-code version (e.g. 'extract-signals/1')
  classifier_model text,                  -- 'stub' now; later 'phi4:14b' / 'claude-...'
  taxonomy_version text,                  -- NULL until a taxonomy is bound; stamped by the taxonomy-aware classifier
  signal jsonb not null,                  -- per-signal record, doc-07 section 1.6 shape; taxonomy-keyed fields are nullable
  source_url text,                        -- copied from the signal for cheap provenance queries
  authenticity_tier int,                  -- 1 primary / 2 reported-with-quote / 3 paraphrased-or-aggregate
  created_at timestamptz not null default now()
);
create index if not exists evidence_signals_raw_idx on evidence_signals (raw_evidence_id);
create index if not exists evidence_signals_person_idx on evidence_signals (person_id);

-- NOTE: evidence_seen_ledger already has the columns this layer needs:
--   `classified boolean` (the per-content "derived layer processed it?" flag)
--   `meta jsonb`         (room for classifier bookkeeping if ever needed)
-- so we deliberately add NO columns to it. The extractor flips `classified`
-- to true after writing a content piece's signals, making the pass idempotent.
