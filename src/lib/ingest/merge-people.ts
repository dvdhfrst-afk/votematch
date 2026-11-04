/**
 * merge-people.ts - guarded, fully reversible people-merge core.
 *
 * This module holds the pure decision logic and the DB-touching merge / undo
 * routines for collapsing a cluster of duplicate `people` rows (one survivor,
 * one-or-more losers) into the survivor, recording everything moved in a
 * merge_audit row so a single merge can be reversed. The runner
 * (scripts/merge-duplicate-people.ts) is a thin CLI (command-line interface)
 * wrapper around the functions here; the offline test
 * (scripts/_test-merge-duplicate-people.ts) imports the pure helpers and the
 * apply path with a stubbed client.
 *
 * DESIGN (per the 2026-06-15 build brief)
 *   1. Pair source is AUTHORITATIVE, not name-based. The caller (the runner)
 *      re-runs clusterFromOwnership() over the public-domain congress-legislators
 *      id set + live person_xref, so we only ever merge person rows the dataset
 *      says are the SAME human. Names alone never trigger a merge.
 *   2. Survivor selection is DETERMINISTIC: prefer the row holding a bioguide_id
 *      xref; tie-break by most person_xref rows, then most candidacies, then most
 *      office_tenures, then the lexicographically smallest id.
 *   3. Re-point EVERY person_id-referencing column (re-derived at runtime from
 *      pg_constraint). Columns under a UNIQUE that includes the person column are
 *      handled with a SAVEPOINT: try a blind UPDATE; on unique_violation, move
 *      only the non-colliding rows and DELETE the colliding loser rows (snapshot
 *      first, so the delete is reversible). do_not_merge and dedup_review_queue
 *      are handled specially (never blindly re-pointed).
 *   4. Merge survivor fields: union name_variants, append loser to merged_from,
 *      NULL-only backfill a fixed set of scalar columns, fold loser meta under
 *      meta.merged_in[<loser_id>].
 *   5. Tombstone the loser (meta.merged_into = survivor; merged_from cleared). No
 *      hard delete -- the loser row stays so the merge is reversible.
 *   6. Close the pair's conflicting_strong_id dedup_review_queue row
 *      (resolution='merge', target=survivor, reviewed_at=now()).
 *   7. Write one merge_audit row capturing exactly what moved.
 *
 * Single TypeScript runtime, no Python. Uses the shared QueryClient surface from
 * identity-resolve.ts so tests can pass a stub. No em-dashes / en-dashes;
 * acronyms spelled out on first use.
 */
import type { QueryClient } from './identity-resolve';

/**
 * Re-export the shared query surface under a local name so the runner and the
 * offline test can import it from this module without reaching into
 * identity-resolve. A pg (PostgreSQL) Client / PoolClient satisfies it; the test
 * passes an in-memory stub.
 */
export type QueryClientLike = QueryClient;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Scalar people columns we NULL-only backfill from a loser onto the survivor
 * (never overwrite a non-null survivor value). Brief step 4.
 */
export const BACKFILL_COLUMNS = [
  'birth_year',
  'state_fips_primary',
  'contact_email',
  'contact_phone',
  'wikipedia_url',
  'canonical_key',
  'full_legal_name',
] as const;

export type BackfillColumn = (typeof BACKFILL_COLUMNS)[number];

/**
 * Tables that reference people but are NOT re-pointed by the generic plan. They
 * get bespoke handling so we never create a self-pair or stomp review state.
 *   - do_not_merge: a sticky pair table; re-pointing a loser id here could create
 *     a self-pair (a=b) or collide on UNIQUE(a,b). Handled in mergeOne().
 *   - dedup_review_queue: not re-pointed; the pair's row is CLOSED (resolution).
 */
export const SPECIAL_TABLES = new Set<string>(['do_not_merge', 'dedup_review_queue']);

// ---------------------------------------------------------------------------
// Runtime FK re-derivation
// ---------------------------------------------------------------------------

/** A column on some table that references people(id). */
export interface PersonFkColumn {
  table: string;
  column: string;
}

/**
 * Re-derive, from pg_constraint, every column that has a FOREIGN KEY referencing
 * people(id). This keeps the re-point list correct if the schema drifts (a new
 * table adds a person reference, or a column is renamed). We resolve the column
 * name through pg_attribute using the conkey ordinal so other-named columns
 * (bb_person_id, resolved_person_id, primary_person_id, etc.) are found too.
 *
 * SPECIAL_TABLES are excluded here -- they are handled bespoke in mergeOne().
 */
export const PERSON_FK_QUERY = `
  SELECT
    cl.relname  AS table_name,
    att.attname AS column_name
  FROM pg_constraint con
  JOIN pg_class      cl  ON cl.oid = con.conrelid
  JOIN pg_class      ref ON ref.oid = con.confrelid
  JOIN pg_namespace  ns  ON ns.oid = cl.relnamespace
  JOIN unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) ON TRUE
  JOIN pg_attribute  att ON att.attrelid = con.conrelid AND att.attnum = k.attnum
  WHERE con.contype = 'f'
    AND ref.relname = 'people'
    AND ns.nspname = 'public'
  ORDER BY cl.relname, att.attname
`;

export async function derivePersonFkColumns(client: QueryClient): Promise<PersonFkColumn[]> {
  const res = await client.query<{ table_name: string; column_name: string }>(PERSON_FK_QUERY);
  return res.rows
    .map((r) => ({ table: r.table_name, column: r.column_name }))
    .filter((c) => !SPECIAL_TABLES.has(c.table));
}

/**
 * For each (table, column) that references people, look up whether any UNIQUE
 * constraint or unique index on that table INCLUDES the column. When it does, a
 * blind UPDATE of the column can violate the unique, so the merge uses the
 * collision-safe path. Pure given the unique-membership lookup.
 *
 * This query returns, for every referencing column, a boolean has_unique_with_col.
 */
export const PERSON_FK_UNIQUE_QUERY = `
  WITH fk AS (
    SELECT cl.oid AS relid, cl.relname AS table_name, att.attname AS column_name, k.attnum
    FROM pg_constraint con
    JOIN pg_class cl ON cl.oid = con.conrelid
    JOIN pg_class ref ON ref.oid = con.confrelid
    JOIN pg_namespace ns ON ns.oid = cl.relnamespace
    JOIN unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) ON TRUE
    JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = k.attnum
    WHERE con.contype = 'f' AND ref.relname = 'people' AND ns.nspname = 'public'
  ),
  -- UNIQUE constraints whose key list includes the fk column.
  uniq_con AS (
    SELECT fk.table_name, fk.column_name, TRUE AS has_unique
    FROM fk
    JOIN pg_constraint uc ON uc.conrelid = fk.relid AND uc.contype = 'u'
                          AND fk.attnum = ANY (uc.conkey)
  ),
  -- UNIQUE indexes (covers UNIQUE created via CREATE UNIQUE INDEX) including the col.
  uniq_idx AS (
    SELECT fk.table_name, fk.column_name, TRUE AS has_unique
    FROM fk
    JOIN pg_index ix ON ix.indrelid = fk.relid AND ix.indisunique
                     AND fk.attnum = ANY (ix.indkey::int2[])
  )
  SELECT DISTINCT table_name, column_name FROM (
    SELECT table_name, column_name FROM uniq_con
    UNION
    SELECT table_name, column_name FROM uniq_idx
  ) u
`;

export async function derivePersonFkUniqueColumns(
  client: QueryClient
): Promise<Set<string>> {
  const res = await client.query<{ table_name: string; column_name: string }>(
    PERSON_FK_UNIQUE_QUERY
  );
  const set = new Set<string>();
  for (const r of res.rows) set.add(`${r.table_name}.${r.column_name}`);
  return set;
}

/**
 * For a table whose person-referencing column participates in a UNIQUE but which
 * has NO single-column primary key, derive the KEY columns of the (smallest)
 * unique constraint / unique index that INCLUDES the person column. We pick the
 * narrowest such key so the value-keyed collision check below matches the
 * tightest constraint. Returns the ordered list of key column names, or null
 * when none can be determined (caller then falls back to per-row by ctid).
 *
 * This extends the unique-membership lookup (derivePersonFkUniqueColumns) to
 * return the constraint's ACTUAL key columns, so the no-pk collision check keys
 * on the real unique key instead of full-row equality.
 */
export async function deriveUniqueKeyColumns(
  client: QueryClient,
  table: string,
  personColumn: string
): Promise<string[] | null> {
  const res = await client.query<{ key_cols: string[] }>(
    `WITH tbl AS (
       SELECT cl.oid AS relid
         FROM pg_class cl
         JOIN pg_namespace ns ON ns.oid = cl.relnamespace
        WHERE cl.relname = $1::text AND ns.nspname = 'public'
     ),
     -- UNIQUE constraints on the table that include the person column.
     con_keys AS (
       SELECT uc.conkey AS keys
         FROM pg_constraint uc
         JOIN tbl ON tbl.relid = uc.conrelid
        WHERE uc.contype = 'u'
          AND (SELECT att.attnum FROM pg_attribute att
                WHERE att.attrelid = uc.conrelid AND att.attname = $2::text) = ANY (uc.conkey)
     ),
     -- UNIQUE indexes on the table that include the person column.
     idx_keys AS (
       SELECT ix.indkey::int2[]::int2[] AS keys
         FROM pg_index ix
         JOIN tbl ON tbl.relid = ix.indrelid
        WHERE ix.indisunique
          AND (SELECT att.attnum FROM pg_attribute att
                WHERE att.attrelid = ix.indrelid AND att.attname = $2::text) = ANY (ix.indkey::int2[])
     ),
     all_keys AS (
       SELECT keys FROM con_keys
       UNION ALL
       SELECT keys::int2[] FROM idx_keys
     ),
     -- Narrowest key wins (fewest columns).
     chosen AS (
       SELECT keys FROM all_keys ORDER BY array_length(keys, 1) ASC NULLS LAST LIMIT 1
     )
     SELECT array_agg(att.attname ORDER BY k.ord) AS key_cols
       FROM chosen
       JOIN unnest(chosen.keys) WITH ORDINALITY AS k(attnum, ord) ON TRUE
       JOIN tbl ON TRUE
       JOIN pg_attribute att ON att.attrelid = tbl.relid AND att.attnum = k.attnum`,
    [table, personColumn]
  );
  const cols = res.rows[0]?.key_cols;
  return cols && cols.length > 0 ? cols : null;
}

// ---------------------------------------------------------------------------
// Survivor selection (pure)
// ---------------------------------------------------------------------------

/**
 * Per-person attributes the survivor rule weighs. The caller loads these once
 * for the whole cluster from the live DB; selectSurvivor is then pure.
 */
export interface SurvivorCandidate {
  id: string;
  /** True iff this person holds a bioguide_id row in person_xref. */
  has_bioguide: boolean;
  /** Count of person_xref rows for this person. */
  xref_count: number;
  /** Count of candidacies rows for this person. */
  candidacy_count: number;
  /** Count of office_tenures rows for this person. */
  tenure_count: number;
}

/**
 * Deterministic survivor selection (brief step 2):
 *   1. Prefer the row that holds a bioguide_id xref.
 *   2. Tie-break by most person_xref rows.
 *   3. Then most candidacies.
 *   4. Then most office_tenures.
 *   5. Then lexicographically smallest id.
 * Returns the survivor id; the rest of the cluster are losers.
 */
export function selectSurvivor(candidates: SurvivorCandidate[]): string {
  if (candidates.length === 0) throw new Error('selectSurvivor: empty cluster');
  const sorted = [...candidates].sort((a, b) => {
    if (a.has_bioguide !== b.has_bioguide) return a.has_bioguide ? -1 : 1;
    if (a.xref_count !== b.xref_count) return b.xref_count - a.xref_count;
    if (a.candidacy_count !== b.candidacy_count) return b.candidacy_count - a.candidacy_count;
    if (a.tenure_count !== b.tenure_count) return b.tenure_count - a.tenure_count;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return sorted[0].id;
}

/** Load the SurvivorCandidate attributes for a set of person ids. */
export async function loadSurvivorCandidates(
  client: QueryClient,
  personIds: string[]
): Promise<SurvivorCandidate[]> {
  if (personIds.length === 0) return [];
  const res = await client.query<{
    id: string;
    has_bioguide: boolean;
    xref_count: string | number;
    candidacy_count: string | number;
    tenure_count: string | number;
  }>(
    `SELECT
        p.id,
        EXISTS (SELECT 1 FROM person_xref x WHERE x.person_id = p.id AND x.kind = 'bioguide_id') AS has_bioguide,
        (SELECT count(*) FROM person_xref x WHERE x.person_id = p.id)     AS xref_count,
        (SELECT count(*) FROM candidacies c WHERE c.person_id = p.id)     AS candidacy_count,
        (SELECT count(*) FROM office_tenures t WHERE t.person_id = p.id)  AS tenure_count
       FROM people p
      WHERE p.id = ANY($1::uuid[])`,
    [personIds]
  );
  return res.rows.map((r) => ({
    id: r.id,
    has_bioguide: r.has_bioguide === true,
    xref_count: Number(r.xref_count) || 0,
    candidacy_count: Number(r.candidacy_count) || 0,
    tenure_count: Number(r.tenure_count) || 0,
  }));
}

// ---------------------------------------------------------------------------
// Per-table re-point with collision-safe fallback
// ---------------------------------------------------------------------------

/** Audit entry for one referencing column's re-point. */
export interface MovedEntry {
  table: string;
  column: string;
  moved_count: number;
  /**
   * The row identifiers ACTUALLY moved loser -> survivor for this column. undo
   * moves back EXACTLY these rows (never the survivor's own pre-existing rows).
   * Each element is the table's single-column primary key (as text) when one
   * exists, otherwise the row's ctid (as text). `key_kind` records which, so undo
   * keys the reverse UPDATE on the right expression.
   *
   * NOTE on ctid: when a table has no single-column primary key we fall back to
   * ctid. A ctid is only stable until the row is vacuumed or updated. For the
   * short-lived merge -> undo window this is acceptable; if a vacuum/update moves a
   * row between merge and undo, that row's reverse-move silently no-ops (the undo
   * reconciliation check will warn when fewer rows move back than were recorded).
   * Tables with a real single-column pk (the common case) are fully stable.
   */
  moved_keys: string[];
  /** Whether moved_keys are primary-key values ('pk') or ctids ('ctid'). */
  key_kind: 'pk' | 'ctid';
  /**
   * Loser rows DELETED because the survivor already held an equivalent under a
   * UNIQUE that includes the person column. Each carries a full snapshot so undo
   * can re-insert it onto the loser (an FK re-point alone can never resurrect a
   * deleted row). Populated only in the default 'snapshot-delete' collision mode.
   */
  deleted_collisions: Array<{ pk: string | null; snapshot: Record<string, unknown> }>;
  /**
   * Loser rows RETAINED in place (not deleted) because the survivor already held
   * an equivalent under a UNIQUE that includes the person column and the caller
   * chose collisionMode 'archive-in-place'. The row keeps pointing at the
   * tombstoned loser person (the FK stays valid because the loser person row is
   * retained). When the table has a meta JSONB column we stamp an archive marker
   * on the retained row; undo removes it. For candidacies specifically we also
   * NULL-only backfill the survivor's colliding row from the loser's richer row
   * and record that (winner_backfill) so it is auditable and undoable.
   *
   * Only ever present when collisionMode is 'archive-in-place'; legacy audit rows
   * (and all 'snapshot-delete' rows) omit this field entirely, so undo must
   * tolerate its absence.
   */
  retained_collisions?: Array<{
    /** The retained loser row's primary key (as text) when one exists, else null. */
    pk: string | null;
    /** Full snapshot of the retained loser row (before any archive stamp). */
    snapshot: Record<string, unknown>;
    /**
     * The archive marker stamped onto the retained row's meta column, when the
     * table has one. Undo removes exactly this key. Absent when the table has no
     * meta column (row left fully untouched).
     */
    meta_archive_key?: string;
    /**
     * For candidacies: the NULL-only content backfill applied to the survivor's
     * colliding row, as { column: { before, after } }. Undo reverts each to its
     * "before" value. Keyed on the SURVIVOR row's primary key (winner_pk).
     */
    winner_backfill?: {
      winner_pk: string | null;
      columns: Record<string, { before: unknown; after: unknown }>;
    };
  }>;
}

/** Merge_audit-recorded collision handling for a person-inclusive UNIQUE column. */
export type CollisionMode = 'snapshot-delete' | 'archive-in-place';

/** The meta-archive marker key stamped onto a retained colliding row. */
export const RETAINED_META_KEY = 'superseded_by_person_merge';

/**
 * Content columns on candidacies we NULL-only backfill from a colliding loser
 * candidacy onto the survivor's colliding candidacy in 'archive-in-place' mode,
 * so the richer row's content is not stranded on the tombstoned loser's row.
 * Verified against migrations 20260420000006 (base) + 20260426000001 (content
 * columns). Every column is verified to exist at runtime via pg_attribute before
 * use, so a schema that lacks one is skipped rather than erroring.
 */
export const CANDIDACY_CONTENT_COLUMNS = [
  'party',
  'ballot_designation',
  'filed_on',
  'qualified_for_ballot_on',
  'withdrew_on',
  'vote_count',
  'vote_percentage',
  'campaign_email',
  'website',
  'summary',
  'statement',
  'legacy_candidate_id',
] as const;

/**
 * The fully-qualified primary-key column for a table, so we can snapshot + delete
 * colliding rows precisely. Falls back to NULL pk reporting when a table has no
 * single-column pk (rare; the snapshot still captures the row for re-insert).
 */
async function primaryKeyColumn(client: QueryClient, table: string): Promise<string | null> {
  const res = await client.query<{ attname: string }>(
    `SELECT att.attname
       FROM pg_index ix
       JOIN pg_class cl ON cl.oid = ix.indrelid
       JOIN pg_namespace ns ON ns.oid = cl.relnamespace
       JOIN pg_attribute att ON att.attrelid = ix.indrelid AND att.attnum = ANY(ix.indkey::int2[])
      WHERE ix.indisprimary AND cl.relname = $1 AND ns.nspname = 'public'`,
    [table]
  );
  // Only return a single-column pk; composite pks fall back to NULL pk reporting.
  return res.rowCount === 1 ? res.rows[0].attname : null;
}

/**
 * Does `table` have a `meta` JSONB column? Cached per client so the archive path
 * only probes pg_attribute once per table for the life of the connection. We key
 * the cache on the client object identity via a WeakMap so a stubbed client in a
 * test and a real pg Client never share cached answers.
 */
const META_COLUMN_CACHE = new WeakMap<object, Map<string, boolean>>();

export async function tableHasMetaColumn(
  client: QueryClient,
  table: string
): Promise<boolean> {
  let byTable = META_COLUMN_CACHE.get(client as object);
  if (!byTable) {
    byTable = new Map<string, boolean>();
    META_COLUMN_CACHE.set(client as object, byTable);
  }
  const cached = byTable.get(table);
  if (cached !== undefined) return cached;
  const res = await client.query<{ has_meta: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_attribute att
       JOIN pg_class cl ON cl.oid = att.attrelid
       JOIN pg_namespace ns ON ns.oid = cl.relnamespace
       WHERE cl.relname = $1::text AND ns.nspname = 'public'
         AND att.attname = 'meta' AND att.attnum > 0 AND NOT att.attisdropped
     ) AS has_meta`,
    [table]
  );
  const has = res.rows[0]?.has_meta === true;
  byTable.set(table, has);
  return has;
}

/**
 * Which of CANDIDACY_CONTENT_COLUMNS actually exist on the candidacies table.
 * Cached per client (same rationale as tableHasMetaColumn). Returned as an
 * ordered subset of CANDIDACY_CONTENT_COLUMNS so the backfill is deterministic.
 */
const CANDIDACY_CONTENT_CACHE = new WeakMap<object, string[]>();

export async function candidacyContentColumns(client: QueryClient): Promise<string[]> {
  const cached = CANDIDACY_CONTENT_CACHE.get(client as object);
  if (cached !== undefined) return cached;
  const res = await client.query<{ attname: string }>(
    `SELECT att.attname
       FROM pg_attribute att
       JOIN pg_class cl ON cl.oid = att.attrelid
       JOIN pg_namespace ns ON ns.oid = cl.relnamespace
      WHERE cl.relname = 'candidacies' AND ns.nspname = 'public'
        AND att.attnum > 0 AND NOT att.attisdropped`,
    []
  );
  const present = new Set(res.rows.map((r) => r.attname));
  const cols = CANDIDACY_CONTENT_COLUMNS.filter((c) => present.has(c));
  CANDIDACY_CONTENT_CACHE.set(client as object, cols);
  return cols;
}

/**
 * Re-point one referencing column from loser -> survivor.
 *
 *  - When the column is NOT under a person-inclusive UNIQUE: a single blind bulk
 *    UPDATE (no collision is possible).
 *  - When it IS under a person-inclusive UNIQUE: a PER-ROW try-move-else-snapshot-
 *    delete. We never need to know which columns form the unique key:
 *      1. Select the loser's rows for this column (their row key + a full to_jsonb
 *         snapshot). The row key is the single-column primary key when one exists,
 *         otherwise the row's ctid.
 *      2. For EACH loser row, in its own SAVEPOINT:
 *           - try `UPDATE table SET <col> = survivor WHERE <rowkey> = thisrow`.
 *           - if that throws SQLSTATE 23505 (unique_violation): ROLLBACK TO the
 *             savepoint, then handle by collisionMode:
 *               * 'snapshot-delete' (default): record the row's full snapshot in
 *                 entry.deleted_collisions and DELETE that single row. The snapshot
 *                 makes the delete reversible. This is the historical behavior and
 *                 keeps merge-duplicate-people.ts byte-for-byte unchanged.
 *               * 'archive-in-place': NEVER delete. Leave the colliding loser row
 *                 where it is (its FK stays valid because the loser person row is
 *                 retained/tombstoned, not deleted). When the table has a meta JSONB
 *                 column, stamp meta.superseded_by_person_merge = { survivor_id,
 *                 merged_at }. For candidacies, additionally NULL-only backfill the
 *                 survivor's colliding row from the loser's richer content. Record
 *                 all of this in entry.retained_collisions so undo reverses it.
 *           - else: RELEASE the savepoint and count the row moved.
 *
 * This is correct regardless of WHICH columns form the unique key: a row that can
 * be moved without a 23505 is, by definition, not colliding; a row that cannot is.
 * It also avoids the old bug where full-row equality failed to flag a genuine
 * unique-key collision (e.g. two candidacies sharing election_id but differing on
 * status / vote_count), which then violated the constraint on the bulk move.
 *
 * Every parameter carries an explicit cast (survivor/loser as ::uuid, the row key
 * as ::text or ::tid) so Postgres can never deduce an ambiguous parameter type
 * ("inconsistent types deduced for parameter $N").
 *
 * The MovedEntry records moved_keys: the identifier of every row actually moved
 * loser -> survivor. undo replays the reverse UPDATE against exactly these keys,
 * so the survivor's own pre-existing rows are never disturbed. key_kind says
 * whether the keys are primary-key values or ctids.
 *
 * Returns the audit MovedEntry for this column.
 */
export async function repointColumn(
  client: QueryClient,
  table: string,
  column: string,
  survivorId: string,
  loserId: string,
  isUnique: boolean,
  collisionMode: CollisionMode = 'snapshot-delete'
): Promise<MovedEntry> {
  // Resolve the row-key strategy once: single-column pk when one exists, else
  // ctid. Both the bulk and per-row paths key moved_keys on this so undo can
  // reverse exactly the rows that moved.
  const pk = await primaryKeyColumn(client, table);
  const keyKind: 'pk' | 'ctid' = pk ? 'pk' : 'ctid';
  const entry: MovedEntry = {
    table,
    column,
    moved_count: 0,
    moved_keys: [],
    key_kind: keyKind,
    deleted_collisions: [],
  };

  if (!isUnique) {
    // No unique includes the person column: a blind bulk move is always safe.
    // RETURNING the row key captures EXACTLY which rows moved, so undo never
    // touches the survivor's own pre-existing rows. We RETURN the pk when there
    // is one, otherwise ctid (cast to text for a stable text[] payload).
    const returnExpr = pk ? `${pk}::text` : `ctid::text`;
    const upd = await client.query<{ k: string }>(
      `UPDATE ${table} SET ${column} = $1::uuid WHERE ${column} = $2::uuid RETURNING ${returnExpr} AS k`,
      [survivorId, loserId]
    );
    entry.moved_keys = upd.rows.map((r) => r.k);
    entry.moved_count = upd.rowCount ?? entry.moved_keys.length;
    return entry;
  }

  // Collision-safe PER-ROW path. Snapshot the loser's rows for this column up
  // front (full to_jsonb so a deleted collision is reversible), keyed by the
  // single-column primary key when one exists, otherwise by ctid.
  const keyExpr = pk ? `l.${pk}::text` : `l.ctid::text`;
  const rows = await client.query<{ rowkey: string; snapshot: Record<string, unknown> }>(
    `SELECT ${keyExpr} AS rowkey, to_jsonb(l) AS snapshot
       FROM ${table} l
      WHERE l.${column} = $1::uuid`,
    [loserId]
  );

  // Per-row UPDATE / DELETE statements. The WHERE clause keys on the pk (cast as
  // text via ANY for the simple-equality case) or on ctid. We cast the row key
  // parameter explicitly so its type is never ambiguously deduced.
  // The move keys on the row key as $2 (survivor is $1). The delete keys on the
  // row key as $1 (no survivor parameter), so each query's parameter list matches
  // exactly the placeholders it uses (pg rejects extra/unused bind parameters).
  const moveWhere = pk ? `${pk}::text = $2::text` : `ctid = $2::tid`;
  const deleteWhere = pk ? `${pk}::text = $1::text` : `ctid = $1::tid`;
  const moveSql = `UPDATE ${table} SET ${column} = $1::uuid WHERE ${moveWhere}`;
  const deleteSql = `DELETE FROM ${table} WHERE ${deleteWhere}`;

  // In 'archive-in-place' mode we may stamp a meta marker on a retained colliding
  // loser row, so resolve once whether the table carries a meta JSONB column and
  // (for candidacies) which content columns exist for the survivor backfill.
  const archive = collisionMode === 'archive-in-place';
  const hasMeta = archive ? await tableHasMetaColumn(client, table) : false;
  const contentCols =
    archive && table === 'candidacies' ? await candidacyContentColumns(client) : [];

  for (const row of rows.rows) {
    await client.query('SAVEPOINT repoint_row_sp');
    try {
      const moved = await client.query(moveSql, [survivorId, row.rowkey]);
      await client.query('RELEASE SAVEPOINT repoint_row_sp');
      entry.moved_count += moved.rowCount ?? 0;
      // Record the key of every row actually moved (NOT the collision rows below,
      // which are restored separately from deleted_collisions / retained_collisions).
      entry.moved_keys.push(row.rowkey);
    } catch (e) {
      const code = (e as { code?: string }).code;
      await client.query('ROLLBACK TO SAVEPOINT repoint_row_sp');
      await client.query('RELEASE SAVEPOINT repoint_row_sp');
      if (code !== '23505') {
        // Not a unique violation: a real error. The savepoint is already rolled
        // back; rethrow so the enclosing per-cluster transaction aborts.
        throw e;
      }
      // Genuine unique-key collision: the survivor already holds an equivalent
      // row under the unique.
      if (!archive) {
        // Default mode: snapshot (for undo) then delete the loser's row.
        entry.deleted_collisions.push({ pk: pk ? row.rowkey : null, snapshot: row.snapshot });
        await client.query(deleteSql, [row.rowkey]);
        continue;
      }
      // 'archive-in-place' mode: leave the loser's colliding row where it is
      // (still pointing at the tombstoned loser person -- the FK stays valid
      // because the loser person row is retained). Optionally stamp an archive
      // marker + backfill the survivor's richer content, all recorded for undo.
      const retained: NonNullable<MovedEntry['retained_collisions']>[number] = {
        pk: pk ? row.rowkey : null,
        snapshot: row.snapshot,
      };

      // candidacies: NULL-only backfill the survivor's colliding row from the
      // loser's row so the richer content is not stranded on the tombstoned
      // person. Record before/after per column for undo.
      if (table === 'candidacies' && contentCols.length > 0) {
        const bf = await backfillCandidacyCollision(
          client,
          survivorId,
          row.snapshot,
          contentCols,
          pk
        );
        if (bf) retained.winner_backfill = bf;
      }

      // Stamp the archive marker on the retained loser row's meta (if the table
      // has one), so it is visibly superseded and excludable from live queries.
      // The row key is $3 here (NOT $1) because $1/$2 carry the jsonb_set path +
      // value; reusing deleteWhere's $1 would bind the key to the path array.
      if (hasMeta) {
        const marker = {
          survivor_id: survivorId,
          merged_at: new Date().toISOString(),
        };
        const stampWhere = pk ? `${pk}::text = $3::text` : `ctid = $3::tid`;
        await client.query(
          `UPDATE ${table}
              SET meta = jsonb_set(COALESCE(meta, '{}'::jsonb), $1::text[], $2::jsonb, true)
            WHERE ${stampWhere}`,
          [[RETAINED_META_KEY], JSON.stringify(marker), row.rowkey]
        );
        retained.meta_archive_key = RETAINED_META_KEY;
      }

      if (!entry.retained_collisions) entry.retained_collisions = [];
      entry.retained_collisions.push(retained);
    }
  }

  return entry;
}

/**
 * NULL-only backfill the survivor's colliding candidacy row (same election_id as
 * the loser's colliding row) from the loser's richer content, plus fill-if-null
 * top-level meta keys. Only columns where the survivor is currently NULL/empty
 * and the loser has a value are changed. Returns the recorded before/after map
 * (keyed on the survivor row's primary key) for undo, or null when nothing was
 * changed. The survivor row is located by (person_id = survivor AND election_id =
 * loser's election_id), which is exactly the UNIQUE(election_id, person_id) key
 * the collision fired on.
 */
async function backfillCandidacyCollision(
  client: QueryClient,
  survivorId: string,
  loserSnapshot: Record<string, unknown>,
  contentCols: string[],
  pk: string | null
): Promise<NonNullable<MovedEntry['retained_collisions']>[number]['winner_backfill'] | null> {
  const electionId = loserSnapshot['election_id'];
  if (electionId == null) return null;

  // Load the survivor's colliding candidacy (the UNIQUE(election_id, person_id)
  // partner of the loser's row).
  const selCols = [...contentCols, 'meta'];
  const winnerRes = await client.query<Record<string, unknown>>(
    `SELECT ${pk ? `${pk}::text AS __pk, ` : ''}${selCols.map((c) => `"${c}"`).join(', ')}
       FROM candidacies
      WHERE person_id = $1::uuid AND election_id = $2::uuid
      LIMIT 1`,
    [survivorId, electionId]
  );
  const winner = winnerRes.rows[0];
  if (!winner) return null;
  const winnerPk = pk ? ((winner['__pk'] as string) ?? null) : null;

  const isEmpty = (val: unknown): boolean => val == null || val === '';

  const setFragments: string[] = [];
  const params: unknown[] = [];
  const columns: Record<string, { before: unknown; after: unknown }> = {};

  // Scalar content columns: NULL-only backfill.
  for (const col of contentCols) {
    const cur = winner[col];
    const incoming = loserSnapshot[col];
    if (isEmpty(cur) && !isEmpty(incoming)) {
      params.push(incoming);
      setFragments.push(`"${col}" = $${params.length}`);
      columns[col] = { before: cur ?? null, after: incoming };
    }
  }

  // meta: fill-if-null top-level keys (never overwrite a present survivor key).
  const winnerMeta =
    winner['meta'] && typeof winner['meta'] === 'object' && !Array.isArray(winner['meta'])
      ? (winner['meta'] as Record<string, unknown>)
      : {};
  const loserMeta =
    loserSnapshot['meta'] && typeof loserSnapshot['meta'] === 'object' && !Array.isArray(loserSnapshot['meta'])
      ? (loserSnapshot['meta'] as Record<string, unknown>)
      : {};
  const newMeta: Record<string, unknown> = { ...winnerMeta };
  let metaChanged = false;
  for (const [k, val] of Object.entries(loserMeta)) {
    const cur = newMeta[k];
    if (cur == null || cur === '' || (Array.isArray(cur) && cur.length === 0)) {
      if (val != null && val !== '') {
        newMeta[k] = val;
        metaChanged = true;
      }
    }
  }
  if (metaChanged) {
    params.push(JSON.stringify(newMeta));
    setFragments.push(`meta = $${params.length}::jsonb`);
    columns['meta'] = { before: winnerMeta, after: newMeta };
  }

  if (setFragments.length === 0) return null;

  const whereExpr = winnerPk
    ? `${pk}::text = $${params.length + 1}::text`
    : `person_id = $${params.length + 1}::uuid AND election_id = $${params.length + 2}::uuid`;
  if (winnerPk) params.push(winnerPk);
  else {
    params.push(survivorId);
    params.push(electionId);
  }
  await client.query(
    `UPDATE candidacies SET ${setFragments.join(', ')}, updated_at = now() WHERE ${whereExpr}`,
    params
  );

  return { winner_pk: winnerPk, columns };
}

// ---------------------------------------------------------------------------
// people-field merge (pure planning + DB apply)
// ---------------------------------------------------------------------------

export interface PeopleRow {
  id: string;
  canonical_name: string | null;
  canonical_key: string | null;
  full_legal_name: string | null;
  name_variants: string[] | null;
  birth_year: number | null;
  state_fips_primary: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  wikipedia_url: string | null;
  merged_from: string[] | null;
  meta: Record<string, unknown> | null;
}

export const PEOPLE_SELECT_COLUMNS =
  `id, canonical_name, canonical_key, full_legal_name, name_variants, birth_year,
   state_fips_primary, contact_email, contact_phone, wikipedia_url, merged_from, meta`;

export async function loadPeopleRow(client: QueryClient, id: string): Promise<PeopleRow | null> {
  const r = await client.query<PeopleRow>(
    `SELECT ${PEOPLE_SELECT_COLUMNS} FROM people WHERE id = $1`,
    [id]
  );
  return r.rows[0] ?? null;
}

export interface PeopleBackfillPlan {
  /** column -> { before, after } for each scalar column we will set. */
  backfilled: Record<string, { before: unknown; after: unknown }>;
  /** loser ids appended to survivor.merged_from this merge (just [loser]). */
  merged_from_appended: string[];
  /** name variants unioned onto the survivor this merge. */
  name_variants_added: string[];
  /** the meta.merged_in.<loser_id> key written. */
  meta_merged_in_key: string;
  /** the survivor's resulting name_variants array. */
  result_name_variants: string[];
  /** the survivor's resulting merged_from array. */
  result_merged_from: string[];
  /** the survivor's resulting meta jsonb. */
  result_meta: Record<string, unknown>;
}

/**
 * PURE: compute the survivor field-merge. Brief step 4:
 *   - union name_variants (survivor existing + loser names + loser canonical_name)
 *   - append loser.id to merged_from
 *   - NULL-only backfill the BACKFILL_COLUMNS scalar fields from loser
 *   - fold loser meta under meta.merged_in[<loser_id>]
 */
export function planPeopleMerge(survivor: PeopleRow, loser: PeopleRow): PeopleBackfillPlan {
  // name_variants union (case-insensitive dedupe, never drop existing).
  const variants = [...(survivor.name_variants ?? [])];
  const seen = new Set(variants.map((v) => v.toLowerCase()));
  const addVariant = (v: string | null | undefined) => {
    if (!v) return;
    if (!seen.has(v.toLowerCase())) {
      seen.add(v.toLowerCase());
      variants.push(v);
    }
  };
  const addedBefore = variants.length;
  for (const v of loser.name_variants ?? []) addVariant(v);
  addVariant(loser.canonical_name);
  const name_variants_added = variants.slice(addedBefore);

  // merged_from: append loser id (dedupe, keep order).
  const mergedFrom = [...(survivor.merged_from ?? [])];
  const mfSet = new Set(mergedFrom);
  const merged_from_appended: string[] = [];
  if (!mfSet.has(loser.id)) {
    mergedFrom.push(loser.id);
    merged_from_appended.push(loser.id);
  }

  // NULL-only scalar backfill.
  const backfilled: Record<string, { before: unknown; after: unknown }> = {};
  const surv = survivor as unknown as Record<string, unknown>;
  const los = loser as unknown as Record<string, unknown>;
  for (const col of BACKFILL_COLUMNS) {
    const cur = surv[col];
    const incoming = los[col];
    const isEmpty = cur == null || cur === '';
    if (isEmpty && incoming != null && incoming !== '') {
      backfilled[col] = { before: cur ?? null, after: incoming };
    }
  }

  // meta: fold loser meta under meta.merged_in[<loser_id>], never touching other
  // survivor meta keys.
  const meta: Record<string, unknown> = { ...(survivor.meta ?? {}) };
  const mergedIn: Record<string, unknown> =
    meta.merged_in && typeof meta.merged_in === 'object' && !Array.isArray(meta.merged_in)
      ? { ...(meta.merged_in as Record<string, unknown>) }
      : {};
  mergedIn[loser.id] = loser.meta ?? {};
  meta.merged_in = mergedIn;
  const meta_merged_in_key = `merged_in.${loser.id}`;

  return {
    backfilled,
    merged_from_appended,
    name_variants_added,
    meta_merged_in_key,
    result_name_variants: variants,
    result_merged_from: mergedFrom,
    result_meta: meta,
  };
}

/** Apply the planned survivor field-merge to the DB. */
export async function applyPeopleMerge(
  client: QueryClient,
  survivorId: string,
  plan: PeopleBackfillPlan
): Promise<void> {
  const sets: string[] = [
    `name_variants = $2::text[]`,
    `merged_from = $3::uuid[]`,
    `meta = $4::jsonb`,
  ];
  const params: unknown[] = [
    survivorId,
    plan.result_name_variants,
    plan.result_merged_from,
    JSON.stringify(plan.result_meta),
  ];
  for (const [col, { after }] of Object.entries(plan.backfilled)) {
    params.push(after);
    // NULL-only guard re-applied in SQL so a concurrent writer can't be stomped.
    sets.push(`${col} = COALESCE(${col}, $${params.length})`);
  }
  await client.query(
    `UPDATE people SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`,
    params
  );
}

/**
 * Tombstone the loser (brief step 5): meta.merged_into = survivor, merged_from
 * cleared. NO hard delete. Captures the loser's prior meta + merged_from so undo
 * can restore them (returned for the audit payload).
 */
export async function tombstoneLoser(
  client: QueryClient,
  loser: PeopleRow,
  survivorId: string
): Promise<{ prior_meta: Record<string, unknown>; prior_merged_from: string[] }> {
  const priorMeta = { ...(loser.meta ?? {}) };
  const priorMergedFrom = [...(loser.merged_from ?? [])];
  const newMeta: Record<string, unknown> = { ...priorMeta };
  newMeta.merged_into = survivorId;
  newMeta.merged_into_at = new Date().toISOString();
  await client.query(
    `UPDATE people SET meta = $2::jsonb, merged_from = '{}'::uuid[], updated_at = now() WHERE id = $1`,
    [loser.id, JSON.stringify(newMeta)]
  );
  return { prior_meta: priorMeta, prior_merged_from: priorMergedFrom };
}

// ---------------------------------------------------------------------------
// do_not_merge + dedup_review_queue handling
// ---------------------------------------------------------------------------

/**
 * Is (survivor, loser) a sticky do-not-merge pair? Order-insensitive. The runner
 * must SKIP any pair present here BEFORE attempting a merge.
 */
export async function isStickyPair(
  client: QueryClient,
  a: string,
  b: string
): Promise<boolean> {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  const res = await client.query(
    `SELECT 1 FROM do_not_merge WHERE person_id_a = $1 AND person_id_b = $2 LIMIT 1`,
    [lo, hi]
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * Re-point do_not_merge entries for a loser that is being merged, WITHOUT ever
 * creating a self-pair (a = b). For each do_not_merge row touching the loser:
 *   - if the other side is the survivor, that pair would become a self-pair --
 *     DELETE it (it is meaningless after the merge).
 *   - otherwise repoint the loser side to the survivor, re-canonicalizing the
 *     (a < b) order, and ON CONFLICT do nothing (the survivor may already carry
 *     the same sticky pair).
 * The runner guarantees the (survivor, loser) pair itself is NOT sticky (it
 * skips sticky pairs), so this only moves the loser's OTHER sticky relationships.
 * Returns the count moved + deleted for the audit.
 */
export async function repointDoNotMerge(
  client: QueryClient,
  survivorId: string,
  loserId: string
): Promise<MovedEntry> {
  const entry: MovedEntry = {
    table: 'do_not_merge',
    column: 'person_id_a/person_id_b',
    moved_count: 0,
    // do_not_merge is restored bespoke from deleted_collisions in undoOne, never
    // via the moved_keys reverse-UPDATE path; these stay empty for it.
    moved_keys: [],
    key_kind: 'pk',
    deleted_collisions: [],
  };

  // Snapshot every do_not_merge row touching the loser (for undo) before mutating.
  const touching = await client.query<{
    id: string;
    person_id_a: string;
    person_id_b: string;
    reason: string;
  }>(
    `SELECT id, person_id_a, person_id_b, reason FROM do_not_merge
      WHERE person_id_a = $1 OR person_id_b = $1`,
    [loserId]
  );
  for (const r of touching.rows) {
    entry.deleted_collisions.push({
      pk: r.id,
      snapshot: { id: r.id, person_id_a: r.person_id_a, person_id_b: r.person_id_b, reason: r.reason },
    });
  }

  // Delete loser<->survivor self-pairs (would become a=b) and any loser rows.
  await client.query(
    `DELETE FROM do_not_merge WHERE (person_id_a = $1 OR person_id_b = $1)`,
    [loserId]
  );
  // Re-insert each as a survivor-anchored canonical pair, skipping the self-pair
  // and de-duping on the UNIQUE(a,b).
  let moved = 0;
  for (const r of touching.rows) {
    const other = r.person_id_a === loserId ? r.person_id_b : r.person_id_a;
    if (other === survivorId || other === loserId) continue; // would be a self-pair
    const [lo, hi] = survivorId < other ? [survivorId, other] : [other, survivorId];
    const ins = await client.query(
      `INSERT INTO do_not_merge (person_id_a, person_id_b, reason, created_by)
       VALUES ($1, $2, $3, 'merge-duplicate-people.ts')
       ON CONFLICT (person_id_a, person_id_b) DO NOTHING`,
      [lo, hi, r.reason]
    );
    moved += ins.rowCount ?? 0;
  }
  entry.moved_count = moved;
  return entry;
}

/**
 * Close the pair's conflicting_strong_id dedup_review_queue row. The detector
 * keyed each row on (canonical_key, state_fips) but stored the conflicting pairs
 * in candidate_people JSONB, so we match on a row that (a) is unresolved,
 * (b) is conflicting_strong_id, and (c) names BOTH the survivor and the loser id
 * anywhere in its candidate_people payload. Sets resolution='merge',
 * resolution_target_person_id=survivor, reviewed_at=now(). Returns the closed
 * row id (or null if none matched) for the audit.
 */
export async function closeDedupReviewRow(
  client: QueryClient,
  survivorId: string,
  loserId: string
): Promise<string | null> {
  const found = await client.query<{ id: string }>(
    `SELECT id FROM dedup_review_queue
      WHERE reviewed_at IS NULL
        AND blocker_category = 'conflicting_strong_id'
        AND candidate_people::text LIKE '%' || $1 || '%'
        AND candidate_people::text LIKE '%' || $2 || '%'
      ORDER BY created_at ASC
      LIMIT 1`,
    [survivorId, loserId]
  );
  if (!found.rowCount) return null;
  const id = found.rows[0].id;
  await client.query(
    `UPDATE dedup_review_queue
        SET resolution = 'merge',
            resolution_target_person_id = $2::uuid,
            reviewed_at = now(),
            resolution_note = COALESCE(resolution_note, '') ||
              ' [auto-merged loser ' || $3::text || ' -> survivor ' || $4::text || ' by merge-duplicate-people.ts]'
      WHERE id = $1`,
    [id, survivorId, loserId, survivorId]
  );
  return id;
}

// ---------------------------------------------------------------------------
// mergeOne: collapse one loser into the survivor (assumes an open transaction).
// ---------------------------------------------------------------------------

export interface MergeOneResult {
  survivor_id: string;
  loser_id: string;
  moved: MovedEntry[];
  people_backfill: PeopleBackfillPlan & {
    loser_prior_meta: Record<string, unknown>;
    loser_prior_merged_from: string[];
  };
  dedup_review_queue_id: string | null;
  /** The merge_audit row id written (null on dry-run, where we do not insert). */
  merge_audit_id: string | null;
}

export interface MergeOneOpts {
  /** When false, perform all reads/plan but write NOTHING (dry-run preview). */
  apply: boolean;
  /** Pre-derived person-fk columns (table+column). */
  fkColumns: PersonFkColumn[];
  /** Set of "table.column" that are under a person-inclusive UNIQUE. */
  uniqueColumns: Set<string>;
  /**
   * How to handle a loser row colliding with the survivor under a person-inclusive
   * UNIQUE. Default 'snapshot-delete' keeps the historical merge-duplicate-people
   * behavior byte-for-byte (snapshot the loser row then DELETE it). 'archive-in-
   * place' NEVER deletes: it leaves the colliding loser row on the tombstoned
   * loser person, stamps a meta archive marker (when the table has a meta column),
   * and for candidacies NULL-only backfills the survivor's richer row.
   */
  collisionMode?: CollisionMode;
  /**
   * Absolute survivor-column SETs the CALLER computed from the already-loaded
   * cohort rows (e.g. dedup-people's email provenance-rank merge, legacy id union,
   * broader scalar fills). Each is applied as `SET col = after` and merged into the
   * audit's people_backfill.backfilled map so undoOne's generic revert (`SET col =
   * before`) restores them. The before value MUST be the survivor's current value
   * so undo is exact. Arrays are recorded as before/after arrays.
   */
  extraSurvivorUpdates?: Record<string, { before: unknown; after: unknown }>;
}

/**
 * Collapse one loser into the survivor. The CALLER opens and commits/rolls back
 * the per-cluster transaction; mergeOne uses SAVEPOINTs internally for the
 * collision-safe re-points. On dry-run (opts.apply=false) the caller is expected
 * to still wrap this in a transaction it ROLLS BACK, so the row counts reflect
 * exactly what an apply would move; mergeOne itself simply does not insert the
 * merge_audit row when apply is false.
 */
export async function mergeOne(
  client: QueryClient,
  survivorId: string,
  loserId: string,
  opts: MergeOneOpts
): Promise<MergeOneResult> {
  if (survivorId === loserId) throw new Error('mergeOne: survivor and loser are the same id');

  const survivor = await loadPeopleRow(client, survivorId);
  const loser = await loadPeopleRow(client, loserId);
  if (!survivor) throw new Error(`mergeOne: survivor ${survivorId} not found`);
  if (!loser) throw new Error(`mergeOne: loser ${loserId} not found`);
  if ((loser.meta ?? {})['merged_into']) {
    throw new Error(`mergeOne: loser ${loserId} already tombstoned (merged_into present)`);
  }
  if ((survivor.meta ?? {})['merged_into']) {
    throw new Error(`mergeOne: survivor ${survivorId} is itself tombstoned`);
  }

  const moved: MovedEntry[] = [];
  const collisionMode: CollisionMode = opts.collisionMode ?? 'snapshot-delete';

  // 1. Re-point every generic person-fk column (loser -> survivor).
  for (const fk of opts.fkColumns) {
    const isUnique = opts.uniqueColumns.has(`${fk.table}.${fk.column}`);
    const entry = await repointColumn(
      client,
      fk.table,
      fk.column,
      survivorId,
      loserId,
      isUnique,
      collisionMode
    );
    moved.push(entry);
  }

  // 2. Special: do_not_merge (never self-pair).
  moved.push(await repointDoNotMerge(client, survivorId, loserId));

  // 3. Survivor field-merge (stock: merged_in fold + NULL-only BACKFILL_COLUMNS).
  const plan = planPeopleMerge(survivor, loser);
  await applyPeopleMerge(client, survivorId, plan);

  // 3b. Extra survivor updates the caller computed from the cohort (e.g. dedup's
  //     email provenance merge, legacy_candidate_ids union, broader scalar fills).
  //     Applied as absolute SETs and folded into people_backfill.backfilled so
  //     undoOne's generic revert (`SET col = before`) restores them. A caller-
  //     supplied key overrides the stock plan's entry for the same column (the
  //     caller has the fuller merge for that column).
  const extra = opts.extraSurvivorUpdates ?? {};
  const extraCols = Object.keys(extra);
  if (extraCols.length > 0) {
    const sets: string[] = [];
    const params: unknown[] = [survivorId];
    for (const col of extraCols) {
      params.push(extra[col].after);
      sets.push(`${col} = $${params.length}`);
      plan.backfilled[col] = { before: extra[col].before, after: extra[col].after };
    }
    await client.query(
      `UPDATE people SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`,
      params
    );
  }

  // 4. Tombstone the loser (reversible).
  const priors = await tombstoneLoser(client, loser, survivorId);

  // 5. Close the pair's dedup_review_queue row.
  const dedupId = await closeDedupReviewRow(client, survivorId, loserId);

  const peopleBackfill = {
    ...plan,
    loser_prior_meta: priors.prior_meta,
    loser_prior_merged_from: priors.prior_merged_from,
  };

  // 6. Write the merge_audit row (apply only).
  let mergeAuditId: string | null = null;
  if (opts.apply) {
    const ins = await client.query<{ id: string }>(
      `INSERT INTO merge_audit (survivor_id, loser_id, moved, people_backfill, dedup_review_queue_id)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5)
       RETURNING id`,
      [survivorId, loserId, JSON.stringify(moved), JSON.stringify(peopleBackfill), dedupId]
    );
    mergeAuditId = ins.rows[0]?.id ?? null;
  }

  return {
    survivor_id: survivorId,
    loser_id: loserId,
    moved,
    people_backfill: peopleBackfill,
    dedup_review_queue_id: dedupId,
    merge_audit_id: mergeAuditId,
  };
}

// ---------------------------------------------------------------------------
// undoOne: reverse a single merge from its merge_audit row.
// ---------------------------------------------------------------------------

export interface UndoResult {
  merge_audit_id: string;
  survivor_id: string;
  loser_id: string;
  moved_back: number;
  reinserted_collisions: number;
  /** Count of 'archive-in-place' retained collisions reverted (marker + backfill). */
  restored_retained_collisions: number;
  reopened_dedup_review_queue_id: string | null;
  /** Warnings (e.g. deleted-collision rows that could not be re-inserted). */
  warnings: string[];
}

/**
 * Reverse one merge using its merge_audit row (brief step 8). The CALLER opens
 * and commits/rolls back the transaction.
 *
 *  - Move re-pointed rows back: for each MovedEntry, move back EXACTLY the rows
 *    the merge moved, keyed on the recorded moved_keys (primary key or ctid). This
 *    never touches the survivor's OWN pre-existing rows -- the prior blanket
 *    `UPDATE table SET col=loser WHERE col=survivor` over-moved every survivor row
 *    on that column (the live bug: an undo moved 9 person_xref rows back when the
 *    merge moved only 1). Legacy merge_audit rows written before moved_keys existed
 *    fall back to the old blanket behavior, with a warning that it may over-move.
 *  - Re-insert deleted-collision snapshots onto the loser.
 *  - Revert survivor backfills (restore the "before" values).
 *  - Pop the loser id off survivor.merged_from; remove meta.merged_in[<loser>].
 *  - Clear the loser tombstone (restore prior meta + merged_from).
 *  - Reopen the dedup_review_queue row.
 *  - Stamp merge_audit.undone_at.
 */
export async function undoOne(client: QueryClient, mergeAuditId: string): Promise<UndoResult> {
  const auditRes = await client.query<{
    id: string;
    survivor_id: string;
    loser_id: string;
    moved: MovedEntry[] | string;
    people_backfill: (PeopleBackfillPlan & {
      loser_prior_meta: Record<string, unknown>;
      loser_prior_merged_from: string[];
    }) | string;
    dedup_review_queue_id: string | null;
    undone_at: string | null;
  }>(
    `SELECT id, survivor_id, loser_id, moved, people_backfill, dedup_review_queue_id, undone_at
       FROM merge_audit WHERE id = $1`,
    [mergeAuditId]
  );
  if (!auditRes.rowCount) throw new Error(`undoOne: merge_audit ${mergeAuditId} not found`);
  const audit = auditRes.rows[0];
  if (audit.undone_at) throw new Error(`undoOne: merge_audit ${mergeAuditId} already undone at ${audit.undone_at}`);

  const moved: MovedEntry[] = typeof audit.moved === 'string' ? JSON.parse(audit.moved) : audit.moved;
  const backfill = typeof audit.people_backfill === 'string'
    ? JSON.parse(audit.people_backfill)
    : audit.people_backfill;

  const survivorId = audit.survivor_id;
  const loserId = audit.loser_id;
  const warnings: string[] = [];
  let movedBack = 0;
  let reinserted = 0;
  let restoredRetained = 0;

  // 1. Re-insert deleted-collision snapshots onto the loser, then move rows back.
  for (const entry of moved) {
    if (entry.table === 'do_not_merge') {
      // Restore the snapshotted do_not_merge rows verbatim (they were deleted in
      // mergeOne and re-inserted survivor-anchored; restore loser-anchored set).
      // First remove the survivor-anchored rows mergeOne created from the loser's
      // relationships, then re-insert the originals.
      for (const c of entry.deleted_collisions) {
        const s = c.snapshot as { id?: string; person_id_a: string; person_id_b: string; reason: string };
        await client.query(
          `INSERT INTO do_not_merge (id, person_id_a, person_id_b, reason)
           VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4)
           ON CONFLICT (person_id_a, person_id_b) DO NOTHING`,
          [s.id ?? null, s.person_id_a, s.person_id_b, s.reason]
        );
        reinserted++;
      }
      continue;
    }
    // Re-insert deleted-collision snapshots (these were loser rows deleted because
    // the survivor already had an equivalent). Insert verbatim back onto the loser.
    for (const c of entry.deleted_collisions) {
      try {
        const cols = Object.keys(c.snapshot);
        const placeholders = cols.map((_, i) => `$${i + 1}`);
        await client.query(
          `INSERT INTO ${entry.table} (${cols.map((x) => `"${x}"`).join(', ')})
           VALUES (${placeholders.join(', ')})
           ON CONFLICT DO NOTHING`,
          cols.map((k) => c.snapshot[k])
        );
        reinserted++;
      } catch (e) {
        warnings.push(
          `could not re-insert deleted collision into ${entry.table} (pk=${c.pk}): ${(e as Error).message}`
        );
      }
    }
    // Move the re-pointed rows back survivor -> loser. We move back EXACTLY the
    // rows the merge moved, keyed on the recorded moved_keys (primary key or
    // ctid). This can never disturb the survivor's own pre-existing rows.
    const movedKeys = Array.isArray(entry.moved_keys) ? entry.moved_keys : undefined;
    if (movedKeys === undefined) {
      // LEGACY merge_audit row written before moved_keys existed: fall back to the
      // OLD blanket move. This may OVER-MOVE (it returns every survivor row on this
      // column to the loser, including rows the merge never touched). Warn loudly.
      if (entry.moved_count > 0) {
        const back = await client.query(
          `UPDATE ${entry.table} SET ${entry.column} = $1 WHERE ${entry.column} = $2`,
          [loserId, survivorId]
        );
        const n = back.rowCount ?? 0;
        movedBack += n;
        warnings.push(
          `${entry.table}.${entry.column}: LEGACY audit row has no moved_keys; used the blanket ` +
            `survivor->loser move which may OVER-MOVE (moved back ${n}, merge recorded ` +
            `${entry.moved_count}). Verify the survivor did not lose its own rows.`
        );
      }
    } else if (movedKeys.length > 0) {
      // Reverse exactly the recorded rows. Key on the primary key (text compare via
      // ANY) when the keys are pk values, otherwise on ctid (tid[]). For the pk
      // case we re-derive the pk column name at undo time (the same single-column
      // pk repointColumn used to capture the keys).
      let whereExpr: string;
      if (entry.key_kind === 'ctid') {
        whereExpr = `ctid = ANY($2::tid[])`;
      } else {
        const pk = await primaryKeyColumn(client, entry.table);
        if (!pk) {
          warnings.push(
            `${entry.table}.${entry.column}: moved_keys recorded as pk but no single-column ` +
              `primary key found at undo time; skipped reverse move (${movedKeys.length} rows)`
          );
          continue;
        }
        whereExpr = `${pk}::text = ANY($2::text[])`;
      }
      const back = await client.query(
        `UPDATE ${entry.table} SET ${entry.column} = $1::uuid WHERE ${whereExpr}`,
        [loserId, movedKeys]
      );
      const n = back.rowCount ?? 0;
      movedBack += n;
      // Reconciliation is now keyed on moved_keys length, not a blanket count.
      // A shortfall means some recorded rows are gone (e.g. a ctid drifted after
      // a vacuum, or a row was deleted post-merge by another writer).
      if (n !== movedKeys.length) {
        warnings.push(
          `${entry.table}.${entry.column}: moved back ${n} but merge recorded ` +
            `${movedKeys.length} moved_keys (some recorded rows are missing -- ` +
            `e.g. ctid drift after vacuum, or post-merge deletion)`
        );
      }
    }

    // Reverse any 'archive-in-place' retained collisions on this entry: remove the
    // meta archive marker from the retained loser row, and revert the survivor's
    // winner_backfill to its "before" values. Legacy / snapshot-delete audit rows
    // have no retained_collisions field and skip this entirely.
    for (const rc of entry.retained_collisions ?? []) {
      // 1. Un-stamp the retained loser row's meta marker (if one was stamped).
      if (rc.meta_archive_key) {
        try {
          if (entry.key_kind === 'ctid') {
            await client.query(
              `UPDATE ${entry.table} SET meta = meta - $1::text WHERE ctid = $2::tid`,
              [rc.meta_archive_key, rc.pk]
            );
          } else {
            const pk = await primaryKeyColumn(client, entry.table);
            if (pk && rc.pk != null) {
              await client.query(
                `UPDATE ${entry.table} SET meta = meta - $1::text WHERE ${pk}::text = $2::text`,
                [rc.meta_archive_key, rc.pk]
              );
            } else {
              warnings.push(
                `${entry.table}: could not remove archive marker (no pk at undo time)`
              );
            }
          }
        } catch (e) {
          warnings.push(
            `${entry.table}: could not remove archive marker (pk=${rc.pk}): ${(e as Error).message}`
          );
        }
      }
      // 2. Revert the survivor's winner_backfill (restore each "before" value).
      const wb = rc.winner_backfill;
      if (wb && Object.keys(wb.columns).length > 0) {
        const cols = Object.keys(wb.columns);
        const sets: string[] = [];
        const params: unknown[] = [];
        for (const col of cols) {
          const before = wb.columns[col].before;
          // meta reverts to its jsonb "before"; scalars revert directly.
          if (col === 'meta') {
            params.push(JSON.stringify(before ?? {}));
            sets.push(`meta = $${params.length}::jsonb`);
          } else {
            params.push(before ?? null);
            sets.push(`"${col}" = $${params.length}`);
          }
        }
        const whereExpr =
          wb.winner_pk != null ? `id::text = $${params.length + 1}::text` : null;
        if (whereExpr) {
          params.push(wb.winner_pk);
          try {
            await client.query(
              `UPDATE ${entry.table} SET ${sets.join(', ')}, updated_at = now() WHERE ${whereExpr}`,
              params
            );
          } catch (e) {
            warnings.push(
              `${entry.table}: could not revert winner_backfill (pk=${wb.winner_pk}): ${(e as Error).message}`
            );
          }
        } else {
          warnings.push(
            `${entry.table}: winner_backfill has no winner_pk; skipped revert`
          );
        }
      }
      restoredRetained++;
    }
  }

  // 2. Revert survivor field-merge: restore name_variants/merged_from by removing
  //    what this merge added, restore meta (drop merged_in.<loser>), revert the
  //    NULL-only backfills to their "before" values.
  const survivor = await loadPeopleRow(client, survivorId);
  if (!survivor) throw new Error(`undoOne: survivor ${survivorId} not found`);

  const addedVariants = new Set((backfill.name_variants_added ?? []).map((v: string) => v.toLowerCase()));
  const restoredVariants = (survivor.name_variants ?? []).filter((v) => !addedVariants.has(v.toLowerCase()));
  const restoredMergedFrom = (survivor.merged_from ?? []).filter((id) => id !== loserId);
  const meta: Record<string, unknown> = { ...(survivor.meta ?? {}) };
  if (meta.merged_in && typeof meta.merged_in === 'object' && !Array.isArray(meta.merged_in)) {
    const mi = { ...(meta.merged_in as Record<string, unknown>) };
    delete mi[loserId];
    if (Object.keys(mi).length === 0) delete meta.merged_in;
    else meta.merged_in = mi;
  }
  const sets = [`name_variants = $2::text[]`, `merged_from = $3::uuid[]`, `meta = $4::jsonb`];
  const params: unknown[] = [survivorId, restoredVariants, restoredMergedFrom, JSON.stringify(meta)];
  for (const [col, ba] of Object.entries(backfill.backfilled ?? {})) {
    const before = (ba as { before: unknown }).before;
    params.push(before ?? null);
    sets.push(`${col} = $${params.length}`);
  }
  await client.query(`UPDATE people SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params);

  // 3. Clear the loser tombstone (restore prior meta + merged_from).
  await client.query(
    `UPDATE people SET meta = $2::jsonb, merged_from = $3::uuid[], updated_at = now() WHERE id = $1`,
    [loserId, JSON.stringify(backfill.loser_prior_meta ?? {}), backfill.loser_prior_merged_from ?? []]
  );

  // 4. Reopen the dedup_review_queue row.
  let reopened: string | null = null;
  if (audit.dedup_review_queue_id) {
    await client.query(
      `UPDATE dedup_review_queue
          SET resolution = NULL, resolution_target_person_id = NULL, reviewed_at = NULL,
              resolution_note = COALESCE(resolution_note, '') || ' [undone: merge reversed]'
        WHERE id = $1`,
      [audit.dedup_review_queue_id]
    );
    reopened = audit.dedup_review_queue_id;
  }

  // 5. Stamp undone_at so the same merge cannot be undone twice.
  await client.query(`UPDATE merge_audit SET undone_at = now() WHERE id = $1`, [mergeAuditId]);

  return {
    merge_audit_id: mergeAuditId,
    survivor_id: survivorId,
    loser_id: loserId,
    moved_back: movedBack,
    reinserted_collisions: reinserted,
    restored_retained_collisions: restoredRetained,
    reopened_dedup_review_queue_id: reopened,
    warnings,
  };
}
