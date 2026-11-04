-- Contact enrichment support (plan D1 family, 2026-06-03):
-- 1. Person-level running lock for the contact engine — same pattern as the body
--    engine's body_id lock (loop-protection postmortem #1): a partial unique index
--    on ingestion_runs rejects two concurrent dispatches for the same person.
create unique index if not exists ingestion_runs_contact_person_lock
  on ingestion_runs ((meta->>'person_id'))
  where status = 'running' and adapter_name = 'contact_research';

-- 2. candidate_sources.person_id — the enricher emits positioning-source rows
--    keyed to PEOPLE (new graph). Additive, nullable; mirrors the legacy-graph
--    phase-1 precedent (positions.person_id, 20260502000020).
alter table candidate_sources add column if not exists person_id uuid references people(id) on delete set null;
create index if not exists candidate_sources_person_idx on candidate_sources (person_id) where person_id is not null;
-- Dedupe guard for enricher emissions (same person + same url = one row).
create unique index if not exists candidate_sources_person_url_idx
  on candidate_sources (person_id, url) where person_id is not null;
