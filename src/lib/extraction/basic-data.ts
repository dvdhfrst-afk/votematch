/**
 * Basic-data extraction — Havesay / 2026-04-27
 *
 * Stub for the BASIC-DATA pipeline (the six per-candidate string fields the
 * verify-step gates on). Distinct from the 19-dim ideological positioning
 * classifier (that one already has its bias eval; this is the "did we get
 * the candidate's NAME right" eval).
 *
 * Real implementation will fan out to ollama / Claude based on `kind`.
 * For now:
 *   - `no_source` or empty `text`         → all-nulls
 *   - `sos_json`                          → JSON.parse and pick known keys
 *   - everything else                     → all-nulls (TODO)
 *
 * The gate is per-field F1 against the gold set in
 * 14-classifier-baseline/basic-data-gold-set.json. See
 * scripts/eval-basic-data-extraction.ts.
 */

export type SourceKind =
  | 'sos_pdf'
  | 'sos_html'
  | 'sos_json'
  | 'fec_committee'
  | 'campaign_website'
  | 'no_source';

export type BasicData = {
  canonical_name: string | null;
  party: string | null;
  office_type_slug: string | null;
  district: string | null;
  contact_email: string | null;
  campaign_website_url: string | null;
};

const NULL_RESULT: BasicData = {
  canonical_name: null,
  party: null,
  office_type_slug: null,
  district: null,
  contact_email: null,
  campaign_website_url: null,
};

function pickString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function extractFromSosJson(text: string): BasicData {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ...NULL_RESULT };
  }
  if (!parsed || typeof parsed !== 'object') return { ...NULL_RESULT };
  const obj = parsed as Record<string, unknown>;
  return {
    canonical_name: pickString(obj.canonical_name),
    party: pickString(obj.party),
    office_type_slug: pickString(obj.office_type_slug),
    district: pickString(obj.district),
    contact_email: pickString(obj.contact_email),
    campaign_website_url: pickString(obj.campaign_website_url),
  };
}

/**
 * Extract the six basic-data fields from a single source excerpt.
 * Returns all-nulls for kinds that aren't yet implemented — the eval will
 * fail those F1s, which is the intended signal that they need work.
 */
export function extractBasicData(text: string, kind: SourceKind): BasicData {
  if (kind === 'no_source') return { ...NULL_RESULT };
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { ...NULL_RESULT };
  }
  if (kind === 'sos_json') {
    return extractFromSosJson(text);
  }
  // TODO(2026-04-27): implement sos_pdf / sos_html / fec_committee /
  // campaign_website. For now they fall through to all-nulls and the
  // eval will report low recall on those rows — that's the right signal.
  return { ...NULL_RESULT };
}
