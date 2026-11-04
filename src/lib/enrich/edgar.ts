/**
 * enrich/edgar.ts -- SEC (Securities and Exchange Commission) EDGAR insider ties.
 *
 * NAME-ONLY source, LOW PRIORITY. EDGAR has no crosswalk to our people; we match
 * a person's name against the names of insiders (officers/directors/10%-owners)
 * who file Forms 3/4/5. Names are not unique -> every row is STAGED:
 *   bind_method='name_match', verified=false, requires_strong_id=true.
 *
 * EDGAR access (data.sec.gov + efts.sec.gov):
 *   1. GET https://www.sec.gov/files/company_tickers.json  -> ticker/CIK map
 *      (we DON'T actually need company CIKs to find a PERSON; this file is the
 *      spec's named entrypoint and we cache it for any company-name fallback).
 *   2. GET https://efts.sec.gov/LATEST/search-index?q="{name}"&forms=3,4,5
 *      EDGAR full-text search (EFTS) returns filings whose text contains the
 *      name; we read the hits for Forms 3/4/5 (insider transactions).
 *
 * REQUIREMENTS (SEC fair-access policy): a DESCRIPTIVE User-Agent header is
 * MANDATORY (they block requests without one) and the rate limit is 10 req/s.
 * No API key. We send a Havesay contact UA and keep volume tiny (this is
 * a low-priority, opt-in source).
 *
 * Produces ZERO-OR-MORE candidate_records rows of record_type='business', one
 * per matched insider filing (capped), each staged for review.
 */

import {
  fetchJson,
  nameMatchRow,
  type CandidateRecordRow,
  type EnrichContext,
} from './types';

const EDGAR_FTS = 'https://efts.sec.gov/LATEST/search-index';
const MAX_FILINGS = 10;

// SEC requires a descriptive User-Agent with a contact. Overridable via env so
// the operator can put a real contact address without editing code.
function userAgent(): string {
  return (
    process.env.SEC_EDGAR_USER_AGENT?.trim() ||
    'Havesay civic-data enrichment (contact: data@example.org)'
  );
}

export interface EdgarFilingHit {
  _id?: string; // accession-no:document
  _source?: {
    display_names?: string[]; // e.g. ["SMITH JOHN (CIK 0001234567)"]
    file_type?: string; // "3" | "4" | "5"
    file_date?: string;
    ciks?: string[];
    root_forms?: string[];
  };
}

interface EftsResponse {
  hits?: {
    total?: { value?: number };
    hits?: EdgarFilingHit[];
  };
}

/**
 * PURE. Map EDGAR full-text-search hits into staged business rows. We keep only
 * hits whose display_names plausibly contain the searched person's surname, to
 * cut the worst false positives -- but the row is STILL name-only and staged.
 */
export function normalizeEdgar(
  name: string,
  hits: EdgarFilingHit[],
  ctx: EnrichContext,
  fetchedAt?: string,
): CandidateRecordRow[] {
  const surname = name.trim().split(/\s+/).pop()?.toLowerCase() ?? '';
  const note =
    `NAME-MATCH ONLY (SEC EDGAR Forms 3/4/5). Searched insider filings for ` +
    `"${name}". Homonym risk is high; confirm identity before any surfacing. ` +
    `requires_strong_id=true until human-verified.`;

  const rows: CandidateRecordRow[] = [];
  for (const h of hits ?? []) {
    const src = h._source ?? {};
    const displayNames = src.display_names ?? [];
    // Conservative surname gate (still name-only): skip hits that don't even
    // contain the surname token.
    if (
      surname &&
      !displayNames.some((dn) => dn.toLowerCase().includes(surname))
    ) {
      continue;
    }
    const accession = h._id ?? null;
    const cik = src.ciks?.[0] ?? null;
    const url = cik && accession
      ? `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${encodeURIComponent(cik)}&type=4`
      : 'https://www.sec.gov/cgi-bin/srqsb?text=' + encodeURIComponent(name);
    rows.push(
      nameMatchRow({
        person_id: ctx.person_id,
        record_type: 'business',
        source: 'edgar',
        source_url: url,
        external_ref: accession,
        payload: {
          searched_name: name,
          display_names: displayNames,
          form_type: src.file_type ?? src.root_forms?.[0] ?? null,
          file_date: src.file_date ?? null,
          ciks: src.ciks ?? [],
        },
        note,
        bind_confidence: 0.25,
        fetched_at: fetchedAt,
      }),
    );
    if (rows.length >= MAX_FILINGS) break;
  }
  return rows;
}

/**
 * fetchEdgar: insider-filing search by name (Forms 3/4/5). NAME-ONLY -> staged.
 * Low priority; small volume. Requires a descriptive User-Agent (sent below).
 */
export async function fetchEdgar(
  name: string,
  ctx: EnrichContext,
): Promise<CandidateRecordRow[]> {
  if (!name || !name.trim()) return [];

  let hits: EdgarFilingHit[] = [];
  try {
    const url =
      `${EDGAR_FTS}?q=` +
      encodeURIComponent(`"${name.trim()}"`) +
      `&forms=3,4,5`;
    const res = await fetchJson<EftsResponse>(url, {
      headers: { 'User-Agent': userAgent() },
    });
    hits = res.hits?.hits ?? [];
  } catch (e) {
    if (!(e instanceof Error && /HTTP 404/.test(e.message))) throw e;
  }

  return normalizeEdgar(name.trim(), hits, ctx);
}
