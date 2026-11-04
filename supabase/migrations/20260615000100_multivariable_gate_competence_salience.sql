-- Bias-control gate, signal-to-axis maps, office-competence bridge, and
-- jurisdiction-salience tables (doc 09 Parts 4.2 and 4.3), 2026-06-14.
--
-- Three concerns:
--   1. The graduation gate: a signal type may move a match score only after it
--      passes bias control (mirror symmetry, cross-ideology IRR, false-position
--      audit). Every signal type starts 'informational'. (doc 09 Part 2.5)
--   2. The signal-to-axis maps: the human-reviewed, versioned inference that
--      turns a vote/endorsement into a coordinate, so the inference is auditable
--      rather than a partisan guess. (doc 09 Part 2.4)
--   3. Competence bridge + jurisdiction salience: which axes an office can affect
--      (mask) and how loudly an axis counts where the race happens (weight),
--      finally wiring the dead editorial_salience dial. (doc 09 Part 3)
--
-- Reuses the existing enums policy_authority_domain_t and authority_mode_t from
-- 20260526220000_office_scope_schema.sql. axis_id is polymorphic (backbone or
-- proposition) so it carries no single FK; axis_kind disambiguates.

-- ── GRADUATION GATE (doc 09 Part 2.5) ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS signal_type_axis_gate (
  signal_type         TEXT NOT NULL,   -- 'statement','vote','sponsorship','donation','endorsement','prior_record','non_action'
  axis_family         TEXT NOT NULL,   -- a backbone code, a domain slug, or the literal 'all'
  axis_family_kind    TEXT NOT NULL DEFAULT 'all'
                        CHECK (axis_family_kind IN ('backbone','domain','all')),  -- red-team m3: grain discriminator
  calibration_version TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'informational'
                        CHECK (status IN ('informational','strength_only','direction_licensed')),
  mirror_symmetry     NUMERIC,         -- recorded test metrics (doc 09 Part 2.5)
  cross_ideology_irr  NUMERIC,
  false_position_rate NUMERIC,
  decided_by          TEXT,
  decided_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (signal_type, axis_family, calibration_version)
);
COMMENT ON TABLE signal_type_axis_gate IS
  'Per (signal_type, axis_family, calibration_version): may this signal type move a score? The resolver reads this; lookup precedence is most-specific-first (backbone code, then domain, then all). Lowering a gate is a deliberate, logged, reviewed action.';

-- ── SIGNAL-TO-AXIS MAPS (doc 09 Part 2.4): the inference made auditable ─────

CREATE TABLE IF NOT EXISTS bill_axis_map (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id              TEXT NOT NULL,
  axis_kind            TEXT NOT NULL CHECK (axis_kind IN ('sub_dimension','backbone','proposition')),
  axis_id              UUID,
  sub_dimension_id     UUID NOT NULL REFERENCES sub_dimensions(id) ON DELETE CASCADE,
  yea_direction        NUMERIC CHECK (yea_direction BETWEEN 0 AND 1),       -- direction a 'yea' implies on this axis
  implication_strength NUMERIC CHECK (implication_strength BETWEEN 0 AND 1),
  reviewed_by          TEXT,
  citation             TEXT,
  calibration_version  TEXT NOT NULL DEFAULT 'rubric-v1'
);
-- Natural-key uniqueness over (bill_id, axis_kind, sub_dimension_id, axis_id).
-- axis_id is nullable (null = primary axis); COALESCE to a sentinel UUID so two
-- primary-axis rows for the same bill/sub_dimension cannot both be inserted.
CREATE UNIQUE INDEX IF NOT EXISTS bill_axis_map_natkey_uidx
  ON bill_axis_map (bill_id, axis_kind, sub_dimension_id, COALESCE(axis_id, '00000000-0000-0000-0000-000000000000'::uuid));
COMMENT ON TABLE bill_axis_map IS
  'Reviewed, versioned mapping from a bill to the axes a yes/no vote bears on (doc 09 Part 2.4). An unmapped bill licenses nothing. Subject to per-map IRR audit (doc 09 Part 2.5). org_stance_map and donee_axis_map share this shape and are created only if/when those signal types graduate.';

-- ── COMPETENCE BRIDGE (doc 09 Part 3.2): which authority an axis requires ───

CREATE TABLE IF NOT EXISTS axis_authority_map (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  axis_kind                 TEXT NOT NULL CHECK (axis_kind IN ('sub_dimension','backbone','proposition')),
  axis_id                   UUID,
  sub_dimension_id          UUID NOT NULL REFERENCES sub_dimensions(id) ON DELETE CASCADE,
  required_authority_domain policy_authority_domain_t NOT NULL,  -- reuse existing enum
  authority_subdomain       TEXT,             -- red-team C3: finer than the enum (e.g. 'water' under health_environment/utilities)
  min_authority_mode        authority_mode_t, -- the mode at/above which the axis is fully matching-relevant; weaker modes => indirect (down-weight)
  reviewed_by               TEXT,
  citation                  TEXT
);
-- Natural-key uniqueness over (axis_kind, sub_dimension_id, axis_id,
-- required_authority_domain, authority_subdomain). axis_id and
-- authority_subdomain are both nullable; COALESCE each to a sentinel so null
-- rows cannot duplicate (a primary axis with no subdomain is one logical row).
CREATE UNIQUE INDEX IF NOT EXISTS axis_authority_map_natkey_uidx
  ON axis_authority_map (
    axis_kind,
    sub_dimension_id,
    COALESCE(axis_id, '00000000-0000-0000-0000-000000000000'::uuid),
    required_authority_domain,
    COALESCE(authority_subdomain, '')
  );
COMMENT ON TABLE axis_authority_map IS
  'Maps an axis to the authority domain(s) (and finer subdomain) an office must hold for the axis to be matching-relevant (doc 09 Part 3.2). office_types.relevant_dimensions becomes a derived cache from this JOIN the office policy_authority_domains_v1. An office whose authority_mode for the domain is weaker than min_authority_mode is INDIRECT: the axis is down-weighted, not dropped (the governor-veto case).';

-- ── JURISDICTION SALIENCE (doc 09 Part 3.3): the dead dial, now wired ───────

CREATE TABLE IF NOT EXISTS regional_clusters (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          TEXT UNIQUE NOT NULL,        -- 'western_water','coastal_climate',...
  display_label TEXT NOT NULL,
  member_states TEXT[] NOT NULL,             -- USPS codes; Utah in 'western_water', Maine not
  description   TEXT
);
COMMENT ON TABLE regional_clusters IS
  'Doc 05 regional clusters, finally migrated. Membership raises the salience of a cluster signature axis for member states (doc 09 Part 3.3). This is the mechanism that makes "water matters in Utah, not Maine" a data fact.';

CREATE TABLE IF NOT EXISTS cluster_axis_salience (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cluster_id        UUID NOT NULL REFERENCES regional_clusters(id) ON DELETE CASCADE,
  axis_kind         TEXT NOT NULL CHECK (axis_kind IN ('sub_dimension','backbone','proposition')),
  axis_id           UUID,
  sub_dimension_id  UUID NOT NULL REFERENCES sub_dimensions(id) ON DELETE CASCADE,
  salience_modifier NUMERIC NOT NULL CHECK (salience_modifier BETWEEN 0 AND 1),
  rationale         TEXT NOT NULL,           -- required, like editorial_salience's salience_rationale
  citation          TEXT
);
-- Natural-key uniqueness over (cluster_id, axis_kind, sub_dimension_id, axis_id).
-- axis_id is nullable (null = primary axis); COALESCE to a sentinel so a primary
-- axis row for a cluster/sub_dimension cannot be duplicated.
CREATE UNIQUE INDEX IF NOT EXISTS cluster_axis_salience_natkey_uidx
  ON cluster_axis_salience (cluster_id, axis_kind, sub_dimension_id, COALESCE(axis_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE TABLE IF NOT EXISTS jurisdiction_axis_salience (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  jurisdiction_id   UUID NOT NULL,           -- references the jurisdictions/offices graph
  axis_kind         TEXT NOT NULL CHECK (axis_kind IN ('sub_dimension','backbone','proposition')),
  axis_id           UUID,
  sub_dimension_id  UUID NOT NULL REFERENCES sub_dimensions(id) ON DELETE CASCADE,
  salience          NUMERIC NOT NULL CHECK (salience BETWEEN 0 AND 1),
  rationale         TEXT NOT NULL,
  citation          TEXT
);
-- Natural-key uniqueness over (jurisdiction_id, axis_kind, sub_dimension_id,
-- axis_id). axis_id is nullable (null = primary axis); COALESCE to a sentinel so
-- a primary axis row for a jurisdiction/sub_dimension cannot be duplicated.
CREATE UNIQUE INDEX IF NOT EXISTS jurisdiction_axis_salience_natkey_uidx
  ON jurisdiction_axis_salience (jurisdiction_id, axis_kind, sub_dimension_id, COALESCE(axis_id, '00000000-0000-0000-0000-000000000000'::uuid));
COMMENT ON TABLE jurisdiction_axis_salience IS
  'Optional finer per-jurisdiction salience override when a regional cluster is too coarse (doc 09 Part 3.3). Salience says how loudly an axis counts, NEVER which direction; direction lives on positions.';

-- ── RLS ────────────────────────────────────────────────────────────────────
-- Voter-facing config (authority + salience + clusters) is public-read.
-- Score-moving internals (gate, bill_axis_map) are service-role only.

ALTER TABLE signal_type_axis_gate ENABLE ROW LEVEL SECURITY;   -- no SELECT policy: service-role only
ALTER TABLE signal_type_axis_gate FORCE ROW LEVEL SECURITY;    -- table owner must not bypass RLS (S-1)
ALTER TABLE bill_axis_map ENABLE ROW LEVEL SECURITY;           -- no SELECT policy: service-role only
ALTER TABLE bill_axis_map FORCE ROW LEVEL SECURITY;            -- table owner must not bypass RLS (S-1)

ALTER TABLE axis_authority_map ENABLE ROW LEVEL SECURITY;
ALTER TABLE regional_clusters ENABLE ROW LEVEL SECURITY;
ALTER TABLE cluster_axis_salience ENABLE ROW LEVEL SECURITY;
ALTER TABLE jurisdiction_axis_salience ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS axis_authority_map_public_read ON axis_authority_map;
CREATE POLICY axis_authority_map_public_read ON axis_authority_map FOR SELECT USING (true);
DROP POLICY IF EXISTS regional_clusters_public_read ON regional_clusters;
CREATE POLICY regional_clusters_public_read ON regional_clusters FOR SELECT USING (true);
DROP POLICY IF EXISTS cluster_axis_salience_public_read ON cluster_axis_salience;
CREATE POLICY cluster_axis_salience_public_read ON cluster_axis_salience FOR SELECT USING (true);
DROP POLICY IF EXISTS jurisdiction_axis_salience_public_read ON jurisdiction_axis_salience;
CREATE POLICY jurisdiction_axis_salience_public_read ON jurisdiction_axis_salience FOR SELECT USING (true);
-- Writes everywhere are service-role only (service role bypasses RLS). This sets
-- the public-read / service-role split that 08c calls for, but it does NOT by
-- itself satisfy 08c's computational firewall: the automated billing-isolation
-- firewall TEST that 08c requires (proving the voter-facing scoring path cannot
-- read billing state) does NOT exist yet. That test is a launch gate and is NOT
-- satisfied here.

CREATE INDEX IF NOT EXISTS idx_bill_axis_map_sub_dim ON bill_axis_map (sub_dimension_id);
CREATE INDEX IF NOT EXISTS idx_axis_authority_map_domain ON axis_authority_map (required_authority_domain, authority_subdomain);
CREATE INDEX IF NOT EXISTS idx_cluster_axis_salience_sub_dim ON cluster_axis_salience (sub_dimension_id);
