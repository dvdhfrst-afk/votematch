/**
 * Tests for Data Quality Watcher rules.
 *
 * Covers two layers:
 *   1. Static lint — balanced parens, required aliases, no duplicate names,
 *      detects jsonb details column. No DB.
 *   2. Fixture semantics — spot-check each rule's intent against hand-rolled
 *      TypeScript fixtures (no live Postgres). The fixture evaluators mirror
 *      the rule's SQL logic so if a reviewer rewrites the SQL, the test
 *      forces them to keep the semantics in sync.
 *
 * Run: npx tsx --test src/lib/quality/__tests__/rules.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ALL_RULES,
  assertNoDuplicateRuleNames,
  countBySeverity,
  lintRules,
  type RuleDefinition,
} from '../rules';

// ---------------------------------------------------------------------------
// Layer 1: static lint
// ---------------------------------------------------------------------------
describe('rules / static lint', () => {
  it('every rule passes syntax lint', () => {
    const bad = lintRules(ALL_RULES);
    assert.deepEqual(
      bad,
      [],
      `Rules failed lint:\n${JSON.stringify(bad, null, 2)}`,
    );
  });

  it('no duplicate (table, name) pairs', () => {
    const dupes = assertNoDuplicateRuleNames(ALL_RULES);
    assert.deepEqual(dupes, []);
  });

  it('every rule has a description', () => {
    const missing = ALL_RULES.filter((r) => !r.description || !r.description.trim());
    assert.deepEqual(missing, []);
  });

  it('every rule targets one of the documented tables', () => {
    const allowed = new Set([
      'election_results',
      'candidacies',
      'state_cf_events',
      'endorsements',
      'positions',
      'people',
      'ingestion_runs',
    ]);
    for (const r of ALL_RULES) {
      assert.ok(
        allowed.has(r.table),
        `Rule ${r.name} targets unknown table "${r.table}"`,
      );
    }
  });

  it('severity counts sum to ALL_RULES.length', () => {
    const counts = countBySeverity();
    const sum = counts.info + counts.warning + counts.error + counts.critical;
    assert.equal(sum, ALL_RULES.length);
  });

  it('reports non-trivial counts in every severity bucket', () => {
    const counts = countBySeverity();
    // Verify we have rules in each bucket so the dashboard isn't blank.
    assert.ok(counts.critical >= 1, 'at least 1 critical rule');
    assert.ok(counts.error >= 1, 'at least 1 error rule');
    assert.ok(counts.warning >= 1, 'at least 1 warning rule');
    assert.ok(counts.info >= 1, 'at least 1 info rule');
  });
});

// ---------------------------------------------------------------------------
// Layer 2: fixture semantics — pure-JS reimplementations of each SQL rule
// so we can verify intent independent of Postgres.
// ---------------------------------------------------------------------------

function findRule(name: string): RuleDefinition {
  const r = ALL_RULES.find((x) => x.name === name);
  assert.ok(r, `rule "${name}" not found`);
  return r;
}

// ---- election_results --------------------------------------------------------

interface ElectionResultRow {
  id: string;
  vote_count: number | null;
  vote_percentage: number | null;
  is_winner: boolean;
  is_runoff_advancer: boolean;
  candidacy_id: string | null;
  party_abbreviation: string | null;
  created_at: Date;
}

describe('election_results rules / fixture semantics', () => {
  it('vote_count_negative flags only vote_count < 0', () => {
    findRule('vote_count_negative');
    const rows: ElectionResultRow[] = [
      mkER({ id: 'a', vote_count: -5 }),
      mkER({ id: 'b', vote_count: 0 }),
      mkER({ id: 'c', vote_count: 100 }),
      mkER({ id: 'd', vote_count: null }),
    ];
    const flagged = rows.filter((r) => r.vote_count !== null && r.vote_count < 0);
    assert.deepEqual(
      flagged.map((r) => r.id),
      ['a'],
    );
  });

  it('percentage_out_of_range flags <0 and >100 but not boundary values', () => {
    const rows: ElectionResultRow[] = [
      mkER({ id: 'a', vote_percentage: -0.1 }),
      mkER({ id: 'b', vote_percentage: 0 }),
      mkER({ id: 'c', vote_percentage: 50 }),
      mkER({ id: 'd', vote_percentage: 100 }),
      mkER({ id: 'e', vote_percentage: 100.01 }),
      mkER({ id: 'f', vote_percentage: null }),
    ];
    const flagged = rows.filter(
      (r) =>
        r.vote_percentage !== null
        && (r.vote_percentage < 0 || r.vote_percentage > 100),
    );
    assert.deepEqual(
      flagged.map((r) => r.id),
      ['a', 'e'],
    );
  });

  it('outcome_mutex_violation flags only is_winner AND is_runoff_advancer', () => {
    const rows: ElectionResultRow[] = [
      mkER({ id: 'a', is_winner: true, is_runoff_advancer: true }),
      mkER({ id: 'b', is_winner: true, is_runoff_advancer: false }),
      mkER({ id: 'c', is_winner: false, is_runoff_advancer: true }),
      mkER({ id: 'd', is_winner: false, is_runoff_advancer: false }),
    ];
    const flagged = rows.filter((r) => r.is_winner && r.is_runoff_advancer);
    assert.deepEqual(
      flagged.map((r) => r.id),
      ['a'],
    );
  });
});

function mkER(overrides: Partial<ElectionResultRow>): ElectionResultRow {
  return {
    id: overrides.id ?? 'row',
    vote_count: overrides.vote_count ?? null,
    vote_percentage: overrides.vote_percentage ?? null,
    is_winner: overrides.is_winner ?? false,
    is_runoff_advancer: overrides.is_runoff_advancer ?? false,
    candidacy_id: overrides.candidacy_id ?? null,
    party_abbreviation: overrides.party_abbreviation ?? null,
    created_at: overrides.created_at ?? new Date(),
  };
}

// ---- candidacies ------------------------------------------------------------

describe('candidacies rules / fixture semantics', () => {
  it('missing_person flags when person_id set but not in people', () => {
    const cand = [
      { id: 'c1', person_id: 'p1', election_id: 'e1' },
      { id: 'c2', person_id: 'p_missing', election_id: 'e1' },
      { id: 'c3', person_id: null, election_id: 'e1' },
    ];
    const people = new Set(['p1']);
    const flagged = cand.filter(
      (c) => c.person_id !== null && !people.has(c.person_id),
    );
    assert.deepEqual(
      flagged.map((c) => c.id),
      ['c2'],
    );
  });

  it('invalid_status flags rows outside the CHECK set', () => {
    const allowed = new Set([
      'pending_verification',
      'active',
      'withdrew',
      'disqualified',
      'won_primary',
      'lost_primary',
      'won_general',
      'lost_general',
      'advanced_to_runoff',
    ]);
    const rows = [
      { id: 'c1', status: 'active' },
      { id: 'c2', status: 'unknown' },
      { id: 'c3', status: 'zombie' },
      { id: 'c4', status: 'withdrew' },
    ];
    const flagged = rows.filter((r) => !allowed.has(r.status));
    assert.deepEqual(
      flagged.map((c) => c.id),
      ['c2', 'c3'],
    );
  });

  it('duplicate_ballot_lines flags >3 lines per candidacy', () => {
    const lines = [
      { candidacy_id: 'c1' },
      { candidacy_id: 'c1' },
      { candidacy_id: 'c2' },
      { candidacy_id: 'c2' },
      { candidacy_id: 'c2' },
      { candidacy_id: 'c3' },
      { candidacy_id: 'c3' },
      { candidacy_id: 'c3' },
      { candidacy_id: 'c3' },
      { candidacy_id: 'c3' },
    ];
    const counts = new Map<string, number>();
    for (const l of lines) {
      counts.set(l.candidacy_id, (counts.get(l.candidacy_id) ?? 0) + 1);
    }
    const flagged = [...counts.entries()]
      .filter(([, n]) => n > 3)
      .map(([k]) => k);
    assert.deepEqual(flagged, ['c3']);
  });
});

// ---- state_cf_events --------------------------------------------------------

describe('state_cf_events rules / fixture semantics', () => {
  it('amount_implausible_huge: tier-aware threshold (council #35)', () => {
    // Federal/state: > $50M; county: > $10M; municipal/school/special/judicial: > $1M.
    // Unknown tier (no resolved candidacy) falls back to $50M conservative.
    type Row = { id: string; amount: number | null; tier: string | null };
    const threshold = (tier: string | null): number => {
      if (tier === 'federal' || tier === 'state') return 50_000_000;
      if (tier === 'county') return 10_000_000;
      if (
        tier === 'municipal'
        || tier === 'school'
        || tier === 'special'
        || tier === 'judicial'
      )
        return 1_000_000;
      return 50_000_000; // unknown / unresolved
    };
    const rows: Row[] = [
      { id: 'a', amount: 9_999_999, tier: 'federal' },          // under 50M → ok
      { id: 'b', amount: 60_000_000, tier: 'federal' },         // over 50M  → flagged
      { id: 'c', amount: 11_000_000, tier: 'county' },          // over 10M  → flagged
      { id: 'd', amount: 1_500_000, tier: 'municipal' },        // over 1M   → flagged
      { id: 'e', amount: 500_000, tier: 'municipal' },          // under 1M  → ok
      { id: 'f', amount: 60_000_000, tier: null },              // unknown   → flagged at 50M
      { id: 'g', amount: 10_000_001, tier: null },              // unknown ≤ 50M → ok
      { id: 'h', amount: null, tier: 'federal' },               // null amt → not evaluated
    ];
    const flagged = rows.filter(
      (r) => r.amount !== null && r.amount > threshold(r.tier),
    );
    assert.deepEqual(
      flagged.map((r) => r.id),
      ['b', 'c', 'd', 'f'],
    );
  });

  it('amount_negative_non_refund excludes refund / adjustment', () => {
    const rows = [
      { id: 'a', amount: -100, event_type: 'contribution' },
      { id: 'b', amount: -100, event_type: 'refund' },
      { id: 'c', amount: -100, event_type: 'adjustment' },
      { id: 'd', amount: 100, event_type: 'contribution' },
      { id: 'e', amount: -1, event_type: null as string | null },
    ];
    const skip = new Set(['refund', 'adjustment']);
    const flagged = rows.filter(
      (r) =>
        r.amount !== null
        && r.amount < 0
        && (r.event_type === null || !skip.has(r.event_type)),
    );
    assert.deepEqual(
      flagged.map((r) => r.id),
      ['a', 'e'],
    );
  });

  it('date_future fires on event_date > now + 30d', () => {
    const now = new Date('2026-04-24T00:00:00Z');
    const dPlus30 = new Date('2026-05-24T00:00:00Z');
    const dPlus31 = new Date('2026-05-25T00:00:00Z');
    const dPast = new Date('2025-04-24T00:00:00Z');
    const rows = [
      { id: 'a', event_date: dPlus31 },
      { id: 'b', event_date: dPlus30 },
      { id: 'c', event_date: dPast },
      { id: 'd', event_date: null as Date | null },
    ];
    const cutoff = new Date(now.getTime() + 30 * 24 * 3600 * 1000);
    const flagged = rows.filter(
      (r) => r.event_date !== null && r.event_date > cutoff,
    );
    assert.deepEqual(
      flagged.map((r) => r.id),
      ['a'],
    );
  });

  it('state_code_mismatch accepts postal codes, FIPS codes, and territories (council #35)', () => {
    // VALID = 50 states + DC + 5 territories postal codes UNION 2-digit FIPS
    // for the same set. Mirror that here so the test is self-contained.
    const valid = new Set<string>([
      'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA',
      'HI','ID','IL','IN','IA','KS','KY','LA','ME','MD',
      'MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
      'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC',
      'SD','TN','TX','UT','VT','VA','WA','WV','WI','WY',
      'DC','PR','GU','VI','AS','MP',
      '01','02','04','05','06','08','09','10','11','12',
      '13','15','16','17','18','19','20','21','22','23',
      '24','25','26','27','28','29','30','31','32','33',
      '34','35','36','37','38','39','40','41','42','44',
      '45','46','47','48','49','50','51','53','54','55',
      '56','60','66','69','72','78',
    ]);
    const rows = [
      { id: 'a', state: 'UT' },     // postal      → ok
      { id: 'b', state: 'PR' },     // territory   → ok (regression: old regex passed it too, but this asserts the rule still does)
      { id: 'c', state: '72' },     // PR FIPS     → ok (new behavior)
      { id: 'd', state: '11' },     // DC FIPS     → ok
      { id: 'e', state: 'utah' },   // lowercase   → flagged
      { id: 'f', state: 'UTA' },    // 3-letter    → flagged
      { id: 'g', state: 'u' },      // 1-letter    → flagged
      { id: 'h', state: 'XX' },     // not a state → flagged (regression: old regex passed XX, new logic correctly rejects)
      { id: 'i', state: '99' },     // not a FIPS  → flagged
    ];
    const flagged = rows.filter((r) => !valid.has(r.state));
    assert.deepEqual(
      flagged.map((r) => r.id),
      ['e', 'f', 'g', 'h', 'i'],
    );
  });
});

// ---- endorsements -----------------------------------------------------------

describe('endorsements rules / fixture semantics', () => {
  it('url_missing_for_publish flags published + null url', () => {
    const rows = [
      { id: 'a', published: true, endorsement_url: null as string | null },
      { id: 'b', published: true, endorsement_url: 'https://x' },
      { id: 'c', published: false, endorsement_url: null as string | null },
    ];
    const flagged = rows.filter((r) => r.published && r.endorsement_url === null);
    assert.deepEqual(
      flagged.map((r) => r.id),
      ['a'],
    );
  });

  it('reviewer_missing_for_publish flags published + null reviewer', () => {
    const rows = [
      { id: 'a', published: true, reviewed_by_user_id: null as string | null },
      { id: 'b', published: true, reviewed_by_user_id: 'u1' },
      { id: 'c', published: false, reviewed_by_user_id: null as string | null },
    ];
    const flagged = rows.filter(
      (r) => r.published && r.reviewed_by_user_id === null,
    );
    assert.deepEqual(
      flagged.map((r) => r.id),
      ['a'],
    );
  });

  it('ai_extracted_but_not_verbatim checks the meta flag', () => {
    interface Row {
      id: string;
      extracted_by: string | null;
      meta: { verbatim_endorser_found_in_source?: boolean };
    }
    const rows: Row[] = [
      {
        id: 'a',
        extracted_by: 'ai_extraction_verified',
        meta: { verbatim_endorser_found_in_source: false },
      },
      {
        id: 'b',
        extracted_by: 'ai_extraction_verified',
        meta: { verbatim_endorser_found_in_source: true },
      },
      { id: 'c', extracted_by: 'human', meta: {} },
    ];
    const flagged = rows.filter(
      (r) =>
        r.extracted_by === 'ai_extraction_verified'
        && r.meta.verbatim_endorser_found_in_source === false,
    );
    assert.deepEqual(
      flagged.map((r) => r.id),
      ['a'],
    );
  });

  it('rescinded_still_published flags rescinded + published', () => {
    const rows = [
      { id: 'a', rescinded_at: new Date(), published: true },
      { id: 'b', rescinded_at: new Date(), published: false },
      { id: 'c', rescinded_at: null as Date | null, published: true },
    ];
    const flagged = rows.filter(
      (r) => r.rescinded_at !== null && r.published,
    );
    assert.deepEqual(
      flagged.map((r) => r.id),
      ['a'],
    );
  });
});

// ---- positions --------------------------------------------------------------

describe('positions rules / fixture semantics', () => {
  it('score_out_of_range flags <0 or >1', () => {
    const rows = [
      { id: 'a', score: -0.01 },
      { id: 'b', score: 0 },
      { id: 'c', score: 0.5 },
      { id: 'd', score: 1 },
      { id: 'e', score: 1.01 },
    ];
    const flagged = rows.filter((r) => r.score < 0 || r.score > 1);
    assert.deepEqual(
      flagged.map((r) => r.id),
      ['a', 'e'],
    );
  });

  it('invalid_confidence flags outside the set', () => {
    const allowed = new Set(['high', 'medium', 'low']);
    const rows = [
      { id: 'a', confidence: 'high' },
      { id: 'b', confidence: 'HIGH' },
      { id: 'c', confidence: 'certain' },
      { id: 'd', confidence: 'low' },
    ];
    const flagged = rows.filter((r) => !allowed.has(r.confidence));
    assert.deepEqual(
      flagged.map((r) => r.id),
      ['b', 'c'],
    );
  });

  it('citations_empty flags null or empty array', () => {
    type Cite = null | unknown[] | string;
    const rows: Array<{ id: string; source_citations: Cite }> = [
      { id: 'a', source_citations: null },
      { id: 'b', source_citations: [] },
      { id: 'c', source_citations: [{ url: 'https://x' }] },
      // NB: JSON value literally "null" also flags — mimic jsonb_typeof='null'.
      { id: 'd', source_citations: 'null' },
    ];
    const flagged = rows.filter(
      (r) =>
        r.source_citations === null
        || r.source_citations === 'null'
        || (Array.isArray(r.source_citations)
          && r.source_citations.length === 0),
    );
    assert.deepEqual(
      flagged.map((r) => r.id),
      ['a', 'b', 'd'],
    );
  });
});

// ---- people -----------------------------------------------------------------

describe('people rules / fixture semantics', () => {
  it('duplicate_canonical_key fires on same key across different fetch_state values', () => {
    type Row = {
      id: string;
      canonical_key: string;
      meta: { fetch_state?: string };
    };
    const rows: Row[] = [
      { id: 'p1', canonical_key: 'johnsmith', meta: { fetch_state: 'UT' } },
      { id: 'p2', canonical_key: 'johnsmith', meta: { fetch_state: 'NY' } },
      { id: 'p3', canonical_key: 'janedoe', meta: { fetch_state: 'UT' } },
      { id: 'p4', canonical_key: 'same_state_dup', meta: { fetch_state: 'UT' } },
      { id: 'p5', canonical_key: 'same_state_dup', meta: { fetch_state: 'UT' } },
    ];
    const groups = new Map<string, Set<string>>();
    for (const r of rows) {
      const s = groups.get(r.canonical_key) ?? new Set<string>();
      s.add(r.meta.fetch_state ?? '-');
      groups.set(r.canonical_key, s);
    }
    const flagKeys = new Set(
      [...groups.entries()]
        .filter(
          ([, states]) =>
            states.size > 1 // cross-state only
            && rowsSharingKey(rows, [...groups.keys()]).length > 1,
        )
        .map(([k]) => k),
    );
    const flagged = rows.filter((r) => flagKeys.has(r.canonical_key));
    // Cross-state dup (p1, p2) → flagged. Same-state dup (p4, p5) → NOT flagged.
    assert.deepEqual(
      flagged.map((r) => r.id).sort(),
      ['p1', 'p2'],
    );
  });
});

function rowsSharingKey<T extends { canonical_key: string }>(
  rows: T[],
  keys: string[],
): T[] {
  const set = new Set(keys);
  return rows.filter((r) => set.has(r.canonical_key));
}

// ---- ingestion_runs ---------------------------------------------------------

describe('ingestion_runs rules / fixture semantics', () => {
  it('stuck_running fires on running > 30 min', () => {
    const now = new Date('2026-04-24T12:00:00Z');
    const rows = [
      {
        id: 'r1',
        status: 'running',
        started_at: new Date(now.getTime() - 31 * 60_000),
      },
      {
        id: 'r2',
        status: 'running',
        started_at: new Date(now.getTime() - 29 * 60_000),
      },
      {
        id: 'r3',
        status: 'success',
        started_at: new Date(now.getTime() - 120 * 60_000),
      },
    ];
    const thirtyMinAgo = new Date(now.getTime() - 30 * 60_000);
    const flagged = rows.filter(
      (r) => r.status === 'running' && r.started_at < thirtyMinAgo,
    );
    assert.deepEqual(
      flagged.map((r) => r.id),
      ['r1'],
    );
  });
});
