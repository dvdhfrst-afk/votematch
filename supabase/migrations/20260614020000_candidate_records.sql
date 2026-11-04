-- 20260614020000_candidate_records.sql
-- Build 2 of the candidate-research ingestion engine: OFFICIAL structured-data
-- enrichment, bound by STRONG ID.
--
-- ADDITIVE ONLY: one new table; no changes to existing tables, the matching
-- engine, or any voter-facing output.
--
-- This sits alongside the raw-evidence layer (migration 20260614000000) but
-- serves a different purpose. raw_evidence holds immutable, normalized fetched
-- source TEXT (campaign sites, news, court pages). candidate_records holds
-- STRUCTURED FACTS pulled from official government primary application
-- programming interfaces (APIs) and bound to a canonical person by a registered
-- strong identifier in person_xref:
--   * FEC (Federal Election Commission) API     -> campaign_finance  (fec_candidate_id)
--   * Congress.gov API                          -> member_bio, sponsorship (bioguide_id)
--   * OpenStates API v3                          -> state_role        (openstates_id)
--   * CourtListener REST v4                      -> litigation        (name match only)
--   * SEC (Securities and Exchange Commission)   -> business          (name match only)
--   * IRS (Internal Revenue Service) 990 via ProPublica Nonprofit Explorer
--                                               -> nonprofit         (name match only)
--
-- BIND DISCIPLINE (mirrors identity-resolve.ts). Two classes of source:
--   * STRONG-ID sources (FEC, Congress.gov, OpenStates) are bound DETERMINISTICALLY
--     by a registered external id. bind_method = 'strong_id:<kind>',
--     bind_confidence = 1.0, verified = TRUE for the structured fact itself.
--   * NAME-ONLY sources (CourtListener, SEC EDGAR, IRS 990) are searched by name
--     and can never auto-bind (homonym + defamation risk, especially for
--     litigation). They are STAGED: bind_method = 'name_match',
--     verified = FALSE, requires_strong_id = TRUE, with a `note` for human review.
--
-- PROVENANCE. Every row carries source, source_url, external_ref (the upstream
-- record id), and the full normalized payload as jsonb, so any displayed fact can
-- be audited to its primary source. No row auto-publishes unless verified = TRUE;
-- RLS enforces public-read on verified rows only (mirrors the person_xref pattern).

create table if not exists candidate_records (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references people(id) on delete cascade,
  record_type text not null check (record_type in (
    'campaign_finance',  -- FEC candidate financial summary + totals
    'sponsorship',       -- Congress.gov sponsored / cosponsored legislation
    'member_bio',        -- Congress.gov member record (party, state, terms)
    'state_role',        -- OpenStates current role / office
    'litigation',        -- CourtListener dockets (name match -> staged)
    'business',          -- SEC EDGAR insider ties (name match -> staged)
    'nonprofit'          -- IRS 990 officer ties (name match -> staged)
  )),
  source text not null,                 -- 'fec' | 'congress' | 'openstates' | 'courtlistener' | 'edgar' | 'irs990'
  source_url text,                      -- canonical upstream URL for this record
  external_ref text,                    -- upstream record id (FEC candidate_id, bill number, docket id, CIK, EIN, ...)
  payload jsonb not null default '{}'::jsonb,  -- normalized structured fact(s)
  bind_method text not null,            -- 'strong_id:<kind>' (deterministic) | 'name_match' (staged)
  bind_confidence numeric(4,3) not null,-- 1.0 for strong-id; lower for name match
  verified boolean not null default false,        -- TRUE only for strong-id structured facts
  requires_strong_id boolean not null default false,  -- TRUE for name-only rows awaiting human/strong-id corroboration
  note text,                            -- human-review hint for staged rows
  fetched_at timestamptz,
  created_at timestamptz not null default now(),
  -- Idempotency: re-running enrichment for the same person + record_type +
  -- source + upstream id is a no-op upsert, never a duplicate row.
  unique (person_id, record_type, source, external_ref)
);

create index if not exists candidate_records_person_type_idx
  on candidate_records (person_id, record_type);

alter table candidate_records enable row level security;

-- Public read ONLY on verified rows. Staged (name-only / unverified) rows stay
-- private until a human or a strong id corroborates them. Mirrors the project's
-- public-read RLS pattern (person_xref) but scoped to verified = true so
-- defamation-risk name matches never leak to the voter-facing surface.
create policy "Public read verified candidate_records"
  on candidate_records for select
  using (verified = true);

comment on table candidate_records is
  'Official structured-data enrichment for candidates, bound to canonical people. '
  'Strong-id sources (FEC, Congress.gov, OpenStates) auto-bind verified=true; '
  'name-only sources (CourtListener, SEC EDGAR, IRS 990) stage verified=false, '
  'requires_strong_id=true for human review. RLS public-reads verified rows only.';

comment on column candidate_records.bind_method is
  'strong_id:<kind> for deterministic binds via person_xref; name_match for staged name-only rows.';
comment on column candidate_records.requires_strong_id is
  'TRUE when the row was bound by name only and must not publish until a strong id or human confirms it.';

-- Migration registration is handled automatically by the Supabase CLI.
