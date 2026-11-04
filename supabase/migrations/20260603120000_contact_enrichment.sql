-- Contact enrichment schema (plan: 00-inbox/2026-06-03-contact-ingestion-redesign-plan.md, D1 approved by the operator 2026-06-03)
--
-- Four tables:
--   candidate_contact_fields  one row per discovered field-value, full provenance + ownership + publishability
--   contact_research_state    per-person two-track status (reachable / sources_attempted) + attempts/TTL
--   contact_conflicts         differing values awaiting human resolution (Keep/Accept/Edit)
--   data_disputes             candidate right-of-reply lifecycle (open → under_review → resolved_*)
--
-- RLS: ENABLED with NO public policies on all four — these hold PII (incl. suppressed
-- personal-class values per D4 "capture and suppress"). Service-role access only.
-- Mirror columns (people.contact_email/contact_phone/website_url, candidacies.campaign_email/website)
-- remain the app-facing cache of the PRIMARY PUBLISHABLE value only.

-- ── 1. candidate_contact_fields ─────────────────────────────────────────────
create table if not exists candidate_contact_fields (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references people(id) on delete cascade,
  -- campaign contact is candidacy-cycle-scoped (a person can run two races with
  -- different campaign emails); NULL = person-stable field (socials, bio, address).
  candidacy_id uuid references candidacies(id) on delete set null,
  field_kind text not null check (field_kind in ('email','phone','website','social','mailing_address','bio')),
  platform text check (platform in ('x','facebook','instagram','youtube','linkedin','tiktok','bluesky','other')),
  value text not null,
  value_norm text not null,  -- lowercased/trimmed dedupe key
  -- THE unit of publish-risk (council legal-C1): campaign-official is publishable;
  -- personal_individual is stored-but-suppressed (D4: keep it so we don't re-find
  -- and re-process the same PII every pass), never displayed, never in outreach.
  contact_class text not null default 'unknown' check (contact_class in ('campaign_official','personal_individual','unknown')),
  source_url text,
  source_kind text check (source_kind in ('sos_filing','county_filing','fec','campaign_site','campaign_social','news_lead','candidate_self_report','legacy_backfill','manual')),
  ownership_basis text not null default 'unknown' check (ownership_basis in ('filing_row_labeled','on_confirmed_site','domain_verified','linked_from_confirmed_site','gov_filing','candidate_confirmed','name_match_only','unknown')),
  ownership_score numeric not null default 0,
  ownership_verified boolean not null default false,
  confidence text not null default 'low' check (confidence in ('high','medium','low')),
  method text not null default 'agent' check (method in ('bulk_parse','agent','candidate_self_report','legacy_backfill','manual')),
  -- publishable: ownership_verified AND campaign-class (or candidate_confirmed) AND conflict-free.
  -- The mirror columns only ever receive publishable+is_primary values.
  publishable boolean not null default false,
  suppressed boolean not null default false,
  suppression_reason text,
  is_primary boolean not null default false,  -- the value mirrored to the real column
  verified_at timestamptz,
  run_id text,
  meta jsonb not null default '{}'::jsonb,    -- citations[], notes, dispute refs
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Dedupe: same person+kind+normalized value (+candidacy scope) is one row.
create unique index if not exists ccf_dedupe_idx on candidate_contact_fields
  (person_id, field_kind, value_norm, coalesce(candidacy_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index if not exists ccf_person_idx on candidate_contact_fields (person_id);
create index if not exists ccf_candidacy_idx on candidate_contact_fields (candidacy_id) where candidacy_id is not null;
create index if not exists ccf_kind_publishable_idx on candidate_contact_fields (field_kind, publishable);

-- ── 2. contact_research_state (per person — the two-track status) ───────────
create table if not exists contact_research_state (
  person_id uuid primary key references people(id) on delete cascade,
  -- Track 1: verified campaign email exists (the outreach/questionnaire/B2B gate).
  reachable boolean not null default false,
  reachable_at timestamptz,
  -- Track 2: a good positioning-source attempt was made (socials/news/statements
  -- harvested into candidate_sources). Quality ladder = positioning spec tiers A/B/C, computed downstream.
  sources_attempted boolean not null default false,
  sources_attempted_at timestamptz,
  attempts int not null default 0,
  attempts_cap int not null default 4,        -- explicit, per-person, non-resetting within the quarter
  last_attempt_at timestamptz,
  exhausted boolean not null default false,
  exhausted_at timestamptz,
  recheck_after timestamptz,                  -- TTL re-check; min floor + jitter; clamped to soonest election
  filing_window_state text not null default 'unknown' check (filing_window_state in ('open','closed','unknown')),
  run_id text,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists crs_queue_idx on contact_research_state (reachable, exhausted, recheck_after);

-- ── 3. contact_conflicts (human resolution loop: Keep / Accept / Edit) ──────
create table if not exists contact_conflicts (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references people(id) on delete cascade,
  candidacy_id uuid references candidacies(id) on delete set null,
  field_kind text not null,
  existing_value text,
  found_value text,
  found_source_url text,
  detail text,
  status text not null default 'open' check (status in ('open','kept_existing','accepted_found','edited','dismissed')),
  resolution_value text,     -- for status='edited'
  resolved_by text,
  resolved_at timestamptz,
  run_id text,
  created_at timestamptz not null default now()
);
create index if not exists ccx_open_idx on contact_conflicts (status) where status = 'open';
create index if not exists ccx_person_idx on contact_conflicts (person_id);

-- ── 4. data_disputes (candidate right-of-reply — D6) ────────────────────────
-- Lifecycle: open → under_review → resolved_corrected | resolved_upheld | resolved_suppressed.
-- resolved_upheld + display_disputed_tag=true ⇒ the data stays visible to voters WITH a
-- visible "disputed by candidate" tag (counsel sign-off required before that flow ships).
create table if not exists data_disputes (
  id uuid primary key default gen_random_uuid(),
  person_id uuid references people(id) on delete cascade,
  candidacy_id uuid references candidacies(id) on delete set null,
  target_kind text not null check (target_kind in ('contact_field','position','source','profile','other')),
  target_id uuid,            -- candidate_contact_fields.id / positions.id / candidate_sources.id
  submitted_by text not null default 'candidate' check (submitted_by in ('candidate','campaign','public','internal')),
  submitter_contact text,
  claim text not null,
  status text not null default 'open' check (status in ('open','under_review','resolved_corrected','resolved_upheld','resolved_suppressed')),
  reviewer_notes text,
  resolved_by text,
  resolved_at timestamptz,
  display_disputed_tag boolean not null default false,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists dd_open_idx on data_disputes (status) where status in ('open','under_review');
create index if not exists dd_person_idx on data_disputes (person_id);

-- ── RLS: deny-all (service-role only) — these tables hold PII ───────────────
alter table candidate_contact_fields enable row level security;
alter table contact_research_state  enable row level security;
alter table contact_conflicts       enable row level security;
alter table data_disputes           enable row level security;
-- No policies created on purpose: anon/authenticated get nothing; service role bypasses RLS.
