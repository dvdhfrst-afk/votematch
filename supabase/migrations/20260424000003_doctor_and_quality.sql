-- ============================================================
-- Adapter Doctor + Data Quality Watcher tables
-- ============================================================

CREATE TABLE IF NOT EXISTS adapter_remediation_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  adapter_name TEXT NOT NULL,
  current_url TEXT,
  proposed_url TEXT NOT NULL,
  evidence_kind TEXT NOT NULL CHECK (evidence_kind IN (
    'produced_rows','higher_content_hash_entropy','matches_known_pattern','llm_suggested','manual'
  )),
  evidence JSONB NOT NULL DEFAULT '{}',
  rows_produced INT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending','approved','rejected','applied','superseded'
  )),
  reviewed_by_user_id UUID REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  applied_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_arp_status ON adapter_remediation_proposals (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_arp_adapter ON adapter_remediation_proposals (adapter_name);

ALTER TABLE adapter_remediation_proposals ENABLE ROW LEVEL SECURITY;

-- ============================================================

CREATE TABLE IF NOT EXISTS data_quality_flags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,                        -- id of the flagged row (as text; FKs vary)
  rule TEXT NOT NULL,                           -- machine-readable rule id
  severity TEXT NOT NULL CHECK (severity IN ('info','warning','error','critical')),
  details JSONB NOT NULL DEFAULT '{}',
  resolved_at TIMESTAMPTZ,
  resolution_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (table_name, row_id, rule)             -- same issue re-detected idempotently upserts
);

CREATE INDEX IF NOT EXISTS idx_dqf_unresolved ON data_quality_flags (severity, created_at DESC)
  WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_dqf_table_row ON data_quality_flags (table_name, row_id);

ALTER TABLE data_quality_flags ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE adapter_remediation_proposals IS
  'Adapter Doctor writes here when it finds a better URL than the one the adapter is using. '
  'Review at /admin/remediation-proposals; set status=approved to apply. Proposals with '
  'evidence_kind=produced_rows that yielded >= 5 rows are auto-applied.';

COMMENT ON TABLE data_quality_flags IS
  'Data Quality Watcher writes row-level issues here. Unique on (table_name, row_id, rule) so '
  're-detection is idempotent. Triage at /admin/data-quality. severity escalates: info < warning '
  '< error < critical. Critical issues page; errors surface on morning review.';
