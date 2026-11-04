-- Council review 2026-04-17:
--   (B3) The existing source_type CHECK forces us to store state-profile
--   ingest as 'campaign_website', which is factually wrong and will poison
--   analytics. Add 'state_profile' for Utah EVI profiles (UCA 20A-7-801) and
--   other government-run candidate-profile aggregators.
--
--   (B4) The enumerator inserts candidate_sources without a uniqueness
--   guard, so a weekly schedule would append 12× duplicate rows per
--   candidate over a cycle. Add UNIQUE(candidate_id, source_type, url) so
--   upsert-on-conflict de-dups correctly.

ALTER TABLE candidate_sources DROP CONSTRAINT candidate_sources_source_type_check;

ALTER TABLE candidate_sources
  ADD CONSTRAINT candidate_sources_source_type_check
  CHECK (source_type IN (
    'campaign_website',
    'extracted_positions',
    'voting_record',
    'fec_financials',
    'news_article',
    'questionnaire',
    'state_profile'
  ));

-- Dedup any existing duplicates before adding the unique constraint.
-- Keeps the most recent row per (candidate_id, source_type, url).
DELETE FROM candidate_sources a
USING candidate_sources b
WHERE a.candidate_id = b.candidate_id
  AND a.source_type = b.source_type
  AND a.url = b.url
  AND a.url IS NOT NULL
  AND a.id < b.id;

-- The constraint is nullable-aware: (candidate_id, source_type, NULL) pairs
-- won't deduplicate because Postgres treats NULL != NULL. Intentional:
-- news_article rows without URL are rare and shouldn't be silently merged.
ALTER TABLE candidate_sources
  ADD CONSTRAINT candidate_sources_candidate_source_url_key
  UNIQUE (candidate_id, source_type, url);
