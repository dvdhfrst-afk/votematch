/**
 * Data Quality Watcher — rule definitions.
 *
 * Each rule is a pure description: a name (machine-readable, matches the
 * UNIQUE key on data_quality_flags), a severity, a target table, a detection
 * SQL, and an "is-resolved" SQL (used to mark resolved_at on previously
 * flagged rows that now pass).
 *
 * SQL contract:
 *
 *   detectSQL must return columns:
 *     row_id       TEXT   -- the flagged row's id, cast to text
 *     details      JSONB  -- rule-specific specifics (cols named in docs)
 *
 *   resolveSQL (optional — only for rules where re-checking a single row
 *   is cheap) is used by the worker to re-evaluate flags whose underlying
 *   row now passes, so it can mark them resolved. When omitted, the worker
 *   falls back to "any existing flag whose row_id no longer appears in the
 *   detectSQL output" → resolved.
 *
 * Rules are pure-SQL where possible. Rules requiring JS post-processing
 * (e.g. LLM-assisted) bypass detectSQL and provide a custom evaluator on
 * the worker side.
 *
 * 14-day staleness filter: low-severity rules (info, warning) filter on
 * row-age < 14d via the `recent_row_filter` helper. error/critical rules
 * always run across all rows.
 */
export type RuleSeverity = 'info' | 'warning' | 'error' | 'critical';

export interface RuleDefinition {
  /** Machine-readable rule id. Matches UNIQUE (table_name, row_id, rule). */
  name: string;
  /** Target table_name written to data_quality_flags. */
  table: string;
  severity: RuleSeverity;
  /**
   * SQL that returns (row_id TEXT, details JSONB) for rows that currently
   * FAIL this rule. The worker wraps this into an upsert.
   */
  detectSQL: string;
  /** Human-readable description shown in admin UI. */
  description: string;
}

// ---------------------------------------------------------------------------
// Staleness helpers — low-severity rules skip rows older than 14 days.
// Place the snippet inside the WHERE clause for rules that care.
// ---------------------------------------------------------------------------
const AGE_FILTER_14D = `(created_at > now() - interval '14 days')`;

// ---------------------------------------------------------------------------
// Council #35: state-code validation must accept territory postal codes.
// `^[A-Z]{2}$` already passes territory postals (PR/GU/VI/AS/MP) — they ARE
// 2 uppercase letters — but a number of adapters write FIPS codes
// (e.g. '72' for PR) where postal codes are expected. The validator below
// accepts the UNION of postal codes and FIPS codes so we don't fire false
// positives on adapter rows that legitimately carry FIPS in `state`.
//
// Centralized in one literal so future updates touch one place.
// ---------------------------------------------------------------------------
const VALID_STATE_TOKENS = [
  // 50 states
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
  'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
  'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
  'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
  // DC + 5 territories postal
  'DC', 'PR', 'GU', 'VI', 'AS', 'MP',
  // 2-digit FIPS for the same set (some adapters write FIPS in `state`)
  '01', '02', '04', '05', '06', '08', '09', '10', '11', '12',
  '13', '15', '16', '17', '18', '19', '20', '21', '22', '23',
  '24', '25', '26', '27', '28', '29', '30', '31', '32', '33',
  '34', '35', '36', '37', '38', '39', '40', '41', '42', '44',
  '45', '46', '47', '48', '49', '50', '51', '53', '54', '55',
  '56', '60', '66', '69', '72', '78',
];

/**
 * SQL-safe ARRAY literal of valid state tokens. Used by rules that want to
 * filter on (state IS in this list) without a JOIN to a reference table.
 */
const VALID_STATE_SQL_ARRAY =
  `ARRAY[${VALID_STATE_TOKENS.map((s) => `'${s}'`).join(',')}]::text[]`;

// ---------------------------------------------------------------------------
// election_results
// ---------------------------------------------------------------------------
const rulesElectionResults: RuleDefinition[] = [
  {
    name: 'vote_count_negative',
    table: 'election_results',
    severity: 'error',
    description: 'election_results.vote_count is negative.',
    detectSQL: `
      SELECT id::text AS row_id,
             jsonb_build_object(
               'vote_count', vote_count,
               'election_id', election_id,
               'reported_name', reported_name
             ) AS details
      FROM election_results
      WHERE vote_count IS NOT NULL AND vote_count < 0
    `,
  },
  {
    name: 'percentage_out_of_range',
    table: 'election_results',
    severity: 'error',
    description: 'vote_percentage outside [0, 100].',
    detectSQL: `
      SELECT id::text AS row_id,
             jsonb_build_object(
               'vote_percentage', vote_percentage,
               'election_id', election_id,
               'reported_name', reported_name
             ) AS details
      FROM election_results
      WHERE vote_percentage IS NOT NULL
        AND (vote_percentage < 0 OR vote_percentage > 100)
    `,
  },
  {
    name: 'outcome_mutex_violation',
    table: 'election_results',
    severity: 'critical',
    description: 'is_winner AND is_runoff_advancer both true (CHECK should prevent).',
    detectSQL: `
      SELECT id::text AS row_id,
             jsonb_build_object(
               'election_id', election_id,
               'reported_name', reported_name,
               'is_winner', is_winner,
               'is_runoff_advancer', is_runoff_advancer
             ) AS details
      FROM election_results
      WHERE is_winner = TRUE AND is_runoff_advancer = TRUE
    `,
  },
  {
    name: 'orphan_candidacy',
    table: 'election_results',
    severity: 'warning',
    description: 'candidacy_id set but no matching candidacies row.',
    detectSQL: `
      SELECT er.id::text AS row_id,
             jsonb_build_object(
               'candidacy_id', er.candidacy_id,
               'election_id', er.election_id,
               'reported_name', er.reported_name
             ) AS details
      FROM election_results er
      LEFT JOIN candidacies c ON c.id = er.candidacy_id
      WHERE er.candidacy_id IS NOT NULL
        AND c.id IS NULL
        AND ${AGE_FILTER_14D.replace(/created_at/g, 'er.created_at')}
    `,
  },
  {
    name: 'party_abbreviation_unknown',
    table: 'election_results',
    severity: 'info',
    description: 'party_abbreviation not resolvable via parties.aliases or abbreviation.',
    detectSQL: `
      SELECT er.id::text AS row_id,
             jsonb_build_object(
               'party_abbreviation', er.party_abbreviation,
               'election_id', er.election_id,
               'reported_name', er.reported_name
             ) AS details
      FROM election_results er
      WHERE er.party_abbreviation IS NOT NULL
        AND er.party_abbreviation <> ''
        AND NOT EXISTS (
          SELECT 1 FROM parties p
          WHERE p.abbreviation = er.party_abbreviation
             OR er.party_abbreviation = ANY(p.aliases)
        )
        AND ${AGE_FILTER_14D.replace(/created_at/g, 'er.created_at')}
    `,
  },
];

// ---------------------------------------------------------------------------
// candidacies
// ---------------------------------------------------------------------------
const rulesCandidacies: RuleDefinition[] = [
  {
    name: 'missing_person',
    table: 'candidacies',
    severity: 'critical',
    description: 'candidacies.person_id set but no matching people row.',
    detectSQL: `
      SELECT c.id::text AS row_id,
             jsonb_build_object(
               'person_id', c.person_id,
               'election_id', c.election_id
             ) AS details
      FROM candidacies c
      LEFT JOIN people p ON p.id = c.person_id
      WHERE c.person_id IS NOT NULL AND p.id IS NULL
    `,
  },
  {
    name: 'missing_election',
    table: 'candidacies',
    severity: 'critical',
    description: 'candidacies.election_id set but no matching elections row.',
    detectSQL: `
      SELECT c.id::text AS row_id,
             jsonb_build_object(
               'election_id', c.election_id,
               'person_id', c.person_id
             ) AS details
      FROM candidacies c
      LEFT JOIN elections e ON e.id = c.election_id
      WHERE c.election_id IS NOT NULL AND e.id IS NULL
    `,
  },
  {
    name: 'invalid_status',
    table: 'candidacies',
    severity: 'error',
    description: 'candidacies.status outside the CHECK set.',
    detectSQL: `
      SELECT id::text AS row_id,
             jsonb_build_object('status', status) AS details
      FROM candidacies
      WHERE status IS NOT NULL
        AND status NOT IN (
          'pending_verification','active','withdrew','disqualified',
          'won_primary','lost_primary','won_general','lost_general','advanced_to_runoff'
        )
    `,
  },
  {
    name: 'duplicate_ballot_lines',
    table: 'candidacies',
    severity: 'warning',
    description: '>3 party lines per candidacy (fusion caps at 3 in practice; higher likely bug).',
    detectSQL: `
      SELECT c.id::text AS row_id,
             jsonb_build_object(
               'party_line_count', cnt.n,
               'election_id', c.election_id,
               'person_id', c.person_id
             ) AS details
      FROM candidacies c
      JOIN (
        SELECT candidacy_id, count(*)::int AS n
        FROM candidacy_party_lines
        GROUP BY candidacy_id
        HAVING count(*) > 3
      ) cnt ON cnt.candidacy_id = c.id
      WHERE ${AGE_FILTER_14D.replace(/created_at/g, 'c.created_at')}
    `,
  },
];

// ---------------------------------------------------------------------------
// state_cf_events
// ---------------------------------------------------------------------------
const rulesStateCfEvents: RuleDefinition[] = [
  {
    name: 'amount_implausible_huge',
    table: 'state_cf_events',
    severity: 'warning',
    description:
      'amount above the per-jurisdiction-tier threshold. Council #35: '
      + 'federal+state > $50M, county > $10M, municipal > $1M. Tier is '
      + 'inferred from the joined candidacies → office → office_types row '
      + 'when resolvable; rows without a tier signal use the conservative '
      + '$50M federal/state threshold so we do not over-fire on territory '
      + 'or unresolved-tier rows.',
    detectSQL: `
      SELECT cf.id::text AS row_id,
             jsonb_build_object(
               'amount', cf.amount,
               'state', cf.state,
               'event_type', cf.event_type,
               'event_date', cf.event_date,
               'inferred_tier', tier.tier,
               'threshold_usd', tier.threshold
             ) AS details
      FROM state_cf_events cf
      LEFT JOIN LATERAL (
        SELECT
          CASE
            WHEN o.level IN ('federal','state') THEN 'federal_state'
            WHEN o.level IN ('county') THEN 'county'
            WHEN o.level IN ('municipal','school','special','judicial') THEN 'municipal'
            ELSE 'unknown'
          END AS tier,
          CASE
            WHEN o.level IN ('federal','state') THEN 50000000
            WHEN o.level IN ('county') THEN 10000000
            WHEN o.level IN ('municipal','school','special','judicial') THEN 1000000
            ELSE 50000000  -- conservative fallback (avoid over-firing)
          END AS threshold
        FROM candidacies c
        LEFT JOIN elections e ON e.id = c.election_id
        LEFT JOIN offices o   ON o.id = e.office_id
        WHERE c.id = cf.resolved_candidacy_id
        LIMIT 1
      ) tier ON TRUE
      WHERE cf.amount IS NOT NULL
        AND cf.amount > COALESCE(tier.threshold, 50000000)
        AND ${AGE_FILTER_14D.replace(/created_at/g, 'cf.ingested_at')}
    `,
  },
  {
    name: 'amount_negative_non_refund',
    table: 'state_cf_events',
    severity: 'info',
    description: 'amount < 0 on a non-refund / non-adjustment event.',
    detectSQL: `
      SELECT id::text AS row_id,
             jsonb_build_object(
               'amount', amount,
               'event_type', event_type,
               'state', state
             ) AS details
      FROM state_cf_events
      WHERE amount IS NOT NULL
        AND amount < 0
        AND (event_type IS NULL OR event_type NOT IN ('refund', 'adjustment'))
        AND ${AGE_FILTER_14D.replace(/created_at/g, 'ingested_at')}
    `,
  },
  {
    name: 'date_future',
    table: 'state_cf_events',
    severity: 'warning',
    description: 'event_date > now() + 30 days.',
    detectSQL: `
      SELECT id::text AS row_id,
             jsonb_build_object(
               'event_date', event_date,
               'state', state,
               'event_type', event_type
             ) AS details
      FROM state_cf_events
      WHERE event_date IS NOT NULL
        AND event_date > (CURRENT_DATE + interval '30 days')
        AND ${AGE_FILTER_14D.replace(/created_at/g, 'ingested_at')}
    `,
  },
  {
    name: 'date_ancient',
    table: 'state_cf_events',
    severity: 'info',
    description: 'event_date older than 20 years (likely parse error).',
    detectSQL: `
      SELECT id::text AS row_id,
             jsonb_build_object(
               'event_date', event_date,
               'state', state
             ) AS details
      FROM state_cf_events
      WHERE event_date IS NOT NULL
        AND event_date < (CURRENT_DATE - interval '20 years')
        AND ${AGE_FILTER_14D.replace(/created_at/g, 'ingested_at')}
    `,
  },
  {
    name: 'filer_name_empty',
    table: 'state_cf_events',
    severity: 'error',
    description: 'candidate_name AND committee_name both empty (filer unknown).',
    // state_cf_events has candidate_name and committee_name; either should identify the filer.
    // Rule fires when BOTH are null/empty.
    detectSQL: `
      SELECT id::text AS row_id,
             jsonb_build_object(
               'state', state,
               'event_type', event_type,
               'event_date', event_date
             ) AS details
      FROM state_cf_events
      WHERE (candidate_name IS NULL OR candidate_name = '')
        AND (committee_name IS NULL OR committee_name = '')
    `,
  },
  {
    name: 'state_code_mismatch',
    table: 'state_cf_events',
    severity: 'warning',
    description:
      'state token not in the allowed set (postal codes for 50 states + DC + '
      + 'PR/GU/VI/AS/MP, OR 2-digit FIPS for the same set). Council #35.',
    detectSQL: `
      SELECT id::text AS row_id,
             jsonb_build_object(
               'state', state,
               'event_type', event_type
             ) AS details
      FROM state_cf_events
      WHERE state IS NOT NULL
        AND NOT (state = ANY(${VALID_STATE_SQL_ARRAY}))
        AND ${AGE_FILTER_14D.replace(/created_at/g, 'ingested_at')}
    `,
  },
];

// ---------------------------------------------------------------------------
// endorsements
// ---------------------------------------------------------------------------
const rulesEndorsements: RuleDefinition[] = [
  {
    name: 'url_missing_for_publish',
    table: 'endorsements',
    severity: 'error',
    description: 'published=TRUE but endorsement_url IS NULL (DB CHECK should prevent).',
    detectSQL: `
      SELECT id::text AS row_id,
             jsonb_build_object(
               'candidacy_id', candidacy_id,
               'endorser_id', endorser_id,
               'endorsement_date', endorsement_date
             ) AS details
      FROM endorsements
      WHERE published = TRUE AND endorsement_url IS NULL
    `,
  },
  {
    name: 'reviewer_missing_for_publish',
    table: 'endorsements',
    severity: 'error',
    description: 'published=TRUE but reviewed_by_user_id IS NULL (DB CHECK should prevent).',
    detectSQL: `
      SELECT id::text AS row_id,
             jsonb_build_object(
               'candidacy_id', candidacy_id,
               'endorser_id', endorser_id
             ) AS details
      FROM endorsements
      WHERE published = TRUE AND reviewed_by_user_id IS NULL
    `,
  },
  {
    name: 'ai_extracted_but_not_verbatim',
    table: 'endorsements',
    severity: 'warning',
    description: 'extracted_by=ai_extraction_verified but meta.verbatim_endorser_found_in_source=false.',
    detectSQL: `
      SELECT id::text AS row_id,
             jsonb_build_object(
               'candidacy_id', candidacy_id,
               'endorser_id', endorser_id,
               'extraction_confidence', extraction_confidence
             ) AS details
      FROM endorsements
      WHERE extracted_by = 'ai_extraction_verified'
        AND (meta->>'verbatim_endorser_found_in_source')::boolean = false
        AND ${AGE_FILTER_14D}
    `,
  },
  {
    name: 'rescinded_still_published',
    table: 'endorsements',
    severity: 'warning',
    description: 'rescinded_at IS NOT NULL but published = TRUE (should be unpublished).',
    detectSQL: `
      SELECT id::text AS row_id,
             jsonb_build_object(
               'candidacy_id', candidacy_id,
               'endorser_id', endorser_id,
               'rescinded_at', rescinded_at,
               'rescinded_reason', rescinded_reason
             ) AS details
      FROM endorsements
      WHERE rescinded_at IS NOT NULL AND published = TRUE
    `,
  },
];

// ---------------------------------------------------------------------------
// positions
// ---------------------------------------------------------------------------
const rulesPositions: RuleDefinition[] = [
  {
    name: 'score_out_of_range',
    table: 'positions',
    severity: 'error',
    description: 'score outside [0, 1] (CHECK should prevent).',
    detectSQL: `
      SELECT id::text AS row_id,
             jsonb_build_object(
               'candidate_id', candidate_id,
               'sub_dimension_id', sub_dimension_id,
               'score', score
             ) AS details
      FROM positions
      WHERE score IS NOT NULL AND (score < 0 OR score > 1)
    `,
  },
  {
    name: 'invalid_confidence',
    table: 'positions',
    severity: 'error',
    description: "confidence not in ('high','medium','low').",
    detectSQL: `
      SELECT id::text AS row_id,
             jsonb_build_object(
               'candidate_id', candidate_id,
               'sub_dimension_id', sub_dimension_id,
               'confidence', confidence
             ) AS details
      FROM positions
      WHERE confidence IS NOT NULL
        AND confidence NOT IN ('high','medium','low')
    `,
  },
  {
    name: 'citations_empty',
    table: 'positions',
    severity: 'warning',
    description: 'source_citations is NULL or empty array.',
    detectSQL: `
      SELECT id::text AS row_id,
             jsonb_build_object(
               'candidate_id', candidate_id,
               'sub_dimension_id', sub_dimension_id,
               'view_type', view_type
             ) AS details
      FROM positions
      WHERE (source_citations IS NULL
             OR jsonb_typeof(source_citations) = 'null'
             OR (jsonb_typeof(source_citations) = 'array'
                 AND jsonb_array_length(source_citations) = 0))
        AND ${AGE_FILTER_14D}
    `,
  },
];

// ---------------------------------------------------------------------------
// people
// ---------------------------------------------------------------------------
const rulesPeople: RuleDefinition[] = [
  {
    name: 'duplicate_canonical_key',
    table: 'people',
    severity: 'info',
    description:
      'Multiple people rows share canonical_key across distinct fetch_state values; '
      + 'most often two real people with the same name, occasionally a dedup bug.',
    detectSQL: `
      WITH dup_groups AS (
        SELECT canonical_key,
               count(*) AS n,
               count(DISTINCT coalesce(meta->>'fetch_state', '-')) AS n_states,
               array_agg(DISTINCT coalesce(meta->>'fetch_state', '-')) AS states
        FROM people
        WHERE canonical_key IS NOT NULL
        GROUP BY canonical_key
        HAVING count(*) > 1
           AND count(DISTINCT coalesce(meta->>'fetch_state', '-')) > 1
      )
      SELECT p.id::text AS row_id,
             jsonb_build_object(
               'canonical_key', p.canonical_key,
               'canonical_name', p.canonical_name,
               'group_size', dg.n,
               'states', dg.states
             ) AS details
      FROM people p
      JOIN dup_groups dg ON dg.canonical_key = p.canonical_key
    `,
  },
];

// ---------------------------------------------------------------------------
// ingestion_runs
// ---------------------------------------------------------------------------
const rulesIngestionRuns: RuleDefinition[] = [
  {
    name: 'stuck_running',
    table: 'ingestion_runs',
    severity: 'warning',
    description: "status='running' started > 30 minutes ago (janitor should have fixed).",
    detectSQL: `
      SELECT id::text AS row_id,
             jsonb_build_object(
               'adapter_name', adapter_name,
               'state_fips', state_fips,
               'started_at', started_at,
               'minutes_stuck', EXTRACT(EPOCH FROM (now() - started_at))/60
             ) AS details
      FROM ingestion_runs
      WHERE status = 'running'
        AND started_at < now() - interval '30 minutes'
    `,
  },
];

// ---------------------------------------------------------------------------
// Capped-rule companion predicates — extracted so the per-row LIMIT 5000
// rule and its `:total_count` companion (added 2026-04-26) share an identical
// WHERE clause. Without this, the companion's count could drift from the
// per-row rule's predicate during future edits and silently lie again.
// ---------------------------------------------------------------------------
const CF_PARSER_GARBAGE_PREDICATE = `
  candidate_name ILIKE '%aspnetForm%'
  OR candidate_name ILIKE '%__doPostBack%'
  OR candidate_name ILIKE '%<![CDATA[%'
  OR counterparty ILIKE '%theForm%'
  OR length(candidate_name) > 200
`;

const ALL_CAPS_NAME_PREDICATE = `
  canonical_name IS NOT NULL
  AND canonical_name = upper(canonical_name)
  AND canonical_name ~ '[A-Z]{3,}'
`;

const FED_BILLS_MISSING_SPONSOR_PREDICATE = `
  sponsor_bioguide_id IS NULL
`;

// ---------------------------------------------------------------------------
// Higher-order council rules — added 2026-04-25 from data-council audit.
// These are aggregate / cross-row / coverage / lineage checks that the
// row-level rules above cannot detect.
// ---------------------------------------------------------------------------
const rulesCouncilHigherOrder: RuleDefinition[] = [
  // 1. Per-state CF duplicate rate — emits one flag per state when the
  // count(*)/count(DISTINCT row_uid) ratio exceeds 1.5 (>50% duplicate ingest).
  {
    name: 'cf_per_state_duplicate_rate',
    table: 'state_cf_events_aggregate',
    severity: 'error',
    description:
      'Per-state state_cf_events duplicate rate exceeds 1.5x (count/distinct row_uid). '
      + 'Indicates the per-state ingestion adapter is re-inserting the same source rows.',
    detectSQL: `
      SELECT state AS row_id,
             jsonb_build_object(
               'total', count(*),
               'unique', count(DISTINCT row_uid),
               'dup_rate', count(*)::float / NULLIF(count(DISTINCT row_uid), 0)
             ) AS details
      FROM state_cf_events
      WHERE row_uid IS NOT NULL
      GROUP BY state
      HAVING count(*)::float / NULLIF(count(DISTINCT row_uid), 0) > 1.5
    `,
  },

  // 2. Parser garbage — names that contain ASP.NET form tokens, CDATA, or
  // exceed 200 chars. These slip through field-level rules but are clearly
  // a parser-fall-through.
  {
    name: 'cf_parser_garbage',
    table: 'state_cf_events',
    severity: 'critical',
    description:
      'state_cf_events row contains parser-fall-through markers '
      + '(aspnetForm / __doPostBack / CDATA / theForm) or candidate_name > 200 chars.',
    detectSQL: `
      SELECT id::text AS row_id,
             jsonb_build_object(
               'candidate_name', left(coalesce(candidate_name, ''), 300),
               'state', state
             ) AS details
      FROM state_cf_events
      WHERE ${CF_PARSER_GARBAGE_PREDICATE}
      LIMIT 5000
    `,
  },

  // 2a. Companion to cf_parser_garbage — unbounded count so dashboards see
  // the true scale even when the per-row rule's LIMIT 5000 cap is hit.
  // Always emits a single row keyed by a stable synthetic row_id.
  {
    name: 'cf_parser_garbage:total_count',
    table: 'state_cf_events',
    severity: 'info',
    description:
      'Unbounded total count of state_cf_events rows that fail '
      + 'cf_parser_garbage. Companion to the per-row rule whose emission is '
      + 'capped at 5000 flags per tick; this rule preserves visibility into '
      + 'the true population size.',
    detectSQL: `
      SELECT '__total__'::text AS row_id,
             jsonb_build_object(
               'count', (
                 SELECT count(*) FROM state_cf_events
                 WHERE ${CF_PARSER_GARBAGE_PREDICATE}
               ),
               'capped_at', 5000,
               'companion_of', 'cf_parser_garbage',
               'is_total_count', true
             ) AS details
    `,
  },

  // 3. Field completeness below threshold — UNION ALL of (table:column, pct)
  // synthetic rows. row_id is the table.column key; details carry the pct.
  {
    name: 'field_completeness_below_threshold',
    table: 'data_completeness',
    severity: 'warning',
    description:
      'A critical column has fallen below its target populated-rate. '
      + 'One flag per (table.column) that misses its threshold. '
      + 'Thresholds: people.bio 10%, people.photo_url 30%, '
      + 'federal_bills.summary 50%, federal_bills.sponsor_bioguide_id 80%, '
      + 'federal_bills.introduced_date 90%, state_cf_events.event_date 80%, '
      + 'state_cf_events.resolved_candidacy_id 5%.',
    detectSQL: `
      WITH measurements AS (
        -- people.bio
        SELECT 'people.bio'::text AS key,
               10::numeric AS threshold,
               100.0 * count(*) FILTER (WHERE bio IS NOT NULL AND length(trim(bio)) > 0)::numeric
                 / NULLIF(count(*), 0) AS pct,
               count(*) AS total
        FROM people
        UNION ALL
        -- people.photo_url
        SELECT 'people.photo_url',
               30,
               100.0 * count(*) FILTER (WHERE photo_url IS NOT NULL AND length(trim(photo_url)) > 0)::numeric
                 / NULLIF(count(*), 0),
               count(*)
        FROM people
        UNION ALL
        -- federal_bills.summary
        SELECT 'federal_bills.summary',
               50,
               100.0 * count(*) FILTER (WHERE summary IS NOT NULL AND length(trim(summary)) > 0)::numeric
                 / NULLIF(count(*), 0),
               count(*)
        FROM federal_bills
        UNION ALL
        -- federal_bills.sponsor_bioguide_id
        SELECT 'federal_bills.sponsor_bioguide_id',
               80,
               100.0 * count(*) FILTER (WHERE sponsor_bioguide_id IS NOT NULL)::numeric
                 / NULLIF(count(*), 0),
               count(*)
        FROM federal_bills
        UNION ALL
        -- federal_bills.introduced_date
        SELECT 'federal_bills.introduced_date',
               90,
               100.0 * count(*) FILTER (WHERE introduced_date IS NOT NULL)::numeric
                 / NULLIF(count(*), 0),
               count(*)
        FROM federal_bills
        UNION ALL
        -- state_cf_events.event_date
        SELECT 'state_cf_events.event_date',
               80,
               100.0 * count(*) FILTER (WHERE event_date IS NOT NULL)::numeric
                 / NULLIF(count(*), 0),
               count(*)
        FROM state_cf_events
        UNION ALL
        -- state_cf_events.resolved_candidacy_id
        SELECT 'state_cf_events.resolved_candidacy_id',
               5,
               100.0 * count(*) FILTER (WHERE resolved_candidacy_id IS NOT NULL)::numeric
                 / NULLIF(count(*), 0),
               count(*)
        FROM state_cf_events
      )
      SELECT key AS row_id,
             jsonb_build_object(
               'pct_populated', round(coalesce(pct, 0), 2),
               'threshold_pct', threshold,
               'total_rows', total
             ) AS details
      FROM measurements
      WHERE total > 0
        AND coalesce(pct, 0) < threshold
    `,
  },

  // 4. Lineage gap — provenance-tracking tables with NULL data_source_id.
  {
    name: 'lineage_gap_data_source_id',
    table: 'data_lineage',
    severity: 'error',
    description:
      'Provenance-tracking table has rows with NULL data_source_id. '
      + 'Without lineage we cannot trace, re-fetch, or invalidate stale data. '
      + 'One flag per affected table.',
    // candidacies has no data_source_id yet — gated on a future migration.
    // Skipping it until that column is added avoids `column does not exist`.
    detectSQL: `
      WITH gaps AS (
        SELECT 'state_cf_events'::text AS tbl,
               count(*) FILTER (WHERE data_source_id IS NULL) AS n_null,
               count(*) AS total
        FROM state_cf_events
        UNION ALL
        SELECT 'federal_bills',
               count(*) FILTER (WHERE data_source_id IS NULL),
               count(*)
        FROM federal_bills
        UNION ALL
        SELECT 'federal_vote_positions',
               count(*) FILTER (WHERE data_source_id IS NULL),
               count(*)
        FROM federal_vote_positions
      )
      SELECT tbl AS row_id,
             jsonb_build_object(
               'null_count', n_null,
               'total', total,
               'null_pct', round((100.0 * n_null::numeric / NULLIF(total, 0))::numeric, 2)
             ) AS details
      FROM gaps
      WHERE n_null > 0
    `,
  },

  // 5. Coverage: states with zero state_cf_events. Means we have no donor
  // visibility for that state's voters.
  {
    name: 'coverage_state_zero_cf',
    table: 'state_cf_coverage',
    severity: 'warning',
    description:
      'A US state (50 + DC) has ZERO rows in state_cf_events. '
      + 'No donor visibility for that state — adapter likely broken or unscheduled.',
    detectSQL: `
      WITH state_list AS (
        SELECT unnest(ARRAY[
          'AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL',
          'GA','HI','ID','IL','IN','IA','KS','KY','LA','ME',
          'MD','MA','MI','MN','MS','MO','MT','NE','NV','NH',
          'NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI',
          'SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY'
        ]) AS abbr
      )
      SELECT sl.abbr AS row_id,
             jsonb_build_object('event_count', 0) AS details
      FROM state_list sl
      LEFT JOIN state_cf_events scf ON scf.state = sl.abbr
      GROUP BY sl.abbr
      HAVING count(scf.id) = 0
    `,
  },

  // 6. Top-donor sentinel — duplicate-ingestion detector. SQL-only variant:
  // for each (state, donor) pair, compare the donor's row count against the
  // state's median donor count over the trailing 7 days. Flag any donor that
  // is more than 1000x the median (i.e. a single counterparty appearing
  // wildly more than the typical donor — strong duplicate-ingest signal).
  {
    name: 'top_donor_sentinel',
    table: 'state_cf_events_aggregate',
    severity: 'warning',
    description:
      'A single donor counterparty has a row count >1000x the state median '
      + 'over the last 7 days. Most often duplicate ingestion of the same '
      + 'contribution batch; rarely a real concentrated megadonor.',
    detectSQL: `
      WITH recent AS (
        SELECT state, counterparty, count(*) AS n
        FROM state_cf_events
        WHERE counterparty IS NOT NULL
          AND length(trim(counterparty)) > 0
          AND ingested_at > now() - interval '7 days'
        GROUP BY state, counterparty
      ), state_medians AS (
        SELECT state, percentile_cont(0.5) WITHIN GROUP (ORDER BY n) AS median_n
        FROM recent
        GROUP BY state
        HAVING count(*) >= 5
      )
      SELECT (r.state || ':' || left(r.counterparty, 200)) AS row_id,
             jsonb_build_object(
               'state', r.state,
               'donor', left(r.counterparty, 200),
               'donor_count_7d', r.n,
               'state_median_count_7d', sm.median_n,
               'ratio', round((r.n::numeric / NULLIF(sm.median_n, 0))::numeric, 2)
             ) AS details
      FROM recent r
      JOIN state_medians sm ON sm.state = r.state
      WHERE sm.median_n > 0
        AND r.n::numeric > 1000 * sm.median_n
      LIMIT 5000
    `,
  },

  // 6a. Companion to top_donor_sentinel — unbounded count of (state, donor)
  // pairs whose ratio exceeds 1000x the state median. Same CTE shape as the
  // parent rule. Always emits a single row keyed by a stable synthetic
  // row_id so the upsert is idempotent across ticks.
  {
    name: 'top_donor_sentinel:total_count',
    table: 'state_cf_events_aggregate',
    severity: 'info',
    description:
      'Unbounded total count of (state, donor) pairs flagged by '
      + 'top_donor_sentinel. Companion to the per-row rule whose emission is '
      + 'capped at 5000 flags per tick.',
    detectSQL: `
      WITH recent AS (
        SELECT state, counterparty, count(*) AS n
        FROM state_cf_events
        WHERE counterparty IS NOT NULL
          AND length(trim(counterparty)) > 0
          AND ingested_at > now() - interval '7 days'
        GROUP BY state, counterparty
      ), state_medians AS (
        SELECT state, percentile_cont(0.5) WITHIN GROUP (ORDER BY n) AS median_n
        FROM recent
        GROUP BY state
        HAVING count(*) >= 5
      ), flagged AS (
        SELECT r.state, r.counterparty
        FROM recent r
        JOIN state_medians sm ON sm.state = r.state
        WHERE sm.median_n > 0
          AND r.n::numeric > 1000 * sm.median_n
      )
      SELECT '__total__'::text AS row_id,
             jsonb_build_object(
               'count', (SELECT count(*) FROM flagged),
               'capped_at', 5000,
               'companion_of', 'top_donor_sentinel',
               'is_total_count', true
             ) AS details
    `,
  },

  // 7. All-caps name detector — shouty names from poorly-cased CF dumps.
  {
    name: 'all_caps_name_detector',
    table: 'people',
    severity: 'info',
    description:
      'people.canonical_name is entirely uppercase (>=3 caps). '
      + 'Indicates a CF or ballot-source dump that did not get title-cased.',
    detectSQL: `
      SELECT id::text AS row_id,
             jsonb_build_object('name', canonical_name) AS details
      FROM people
      WHERE ${ALL_CAPS_NAME_PREDICATE}
      LIMIT 5000
    `,
  },

  // 7a. Companion to all_caps_name_detector — unbounded count.
  // Always emits a single row keyed by a stable synthetic row_id.
  {
    name: 'all_caps_name_detector:total_count',
    table: 'people',
    severity: 'info',
    description:
      'Unbounded total count of people rows with all-caps canonical_name. '
      + 'Companion to the per-row rule whose emission is capped at 5000 '
      + 'flags per tick.',
    detectSQL: `
      SELECT '__total__'::text AS row_id,
             jsonb_build_object(
               'count', (
                 SELECT count(*) FROM people
                 WHERE ${ALL_CAPS_NAME_PREDICATE}
               ),
               'capped_at', 5000,
               'companion_of', 'all_caps_name_detector',
               'is_total_count', true
             ) AS details
    `,
  },

  // 8. Federal bills missing sponsor — bills cannot be tied back to a member.
  {
    name: 'fed_bills_missing_sponsor',
    table: 'federal_bills',
    severity: 'error',
    description: 'federal_bills row has NULL sponsor_bioguide_id — cannot link to a member.',
    // federal_bills has a composite PK (congress, bill_type, bill_number),
    // not a UUID id column — synthesize the natural-key string as row_id.
    detectSQL: `
      SELECT (congress::text || '-' || bill_type || '-' || bill_number::text) AS row_id,
             jsonb_build_object(
               'congress', congress,
               'bill_type', bill_type,
               'bill_number', bill_number,
               'title', left(coalesce(title, ''), 200)
             ) AS details
      FROM federal_bills
      WHERE ${FED_BILLS_MISSING_SPONSOR_PREDICATE}
      LIMIT 5000
    `,
  },

  // 8a. Companion to fed_bills_missing_sponsor — unbounded count so we can
  // distinguish "exactly 5,000 = the cap" from the true sponsor-loss rate.
  // Always emits a single row keyed by a stable synthetic row_id.
  {
    name: 'fed_bills_missing_sponsor:total_count',
    table: 'federal_bills',
    severity: 'info',
    description:
      'Unbounded total count of federal_bills rows with NULL '
      + 'sponsor_bioguide_id. Companion to the per-row rule whose emission '
      + 'is capped at 5000 flags per tick.',
    detectSQL: `
      SELECT '__total__'::text AS row_id,
             jsonb_build_object(
               'count', (
                 SELECT count(*) FROM federal_bills
                 WHERE ${FED_BILLS_MISSING_SPONSOR_PREDICATE}
               ),
               'capped_at', 5000,
               'companion_of', 'fed_bills_missing_sponsor',
               'is_total_count', true
             ) AS details
    `,
  },
];

// ---------------------------------------------------------------------------
// Composite export
// ---------------------------------------------------------------------------
export const ALL_RULES: RuleDefinition[] = [
  ...rulesElectionResults,
  ...rulesCandidacies,
  ...rulesStateCfEvents,
  ...rulesEndorsements,
  ...rulesPositions,
  ...rulesPeople,
  ...rulesIngestionRuns,
  ...rulesCouncilHigherOrder,
];

/**
 * Helper: count rules per severity for logging / admin surfaces.
 */
export function countBySeverity(
  rules: RuleDefinition[] = ALL_RULES,
): Record<RuleSeverity, number> {
  const out: Record<RuleSeverity, number> = {
    info: 0,
    warning: 0,
    error: 0,
    critical: 0,
  };
  for (const r of rules) out[r.severity] += 1;
  return out;
}

/**
 * Light-weight SQL syntax sanity check (static; no DB connection).
 * Not a full parser — just catches unclosed parens, unclosed single-quoted
 * strings, and missing row_id / details aliases.
 *
 * Returns an array of { rule, errors[] } entries for rules that fail checks.
 */
export function lintRules(
  rules: RuleDefinition[] = ALL_RULES,
): Array<{ rule: string; errors: string[] }> {
  const results: Array<{ rule: string; errors: string[] }> = [];
  for (const r of rules) {
    const errs: string[] = [];
    // Parens balance (ignoring parens inside quoted strings).
    let parens = 0;
    let inSingle = false;
    for (let i = 0; i < r.detectSQL.length; i++) {
      const c = r.detectSQL[i];
      if (c === "'") {
        // Handle doubled '' inside quoted strings as escape.
        if (inSingle && r.detectSQL[i + 1] === "'") {
          i += 1;
          continue;
        }
        inSingle = !inSingle;
        continue;
      }
      if (inSingle) continue;
      if (c === '(') parens += 1;
      else if (c === ')') parens -= 1;
      if (parens < 0) {
        errs.push('Unmatched close-paren');
        break;
      }
    }
    if (inSingle) errs.push('Unclosed single-quoted string');
    if (parens !== 0) errs.push(`Unbalanced parens (${parens})`);

    // Must have `row_id` and `details` aliases in the top-level SELECT.
    if (!/\bAS\s+row_id\b/i.test(r.detectSQL))
      errs.push('Missing `AS row_id` alias');
    if (!/\bAS\s+details\b/i.test(r.detectSQL))
      errs.push('Missing `AS details` alias');

    // `details` should be jsonb — check for jsonb_build_object or ::jsonb cast.
    if (
      !/jsonb_build_object\s*\(/i.test(r.detectSQL)
      && !/::jsonb\b/i.test(r.detectSQL)
    ) {
      errs.push('`details` is not jsonb (no jsonb_build_object or ::jsonb)');
    }

    if (errs.length > 0) results.push({ rule: r.name, errors: errs });
  }
  return results;
}

/**
 * Validate no two rules share a (table, name) — that would confuse the upsert.
 */
export function assertNoDuplicateRuleNames(
  rules: RuleDefinition[] = ALL_RULES,
): string[] {
  const seen = new Set<string>();
  const dupes: string[] = [];
  for (const r of rules) {
    const key = `${r.table}.${r.name}`;
    if (seen.has(key)) dupes.push(key);
    seen.add(key);
  }
  return dupes;
}
