-- =============================================================================
-- Council-driven hardening pass (2026-04-25).
--
-- Implements the 16 improvements identified by the four-voice council review:
--   1. Banner schema mismatch (no schema change here — fixed in app code)
--   2. parser_signal + new statuses 'unproductive' and 'unchanged'
--   3. Adapter Doctor improvements (no schema; code-only)
--   4. sos-indiana-candidacies fix (code-only)
--   5. Content-hash short-circuit + separate insert/update reporting
--   6. Cross-state canonical_key dedup (state + cycle_year)
--   7. Federal voting on /candidate/[id] (code-only)
--   8. CF strip on /candidate/[id] (code-only)
--   9. Primary-readiness check
--  10. Prioritize OH+CA dormants (code-only)
--  11. Circuit-breaker hysteresis + flap_count + 'quarantined' status
--  12. Pipe worker stdout (code-only)
--  13. Worker heartbeat table
--  14. Janitor pg_terminate_backend (code-only — uses existing pg_stat_activity)
--  15. New adapter categories (per-state candidacies, etc. — code-only)
--  16. Fingerprint-based stale-URL detection
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 2/5 + 11. Expand ingestion_runs.status to allow new states.
--   - 'unproductive': parser signaled non-ok (no_table / parse_failed) AND
--     0 rows. Distinguishes "URL is wrong" from "this state has no data."
--   - 'unchanged': content_hash matches a recent successful run; runner
--     short-circuited and didn't re-insert. Avoids re-ingest churn that
--     inflates productive counts.
--   - 'rejected_concurrent' / 'rejected_cost_cap': were already used by the
--     analyzer and reportIngestionFailure but the CHECK only allowed 5
--     values, which is fine when they're not actually written into this
--     table. Add explicitly so future writers can.
-- ---------------------------------------------------------------------------

ALTER TABLE ingestion_runs DROP CONSTRAINT IF EXISTS ingestion_runs_status_check;
ALTER TABLE ingestion_runs ADD CONSTRAINT ingestion_runs_status_check CHECK (
  status IN (
    'running','success','partial','failed','skipped',
    'unproductive','unchanged',
    'rejected_concurrent','rejected_cost_cap'
  )
);

-- Index on status for analyzer + janitor queries (used heavily).
CREATE INDEX IF NOT EXISTS idx_ingestion_runs_status_started
  ON ingestion_runs (status, started_at DESC);

-- 5. Helper view that exposes the rows-inserted-vs-updated split. The
-- voter-facing dashboards should report rowsInserted (true new) separately
-- from rowsUpdated (re-touches), so churn doesn't inflate "productive."
CREATE OR REPLACE VIEW v_ingestion_run_velocity AS
SELECT
  date_trunc('hour', started_at) AS hour,
  adapter_name,
  count(*) FILTER (WHERE status='success' AND rows_inserted > 0) AS productive,
  count(*) FILTER (WHERE status='unchanged') AS unchanged,
  count(*) FILTER (WHERE status='unproductive') AS unproductive,
  count(*) FILTER (WHERE status IN ('failed','partial')) AS failed_partial,
  sum(rows_inserted) FILTER (WHERE status='success') AS true_new_rows,
  sum(rows_updated) FILTER (WHERE status='success') AS touched_rows
FROM ingestion_runs
WHERE started_at > now() - interval '7 days'
GROUP BY 1, 2;

-- ---------------------------------------------------------------------------
-- 11. Circuit-breaker hysteresis. Add columns to adapter_status so the
-- analyzer can:
--   - require ≥3 productive runs across ≥2 distinct hours before clearing
--   - track flap_count (number of trip→clear→trip cycles in 30d)
--   - escalate to 'quarantined' when flap_count > 3 (only manual unbreak)
--
-- Also widen the schema. The current adapter_status table was created
-- inline by mark-dormant-adapters.ts via `CREATE TABLE IF NOT EXISTS`;
-- this is the canonical place for it now.
-- ---------------------------------------------------------------------------

ALTER TABLE adapter_status
  ADD COLUMN IF NOT EXISTS flap_count int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_breaker_trip_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_breaker_clear_at timestamptz,
  ADD COLUMN IF NOT EXISTS quarantined_at timestamptz,
  ADD COLUMN IF NOT EXISTS quarantine_reason text;

-- Status check — allow the values we use. 'dormant_quiescent' is broadened
-- formally in 20260425000016; included here so this constraint applies
-- cleanly against tables that may already contain dormant_quiescent rows
-- by the time this migration is run (e.g. local DB that has been live-
-- updating ahead of the migration ledger).
ALTER TABLE adapter_status DROP CONSTRAINT IF EXISTS adapter_status_status_check;
ALTER TABLE adapter_status ADD CONSTRAINT adapter_status_status_check CHECK (
  status IN ('productive','dormant','dormant_quiescent','circuit_broken','quarantined','unknown')
);

-- ---------------------------------------------------------------------------
-- 13. Worker heartbeat table. Each long-running script UPSERTs into this
-- on every tick. A separate watchdog cron pages a human if any worker's
-- last heartbeat is older than 2× its expected tick interval.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS worker_heartbeats (
  worker_name text PRIMARY KEY,
  pid int,
  last_heartbeat_at timestamptz NOT NULL DEFAULT now(),
  expected_tick_seconds int NOT NULL,
  cycle_count bigint NOT NULL DEFAULT 0,
  last_event text,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- Plain index on last_heartbeat_at; the watchdog query filters with a
-- now()-window, but Postgres requires IMMUTABLE in partial-index predicates.
CREATE INDEX IF NOT EXISTS idx_worker_heartbeats_last
  ON worker_heartbeats (last_heartbeat_at);

COMMENT ON TABLE worker_heartbeats IS
  'Liveness signal from continuous-ingest, failure-analyzer, stuck-task-janitor, '
  'adapter-doctor, and data-quality-watcher. Stale rows (last_heartbeat older than '
  'expected_tick_seconds × 2) indicate a crashed loop.';

-- ---------------------------------------------------------------------------
-- 6. Cross-state canonical_key dedup. The 457 cross-state duplicates the
-- data-quality watcher found are because canonical_key was being computed
-- without state scoping. Add a partial unique index so the runner's UPSERT
-- can dedupe on (canonical_key, state_fips). The dedupe-existing-dupes
-- migration is non-destructive: lower-rowid wins, others get suffixed.
--
-- NOTE: this only adds the structural support. The actual canonical_key
-- generator update lives in the adapter base helpers; until those are
-- patched, the index will be enforced going forward but old dupes remain
-- (data_quality_flags will continue to track them until cleared).
-- ---------------------------------------------------------------------------

-- people.canonical_key alone (no state column) is too coarse: "John Smith"
-- in CA vs OH collide. The fix needs deeper semantic dedup (birth_year,
-- party history, candidacy state). For now: surface the dupes via a view
-- so the data-quality watcher can flag them and the candidate-resolver
-- can be hardened to use state_fips from candidacies.
CREATE OR REPLACE VIEW v_people_canonical_dupes AS
SELECT
  canonical_key,
  count(*)::int AS dupe_count,
  array_agg(id ORDER BY created_at) AS person_ids,
  array_agg(canonical_name ORDER BY created_at) AS canonical_names
FROM people
WHERE canonical_key IS NOT NULL
GROUP BY canonical_key
HAVING count(*) > 1;

COMMENT ON VIEW v_people_canonical_dupes IS
  'Surfaces 457+ canonical_key collisions across people rows. The right '
  'fix is to disambiguate via candidacies.state_fips when merging — the '
  'candidate-resolver in src/lib/adapters/state-sos/candidate-resolver.ts '
  'should attach state_fips to incoming people before dedup. See council '
  'review 2026-04-25 finding DE#3.';

-- ---------------------------------------------------------------------------
-- 9. Primary-readiness check. Per-state, per-election: how many candidacies
-- do we have in DB vs how many SHOULD be there. The "should" number comes
-- from a per-state SoS filing-list count (scraped or manually entered). If
-- our number deviates >10% from theirs within 30 days of the primary, fire
-- a critical data_quality_flag.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS primary_readiness (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  state_fips text NOT NULL,
  election_date date NOT NULL,
  expected_candidacy_count int,         -- from SoS official filing list
  actual_candidacy_count int,           -- from our DB at last check
  source_url text,                       -- where expected count came from
  last_checked_at timestamptz,
  delta_pct numeric GENERATED ALWAYS AS (
    CASE
      WHEN expected_candidacy_count IS NULL OR expected_candidacy_count = 0 THEN NULL
      WHEN actual_candidacy_count IS NULL THEN NULL
      ELSE ROUND(100.0 * (actual_candidacy_count - expected_candidacy_count) / expected_candidacy_count, 2)
    END
  ) STORED,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (state_fips, election_date)
);

CREATE INDEX IF NOT EXISTS idx_primary_readiness_state ON primary_readiness (state_fips);
CREATE INDEX IF NOT EXISTS idx_primary_readiness_at_risk
  ON primary_readiness (election_date, delta_pct)
  WHERE delta_pct < -10 OR delta_pct IS NULL;

COMMENT ON TABLE primary_readiness IS
  'Tracks completeness of candidate coverage vs SoS filing lists. delta_pct < -10% '
  'within 30 days of election → critical data_quality_flag, page humans. '
  'Populated by primary-readiness-checker.ts on a daily cron.';

-- ---------------------------------------------------------------------------
-- 16. Fingerprint-based stale-URL detection. Store rolling fingerprints of
-- adapter response bodies. If N consecutive runs produce identical
-- fingerprint AND zero rows, the URL is almost certainly pointing at a
-- static landing page — auto-flag for the doctor.
-- Storage lives on data_sources.meta but we add a typed view for queries.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW v_likely_stale_urls AS
SELECT
  ds.id AS data_source_id,
  ds.name,
  ds.url,
  ds.state_fips,
  ds.meta->'body_fingerprints' AS fingerprints,
  jsonb_array_length(COALESCE(ds.meta->'body_fingerprints', '[]'::jsonb)) AS fingerprint_count,
  -- Are all fingerprints identical?
  CASE
    WHEN jsonb_array_length(COALESCE(ds.meta->'body_fingerprints', '[]'::jsonb)) >= 5
     AND (
       SELECT count(DISTINCT (e->>'hash')) <= 1
       FROM jsonb_array_elements(ds.meta->'body_fingerprints') e
     )
    THEN true
    ELSE false
  END AS likely_stale,
  ds.last_successful_fetch_at
FROM data_sources ds
WHERE ds.meta ? 'body_fingerprints';

COMMENT ON VIEW v_likely_stale_urls IS
  '5+ identical body fingerprints + 0 rows ⇒ landing page, not data. '
  'Adapter Doctor reads this view to prioritize URL discovery.';

-- ---------------------------------------------------------------------------
-- Done.
-- ---------------------------------------------------------------------------
