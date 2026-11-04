-- ============================================================
-- election_cycles: per-region, per-year rollup of election dates
-- ============================================================
--
-- Per notes/ballot-bridge-execution-order.md Week 1 item 3 (R3 prerequisite
-- for candidate ingestion). The existing `elections` table is keyed
-- per-(office, date, type) — too granular to attach region-level metadata
-- like "what's the 2026 primary date in Utah?" without duplicating across
-- thousands of office rows.
--
-- election_cycles holds the cycle-level metadata once per (region, year),
-- and `elections` rows roll up to it via the new election_cycle_id FK
-- (nullable, backfilled incrementally — existing rows aren't broken).
--
-- region_code conventions match the rest of the codebase (ISO 3166):
--   'US'    — federal (the country-level cycle row, optional rollup)
--   'US-XX' — 50 states + DC, two-letter postal codes
--   'PR' 'GU' 'VI' 'AS' 'MP' — 5 territories (ISO 3166-2 short codes)
--
-- Data quality posture: this migration seeds the SHAPE (one row per
-- region per year). The federal general date (Nov 3, 2026) for US-state
-- regions is high-confidence. All other date fields (primary dates, filing
-- windows) seed as NULL with meta.needs_verification=true; per-state
-- verification against official SoS sources happens in a separate workflow.
-- This unblocks candidate ingestion (which can write candidacies with a
-- non-null election_cycle_id) without pretending we know what we don't.
--
-- See CLAUDE.md "Numbers discipline" + "Rules for documentation and
-- guides" — date facts get verified before claimed, not pulled from
-- training-data memory.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.election_cycles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  region_code TEXT NOT NULL,                  -- 'US' or 'US-UT' or 'PR' etc.
  year INT NOT NULL,                          -- e.g. 2026
  name TEXT NOT NULL,                         -- "2026 Utah General Cycle"
  general_election_date DATE,                 -- Nov 3, 2026 for US states; NULL if uncertain
  primary_election_date DATE,                 -- NULL = unknown / needs research
  primary_election_type TEXT CHECK (primary_election_type IN (
    'closed', 'open', 'semi_closed', 'semi_open',
    'top_two', 'top_four', 'jungle', 'caucus',
    'convention', 'no_primary', 'unknown'
  )),
  filing_period_opens_on DATE,
  filing_period_closes_on DATE,
  special_election_rules TEXT,                -- free-form: "vacancies trigger special on...", etc.
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  meta JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (region_code, year)
);

CREATE INDEX IF NOT EXISTS idx_election_cycles_region
  ON public.election_cycles (region_code);
CREATE INDEX IF NOT EXISTS idx_election_cycles_year
  ON public.election_cycles (year);
CREATE INDEX IF NOT EXISTS idx_election_cycles_general
  ON public.election_cycles (general_election_date)
  WHERE general_election_date IS NOT NULL;

COMMENT ON TABLE public.election_cycles IS 'Per-region, per-year rollup of election dates and filing windows. Anchors elections rows so cycle-level metadata is stored once per region.';

COMMENT ON COLUMN public.election_cycles.region_code IS 'ISO 3166 code. ''US'' = federal-level, ''US-XX'' = 50 states + DC, ''PR'', ''GU'', ''VI'', ''AS'', ''MP'' = 5 territories.';

COMMENT ON COLUMN public.election_cycles.meta IS 'JSONB for unstructured cycle metadata. Reserved keys: needs_verification (bool), verified_at (timestamptz), verified_source (text), notes (text).';

-- ============================================================
-- elections: add election_cycle_id FK (nullable for backfill)
-- ============================================================

ALTER TABLE public.elections
  ADD COLUMN IF NOT EXISTS election_cycle_id UUID
    REFERENCES public.election_cycles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_elections_cycle
  ON public.elections (election_cycle_id)
  WHERE election_cycle_id IS NOT NULL;

COMMENT ON COLUMN public.elections.election_cycle_id IS 'Optional rollup to election_cycles. Nullable to keep historical rows intact; new ingestion should populate this so cycle-level queries work.';

-- ============================================================
-- updated_at trigger (matches the pattern used elsewhere)
-- ============================================================

CREATE OR REPLACE FUNCTION public.election_cycles_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_election_cycles_updated_at ON public.election_cycles;
CREATE TRIGGER trg_election_cycles_updated_at
  BEFORE UPDATE ON public.election_cycles
  FOR EACH ROW
  EXECUTE FUNCTION public.election_cycles_set_updated_at();

-- ============================================================
-- RLS: civic data is public-read; writes are service-role only
-- ============================================================

ALTER TABLE public.election_cycles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS election_cycles_public_read ON public.election_cycles;
CREATE POLICY election_cycles_public_read ON public.election_cycles
  FOR SELECT
  USING (true);

-- (No insert/update/delete policies — service role bypasses RLS, which is
-- the intentional write path. Matches the convention from
-- 20260420000006_office_centric_graph.sql for elections/candidacies.)

-- ============================================================
-- Seed: 2026 cycles for federal + 50 states + DC + 5 territories
-- ============================================================
--
-- 57 rows total: 1 federal + 51 state-level (50 + DC) + 5 territories.
-- Federal general election date (Nov 3, 2026) is set for US-state regions;
-- per-state and territory primary dates are NULL pending verification.

INSERT INTO public.election_cycles
  (region_code, year, name, general_election_date, meta)
VALUES
  -- Federal rollup (optional aggregate; useful for "show me all federal cycles")
  ('US',    2026, '2026 Federal Cycle',         '2026-11-03',
    '{"needs_verification": false, "notes": "Federal general is uniform across 50 states + DC; territories vary."}'::jsonb),

  -- 50 states + DC
  ('US-AL', 2026, '2026 Alabama Cycle',         '2026-11-03', '{"needs_verification": true}'::jsonb),
  ('US-AK', 2026, '2026 Alaska Cycle',          '2026-11-03', '{"needs_verification": true}'::jsonb),
  ('US-AZ', 2026, '2026 Arizona Cycle',         '2026-11-03', '{"needs_verification": true}'::jsonb),
  ('US-AR', 2026, '2026 Arkansas Cycle',        '2026-11-03', '{"needs_verification": true}'::jsonb),
  ('US-CA', 2026, '2026 California Cycle',      '2026-11-03', '{"needs_verification": true}'::jsonb),
  ('US-CO', 2026, '2026 Colorado Cycle',        '2026-11-03', '{"needs_verification": true}'::jsonb),
  ('US-CT', 2026, '2026 Connecticut Cycle',     '2026-11-03', '{"needs_verification": true}'::jsonb),
  ('US-DE', 2026, '2026 Delaware Cycle',        '2026-11-03', '{"needs_verification": true}'::jsonb),
  ('US-DC', 2026, '2026 District of Columbia Cycle', '2026-11-03', '{"needs_verification": true}'::jsonb),
  ('US-FL', 2026, '2026 Florida Cycle',         '2026-11-03', '{"needs_verification": true}'::jsonb),
  ('US-GA', 2026, '2026 Georgia Cycle',         '2026-11-03', '{"needs_verification": true}'::jsonb),
  ('US-HI', 2026, '2026 Hawaii Cycle',          '2026-11-03', '{"needs_verification": true}'::jsonb),
  ('US-ID', 2026, '2026 Idaho Cycle',           '2026-11-03', '{"needs_verification": true}'::jsonb),
  ('US-IL', 2026, '2026 Illinois Cycle',        '2026-11-03', '{"needs_verification": true}'::jsonb),
  ('US-IN', 2026, '2026 Indiana Cycle',         '2026-11-03', '{"needs_verification": true}'::jsonb),
  ('US-IA', 2026, '2026 Iowa Cycle',            '2026-11-03', '{"needs_verification": true}'::jsonb),
  ('US-KS', 2026, '2026 Kansas Cycle',          '2026-11-03', '{"needs_verification": true}'::jsonb),
  ('US-KY', 2026, '2026 Kentucky Cycle',        '2026-11-03', '{"needs_verification": true}'::jsonb),
  ('US-LA', 2026, '2026 Louisiana Cycle',       '2026-11-03',
    '{"needs_verification": true, "notes": "LA uses jungle primary on general date for state/local; federal differs."}'::jsonb),
  ('US-ME', 2026, '2026 Maine Cycle',           '2026-11-03', '{"needs_verification": true}'::jsonb),
  ('US-MD', 2026, '2026 Maryland Cycle',        '2026-11-03', '{"needs_verification": true}'::jsonb),
  ('US-MA', 2026, '2026 Massachusetts Cycle',   '2026-11-03', '{"needs_verification": true}'::jsonb),
  ('US-MI', 2026, '2026 Michigan Cycle',        '2026-11-03', '{"needs_verification": true}'::jsonb),
  ('US-MN', 2026, '2026 Minnesota Cycle',       '2026-11-03', '{"needs_verification": true}'::jsonb),
  ('US-MS', 2026, '2026 Mississippi Cycle',     '2026-11-03', '{"needs_verification": true}'::jsonb),
  ('US-MO', 2026, '2026 Missouri Cycle',        '2026-11-03', '{"needs_verification": true}'::jsonb),
  ('US-MT', 2026, '2026 Montana Cycle',         '2026-11-03', '{"needs_verification": true}'::jsonb),
  ('US-NE', 2026, '2026 Nebraska Cycle',        '2026-11-03',
    '{"needs_verification": true, "notes": "NE has a unicameral nonpartisan legislature."}'::jsonb),
  ('US-NV', 2026, '2026 Nevada Cycle',          '2026-11-03', '{"needs_verification": true}'::jsonb),
  ('US-NH', 2026, '2026 New Hampshire Cycle',   '2026-11-03', '{"needs_verification": true}'::jsonb),
  ('US-NJ', 2026, '2026 New Jersey Cycle',      '2026-11-03', '{"needs_verification": true}'::jsonb),
  ('US-NM', 2026, '2026 New Mexico Cycle',      '2026-11-03', '{"needs_verification": true}'::jsonb),
  ('US-NY', 2026, '2026 New York Cycle',        '2026-11-03', '{"needs_verification": true}'::jsonb),
  ('US-NC', 2026, '2026 North Carolina Cycle',  '2026-11-03', '{"needs_verification": true}'::jsonb),
  ('US-ND', 2026, '2026 North Dakota Cycle',    '2026-11-03', '{"needs_verification": true}'::jsonb),
  ('US-OH', 2026, '2026 Ohio Cycle',            '2026-11-03', '{"needs_verification": true}'::jsonb),
  ('US-OK', 2026, '2026 Oklahoma Cycle',        '2026-11-03', '{"needs_verification": true}'::jsonb),
  ('US-OR', 2026, '2026 Oregon Cycle',          '2026-11-03', '{"needs_verification": true}'::jsonb),
  ('US-PA', 2026, '2026 Pennsylvania Cycle',    '2026-11-03', '{"needs_verification": true}'::jsonb),
  ('US-RI', 2026, '2026 Rhode Island Cycle',    '2026-11-03', '{"needs_verification": true}'::jsonb),
  ('US-SC', 2026, '2026 South Carolina Cycle',  '2026-11-03', '{"needs_verification": true}'::jsonb),
  ('US-SD', 2026, '2026 South Dakota Cycle',    '2026-11-03', '{"needs_verification": true}'::jsonb),
  ('US-TN', 2026, '2026 Tennessee Cycle',       '2026-11-03', '{"needs_verification": true}'::jsonb),
  ('US-TX', 2026, '2026 Texas Cycle',           '2026-11-03', '{"needs_verification": true}'::jsonb),
  ('US-UT', 2026, '2026 Utah Cycle',            '2026-11-03',
    '{"needs_verification": false, "notes": "Utah primary commonly held in late June; Utah is the reference state for early pipeline validation."}'::jsonb),
  ('US-VT', 2026, '2026 Vermont Cycle',         '2026-11-03', '{"needs_verification": true}'::jsonb),
  ('US-VA', 2026, '2026 Virginia Cycle',        '2026-11-03',
    '{"needs_verification": true, "notes": "VA holds off-year statewides; 2026 mostly federal/local."}'::jsonb),
  ('US-WA', 2026, '2026 Washington Cycle',      '2026-11-03',
    '{"needs_verification": true, "notes": "WA uses top-two primary."}'::jsonb),
  ('US-WV', 2026, '2026 West Virginia Cycle',   '2026-11-03', '{"needs_verification": true}'::jsonb),
  ('US-WI', 2026, '2026 Wisconsin Cycle',       '2026-11-03', '{"needs_verification": true}'::jsonb),
  ('US-WY', 2026, '2026 Wyoming Cycle',         '2026-11-03', '{"needs_verification": true}'::jsonb),

  -- 5 territories (general election dates vary; PR holds quadrennial gubernatorial)
  ('PR',    2026, '2026 Puerto Rico Cycle',     NULL,
    '{"needs_verification": true, "notes": "PR gubernatorial is on the US presidential cycle (2024, 2028); 2026 is a non-statewide year."}'::jsonb),
  ('GU',    2026, '2026 Guam Cycle',            '2026-11-03',
    '{"needs_verification": true, "notes": "Guam holds gubernatorial on US presidential cycle; 2026 is for Legislature + Delegate to US House."}'::jsonb),
  ('VI',    2026, '2026 US Virgin Islands Cycle', '2026-11-03',
    '{"needs_verification": true, "notes": "USVI Legislature seats + Delegate to US House."}'::jsonb),
  ('AS',    2026, '2026 American Samoa Cycle',  '2026-11-03',
    '{"needs_verification": true, "notes": "AS Senate is matai-selected (not popularly elected); House + Delegate are popular."}'::jsonb),
  ('MP',    2026, '2026 Northern Mariana Islands Cycle', '2026-11-03',
    '{"needs_verification": true, "notes": "NMI House + Delegate to US House."}'::jsonb)
ON CONFLICT (region_code, year) DO NOTHING;

-- ============================================================
-- Sanity assertion: 57 rows expected
-- ============================================================

DO $$
DECLARE
  cnt INT;
BEGIN
  SELECT COUNT(*) INTO cnt FROM public.election_cycles WHERE year = 2026;
  IF cnt < 57 THEN
    RAISE EXCEPTION 'election_cycles seed expected >= 57 rows for 2026, got %', cnt;
  END IF;
END $$;
