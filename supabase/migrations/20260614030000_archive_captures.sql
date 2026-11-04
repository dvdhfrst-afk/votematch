-- 20260614030000_archive_captures.sql
-- Build 4 of the ingestion engine: ARCHIVE MINING via the Wayback Machine CDX
-- (Capture Index) Server API, for position-drift detection and deleted-content
-- recovery. ADDITIVE ONLY: one new table; no changes to existing tables, the
-- raw-evidence pipeline, the matching engine, or any voter-facing output.
--
-- WHY THIS TABLE EXISTS
--   The raw-evidence ingest (migration 20260614000000) captures the LIVE web as
--   it is today. This layer captures the SAME pages as they were over TIME,
--   enumerated from the Internet Archive's Wayback Machine CDX Server API. Each
--   enumerated capture is a (url, timestamp, digest) tuple; the digest is the
--   archive's SHA-1 (Secure Hash Algorithm 1) of the captured payload, so two
--   captures with the same digest are byte-identical and one row per distinct
--   digest is enough to reconstruct the change history of a page. From that
--   history we derive two civic-research products:
--     1. POSITION DRIFT: "this candidate's stance on X changed between date A and
--        date B" - dated to the midpoint between the last capture with the old
--        content and the first capture with the new content.
--     2. DELETED-CONTENT RECOVERY: a page (or a statement on it) that existed in
--        the archive but is gone from the live site.
--
-- VISIBILITY / LEGAL POSTURE (founder decision, per doc-09 section 3)
--   Deleted-content publishing is OFF pending legal review. Every row defaults to
--   visibility='internal' and this table has RLS enabled with NO public-read
--   policy, so anon / authenticated clients get NOTHING; only the service role
--   (which bypasses RLS) can read it. We may internally surface "positions
--   changed between X and Y" without quoting deleted text to voters; we do NOT
--   expose archived snapshots to the public from this table until legal signs off.
--
-- DEDUP CHAIN (mirrors the raw-evidence ledger discipline)
--   First gate: the archive's SHA-1 `digest` (UNIQUE(digest, source)) - identical
--   archive payloads collapse to one row, exactly as CDX collapse=digest does at
--   enumeration time. Second gate (downstream, when a snapshot is actually
--   fetched): our own SHA-256 (Secure Hash Algorithm 256) normalized-text hash,
--   matched against evidence_seen_ledger.normalized_hash so archived content that
--   is byte-different (a Wayback toolbar tweak) but semantically identical to
--   content we already hold is RECOGNIZED, not re-stored. `content_hash` here
--   holds the raw_evidence.content_hash of a fetched-and-stored snapshot when one
--   exists; `raw_evidence_id` links the fetched snapshot row.

create table if not exists archive_captures (
  id uuid primary key default gen_random_uuid(),
  person_id uuid references people(id) on delete set null,         -- bound by identity resolution; null until bound
  raw_evidence_id uuid references raw_evidence(id) on delete set null,  -- the fetched+stored snapshot row, when one exists
  url text not null,                       -- the ORIGINAL (live-web) URL the capture is of (CDX `original`)
  snapshot_url text not null,              -- the Wayback playback URL: http://web.archive.org/web/{timestamp}/{url}
  captured_at timestamptz not null,        -- the capture timestamp (CDX `timestamp`, parsed from YYYYMMDDhhmmss)
  digest text not null,                    -- the archive's SHA-1 payload digest (CDX `digest`); first dedup gate
  source text not null default 'wayback',  -- archive source; 'wayback' now, room for common_crawl etc. later
  content_hash text,                       -- raw_evidence.content_hash of the fetched snapshot (sha256), when fetched
  visibility text not null default 'internal',  -- internal-only until legal review of deleted-content publishing
  status text not null default 'pending'        -- lifecycle of this capture in our pipeline
    check (status in ('pending', 'fetched', 'deduped', 'diffed', 'error')),
  drift jsonb,                             -- drift-diff result: change segments + dated change window (see diffCaptures)
  created_at timestamptz default now(),
  unique (digest, source)                  -- first dedup gate: identical archive payloads collapse to one row
);

-- Lookups: by the person a capture is bound to, and by the live-web URL whose
-- history we are reconstructing (enumeration writes many rows per url).
create index if not exists archive_captures_person_idx on archive_captures (person_id);
create index if not exists archive_captures_url_idx on archive_captures (url);

-- RLS: enabled, NO policies on purpose. Deleted-content publishing defaults OFF
-- pending legal review; visibility is internal-only. anon / authenticated get
-- nothing; the service role bypasses RLS for the internal pipeline + dashboards.
alter table archive_captures enable row level security;
