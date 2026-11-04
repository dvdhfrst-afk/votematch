/**
 * source-harvest-runner.ts -- the GENERIC source-centric harvest runner (Phase 0).
 *
 * THE PATTERN (see 12-positioning-engine/13-harvest-buildout-plan.md):
 *   Fetch a source ONCE, find every candidate it covers, attribute the extracted
 *   material to each. This runner is the SHARED machine that does that. Each later
 *   harvester (Builds 1 to 5: forum video, voter guide, endorsement, finance,
 *   legislative record) supplies a small SourceParser that turns one
 *   harvest_sources row into a list of ParsedUnit objects; the runner does the
 *   SAFE candidate resolution + attributed / unattributed write + idempotency for
 *   all of them. The per-source parsers are NOT built here (that is Builds 1 to 5);
 *   a trivial 'manual_text' stub parser ships so the runner is testable end to end.
 *
 * SAFETY (the core invariant): a ParsedUnit's name mention is resolved ONLY
 * against the source's RACE ROSTER (race-roster.ts) -- the 2 to 4 candidacies
 * actually in scope -- or by a strong external id via person_xref. A mention that
 * resolves to exactly one roster person is written ATTRIBUTED (person_id set). A
 * mention that is AMBIGUOUS or matches NO ONE in the roster is written
 * UNATTRIBUTED (person_id NULL) tied to the harvest_source, plus a review note.
 * We NEVER guess a namesake.
 *
 * REUSE: hashing (sha256Text / sha256Bytes), content normalization
 * (normalizeContent), the contraband / Social Security number scrub
 * (applyIngestScrubs), the empty-content floor (MIN_CONTENT_LEN), and the
 * normalized-hash idempotency LEDGER (evidence_seen_ledger) are all reused from
 * raw-ingest.ts so an attributed harvest unit hashes, scrubs, and dedups
 * identically to the canonical per-URL ingest path. The raw_evidence + ledger
 * write SQL mirrors raw-ingest's insertRawEvidence / insertLedger contract.
 *
 * DRY-RUN is the DEFAULT (opts.apply !== true): resolve and compute, print the
 * rows that WOULD be written, but touch nothing.
 *
 * Single TypeScript runtime, no Python. The pg (PostgreSQL) Client does all DB
 * work; this module imports only existing helpers and the race roster.
 */
import type { QueryClient } from '../identity-resolve';
import { enqueueDedupReview } from '../identity-resolve';
import {
  normalizeContent,
  sha256Text,
  sha256Bytes,
  applyIngestScrubs,
  MIN_CONTENT_LEN,
} from '../raw-ingest';
import {
  loadRosterForSource,
  resolveMentionInRoster,
  type Roster,
  type RosterEntry,
} from './race-roster';

// ---------------------------------------------------------------------------
// Public types: the harvest_sources row + the pluggable parser contract.
// ---------------------------------------------------------------------------

/** The harvest_sources row shape the runner reads (scope + addressing + meta). */
export interface HarvestSource {
  id: string;
  source_type: string;
  url?: string | null;
  channel_ref?: string | null;
  handle?: string | null;
  jurisdiction_id?: string | null;
  fips_state?: string | null;
  fips_county?: string | null;
  fips_place?: string | null;
  office_hint?: string | null;
  election_cycle?: string | null;
  cadence?: string | null;
  status?: string | null;
  meta?: Record<string, unknown> | null;
}

/** A strong external identifier a unit may carry (resolved via person_xref). */
export interface StrongIdRef {
  kind: string;
  external_id: string;
}

/**
 * One per-candidate unit a parser extracts from a source. candidateMention is the
 * raw NAME STRING as it appeared in the document (null when the unit is keyed only
 * by a strong id). strongId, when present, is the deterministic bind path
 * (person_xref) and takes priority over the name. locus is the exact location of
 * the unit within the source (a video timestamp range, a guide section, a
 * scorecard row) and flows into provenance. content is the extracted text for this
 * candidate's slice. source_family tags the evidence; signal_view marks whether it
 * is the candidate's own words ('stated') or a third-party read ('inferred').
 */
export interface ParsedUnit {
  candidateMention: string | null;
  strongId?: StrongIdRef;
  locus: Record<string, unknown>;
  content: string;
  source_family: string;
  signal_view: 'stated' | 'inferred';
  /** Optional parser-specific extra, merged into provenance.extra. */
  extra?: Record<string, unknown>;
}

/** Dependencies a parser may need (injected so the runner stays I/O-agnostic). */
export interface ParserDeps {
  /** The pg client, in case the parser needs to read the DB while parsing. */
  client: QueryClient;
  /** Anything else a real parser wants (fetch impl, transcript pipeline, ...). */
  [key: string]: unknown;
}

/**
 * The pluggable parser interface. Build N supplies one of these; the runner does
 * the rest. fetchAndParse turns ONE harvest_sources row into the per-candidate
 * units found in it (fetching the source however that source type requires).
 */
export interface SourceParser {
  source_type: string;
  fetchAndParse(harvestSource: HarvestSource, deps: ParserDeps): Promise<ParsedUnit[]>;
}

// ---------------------------------------------------------------------------
// Runner options + result shapes.
// ---------------------------------------------------------------------------

export interface RunSourceHarvestOptions {
  /** Default false. When false, NO writes happen (dry-run). */
  apply?: boolean;
  /** Extra deps forwarded to parser.fetchAndParse (merged with { client }). */
  parserDeps?: Record<string, unknown>;
  /**
   * When true (default), an ambiguous / unresolved mention enqueues a review row
   * in dedup_review_queue. Tests / pure runs pass false.
   */
  enqueue?: boolean;
}

export type UnitOutcome =
  | 'attributed' // resolved to one roster person (or strong id): person_id set
  | 'unattributed' // ambiguous / no roster match: person_id null, held to source
  | 'seen' // normalized_hash already in ledger: cheap no-op, no new row
  | 'skipped_empty' // content below MIN_CONTENT_LEN after normalization
  | 'blocked'; // contraband floor tripped: refused to store

export interface UnitResult {
  outcome: UnitOutcome;
  /** The resolved person, when attributed. */
  person_id: string | null;
  /** The roster entry the mention bound to (attributed-by-roster only). */
  roster_entry?: RosterEntry;
  /** The resolution method / basis. */
  basis:
    | 'roster_canonical_key'
    | 'roster_name_variant'
    | 'roster_safe_fuzzy'
    | 'strong_id'
    | 'ambiguous_held'
    | 'no_match_held'
    | 'empty'
    | 'blocked';
  bind_confidence: number;
  content_hash: string;
  normalized_hash: string;
  /** The raw_evidence id written (apply mode), else null (dry-run / no write). */
  raw_evidence_id: string | null;
  candidate_mention: string | null;
  detail: string;
}

export interface RunSourceHarvestResult {
  harvest_source_id: string;
  source_type: string;
  dry_run: boolean;
  roster_size: number;
  roster_note: string;
  units_parsed: number;
  attributed: number;
  unattributed: number;
  seen: number;
  skipped: number;
  blocked: number;
  results: UnitResult[];
  notes: string[];
}

// ---------------------------------------------------------------------------
// DB helpers -- same contract as raw-ingest's insertRawEvidence / ledger, plus a
// harvest_source_id and a roster-bound provenance block. Gated behind apply.
// ---------------------------------------------------------------------------

/** Read the seen-ledger by normalized_hash (idempotency guard). */
async function readLedger(
  client: QueryClient,
  normalizedHash: string,
): Promise<{ times_seen: number } | null> {
  const res = await client.query<{ times_seen: number }>(
    'select times_seen from evidence_seen_ledger where normalized_hash = $1 limit 1',
    [normalizedHash],
  );
  return res.rows[0] ?? null;
}

/** Touch an existing ledger row (last_seen / times_seen+1). Returns new count. */
async function touchLedger(client: QueryClient, normalizedHash: string): Promise<number> {
  const res = await client.query<{ times_seen: number }>(
    `update evidence_seen_ledger
        set last_seen_at = now(), times_seen = times_seen + 1
      where normalized_hash = $1
      returning times_seen`,
    [normalizedHash],
  );
  return res.rows[0]?.times_seen ?? 0;
}

/**
 * Insert an attributed / unattributed harvest unit into raw_evidence. Mirrors
 * raw-ingest's insertRawEvidence ON CONFLICT (content_hash) idempotency, and
 * additionally sets harvest_source_id. source_url is the harvest_source's url (or
 * a synthetic "harvest://<source_id>" reference when the source has no url, e.g. a
 * channel-only source) so the column stays non-null and traceable.
 */
async function insertHarvestEvidence(
  client: QueryClient,
  row: {
    contentHash: string;
    normalizedHash: string;
    sourceUrl: string;
    registrable: string | null;
    extractedText: string;
    sourceFamily: string;
    personId: string | null;
    bindConfidence: number | null;
    harvestSourceId: string;
    ingestScrubs: string[];
    provenance: Record<string, unknown>;
  },
): Promise<string> {
  // harvest_source_id is a uuid foreign key; a synthetic (not-yet-registered)
  // source passes a non-uuid label, so null the column and keep the label in
  // provenance for traceability.
  const HSID_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const hsid = row.harvestSourceId && HSID_UUID.test(row.harvestSourceId) ? row.harvestSourceId : null;
  const prov = hsid ? row.provenance : { ...row.provenance, synthetic_source: row.harvestSourceId };
  const res = await client.query<{ id: string }>(
    `insert into raw_evidence
       (content_hash, normalized_hash, source_url, final_url, registrable_domain,
        fetch_tier, http_status, content_type, byte_size, storage_ref,
        extracted_text, source_family, discovery_path, person_id, bind_confidence,
        harvest_source_id, ingest_scrubs, provenance, fetched_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18::jsonb,now())
     on conflict (content_hash) do update set
       normalized_hash = excluded.normalized_hash,
       person_id = coalesce(raw_evidence.person_id, excluded.person_id),
       bind_confidence = greatest(
         coalesce(raw_evidence.bind_confidence, 0),
         coalesce(excluded.bind_confidence, 0)
       ),
       harvest_source_id = coalesce(raw_evidence.harvest_source_id, excluded.harvest_source_id)
     returning id`,
    [
      row.contentHash,
      row.normalizedHash,
      row.sourceUrl,
      row.sourceUrl, // final_url == source_url for a synthesized harvest unit
      row.registrable,
      'harvest', // fetch_tier: this row came from a source-centric parser
      null, // http_status
      'text/plain', // content_type
      Buffer.byteLength(row.extractedText, 'utf8'),
      null, // storage_ref: harvest units store extracted_text inline, not a file
      row.extractedText,
      row.sourceFamily,
      'source_harvest', // discovery_path
      row.personId,
      row.bindConfidence,
      hsid,
      JSON.stringify(row.ingestScrubs),
      JSON.stringify(prov),
    ],
  );
  return res.rows[0].id;
}

/** Upsert the seen-ledger row for a freshly stored unit. */
async function insertLedger(
  client: QueryClient,
  args: { normalizedHash: string; firstRawEvidenceId: string; url: string },
): Promise<void> {
  await client.query(
    `insert into evidence_seen_ledger
       (normalized_hash, first_raw_evidence_id, first_seen_at, last_seen_at, times_seen, classified, meta)
     values ($1, $2, now(), now(), 1, false, $3::jsonb)
     on conflict (normalized_hash) do update set
       last_seen_at = now(),
       times_seen = evidence_seen_ledger.times_seen + 1`,
    [args.normalizedHash, args.firstRawEvidenceId, JSON.stringify({ urls: [args.url], harvest: true })],
  );
}

/** Stamp harvest_sources.last_harvested_at (apply mode only). */
async function stampLastHarvested(client: QueryClient, harvestSourceId: string): Promise<void> {
  await client.query('update harvest_sources set last_harvested_at = now() where id = $1', [
    harvestSourceId,
  ]);
}

// ---------------------------------------------------------------------------
// Strong-id resolution via person_xref (deterministic, like identity-resolve A).
// ---------------------------------------------------------------------------

async function resolveStrongId(
  client: QueryClient,
  strongId: StrongIdRef,
): Promise<string | null> {
  const res = await client.query<{ person_id: string }>(
    'select person_id from person_xref where kind = $1 and external_id = $2 limit 1',
    [strongId.kind, strongId.external_id],
  );
  return res.rows[0]?.person_id ?? null;
}

// ---------------------------------------------------------------------------
// runSourceHarvest -- the generic loop.
// ---------------------------------------------------------------------------

/** Reference url for a unit: the source's url, or a synthetic harvest:// ref. */
function unitSourceUrl(source: HarvestSource): string {
  if (source.url && source.url.trim()) return source.url.trim();
  if (source.channel_ref && source.channel_ref.trim()) {
    return `harvest://channel/${source.channel_ref.trim()}`;
  }
  return `harvest://source/${source.id}`;
}

/**
 * runSourceHarvest -- fetch + parse a source via its parser, then for each unit:
 * resolve the candidate (strong id first, else roster-constrained name match),
 * write the unit ATTRIBUTED (resolved) or UNATTRIBUTED (ambiguous / no match,
 * held to the source + review-noted), idempotently via the normalized-hash
 * ledger. DRY-RUN by default. Updates harvest_sources.last_harvested_at in apply
 * mode.
 *
 * @param client  pg client (live local Postgres via the bridge, or a stub)
 * @param source  the harvest_sources row to harvest
 * @param parser  the SourceParser whose source_type matches the source
 * @param opts    { apply?, parserDeps?, enqueue? }
 */
export async function runSourceHarvest(
  client: QueryClient,
  source: HarvestSource,
  parser: SourceParser,
  opts: RunSourceHarvestOptions = {},
): Promise<RunSourceHarvestResult> {
  const apply = opts.apply === true;
  const enqueue = opts.enqueue !== false; // default true
  const notes: string[] = [];

  if (parser.source_type !== source.source_type) {
    notes.push(
      `WARN: parser source_type "${parser.source_type}" != source source_type "${source.source_type}"`,
    );
  }

  // 1) Build the in-scope race roster ONCE for the whole source.
  const roster: Roster = await loadRosterForSource(client, source);
  notes.push(roster.note);

  // 2) Fetch + parse the source into per-candidate units. The already-loaded race
  // roster is injected into deps so a source-centric parser (e.g. the news_guide
  // voter-guide parser) can use it to tell candidate-name headings apart from
  // topic/question headings while segmenting. A caller-supplied parserDeps.roster
  // still wins (explicit override). The runner re-resolves every mention against
  // this same roster afterward, so the parser's use of it is an aid, not the gate.
  const deps: ParserDeps = { roster, client, ...(opts.parserDeps ?? {}) };
  let units: ParsedUnit[] = [];
  try {
    units = await parser.fetchAndParse(source, deps);
  } catch (e) {
    notes.push(`parser.fetchAndParse threw: ${e instanceof Error ? e.message : String(e)}`);
    units = [];
  }

  const sourceUrl = unitSourceUrl(source);
  const registrable = (() => {
    try {
      return new URL(sourceUrl).hostname.toLowerCase();
    } catch {
      return null;
    }
  })();

  const results: UnitResult[] = [];

  // 3) Per-unit: resolve + write (or hold).
  for (const unit of units) {
    const r = await processUnit(client, {
      source,
      sourceUrl,
      registrable,
      roster,
      unit,
      apply,
      enqueue,
      parserType: parser.source_type,
      notes,
    });
    results.push(r);
  }

  // 4) Stamp last_harvested_at (apply only).
  if (apply) {
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(source.id)) {
      try {
        await stampLastHarvested(client, source.id);
      } catch (e) {
        notes.push(`could not stamp last_harvested_at: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else {
      notes.push('synthetic source (not a registered uuid): skipped last_harvested_at stamp');
    }
  } else {
    notes.push('dry-run: would stamp harvest_sources.last_harvested_at');
  }

  const tally = (o: UnitOutcome) => results.filter((r) => r.outcome === o).length;
  return {
    harvest_source_id: source.id,
    source_type: source.source_type,
    dry_run: !apply,
    roster_size: roster.entries.length,
    roster_note: roster.note,
    units_parsed: units.length,
    attributed: tally('attributed'),
    unattributed: tally('unattributed'),
    seen: tally('seen'),
    skipped: tally('skipped_empty'),
    blocked: tally('blocked'),
    results,
    notes,
  };
}

// ---------------------------------------------------------------------------
// processUnit -- resolve one unit + write attributed / unattributed.
// ---------------------------------------------------------------------------

interface ProcessUnitArgs {
  source: HarvestSource;
  sourceUrl: string;
  registrable: string | null;
  roster: Roster;
  unit: ParsedUnit;
  apply: boolean;
  enqueue: boolean;
  parserType: string;
  notes: string[];
}

async function processUnit(client: QueryClient, args: ProcessUnitArgs): Promise<UnitResult> {
  const { source, sourceUrl, registrable, roster, unit, apply, enqueue, parserType } = args;

  // ---- (a) Normalize + scrub + hash, exactly like the canonical ingest path. --
  const extracted = normalizeContent(unit.content ?? '', 'text/plain');
  if (extracted.trim().length < MIN_CONTENT_LEN) {
    return {
      outcome: 'skipped_empty',
      person_id: null,
      basis: 'empty',
      bind_confidence: 0,
      content_hash: '',
      normalized_hash: '',
      raw_evidence_id: null,
      candidate_mention: unit.candidateMention,
      detail: `unit content below MIN_CONTENT_LEN (${extracted.trim().length} < ${MIN_CONTENT_LEN}); not stored`,
    };
  }

  const scrub = applyIngestScrubs(extracted);
  if (scrub.blocked) {
    return {
      outcome: 'blocked',
      person_id: null,
      basis: 'blocked',
      bind_confidence: 0,
      content_hash: '',
      normalized_hash: '',
      raw_evidence_id: null,
      candidate_mention: unit.candidateMention,
      detail: `contraband floor tripped (${scrub.scrubs[0] ?? 'contraband'}); refused to store`,
    };
  }

  const scrubbedText = scrub.scrubbed_text;
  // content_hash over the scrubbed text bytes; normalized_hash over the scrubbed
  // text. Bind the locus into the normalized hash input so two DIFFERENT slices of
  // the SAME source (e.g. two candidates' transcript spans that happen to contain
  // identical boilerplate) do not collide to one ledger row and wrongly dedup.
  const locusKey = JSON.stringify(unit.locus ?? {});
  const contentHash = sha256Bytes(Buffer.from(scrubbedText, 'utf8'));
  const normalizedHash = sha256Text(`${source.id}|${locusKey}|${scrubbedText}`);

  // ---- (b) Resolve the candidate: strong id first, else roster-constrained. ----
  let personId: string | null = null;
  let bindConfidence = 0;
  let basis: UnitResult['basis'] = 'no_match_held';
  let rosterEntry: RosterEntry | undefined;
  let resolveDetail = '';

  if (unit.strongId) {
    const sid = await resolveStrongId(client, unit.strongId);
    if (sid) {
      personId = sid;
      bindConfidence = 1.0;
      basis = 'strong_id';
      resolveDetail = `strong id ${unit.strongId.kind}=${unit.strongId.external_id} -> person ${sid}`;
    } else {
      resolveDetail = `strong id ${unit.strongId.kind}=${unit.strongId.external_id} not found in person_xref`;
    }
  }

  // Fall back to roster-constrained name resolution if no strong-id bind.
  if (!personId && unit.candidateMention) {
    const res = resolveMentionInRoster(unit.candidateMention, roster);
    if (res.status === 'resolved') {
      personId = res.entry.person_id;
      bindConfidence = res.confidence;
      rosterEntry = res.entry;
      basis =
        res.method === 'canonical_key'
          ? 'roster_canonical_key'
          : res.method === 'name_variant'
            ? 'roster_name_variant'
            : 'roster_safe_fuzzy';
      resolveDetail = res.detail;
    } else if (res.status === 'ambiguous') {
      basis = 'ambiguous_held';
      resolveDetail = res.detail;
    } else {
      basis = 'no_match_held';
      resolveDetail = res.detail;
    }
  } else if (!personId && !unit.candidateMention && !unit.strongId) {
    basis = 'no_match_held';
    resolveDetail = 'unit carried neither a candidateMention nor a strongId; held unattributed';
  }

  const attributed = personId != null;

  // ---- (c) Idempotency guard: normalized_hash already in the ledger? -----------
  const ledger = await readLedger(client, normalizedHash);
  if (ledger) {
    let timesSeen = ledger.times_seen + 1;
    if (apply) timesSeen = await touchLedger(client, normalizedHash);
    return {
      outcome: 'seen',
      person_id: personId,
      basis,
      bind_confidence: bindConfidence,
      content_hash: contentHash,
      normalized_hash: normalizedHash,
      raw_evidence_id: null,
      candidate_mention: unit.candidateMention,
      detail: `unit already in ledger (nhash=${normalizedHash.slice(0, 12)}); no new row${apply ? ` (ledger touched, times_seen=${timesSeen})` : ' (dry-run: would touch ledger)'}`,
    };
  }

  // ---- (d) Provenance: source back-pointer + locus + signal_view + parser. -----
  const provenance: Record<string, unknown> = {
    harvest_source_id: source.id,
    source_type: source.source_type,
    locus: unit.locus ?? {},
    signal_view: unit.signal_view,
    parser: parserType,
    source_family: unit.source_family,
    resolution: { basis, bind_confidence: bindConfidence, detail: resolveDetail, attributed },
    scrubs: scrub.scrubs,
    ...(unit.extra ? { extra: unit.extra } : {}),
  };

  // ---- (e) Write attributed / unattributed, plus a review note when held. ------
  if (!apply) {
    // Dry-run: print the planned row + (if held) the review enqueue, write nothing.
    const plan = {
      raw_evidence: {
        content_hash: contentHash,
        normalized_hash: normalizedHash,
        source_url: sourceUrl,
        harvest_source_id: source.id,
        person_id: personId,
        bind_confidence: bindConfidence,
        source_family: unit.source_family,
        extracted_text_len: scrubbedText.length,
        provenance,
      },
      review_enqueue:
        !attributed && (basis === 'ambiguous_held' || basis === 'no_match_held')
          ? { reason: basis, mention: unit.candidateMention }
          : null,
    };
    console.log(
      `[DRY-RUN] harvest unit (${attributed ? 'ATTRIBUTED' : 'UNATTRIBUTED'}):\n` +
        JSON.stringify(plan, null, 2),
    );
    return {
      outcome: attributed ? 'attributed' : 'unattributed',
      person_id: personId,
      roster_entry: rosterEntry,
      basis,
      bind_confidence: bindConfidence,
      content_hash: contentHash,
      normalized_hash: normalizedHash,
      raw_evidence_id: null,
      candidate_mention: unit.candidateMention,
      detail: `DRY-RUN: would write ${attributed ? 'attributed' : 'unattributed'} raw_evidence (${resolveDetail})`,
    };
  }

  const rawId = await insertHarvestEvidence(client, {
    contentHash,
    normalizedHash,
    sourceUrl,
    registrable,
    extractedText: scrubbedText,
    sourceFamily: unit.source_family,
    personId,
    bindConfidence: attributed ? bindConfidence : null,
    harvestSourceId: source.id,
    ingestScrubs: scrub.scrubs,
    provenance,
  });
  await insertLedger(client, { normalizedHash, firstRawEvidenceId: rawId, url: sourceUrl });

  // For a HELD (unattributed) mention, enqueue a review note so a human can bind
  // it later -- never guess a namesake. We key the review on the mention + state.
  if (!attributed && enqueue && (basis === 'ambiguous_held' || basis === 'no_match_held') && unit.candidateMention) {
    try {
      const { canonicalKey } = await import('../identity-resolve');
      await enqueueDedupReview(client, {
        canonical_key: canonicalKey(unit.candidateMention),
        state_fips: source.fips_state ?? null,
        blocker_category: 'insufficient_evidence',
        blocker_explanation:
          `Source-harvest mention "${unit.candidateMention}" could not be safely bound within the ` +
          `race roster for harvest_source ${source.id} (${basis}): ${resolveDetail}. ` +
          `Stored unattributed (raw_evidence ${rawId}); needs a human bind.`,
        candidate_people: roster.entries.map((e) => ({
          person_id: e.person_id,
          canonical_name: e.canonical_name,
          office: e.office_canonical_name,
        })),
      });
    } catch (e) {
      args.notes.push(
        `review enqueue failed for "${unit.candidateMention}": ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  return {
    outcome: attributed ? 'attributed' : 'unattributed',
    person_id: personId,
    roster_entry: rosterEntry,
    basis,
    bind_confidence: bindConfidence,
    content_hash: contentHash,
    normalized_hash: normalizedHash,
    raw_evidence_id: rawId,
    candidate_mention: unit.candidateMention,
    detail: attributed
      ? `attributed to ${personId} (${resolveDetail}); raw_evidence ${rawId}`
      : `held unattributed (${resolveDetail}); raw_evidence ${rawId}${enqueue ? ' + review enqueued' : ''}`,
  };
}

// ---------------------------------------------------------------------------
// The trivial EXAMPLE / stub parser -- 'manual_text'.
//
// It does NOT fetch anything; it returns units fed to it inline via
// source.meta.units (an array of ParsedUnit) or via deps.units. This makes the
// generic runner testable end to end with no external source. Builds 1 to 5
// replace this with real parsers (forum video, voter guide, endorsement, ...).
// ---------------------------------------------------------------------------

export const manualTextParser: SourceParser = {
  source_type: 'manual_text',
  async fetchAndParse(harvestSource: HarvestSource, deps: ParserDeps): Promise<ParsedUnit[]> {
    // Prefer units injected via deps (tests / CLI), then source.meta.units.
    const fromDeps = (deps as { units?: ParsedUnit[] }).units;
    if (Array.isArray(fromDeps)) return fromDeps;
    const fromMeta = (harvestSource.meta as { units?: ParsedUnit[] } | null | undefined)?.units;
    if (Array.isArray(fromMeta)) return fromMeta;
    return [];
  },
};

/**
 * Registry of Phase 0 parsers, keyed by source_type. Phase 0 ships only the stub.
 * Builds 1 to 5 add their parsers here (and the CLI picks by source_type). The
 * 'manual_text' source_type is NOT in the migration's source_type CHECK on
 * purpose: it is a TEST-ONLY type used to exercise the runner; real sources use
 * one of the six constrained types and a real parser registered here later.
 */
export const PARSER_REGISTRY: Record<string, SourceParser> = {
  manual_text: manualTextParser,
};

/** Look up the parser for a source_type, or null when none is registered yet. */
export function parserFor(sourceType: string): SourceParser | null {
  return PARSER_REGISTRY[sourceType] ?? null;
}
