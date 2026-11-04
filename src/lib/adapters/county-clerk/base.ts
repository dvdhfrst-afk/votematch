/**
 * County-clerk **candidate-filing** adapter framework.
 *
 * Distinct from `adapters/municipal/` which targets meeting-platforms
 * (Granicus, Legistar). This namespace is for the ~3,143 US county election
 * offices that publish candidate-of-record filings (the people who actually
 * appear on the local ballot — county commissioner, sheriff, school board,
 * municipal court, etc.).
 *
 * Why a separate namespace
 * ------------------------
 * State SoS portals only carry federal + state offices for most states.
 * Sub-state offices — which dominate ballot length — live with the county
 * clerk / county election office. There is no national feed; each county
 * publishes filings via either:
 *
 *   1. A Telerik RadGrid ASP.NET portal (`platform-telerik-radgrid.ts`)
 *   2. A static PDF (`platform-pdf.ts`)
 *   3. A bespoke HTML table or CSV download
 *   4. (rare) A vendor API like Civix or KnowInk
 *
 * v0 framework
 * ------------
 * This file defines the contract every county-clerk adapter implements. The
 * registry (`registry.ts`) keys factories on `${state}-${fips_county}`.
 *
 * Sourcing tier
 * -------------
 * Rows produced by these adapters set `offices.sourcing_tier='filing_direct'`
 * (introduced in migration `20260427000001_office_ballot_coverage.sql`) so the
 * UI can mark this office as "we read the filing" vs. "we inferred it from
 * the SoS roster".
 *
 * Licensing
 * ---------
 * Candidate filings are public record under every state's election code —
 * they are public domain on ingest. NOT subject to the CC-BY-SA share-alike
 * concern that bars OpenStates / Wikipedia / Ballotpedia in this codebase.
 *
 * Refs:
 *   - adapters/base.ts is wrong (no such file); shared types live in
 *     adapters/types.ts. This module re-uses `SourceAdapter<Row>` from there.
 *   - adapters/state-sos/candidacies-shared.ts has the canonical insert path
 *     a future runner-integrated county adapter should reuse.
 */

import type { SourceAdapter } from '../types';

// ---------------------------------------------------------------------------
// Row shape — must match the apply-2026-candidates.ts CandidateRecord input
// shape so a county adapter's output can flow into the same downstream
// upsert without translation.
// ---------------------------------------------------------------------------

/**
 * Raw candidacy record produced by a county-clerk adapter.
 *
 * Field shape mirrors `CandidateRecord` in
 * `scripts/apply-2026-candidates.ts` so an adapter's output can be written
 * straight into a per-state JSON file for that script, OR fed through
 * `state-sos/candidacies-shared.ts#insertGenericCandidacies` once the runner
 * wiring lands.
 */
export type RawCandidacy = {
  /** Full name as filed, normalized to "First M. Last [Suffix]" form. */
  canonical_name: string;
  /** Free-form party label as printed on the filing ('R'/'D'/'NPP'/...). */
  party?: string | null;
  /** Canonical office_type slug — see scripts/apply-2026-candidates.ts. */
  office_type_slug: string;
  /** District identifier (e.g. 'commissioner-district-3'); null for at-large. */
  district?: string | null;
  /** Optional human-readable office name as printed on the filing. */
  office_canonical_name?: string | null;
  /** ISO date of the election the filing is for (primary or general). */
  election_date?: string | null;
  /** Email pulled from the filing form, if printed publicly. */
  contact_email?: string | null;
  /** Tag for provenance ('county-filing-form' | 'county-pdf-roster' | ...). */
  contact_email_source?: string | null;
  /** Campaign or candidate website printed on the filing, if any. */
  campaign_website_url?: string | null;
  /** Free-form notes preserved from the source row (e.g. 'write-in'). */
  notes?: string | null;
  /** YYYY birth year if printed on the filing (rare; used for person dedup). */
  birth_year?: number | null;
};

// ---------------------------------------------------------------------------
// Adapter contract
// ---------------------------------------------------------------------------

/**
 * Discriminator on `data_sources.source_type` for rows produced by this
 * namespace. Matches the new value added in the office_ballot_coverage
 * migration; the runner will reject any other value.
 */
export const COUNTY_CLERK_SOURCE_TYPE = 'county_clerk' as const;

/**
 * The county-clerk variant of `SourceAdapter<RawCandidacy>`. Adds a
 * convenience `fetchFilings()` for callers that want a parser-only invocation
 * (e.g. testing a county against a saved HTML fixture) without going through
 * the full `runAdapter()` audit pipeline.
 */
export interface CountyClerkAdapter
  extends Omit<SourceAdapter<RawCandidacy>, 'stateFips'> {
  /** Two-letter USPS code, uppercase. */
  state: string;
  /** 3-digit county FIPS as string ('201' for Harris, TX). */
  fips_county: string;
  /** Source type — pinned to 'county_clerk' for the registry / runner. */
  source_type: typeof COUNTY_CLERK_SOURCE_TYPE;
  /**
   * Standalone fetch+parse entrypoint. Returns the parsed RawCandidacy[]
   * without writing to the DB. The runner-integrated path goes through
   * SourceAdapter.run() / .insert() instead.
   */
  fetchFilings(election_year: number): Promise<RawCandidacy[]>;
}

// ---------------------------------------------------------------------------
// Abstract base — shared utilities only; concrete adapters extend this
// ---------------------------------------------------------------------------

/**
 * Optional base class for per-county adapters. Provides shared name /
 * date / party normalization helpers so each county adapter doesn't reinvent
 * them.
 *
 * Subclasses MUST implement `fetchFilings()`, `run()`, and `insert()`.
 * The `validateRow()` default below covers the common-case "name and office
 * are present" check — override for state-specific stricter rules.
 */
export abstract class BaseCountyClerkAdapter implements CountyClerkAdapter {
  abstract readonly name: string;
  abstract readonly state: string;
  abstract readonly fips_county: string;
  readonly source_type = COUNTY_CLERK_SOURCE_TYPE;

  abstract fetchFilings(election_year: number): Promise<RawCandidacy[]>;
  abstract run: SourceAdapter<RawCandidacy>['run'];
  abstract insert: SourceAdapter<RawCandidacy>['insert'];

  validateRow(row: RawCandidacy): string | null {
    if (!row.canonical_name || row.canonical_name.trim().length === 0) {
      return 'missing canonical_name';
    }
    if (!row.office_type_slug || row.office_type_slug.trim().length === 0) {
      return 'missing office_type_slug';
    }
    if (
      row.contact_email &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.contact_email)
    ) {
      return `invalid contact_email: ${row.contact_email}`;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Shared utilities
  // -------------------------------------------------------------------------

  /**
   * Normalize a candidate name to "First M. Last [Suffix]" form.
   *
   *   - Collapses whitespace
   *   - Title-cases lowercase ALLCAPS submissions ("ALEX EXAMPLE" → "Alex Example")
   *   - Strips parenthetical nicknames ('"Doc"', '(Mike)') for the canonical key
   *     but preserves them in `notes` if the caller wants them
   *
   * Conservative — does NOT attempt to re-order "Last, First" submissions,
   * since that varies by county and a wrong reorder is worse than passing
   * the original through. Subclasses should call `flipLastFirst()` first if
   * the source has a known `LAST, FIRST` layout.
   */
  protected normalizeName(raw: string): string {
    if (!raw) return '';
    let out = raw.replace(/\s+/g, ' ').trim();
    // Drop the bracketed-nickname forms.
    out = out.replace(/\s*"[^"]*"\s*/g, ' ').replace(/\s*\([^)]*\)\s*/g, ' ');
    out = out.replace(/\s+/g, ' ').trim();
    // Title-case if everything was uppercase or everything was lowercase.
    if (out === out.toUpperCase() || out === out.toLowerCase()) {
      out = out
        .toLowerCase()
        .split(' ')
        .map((p) =>
          p.length === 0
            ? p
            : p[0].toUpperCase() + p.slice(1),
        )
        .join(' ');
    }
    return out;
  }

  /** Flip "Last, First M." → "First M. Last". No-op if no comma. */
  protected flipLastFirst(raw: string): string {
    if (!raw) return '';
    const idx = raw.indexOf(',');
    if (idx < 0) return raw.trim();
    const last = raw.slice(0, idx).trim();
    const rest = raw.slice(idx + 1).trim();
    if (!last || !rest) return raw.trim();
    return `${rest} ${last}`;
  }

  /**
   * Parse a date the way county filings tend to print them:
   *
   *   - ISO 8601 (passes through)
   *   - "MM/DD/YYYY"
   *   - "Month D, YYYY"
   *
   * Returns the canonical `YYYY-MM-DD` form, or null if unparseable.
   */
  protected parseFilingDate(raw: string | null | undefined): string | null {
    if (!raw) return null;
    const s = raw.trim();
    if (!s) return null;
    // Already ISO?
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s);
    if (slash) {
      const m = slash[1].padStart(2, '0');
      const d = slash[2].padStart(2, '0');
      const y = slash[3].length === 2 ? `20${slash[3]}` : slash[3];
      return `${y}-${m}-${d}`;
    }
    const t = Date.parse(s);
    if (!Number.isNaN(t)) {
      return new Date(t).toISOString().slice(0, 10);
    }
    return null;
  }

  /**
   * Map a raw party string to a canonical short label.
   *
   * Conservative — only collapses the most common label spellings; preserves
   * the original for everything else so downstream party_resolver can decide.
   */
  protected normalizeParty(raw: string | null | undefined): string | null {
    if (!raw) return null;
    const s = raw.trim();
    if (!s) return null;
    const upper = s.toUpperCase();
    if (upper === 'D' || upper === 'DEM' || upper === 'DEMOCRAT' || upper === 'DEMOCRATIC') {
      return 'Democratic';
    }
    if (upper === 'R' || upper === 'REP' || upper === 'REPUBLICAN') {
      return 'Republican';
    }
    if (
      upper === 'NPP' ||
      upper === 'NP' ||
      upper === 'NONE' ||
      upper === 'UNAFFILIATED' ||
      upper === 'INDEPENDENT'
    ) {
      return 'Nonpartisan';
    }
    return s;
  }
}
