-- Track C: taxonomy governance workflow.
--
-- Proposals table + RPC for safely applying approved changes.
--
-- Design rationale with counter-arguments:
--
--   1. Why a DB table and not just git commits?
--      Proposals need to be renderable BEFORE approval — the transparency feature
--      is that users (and candidates) can see pending proposals during a
--      review window. Git history is private to operators; a table is public-read.
--
--   2. Why not enforce a 48-hour review period in SQL?
--      Rigid enforcement punishes legitimate emergency fixes (e.g., correcting a
--      factual error in a spectrum anchor that's misrepresenting candidates right
--      now). We track timestamps so norm violations are auditable but don't block.
--
--   3. Why two-step apply (approved → applied) instead of auto-applying on approval?
--      Automation removes a final sanity check. The RPC lets a human review the
--      diff one last time and catch typos or missing cascading updates.
--
--   4. Why a single proposals table with typed payloads rather than a table per
--      proposal type?
--      Schema simplicity. Proposal types proliferate over time (we've already got
--      7 types); a table per type would be onerous. Validation happens in the
--      apply RPC, not at the column level.

-- ============================================================
-- 1. Proposals table
-- ============================================================

CREATE TABLE taxonomy_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Who proposed this change. Plain text for MVP; swap to user_id FK when auth exists.
  proposer_name TEXT NOT NULL,

  -- What kind of change.
  proposal_type TEXT NOT NULL CHECK (proposal_type IN (
    'new_dim',          -- add a new sub_dimension
    'retire_dim',       -- deactivate an existing sub_dim (soft delete)
    'restore_dim',      -- reactivate a previously-deprecated sub_dim
    'reword_spectrum',  -- minor text change to spectrum_low / spectrum_high
    'change_scope',     -- change scope_applicability
    'change_regions',   -- change applicable_regions
    'change_salience',  -- change editorial_salience (+ rationale)
    'rename_dim',       -- change display name
    'change_domain'     -- move dim to a different domain
  )),

  -- Which existing dim this targets. NULL when proposal_type = 'new_dim'.
  target_sub_dimension_id UUID REFERENCES sub_dimensions(id) ON DELETE CASCADE,

  -- Proposed values, shape depends on proposal_type. Validated at apply time, not here.
  -- Examples:
  --   new_dim:          { "domain": "economy", "name": "trade_policy", "spectrum_low": "...",
  --                       "spectrum_high": "...", "scope_applicability": {...},
  --                       "applicable_regions": ["US"], "display_order": 20 }
  --   reword_spectrum:  { "spectrum_low": "new text" }  -- only touches provided keys
  --   change_scope:     { "scope_applicability": { "federal": "matching", ... } }
  --   retire_dim:       { "reason": "superseded by new_dim X" }
  payload JSONB NOT NULL,

  -- Required human explanation. Shown in the public proposal view.
  rationale TEXT NOT NULL,

  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft',           -- being written; not yet submitted
    'under_review',    -- submitted, publicly visible, awaiting decision
    'approved',        -- decision made; ready to apply but not yet executed
    'applied',         -- executed against sub_dimensions (terminal)
    'rejected',        -- decision negative (terminal)
    'withdrawn'        -- proposer withdrew before decision (terminal)
  )),

  -- Required when status = rejected
  decision_reason TEXT,

  submitted_at TIMESTAMPTZ,
  approved_at TIMESTAMPTZ,
  applied_at TIMESTAMPTZ,
  decision_at TIMESTAMPTZ,  -- set when rejected/withdrawn

  -- Who made the approve/reject decision. Plain text for MVP.
  decision_by TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_tax_proposals_status ON taxonomy_proposals (status, submitted_at DESC);
CREATE INDEX idx_tax_proposals_target ON taxonomy_proposals (target_sub_dimension_id);

-- Consistency rules enforced in-trigger (simpler than CHECK on multi-column logic)
CREATE OR REPLACE FUNCTION enforce_proposal_consistency()
RETURNS TRIGGER AS $$
BEGIN
  -- New-dim proposals don't target an existing dim
  IF NEW.proposal_type = 'new_dim' AND NEW.target_sub_dimension_id IS NOT NULL THEN
    RAISE EXCEPTION 'new_dim proposals must not specify target_sub_dimension_id';
  END IF;
  -- All other types do target an existing dim
  IF NEW.proposal_type != 'new_dim' AND NEW.target_sub_dimension_id IS NULL THEN
    RAISE EXCEPTION '% proposals require target_sub_dimension_id', NEW.proposal_type;
  END IF;

  -- Rejected proposals need a reason
  IF NEW.status = 'rejected' AND (NEW.decision_reason IS NULL OR NEW.decision_reason = '') THEN
    RAISE EXCEPTION 'rejected proposals require decision_reason';
  END IF;

  -- Draft → under_review sets submitted_at
  IF TG_OP = 'UPDATE' AND OLD.status = 'draft' AND NEW.status = 'under_review' THEN
    IF NEW.submitted_at IS NULL THEN
      NEW.submitted_at := now();
    END IF;
  END IF;

  -- under_review → approved sets approved_at
  IF TG_OP = 'UPDATE' AND OLD.status = 'under_review' AND NEW.status = 'approved' THEN
    IF NEW.approved_at IS NULL THEN
      NEW.approved_at := now();
    END IF;
  END IF;

  -- Any move to terminal (applied / rejected / withdrawn) sets decision_at if not set
  IF NEW.status IN ('rejected', 'withdrawn') AND NEW.decision_at IS NULL THEN
    NEW.decision_at := now();
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_enforce_proposal_consistency
  BEFORE INSERT OR UPDATE ON taxonomy_proposals
  FOR EACH ROW
  EXECUTE FUNCTION enforce_proposal_consistency();

-- ============================================================
-- 2. Apply RPC — moves approved proposals to applied, executing the change
-- ============================================================
--
-- Separate from trigger logic because applying involves writes to multiple tables
-- and should be callable explicitly from admin tooling (the "last sanity check").
-- Must be called from service_role context.

CREATE OR REPLACE FUNCTION apply_taxonomy_proposal(proposal_id UUID, applier TEXT)
RETURNS UUID AS $$
DECLARE
  p taxonomy_proposals%ROWTYPE;
  new_dim_id UUID;
  payload JSONB;
BEGIN
  SELECT * INTO p FROM taxonomy_proposals WHERE id = proposal_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Proposal % not found', proposal_id;
  END IF;
  IF p.status != 'approved' THEN
    RAISE EXCEPTION 'Proposal % has status %, expected approved', proposal_id, p.status;
  END IF;
  payload := p.payload;

  -- Set session change_reason so the audit trigger on sub_dimensions captures context
  PERFORM set_config(
    'ballot_bridge.taxonomy_change_reason',
    format('proposal %s: %s', p.id, p.rationale),
    true
  );

  CASE p.proposal_type
    WHEN 'new_dim' THEN
      INSERT INTO sub_dimensions (
        domain, name, spectrum_low, spectrum_high, display_order,
        scope_applicability, applicable_regions, editorial_salience, salience_rationale
      ) VALUES (
        payload->>'domain',
        payload->>'name',
        payload->>'spectrum_low',
        payload->>'spectrum_high',
        COALESCE((payload->>'display_order')::INT, 99),
        COALESCE(payload->'scope_applicability', '{"federal":"matching","state":"matching","county":"informational"}'::jsonb),
        COALESCE(
          ARRAY(SELECT jsonb_array_elements_text(payload->'applicable_regions')),
          ARRAY['US']::TEXT[]
        ),
        COALESCE((payload->>'editorial_salience')::NUMERIC, 0.5),
        payload->>'salience_rationale'
      ) RETURNING id INTO new_dim_id;

    WHEN 'retire_dim' THEN
      UPDATE sub_dimensions
        SET active = false, deprecated_at = now()
        WHERE id = p.target_sub_dimension_id;

    WHEN 'restore_dim' THEN
      UPDATE sub_dimensions
        SET active = true, deprecated_at = NULL
        WHERE id = p.target_sub_dimension_id;

    WHEN 'reword_spectrum' THEN
      UPDATE sub_dimensions SET
        spectrum_low = COALESCE(payload->>'spectrum_low', spectrum_low),
        spectrum_high = COALESCE(payload->>'spectrum_high', spectrum_high)
        WHERE id = p.target_sub_dimension_id;

    WHEN 'change_scope' THEN
      UPDATE sub_dimensions
        SET scope_applicability = payload->'scope_applicability'
        WHERE id = p.target_sub_dimension_id;

    WHEN 'change_regions' THEN
      UPDATE sub_dimensions
        SET applicable_regions = ARRAY(
          SELECT jsonb_array_elements_text(payload->'applicable_regions')
        )
        WHERE id = p.target_sub_dimension_id;

    WHEN 'change_salience' THEN
      UPDATE sub_dimensions SET
        editorial_salience = (payload->>'editorial_salience')::NUMERIC,
        salience_rationale = payload->>'salience_rationale'
        WHERE id = p.target_sub_dimension_id;

    WHEN 'rename_dim' THEN
      UPDATE sub_dimensions
        SET name = payload->>'name'
        WHERE id = p.target_sub_dimension_id;

    WHEN 'change_domain' THEN
      UPDATE sub_dimensions
        SET domain = payload->>'domain'
        WHERE id = p.target_sub_dimension_id;

    ELSE
      RAISE EXCEPTION 'Unknown proposal_type: %', p.proposal_type;
  END CASE;

  UPDATE taxonomy_proposals SET
    status = 'applied',
    applied_at = now(),
    decision_by = applier
    WHERE id = proposal_id;

  RETURN COALESCE(new_dim_id, p.target_sub_dimension_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION apply_taxonomy_proposal(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION apply_taxonomy_proposal(UUID, TEXT) TO service_role;

-- ============================================================
-- 3. RLS — public read for under_review+, writes via service_role only
-- ============================================================

ALTER TABLE taxonomy_proposals ENABLE ROW LEVEL SECURITY;

-- Public can see proposals that have been submitted (transparency feature).
-- Drafts stay private to the operator.
CREATE POLICY "Public read submitted taxonomy_proposals"
  ON taxonomy_proposals FOR SELECT
  USING (status != 'draft');

-- ============================================================
-- 4. Convenience view: human-readable proposal summary for admin pages
-- ============================================================

CREATE OR REPLACE VIEW v_taxonomy_proposals AS
SELECT
  p.id,
  p.proposer_name,
  p.proposal_type,
  p.status,
  p.rationale,
  p.decision_reason,
  p.submitted_at,
  p.approved_at,
  p.applied_at,
  p.decision_at,
  p.decision_by,
  sd.name AS target_dim_name,
  sd.domain AS target_dim_domain,
  p.payload,
  p.created_at,
  p.updated_at
FROM taxonomy_proposals p
LEFT JOIN sub_dimensions sd ON sd.id = p.target_sub_dimension_id;

GRANT SELECT ON v_taxonomy_proposals TO anon, authenticated;

-- ============================================================
-- 5. Comments
-- ============================================================

COMMENT ON TABLE taxonomy_proposals IS
  'Governance workflow for changes to sub_dimensions. Status machine: '
  'draft → under_review → (approved → applied | rejected | withdrawn). '
  'Approved proposals do not auto-apply; call apply_taxonomy_proposal(id, applier) as service_role.';

COMMENT ON FUNCTION apply_taxonomy_proposal(UUID, TEXT) IS
  'Executes an approved taxonomy proposal against sub_dimensions. Returns the '
  'affected sub_dimension_id. Must be called by service_role. Sets session '
  'variable ballot_bridge.taxonomy_change_reason so the audit trigger on '
  'sub_dimensions captures the proposal context.';
