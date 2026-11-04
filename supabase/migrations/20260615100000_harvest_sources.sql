-- =============================================================================
-- 20260615100000_harvest_sources.sql
--
-- Phase 0 of the source-centric harvest engine: the SHARED registry of "fetched
-- once, attributed to many" inputs, plus the back-pointer that lets an attributed
-- piece of evidence trace to the shared source it came from.
--
-- THE CONCEPT (see 12-positioning-engine/13-harvest-buildout-plan.md):
--   Most candidate-coverage sources are ONE-SOURCE-TO-MANY-CANDIDATES. A single
--   forum video covers a whole race; a voter guide covers a contest; an
--   endorsement page lists everyone an org backed; a finance / voting bulk file
--   covers thousands. So we fetch the source ONCE, find every candidate it
--   covers, and attribute the extracted material to each. harvest_sources is the
--   catalog of those shared inputs; raw_evidence.harvest_source_id is how an
--   attributed (or held-unattributed) piece points back to its shared source.
--
-- This migration is ADDITIVE and REVERSIBLE: it creates one new table, adds one
-- nullable column to raw_evidence (existing rows stay NULL), and enables
-- service-role-only RLS (Row Level Security) on the new table, mirroring
-- dedup_review_queue / do_not_merge / merge_audit. No existing column or table is
-- altered in a breaking way. The provenance jsonb on raw_evidence already holds
-- arbitrary keys, so an attributed item's "locus" (a video timestamp range, a
-- guide section, a scorecard row) is stored under provenance.locus with NO schema
-- change.
--
-- No em-dashes / en-dashes. Acronyms spelled out on first use.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- harvest_sources -- the catalog of "sourced once" inputs.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.harvest_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The kind of one-to-many source. Constrained so each later harvester (Builds
  -- 1 through 5) registers under a known type and the generic runner can pick the
  -- right pluggable parser by source_type:
  --   forum_video        -- a candidate forum / debate recording (Build 1)
  --   news_guide         -- a local-news candidate Q&A / voter guide page (Build 3)
  --   endorsement_org    -- an interest-group endorsement / scorecard page (Build 2)
  --   party_slate        -- a party / issue slate or sample-ballot card (Tier 3)
  --   finance_bulk       -- a campaign-finance bulk file / portal (Build 5)
  --   legislative_record -- a legislator vote / sponsorship bulk record (Build 4)
  source_type TEXT NOT NULL CHECK (source_type IN (
    'forum_video',
    'news_guide',
    'endorsement_org',
    'party_slate',
    'finance_bulk',
    'legislative_record'
  )),

  -- WHERE the source lives. A source may be addressed by a direct url, by a
  -- channel reference (e.g. a YouTube channel id for ongoing forum harvests), or
  -- by a handle (e.g. an org's account). At least one is expected in practice but
  -- none is enforced NOT NULL, so a source can be registered before its address
  -- is fully known.
  url TEXT,
  channel_ref TEXT,
  handle TEXT,

  -- The JURISDICTION + CYCLE + OFFICE SCOPE that constrains in-document candidate
  -- resolution. A source covers a specific race / contest, so a name in the
  -- document only has to resolve against the 2 to 4 candidacies actually in that
  -- race. The jurisdiction may be given as a direct office-graph reference
  -- (jurisdiction_id) and/or as FIPS (Federal Information Processing Standards)
  -- codes for state / county / place, whichever the registrar has. office_hint is
  -- a free-text office name / pattern (e.g. "County Commission", "Mayor") used to
  -- narrow the roster to the right offices within the jurisdiction.
  jurisdiction_id UUID REFERENCES public.jurisdictions(id) ON DELETE SET NULL,
  fips_state TEXT,
  fips_county TEXT,
  fips_place TEXT,
  office_hint TEXT,
  election_cycle TEXT,

  -- How often this source is re-harvested ('once' | 'daily' | 'weekly' | ...),
  -- free text so each harvester sets its own cadence vocabulary.
  cadence TEXT,

  -- 'active' sources are eligible for harvesting; others ('paused', 'retired',
  -- 'broken') are skipped. Free text with an 'active' default.
  status TEXT NOT NULL DEFAULT 'active',

  -- Stamped by the runner each time the source is harvested (apply mode only).
  last_harvested_at TIMESTAMPTZ,

  -- Per-source extra: parser config, discovery provenance, notes, etc.
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- A source is identified by its type + url. Re-registering the same (type, url)
  -- is an idempotent no-op / update rather than a duplicate. NULL url is allowed
  -- (channel / handle addressed sources); Postgres treats NULL as distinct in a
  -- UNIQUE, so two channel-only rows of the same type can both exist, which is the
  -- intended behavior (the registrar dedups those by channel_ref in application
  -- code when needed).
  UNIQUE (source_type, url)
);

-- Hot paths: "list active sources to harvest", "all sources of a type", and
-- "sources in a state / county" for scoped harvest runs.
CREATE INDEX IF NOT EXISTS idx_harvest_sources_status
  ON public.harvest_sources (status);
CREATE INDEX IF NOT EXISTS idx_harvest_sources_type
  ON public.harvest_sources (source_type);
CREATE INDEX IF NOT EXISTS idx_harvest_sources_fips
  ON public.harvest_sources (fips_state, fips_county);

COMMENT ON TABLE public.harvest_sources IS
  'Phase 0 registry of source-centric harvest inputs (fetched once, attributed '
  'to many candidates). source_type selects the pluggable parser; the '
  'jurisdiction + FIPS + office_hint + election_cycle scope constrains '
  'in-document candidate resolution to the race roster. Builds 1 to 5 register '
  'rows here and add a SourceParser; the generic runner consumes them.';

COMMENT ON COLUMN public.harvest_sources.office_hint IS
  'Free-text office name / pattern used to narrow the race roster to the right '
  'offices within the jurisdiction (e.g. "County Commission", "Mayor").';

-- -----------------------------------------------------------------------------
-- raw_evidence.harvest_source_id -- back-pointer to the shared source.
--
-- An attributed item (person_id set) AND a held-unattributed item (person_id
-- NULL, mention could not be safely resolved) both point back to the
-- harvest_source they came from. This is what powers the digital-footprint
-- product ("found in: <outlet> voter guide, <org> endorsement, <forum> at
-- 14:32") and lets a reviewer see every item a single source produced. Nullable;
-- existing rows (campaign-site / social ingest from raw-ingest) stay NULL.
-- ON DELETE SET NULL so removing a source never deletes the evidence it sourced.
-- -----------------------------------------------------------------------------
ALTER TABLE public.raw_evidence
  ADD COLUMN IF NOT EXISTS harvest_source_id UUID
    REFERENCES public.harvest_sources(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_raw_evidence_harvest_source
  ON public.raw_evidence (harvest_source_id)
  WHERE harvest_source_id IS NOT NULL;

COMMENT ON COLUMN public.raw_evidence.harvest_source_id IS
  'Back-pointer to the shared harvest_sources row this evidence was attributed '
  'from (one source -> many candidates). NULL for per-candidate ingest '
  '(campaign site / social). provenance.locus carries the exact location within '
  'the source (video timestamp range, guide section, scorecard row).';

-- -----------------------------------------------------------------------------
-- RLS: service-role-only, mirroring dedup_review_queue / do_not_merge / merge_audit.
-- Enabling RLS with NO public policies means anon / authenticated roles get no
-- rows; the service role bypasses RLS and the admin layer is gated by users.role.
-- -----------------------------------------------------------------------------
ALTER TABLE public.harvest_sources ENABLE ROW LEVEL SECURITY;

-- =============================================================================
-- REVERSAL (manual, if ever needed):
--   DROP INDEX IF EXISTS public.idx_raw_evidence_harvest_source;
--   ALTER TABLE public.raw_evidence DROP COLUMN IF EXISTS harvest_source_id;
--   DROP TABLE IF EXISTS public.harvest_sources;  -- ON DELETE SET NULL on the
--     FK means dropping the table after dropping the column is clean.
-- =============================================================================
