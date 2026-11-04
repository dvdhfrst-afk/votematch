-- Own-archive pipeline per blueprint-v6 §7.5 infrastructure + methodology
-- research iter-10 finding: "flip from Wayback-as-rescue to Ballot Bridge as
-- the archive." Every ingested source gets a byte-level snapshot stored to
-- Supabase Storage with a row here recording provenance.
--
-- Also addresses iter-06's "longitudinal contamination" finding — candidate
-- sites silently rewrite post-election. A time-stamped archive is the only
-- faithful source for past-cycle positions.

CREATE TABLE snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The URL we fetched (normalized)
  url TEXT NOT NULL,
  -- SHA-256 of the URL for de-dup and lookup
  url_hash TEXT NOT NULL,
  -- When we fetched (our fetch time, not the page's publish time)
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- HTTP status we got
  http_status INT,
  -- Server-reported content type
  content_type TEXT,
  -- Supabase Storage path (bucket `snapshots`, path per convention below)
  storage_path TEXT NOT NULL,
  -- Raw byte size
  raw_size_bytes INT,
  -- What fetcher we used: 'plain', 'playwright', 'wayback_cdx', 'pdf'
  fetcher TEXT NOT NULL,
  -- Source classification: 'candidate_site', 'ballotpedia', 'news',
  -- 'voter_guide', 'debate_video', 'endorsement_list', 'official',
  -- 'campaign_finance', 'wayback', 'other'
  source_type TEXT NOT NULL,
  -- Optional link to a candidate if the snapshot is about them
  candidate_id UUID REFERENCES candidates(id) ON DELETE SET NULL,
  -- Optional link to the candidate_sources row this snapshot supports
  candidate_source_id UUID REFERENCES candidate_sources(id) ON DELETE SET NULL,
  -- Extracted plain text (for later classification; may be null if binary)
  extracted_text TEXT,
  -- Notes about fetch conditions / errors
  fetch_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Lookup by URL for "do we already have a recent snapshot of this?"
CREATE INDEX idx_snapshots_url_hash_fetched_at
  ON snapshots (url_hash, fetched_at DESC);

-- Lookup by candidate for "show me everything we've archived for X"
CREATE INDEX idx_snapshots_candidate
  ON snapshots (candidate_id, fetched_at DESC)
  WHERE candidate_id IS NOT NULL;

-- Lookup by source_type for coverage analysis
CREATE INDEX idx_snapshots_source_type
  ON snapshots (source_type, fetched_at DESC);

-- RLS: service role only (archive is operational, not user-facing read)
ALTER TABLE snapshots ENABLE ROW LEVEL SECURITY;
-- No policies = only service role can read/write. This is deliberate —
-- snapshots are admin-only until we add UI surfaces for attribution.
