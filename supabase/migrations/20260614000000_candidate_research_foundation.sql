-- 20260614000000_candidate_research_foundation.sql
-- Phase 0/1 foundation for the candidate-research + comprehensive-profile system.
-- ADDITIVE ONLY: new tables; no changes to existing tables, the matching engine,
-- or any voter-facing output. Council-approved architecture: immutable RAW evidence
-- + a seen-before ledger keyed on NORMALIZED text + a URL negative cache, so
-- discovery is idempotent and the find-forget-refind loop cannot form. Redaction
-- happens later at OUTPUT, never here. Ingest-time scrubs are limited to the
-- contraband floor + minors per founder decision 2026-06-13.

create table if not exists raw_evidence (
  id uuid primary key default gen_random_uuid(),
  content_hash text not null,            -- sha256 of raw fetched bytes (storage dedup)
  normalized_hash text not null,         -- sha256 of normalized main-content text (ledger key)
  source_url text not null,
  final_url text,                        -- after redirect resolution
  registrable_domain text,               -- evaluated vs denylist at fetch time
  fetch_tier text,                       -- direct|jina|cf_bypass|headless|api
  http_status int,
  content_type text,
  byte_size bigint,
  storage_ref text,                      -- object-storage key for raw bytes
  extracted_text text,                   -- normalized, boilerplate-stripped main content
  source_family text,                    -- candidate_site|social|gov_record|news|business|court|finance|...
  discovery_path text,                   -- authoritative_anchor|verified_email_domain|claim|permutation|search|...
  person_id uuid references people(id) on delete set null,  -- bound later by identity resolution
  bind_confidence numeric(4,3),          -- 0..1; null until bound; low binds never publish
  ingest_scrubs jsonb not null default '[]'::jsonb,  -- contraband/minor scrubs applied at ingest
  provenance jsonb not null default '{}'::jsonb,
  fetched_at timestamptz,
  created_at timestamptz not null default now(),
  unique (content_hash)
);
create index if not exists raw_evidence_normhash_idx on raw_evidence (normalized_hash);
create index if not exists raw_evidence_person_idx on raw_evidence (person_id);
create index if not exists raw_evidence_domain_idx on raw_evidence (registrable_domain);

create table if not exists evidence_seen_ledger (
  normalized_hash text primary key,      -- idempotency key: have we processed this content?
  first_raw_evidence_id uuid references raw_evidence(id) on delete set null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  times_seen int not null default 1,
  classified boolean not null default false,  -- derived layer processed it?
  meta jsonb not null default '{}'::jsonb
);

create table if not exists url_negative_cache (
  url_canonical text primary key,        -- canonicalized URL, consulted BEFORE fetch
  reason text not null,                  -- denylist|robots_disallow|dead|http_error|irrelevant|duplicate
  http_status int,
  registrable_domain text,
  last_checked_at timestamptz not null default now(),
  recheck_after timestamptz,             -- null = permanent; else earliest re-fetch
  times_hit int not null default 1,
  notes text
);
create index if not exists url_negative_cache_recheck_idx on url_negative_cache (recheck_after);
