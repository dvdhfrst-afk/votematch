-- =============================================================================
-- Council finding #40 — per-host rate-limit calibration table.
--
-- Today every adapter shares one global default (1000ms / req, burst 2). That
-- under-utilizes hosts that can take 10 rps (CA's CDN-backed bulk endpoints,
-- ftp.fec.gov) and over-hammers hosts that need 0.1 rps (small SoS sites with
-- no caching, MT/WV/AS portals on shared shoestring infra).
--
-- This migration introduces `host_rate_limits` as the canonical per-hostname
-- pacing table. `politeFetch` reads it (cached in-process for 60s) and falls
-- back to the conservative default when the host is unknown.
--
-- Seeded with sensible defaults for known categories:
--   - Bulk/CDN (CA, FEC bulk): 200ms (5 rps), burst 5
--   - Federal data services (Congress.gov, OpenStates): 500ms (2 rps), burst 3
--   - State SoS portals (large states): 1000ms (1 rps), burst 2
--   - State SoS portals (small states / WAF-flaky): 3000ms (0.33 rps), burst 1
--   - Tested hostile hosts (TN, CO TRACER, MT, OH liveresults): 5000ms, burst 1
--   - Default fallback (unknown host): 2000ms, burst 2
-- =============================================================================

CREATE TABLE IF NOT EXISTS host_rate_limits (
  hostname        TEXT PRIMARY KEY,
  min_interval_ms INTEGER NOT NULL CHECK (min_interval_ms > 0 AND min_interval_ms < 600000),
  burst           INTEGER NOT NULL CHECK (burst >= 1 AND burst <= 50),
  notes           TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE host_rate_limits IS
  'Per-hostname pacing config consumed by politeFetch. Council #40 (2026-04-25). '
  'Read-cached in-process for 60s. Unknown hosts fall back to '
  'DEFAULT_INTERVAL_MS in fetch-polite.ts (2000ms, burst 2 — conservative).';

COMMENT ON COLUMN host_rate_limits.min_interval_ms IS
  'Minimum spacing between successive requests to this host, in ms. '
  'Lower bound 1ms (effectively unthrottled), upper bound 10min (would mean '
  'we cannot reasonably scrape this host). Calibrate by observation: drop '
  'the floor when the host returns 429 / 503; raise it when 200s come back '
  'fast and stable. Council #40.';

COMMENT ON COLUMN host_rate_limits.burst IS
  'Number of requests permitted in quick succession before the per-host '
  'spacing kicks in. Most state SoS portals tolerate burst=2-3 on a fresh '
  'connection. Bulk endpoints (FEC bulk, CA) tolerate 5+. Council #40.';

CREATE INDEX IF NOT EXISTS idx_host_rate_limits_updated
  ON host_rate_limits (updated_at DESC);

-- ---------------------------------------------------------------------------
-- RLS — operations data, public never reads. Service role only.
-- ---------------------------------------------------------------------------
ALTER TABLE host_rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE host_rate_limits FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS host_rate_limits_service_only ON host_rate_limits;
CREATE POLICY host_rate_limits_service_only ON host_rate_limits
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- Seed values. Each row's note documents WHY the chosen interval. Operators
-- adjust by editing this table; code never hardcodes per-host values.
-- ---------------------------------------------------------------------------

INSERT INTO host_rate_limits (hostname, min_interval_ms, burst, notes) VALUES
  -- ===== Bulk / CDN-backed federal endpoints =====
  ('ftp.fec.gov',                200,  5, 'FEC bulk FTP — public bulk dump, no rate-limit; CDN handles burst.'),
  ('www.fec.gov',                500,  3, 'FEC API + web — 1000 req/hour key limit; 500ms/burst 3 stays well under.'),
  ('www.openstates.org',         500,  3, 'OpenStates v3 API — 5 rps cap per docs; 500ms is safe.'),
  ('api.congress.gov',           500,  3, 'Congress.gov v3 — 5000 req/hour key limit; 500ms ample.'),
  ('api.regulations.gov',        500,  3, 'Regulations.gov API — 1000 req/hour; 500ms safe.'),

  -- ===== Large-state SoS portals (CDN-backed, can sustain 2-5 rps) =====
  ('elections.cdn.sos.ca.gov',   200,  5, 'CA SoS bulk JSON via CDN — fronted by Akamai; 5 rps fine.'),
  ('www.sos.ca.gov',             1000, 2, 'CA SoS main site — non-CDN HTML; 1 rps polite.'),
  ('www.sos.state.tx.us',        1000, 2, 'TX SoS — large state, well-resourced; 1 rps standard.'),
  ('www.dos.ny.gov',             1000, 2, 'NY DOS — well-resourced; 1 rps standard.'),
  ('myfloridaelections.com',     1000, 2, 'FL elections portal — modern infra; 1 rps.'),
  ('www.sos.state.il.us',        1000, 2, 'IL SoS — large state; 1 rps.'),

  -- ===== Standard state SoS portals — 1 rps polite default =====
  ('www.sos.wa.gov',             1000, 2, 'WA SoS standard pacing.'),
  ('sos.oregon.gov',             1000, 2, 'OR SoS standard pacing.'),
  ('elections.az.gov',           1000, 2, 'AZ SoS — modern Akamai-fronted; 1 rps standard.'),
  ('elections.mass.gov',         1000, 2, 'MA elections portal standard.'),
  ('elections.maryland.gov',     1000, 2, 'MD SBE standard.'),
  ('www.sos.mo.gov',             1000, 2, 'MO SoS standard.'),
  ('sos.iowa.gov',               1000, 2, 'IA SoS standard.'),
  ('www.sos.la.gov',             1000, 2, 'LA SoS standard.'),
  ('www.sos.state.mn.us',        1000, 2, 'MN SoS standard.'),
  ('voterportal.sos.la.gov',     1000, 2, 'LA voter portal standard.'),
  ('www.azsos.gov',              1000, 2, 'AZ SoS alternate hostname standard.'),

  -- ===== Small-state / WAF-flaky portals — 3 rps polite default =====
  ('sos.colorado.gov',           3000, 1, 'CO SoS TRACER — small infra, returns 403 to anything that looks bot-y; 1 req/3s.'),
  ('campaignfinance.colorado.gov', 3000, 1, 'CO TRACER campaign-finance — same infra as SoS root; 1 req/3s.'),
  ('tn.gov',                     3000, 1, 'TN gateway — has hit 429s at 1 rps in the past; 1 req/3s.'),
  ('sos.tn.gov',                 3000, 1, 'TN SoS — same infra family as tn.gov.'),
  ('elections.mt.gov',           5000, 1, 'MT SoS — known WAF-hostile; 1 req/5s minimum.'),
  ('cabinetonline.mt.gov',       5000, 1, 'MT cabinet portal — same infra family.'),
  ('apps.sos.wv.gov',            3000, 1, 'WV SoS — small state, slow apps backend.'),
  ('cers.sos.in.gov',            3000, 1, 'IN CERS — known to 503 under load.'),
  ('publicaccess.elections.wv.gov', 3000, 1, 'WV public access — small infra.'),

  -- ===== Tested-hostile hosts — most conservative pacing =====
  ('liveresults.ohiosos.gov',    5000, 1, 'OH live-results — returns 403 on plain UA bursts; 1 req/5s.'),
  ('apps.azsos.gov',             5000, 1, 'AZ apps — has returned 403 on bursts.'),
  ('campaignfinance.az.gov',     5000, 1, 'AZ CF — small backend, 1 req/5s.'),

  -- ===== Territories — single small servers, treat conservatively =====
  ('ceepur.org',                 3000, 1, 'PR CEE — single-server portal.'),
  ('elections.gov.gu',           5000, 1, 'GU elections — small island infra.'),
  ('vivote.gov',                 5000, 1, 'USVI elections — small infra.'),
  ('americansamoaelectionoffice.org', 5000, 1, 'AS election office — small infra.'),

  -- ===== Newspaper / endorsement scraping =====
  ('www.nytimes.com',            2000, 2, 'NYT — large CDN but we respect editorial-traffic guidelines.'),
  ('www.washingtonpost.com',     2000, 2, 'WaPo — large CDN, polite spacing.'),
  ('www.latimes.com',            2000, 2, 'LAT — polite spacing.'),
  ('www.chicagotribune.com',     2000, 2, 'Chicago Tribune — polite spacing.')
ON CONFLICT (hostname) DO UPDATE
  SET min_interval_ms = EXCLUDED.min_interval_ms,
      burst           = EXCLUDED.burst,
      notes           = EXCLUDED.notes,
      updated_at      = now();

-- ---------------------------------------------------------------------------
-- Done. politeFetch (src/lib/adapters/fetch-polite.ts) reads this table on
-- demand. data_sources.meta->>'min_request_interval_ms' continues to work
-- as a per-source override; host_rate_limits is the host-default fallback.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Council #29 companion: allow matches.score to be NULL.
--
-- The matching algorithm now refuses to emit a numeric score when fewer than
-- 5 dimensions overlap (a 1-2 dim coincidence shouldn't produce a 100% match).
-- It returns score=null + confidence='insufficient_overlap'. The matches table
-- needs to round-trip that, so drop the NOT NULL on score.
--
-- The CHECK that previously required score >= 0 / <= 100 was already inline
-- via app validation; the DB never had it. Just relax the NOT NULL.
-- ---------------------------------------------------------------------------

ALTER TABLE matches ALTER COLUMN score DROP NOT NULL;

COMMENT ON COLUMN matches.score IS
  '0-100 weighted-L1 match score, or NULL when fewer than 5 dimensions of '
  'overlap exist between voter and candidate (council #29). NULL rows must '
  'be rendered as "insufficient overlap" rather than 0%.';

