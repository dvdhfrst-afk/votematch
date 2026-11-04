-- =============================================================================
-- adapter_status: add state_fips for exact-tuple skip checks
--
-- Council finding #4 (continuous-ingest substring collision): the previous
-- implementation skipped adapters whose `adapter_name` happened to contain
-- another state's lowercase code as a substring (e.g. `state='IN'` matched
-- adapters with `-in-`, `printing`, etc.). Fix is to track the broken-adapter
-- set as `(adapter_name, state_fips)` tuples and compare on exact equality.
--
-- This migration adds the column + a best-effort backfill from adapter_name
-- parsing. The column is nullable because some adapters are national-scope
-- (no state_fips) — those rows simply have NULL.
-- =============================================================================

ALTER TABLE adapter_status
  ADD COLUMN IF NOT EXISTS state_fips CHAR(2);

CREATE INDEX IF NOT EXISTS idx_adapter_status_state_fips
  ON adapter_status (state_fips)
  WHERE state_fips IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Backfill state_fips from adapter_name. Adapter names follow loose
-- conventions like:
--   cf-<state>-<source>            e.g. cf-ut-utah-disclosures
--   <kind>-<state>                 e.g. ballot-measures-co
--   sos-<state>-<…>                e.g. sos-oh-results
--   state-cf-<state>-…             e.g. state-cf-ny-elections
-- We extract the first 2-letter state-code-looking token and map it to FIPS.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  state_to_fips CONSTANT JSONB := '{
    "al":"01","ak":"02","az":"04","ar":"05","ca":"06","co":"08","ct":"09",
    "de":"10","fl":"12","ga":"13","hi":"15","id":"16","il":"17","in":"18",
    "ia":"19","ks":"20","ky":"21","la":"22","me":"23","md":"24","ma":"25",
    "mi":"26","mn":"27","ms":"28","mo":"29","mt":"30","ne":"31","nv":"32",
    "nh":"33","nj":"34","nm":"35","ny":"36","nc":"37","nd":"38","oh":"39",
    "ok":"40","or":"41","pa":"42","ri":"44","sc":"45","sd":"46","tn":"47",
    "tx":"48","ut":"49","vt":"50","va":"51","wa":"53","wv":"54","wi":"55",
    "wy":"56","dc":"11"
  }'::jsonb;
  r RECORD;
  tok TEXT;
  matched TEXT;
BEGIN
  FOR r IN SELECT adapter_name FROM adapter_status WHERE state_fips IS NULL LOOP
    matched := NULL;
    -- Try each 2-letter token between dashes/underscores in the name
    FOR tok IN
      SELECT lower(t)
        FROM regexp_split_to_table(r.adapter_name, '[-_/]') t
       WHERE length(t) = 2
    LOOP
      IF state_to_fips ? tok THEN
        matched := state_to_fips ->> tok;
        EXIT;
      END IF;
    END LOOP;
    IF matched IS NOT NULL THEN
      UPDATE adapter_status SET state_fips = matched WHERE adapter_name = r.adapter_name;
    END IF;
  END LOOP;
END $$;
