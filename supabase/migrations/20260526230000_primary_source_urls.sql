-- primary_source_urls: the discovery layer for "where does the .gov roster
-- for body X live." Populated from Wikidata SPARQL (P856 = official website)
-- with manual + NCES fallback for gaps. Templates inject these URLs into
-- the agent's prompt so the agent NEVER has to guess from memorized URLs.
--
-- Source of truth is still the .gov page itself — this table just tells
-- the agent which URL to fetch.

CREATE TABLE primary_source_urls (
  id                  serial PRIMARY KEY,
  body_kind           text NOT NULL,            -- 'state_legislative_upper', 'state_supreme_court', etc.
  jurisdiction_name   text NOT NULL,            -- 'Vermont', 'Salt Lake County', 'Salt Lake City', etc.
  state_fips          text,                     -- '50' for Vermont
  county_fips         text,                     -- for county/municipal bodies
  gnis_id             text,                     -- GNIS feature id for municipalities (where available)
  wikidata_qid        text,                     -- Q19207 for Vermont Senate
  primary_url         text NOT NULL,            -- the canonical .gov URL the agent fetches
  url_kind            text NOT NULL DEFAULT 'roster',  -- 'roster' | 'charter' | 'statute' | 'home'
  source              text NOT NULL,            -- 'wikidata' | 'nces' | 'manual' | 'state_register'
  source_fetched_at   timestamptz,
  verified_resolves   boolean,                  -- nightly cron probes the URL
  last_resolve_check  timestamptz,
  notes               text,
  UNIQUE (body_kind, jurisdiction_name, primary_url)
);

CREATE INDEX idx_primary_source_urls_lookup
  ON primary_source_urls (body_kind, jurisdiction_name);
CREATE INDEX idx_primary_source_urls_state
  ON primary_source_urls (state_fips, body_kind)
  WHERE state_fips IS NOT NULL;
CREATE INDEX idx_primary_source_urls_wikidata
  ON primary_source_urls (wikidata_qid)
  WHERE wikidata_qid IS NOT NULL;

COMMENT ON TABLE primary_source_urls IS
  'Wikidata-sourced (and manually filled) URL map: body → its primary .gov source URL. Templates inject these into agent prompts so the agent does not guess from memory.';
COMMENT ON COLUMN primary_source_urls.url_kind IS
  'What this URL points at: roster (member list), charter (city charter PDF), statute (state code), home (root .gov).';
