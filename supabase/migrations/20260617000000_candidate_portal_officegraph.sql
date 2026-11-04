-- ============================================================================
-- Candidate portal -> office-graph rewire (Brief A, Decision 1 = Option A)
-- ============================================================================
-- Lets the /for-candidates portal serve 2026 candidacies that live in
-- people/candidacies with NO legacy `candidates` row. The portal's write tables
-- previously hard-required legacy candidate_id (+ race_id), so person-native
-- candidacies could not be claimed, drafted, affirmed, sourced, or disputed.
--
-- This migration ONLY relaxes legacy NOT NULLs and adds candidacy_id/person_id
-- targets + supporting indexes/constraints. It does NOT drop legacy columns or
-- touch existing data. The voter read path is already person-aware
-- (positions.person_id, candidate_sources.person_id, v_voter_candidates), so
-- writing person-keyed rows is sufficient for voters to consume them.
--
-- Applied to the live local DB on 2026-06-17 via scripts/_live-write.ts; this
-- is the canonical record so a clean rebuild reproduces it. Idempotent guards
-- (IF NOT EXISTS / DROP ... IF EXISTS) make re-running safe.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. candidate_questionnaire_tokens: add candidacy_id as a third token target
-- ----------------------------------------------------------------------------
alter table public.candidate_questionnaire_tokens
  add column if not exists candidacy_id uuid
    references public.candidacies(id) on delete cascade;

create index if not exists idx_cqt_candidacy_id
  on public.candidate_questionnaire_tokens(candidacy_id);

-- Replace the two-target check with an exactly-one-of-three check.
alter table public.candidate_questionnaire_tokens
  drop constraint if exists cqt_one_target_only;

alter table public.candidate_questionnaire_tokens
  add constraint cqt_one_target_only
  check (
    (case when candidate_id   is not null then 1 else 0 end)
  + (case when candidacy_id    is not null then 1 else 0 end)
  + (case when pending_claim_id is not null then 1 else 0 end)
    = 1
  );

-- ----------------------------------------------------------------------------
-- 2. questionnaire_responses: add candidacy_id/person_id, relax legacy NOT NULLs
-- ----------------------------------------------------------------------------
alter table public.questionnaire_responses
  add column if not exists candidacy_id uuid
    references public.candidacies(id) on delete cascade,
  add column if not exists person_id uuid
    references public.people(id) on delete cascade;

alter table public.questionnaire_responses alter column candidate_id drop not null;
alter table public.questionnaire_responses alter column race_id      drop not null;

create index if not exists idx_qr_candidacy_id on public.questionnaire_responses(candidacy_id);
create index if not exists idx_qr_person_id    on public.questionnaire_responses(person_id);

-- Every response must anchor to at least one identity (legacy OR office-graph).
-- NOT VALID: skip the full-table re-scan; all pre-existing rows already carry
-- candidate_id so they satisfy it anyway.
alter table public.questionnaire_responses
  drop constraint if exists qr_identity_present;
alter table public.questionnaire_responses
  add constraint qr_identity_present
  check (candidate_id is not null or candidacy_id is not null) not valid;

-- ----------------------------------------------------------------------------
-- 3. candidate_sources: allow person-only rows (person_id already exists)
-- ----------------------------------------------------------------------------
alter table public.candidate_sources alter column candidate_id drop not null;

alter table public.candidate_sources
  drop constraint if exists cs_identity_present;
alter table public.candidate_sources
  add constraint cs_identity_present
  check (candidate_id is not null or person_id is not null) not valid;

-- The legacy UNIQUE (candidate_id, source_type, url) does not dedup person-keyed
-- rows (candidate_id NULL -> NULLs distinct in a unique key). Add a person-keyed
-- unique index so the affirm upsert can ON CONFLICT on the person key. NON-partial
-- on purpose: PostgREST/Supabase upsert (on_conflict=person_id,source_type,url)
-- cannot infer a PARTIAL unique index as the conflict arbiter (it can't supply
-- the index WHERE predicate). Legacy rows (person_id NULL) are simply distinct
-- under this index, so it is inert for them; they continue to dedup via the
-- existing candidate_id unique.
create unique index if not exists cs_person_source_url_key
  on public.candidate_sources(person_id, source_type, url);

-- ----------------------------------------------------------------------------
-- 4. candidate_position_disputes: allow office-graph-keyed disputes
-- ----------------------------------------------------------------------------
alter table public.candidate_position_disputes
  add column if not exists person_id uuid
    references public.people(id) on delete cascade,
  add column if not exists candidacy_id uuid
    references public.candidacies(id) on delete cascade;

alter table public.candidate_position_disputes alter column candidate_id drop not null;

create index if not exists idx_cpd_person_id   on public.candidate_position_disputes(person_id);
create index if not exists idx_cpd_candidacy_id on public.candidate_position_disputes(candidacy_id);

alter table public.candidate_position_disputes
  drop constraint if exists cpd_identity_present;
alter table public.candidate_position_disputes
  add constraint cpd_identity_present
  check (candidate_id is not null or person_id is not null or candidacy_id is not null) not valid;
