-- ============================================================
-- Parties, fusion ballot lines, and candidacy status history
-- ============================================================
--
-- Three related changes:
--
-- 1. parties table: state-scoped party directory. The Libertarian
--    Party of Utah is a distinct row from the Libertarian Party of
--    Oregon under ballot-access law. National-level references
--    (e.g., "the national Democratic Party") use state_fips IS NULL.
--
-- 2. candidacy_party_lines: a candidacy can appear on multiple
--    party lines (fusion voting in NY, CT, SC, VT). Schema must
--    represent the ballot as printed, not flatten it to one party.
--
-- 3. candidacy_status_changes: audit log of every candidacy
--    status transition, with reason + source. Drives the UI "this
--    candidate withdrew on X, reason Y" disclosure.
--
-- Why NOW: Item 1 advancement pipeline needs party-scoped
-- winners (top Republican + top Democrat from a partisan primary).
-- Without normalized parties, advancement logic has to regex-match
-- "REP" vs "Republican" vs "R" — brittle.
--
-- Why TEXT + CHECK instead of ENUM: same reasoning as Item 5.
-- Postgres enums are add-only and can't be cleanly refactored.
--
-- The existing candidacies.party text column STAYS populated for
-- back-compat. The new FK candidacies.primary_party_id (via
-- candidacy_party_lines) is the new source of truth.
-- ============================================================

-- ============================================================
-- 1. parties directory
-- ============================================================

CREATE TABLE IF NOT EXISTS parties (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Scoping
  state_fips CHAR(2),                          -- NULL = national reference row
  abbreviation TEXT NOT NULL,                  -- 'D', 'R', 'L', 'G', 'WFP', 'DFL', etc.
  normalized_name TEXT NOT NULL,               -- 'Democratic Party', 'Republican Party'
  display_name TEXT NOT NULL,                  -- 'Democratic-Farmer-Labor Party' (MN-specific)

  -- Classification
  party_family TEXT CHECK (party_family IN (
    'democratic',         -- D + state affiliates (DFL MN, NPL ND-D, etc.)
    'republican',          -- R + state affiliates
    'libertarian',
    'green',
    'constitution',
    'independent',         -- generic independent / unaffiliated
    'independence_nominal',-- state-specific independence parties
    'working_families',
    'progressive',
    'socialist',
    'reform',
    'forward',
    'no_labels',
    'write_in',            -- write-in "party" placeholder
    'nonpartisan',         -- for nonpartisan races
    'other'
  )),

  -- Ballot access
  is_major_in_state BOOLEAN NOT NULL DEFAULT FALSE,
  ballot_access_status TEXT CHECK (ballot_access_status IS NULL OR ballot_access_status IN (
    'qualified',                    -- has automatic ballot access this cycle
    'petition_required',            -- must petition per-race for access
    'write_in_only',                -- no ballot line, write-in only
    'not_qualified',                -- no access in this state this cycle
    'recognized_without_access'     -- recognized party but no 2026 access
  )),

  -- Relationships
  national_affiliate_id UUID REFERENCES parties(id) ON DELETE SET NULL,  -- state row → national row
  aliases TEXT[] NOT NULL DEFAULT '{}',        -- known string variants ('DEM', 'Dem', 'Democrat', 'Dems')

  -- Display
  color_hex TEXT,                              -- e.g. '#0044AA' — display accent
  color_hex_accessible TEXT,                   -- WCAG AA contrast-safe variant

  -- Provenance
  rule_citation TEXT,                          -- URL / statute establishing recognition
  data_source_id UUID REFERENCES data_sources(id) ON DELETE SET NULL,

  meta JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- State-scoped uniqueness: (state_fips, abbreviation) is the primary lookup key.
-- NULLS NOT DISTINCT so two national-level rows (state_fips IS NULL) with same
-- abbreviation collide instead of silently duplicating.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_parties_state_abbr
  ON parties (state_fips, abbreviation) NULLS NOT DISTINCT;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_parties_state_normname
  ON parties (state_fips, normalized_name) NULLS NOT DISTINCT;

CREATE INDEX IF NOT EXISTS idx_parties_family ON parties (party_family);
CREATE INDEX IF NOT EXISTS idx_parties_aliases ON parties USING GIN (aliases);
CREATE INDEX IF NOT EXISTS idx_parties_national_affiliate ON parties (national_affiliate_id)
  WHERE national_affiliate_id IS NOT NULL;

ALTER TABLE parties ENABLE ROW LEVEL SECURITY;
CREATE POLICY parties_public_read ON parties FOR SELECT USING (true);

-- Trigger to bump updated_at
CREATE OR REPLACE FUNCTION parties_bump_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_parties_bump_updated_at
  BEFORE UPDATE ON parties FOR EACH ROW EXECUTE FUNCTION parties_bump_updated_at();

-- ============================================================
-- 2. Seed national-level parties (state_fips IS NULL)
-- ============================================================

INSERT INTO parties (state_fips, abbreviation, normalized_name, display_name, party_family, aliases, is_major_in_state)
VALUES
  (NULL, 'D',  'Democratic Party',      'Democratic Party',        'democratic',    ARRAY['DEM','Dem','Democrat','Democratic','Dems'], TRUE),
  (NULL, 'R',  'Republican Party',      'Republican Party',        'republican',    ARRAY['REP','Rep','Republican','GOP','Repub'], TRUE),
  (NULL, 'L',  'Libertarian Party',     'Libertarian Party',       'libertarian',   ARRAY['LIB','Lib','Libertarian'], FALSE),
  (NULL, 'G',  'Green Party',           'Green Party',             'green',         ARRAY['GRE','GRN','Green'], FALSE),
  (NULL, 'CON','Constitution Party',    'Constitution Party',      'constitution',  ARRAY['Constitution','CST'], FALSE),
  (NULL, 'I',  'Independent',           'Independent',             'independent',   ARRAY['IND','Ind','Independent','Unaffiliated','UN'], FALSE),
  (NULL, 'WF', 'Working Families Party','Working Families Party',  'working_families', ARRAY['WFP','Working Families'], FALSE),
  (NULL, 'NL', 'No Labels',             'No Labels',               'no_labels',     ARRAY['NL','No Labels'], FALSE),
  (NULL, 'FW', 'Forward Party',         'Forward Party',           'forward',       ARRAY['FWD','Forward'], FALSE),
  (NULL, 'NP', 'Nonpartisan',           'Nonpartisan',             'nonpartisan',   ARRAY['NP','Nonpartisan','Non-Partisan'], FALSE),
  (NULL, 'WI', 'Write-In',              'Write-In',                'write_in',      ARRAY['WI','Write-in','Write-In','write-in'], FALSE),
  (NULL, 'NPA','No Party Preference',   'No Party Preference',     'independent',   ARRAY['NPA','NPP','No Party Preference','Decline to State','DTS'], FALSE),
  (NULL, 'OTH','Other',                 'Other',                   'other',         ARRAY['OTH','Unknown','Other'], FALSE)
ON CONFLICT DO NOTHING;

-- ============================================================
-- 3. candidacy_party_lines — fusion-ready ballot representation
-- ============================================================

CREATE TABLE IF NOT EXISTS candidacy_party_lines (
  candidacy_id UUID NOT NULL REFERENCES candidacies(id) ON DELETE CASCADE,
  party_id UUID NOT NULL REFERENCES parties(id) ON DELETE RESTRICT,

  ballot_line_order INT NOT NULL DEFAULT 1,    -- 1 = primary/first line; fusion → 2, 3, etc.
  nomination_method TEXT CHECK (nomination_method IN (
    'primary',                    -- won a partisan primary
    'convention',                 -- nominated at party convention (UT SB54 convention path, VA)
    'committee_appointment',      -- party committee filled a vacancy
    'petition',                   -- qualified via signature petition
    'self_nomination',            -- independent self-nomination
    'cross_endorsement',          -- fusion: endorsed by this party without separate nomination
    'write_in_registration',      -- certified write-in candidate
    'automatic_nonpartisan',      -- nonpartisan race, no nomination needed
    'jungle_blanket',             -- LA-style: candidate just files with a party label
    'unknown'
  )),

  qualified_on DATE,                            -- when this line was finalized on the ballot
  data_source_id UUID REFERENCES data_sources(id) ON DELETE SET NULL,
  meta JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (candidacy_id, party_id)
);

CREATE INDEX IF NOT EXISTS idx_cpl_candidacy ON candidacy_party_lines (candidacy_id);
CREATE INDEX IF NOT EXISTS idx_cpl_party ON candidacy_party_lines (party_id);
CREATE INDEX IF NOT EXISTS idx_cpl_order ON candidacy_party_lines (candidacy_id, ballot_line_order);

ALTER TABLE candidacy_party_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY cpl_public_read ON candidacy_party_lines FOR SELECT USING (true);

COMMENT ON TABLE candidacy_party_lines IS
  'A candidacy can appear on 1-N party lines. Standard case: 1 row per candidacy. '
  'Fusion cases (NY, CT, SC, VT): multiple rows. ballot_line_order=1 is the primary line. '
  'Item 1 advancement pipeline uses (candidacy_id, party_id) where ballot_line_order=1 '
  'to determine "winner per party" in partisan primaries.';

-- ============================================================
-- 4. candidacies: add primary_party_id denormalized FK
--
-- This is the "main" party for the candidacy (ballot_line_order=1).
-- Denormalized for join performance in the materialized view (Item 8).
-- Kept in sync with candidacy_party_lines via trigger.
-- ============================================================

ALTER TABLE candidacies
  ADD COLUMN IF NOT EXISTS primary_party_id UUID REFERENCES parties(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_candidacies_primary_party
  ON candidacies (primary_party_id) WHERE primary_party_id IS NOT NULL;

-- Sync primary_party_id when candidacy_party_lines changes.
CREATE OR REPLACE FUNCTION sync_candidacy_primary_party() RETURNS TRIGGER AS $$
DECLARE
  v_candidacy_id UUID;
  v_new_primary UUID;
BEGIN
  v_candidacy_id := COALESCE(NEW.candidacy_id, OLD.candidacy_id);

  SELECT party_id INTO v_new_primary
  FROM candidacy_party_lines
  WHERE candidacy_id = v_candidacy_id
  ORDER BY ballot_line_order ASC, created_at ASC
  LIMIT 1;

  UPDATE candidacies SET primary_party_id = v_new_primary
  WHERE id = v_candidacy_id
    AND (primary_party_id IS DISTINCT FROM v_new_primary);

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_sync_candidacy_primary_party
  AFTER INSERT OR UPDATE OR DELETE ON candidacy_party_lines
  FOR EACH ROW EXECUTE FUNCTION sync_candidacy_primary_party();

-- ============================================================
-- 5. candidacy_status_changes — append-only audit log
-- ============================================================

CREATE TABLE IF NOT EXISTS candidacy_status_changes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  candidacy_id UUID NOT NULL REFERENCES candidacies(id) ON DELETE CASCADE,

  old_status TEXT,                             -- NULL for the initial row
  new_status TEXT NOT NULL,

  changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  effective_at TIMESTAMPTZ,                    -- when the change took effect in the real world
                                                -- (may differ from changed_at if we learned about it later)
  announced_at TIMESTAMPTZ,                    -- when publicly announced

  reason TEXT,                                 -- free-text note
  reason_category TEXT CHECK (reason_category IS NULL OR reason_category IN (
    'withdrew_voluntarily',
    'withdrew_for_other_office',
    'death',
    'disqualification_legal',
    'disqualification_filing_error',
    'court_order',
    'primary_outcome',                         -- won_primary / lost_primary
    'general_outcome',                         -- won_general / lost_general
    'advanced_to_runoff',
    'replaced_on_ballot',                      -- party committee substitution
    'data_correction',                         -- our mistake; audit note
    'other'
  )),

  source_url TEXT,                             -- e.g., news article announcing withdrawal
  data_source_id UUID REFERENCES data_sources(id) ON DELETE SET NULL,
  changed_by TEXT NOT NULL DEFAULT 'pipeline', -- 'pipeline' | 'admin' | 'candidate_claimed'
  meta JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_csc_candidacy ON candidacy_status_changes (candidacy_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_csc_new_status ON candidacy_status_changes (new_status, changed_at DESC);

ALTER TABLE candidacy_status_changes ENABLE ROW LEVEL SECURITY;
CREATE POLICY csc_public_read ON candidacy_status_changes FOR SELECT USING (true);

-- ============================================================
-- 6. Trigger: log candidacy.status changes
-- ============================================================

CREATE OR REPLACE FUNCTION log_candidacy_status_change() RETURNS TRIGGER AS $$
BEGIN
  -- Only log real transitions (IS DISTINCT FROM handles NULLs).
  IF (TG_OP = 'INSERT' AND NEW.status IS NOT NULL) THEN
    INSERT INTO candidacy_status_changes (
      candidacy_id, old_status, new_status, changed_by,
      meta
    ) VALUES (
      NEW.id, NULL, NEW.status, 'pipeline',
      jsonb_build_object('source', 'candidacy_insert')
    );
  ELSIF (TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status) THEN
    INSERT INTO candidacy_status_changes (
      candidacy_id, old_status, new_status, changed_by,
      meta
    ) VALUES (
      NEW.id, OLD.status, NEW.status, 'pipeline',
      jsonb_build_object('source', 'candidacy_update')
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Install trigger AFTER the initial backfill (next block).
-- That avoids duplicate initial-row inserts for existing rows.

-- ============================================================
-- 7. Backfill: write one "initial" row per existing candidacy
-- ============================================================

INSERT INTO candidacy_status_changes (candidacy_id, old_status, new_status, changed_at, changed_by, meta)
SELECT id, NULL, status, created_at, 'backfill',
       jsonb_build_object('source', 'backfill_20260423')
FROM candidacies
WHERE status IS NOT NULL
ON CONFLICT DO NOTHING;

-- Now attach the trigger — from here, all future status changes auto-log.
DROP TRIGGER IF EXISTS trg_log_candidacy_status_change ON candidacies;
CREATE TRIGGER trg_log_candidacy_status_change
  AFTER INSERT OR UPDATE OF status ON candidacies
  FOR EACH ROW EXECUTE FUNCTION log_candidacy_status_change();

-- ============================================================
-- 8. Documentation
-- ============================================================

COMMENT ON TABLE parties IS
  'State-scoped party directory. state_fips NULL = national reference row. '
  'Libertarian Party of Utah and Libertarian Party of Oregon are separate rows both '
  'linked to the national row via national_affiliate_id. aliases array covers known '
  'string variants ("DEM", "Dem", "Democrat") so legacy imports resolve cleanly.';

COMMENT ON COLUMN parties.aliases IS
  'String variants for import-time matching. Seed script looks up parties WHERE alias = ANY(aliases) OR abbreviation = alias.';

COMMENT ON TABLE candidacy_status_changes IS
  'Append-only audit log of candidacy.status transitions. Written by trg_log_candidacy_status_change. '
  'Sources transitions back to the pipeline or admin that made the change.';

COMMENT ON TRIGGER trg_log_candidacy_status_change ON candidacies IS
  'Auto-logs every candidacy.status transition to candidacy_status_changes. Installed AFTER '
  'the initial backfill that wrote one "initial" row per existing candidacy.';
