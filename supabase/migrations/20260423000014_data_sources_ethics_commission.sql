-- ============================================================
-- Expand data_sources.source_type to include 'ethics_commission'
-- ============================================================
--
-- Several state CF regulators are ethics commissions (not SoS):
-- AK APOC, GA Ethics Commission, TX Ethics Commission, WI Ethics
-- Commission, etc. F1a/F1b/F1c state-CF adapters declare this as
-- a valid source_type in TS; the DB enum needed to catch up.
-- ============================================================

ALTER TABLE data_sources DROP CONSTRAINT IF EXISTS data_sources_source_type_check;
ALTER TABLE data_sources
  ADD CONSTRAINT data_sources_source_type_check
  CHECK (source_type IN (
    'sos_results_api',
    'sos_candidate_filing',
    'sos_campaign_finance',
    'ethics_commission',           -- NEW: state ethics commissions (CF regulators that aren't SoS)
    'federal_api',
    'federal_vote_record',
    'census_tiger',
    'census_geocoder',
    'redistricting_data_hub',
    'state_gis_portal',
    'county_gis_portal',
    'openstates',
    'ballot_measure_official',
    'newspaper_editorial',
    'editorial_rss',
    'wayback_snapshot',
    'campaign_website',
    'candidate_questionnaire',
    'ai_extraction',
    'manual_entry',
    'state_legislature_api',       -- NEW: per-state legislator-votes (F2 adapters)
    'other'
  ));

COMMENT ON CONSTRAINT data_sources_source_type_check ON data_sources IS
  'Expanded 2026-04-23 to include ethics_commission (F1 state-CF adapters) and '
  'state_legislature_api (F2 state-votes adapters).';
