/**
 * Cross-device pick handoff (Booth Mode, V2 pillar 5b).
 *
 * The embed widget runs inside a partner iframe on (usually) a desktop reader
 * page. To carry the voter's issue answers to the phone they will bring into the
 * voting booth, we encode those answers into a COMPACT payload placed in the URL
 * FRAGMENT of the booth link (and the QR code that renders it). The fragment is
 * never transmitted to any server (browsers do not send the hash in a request),
 * so this respects the absolute on-device rule: opinions live only on the device
 * and travel only inside the URL the voter carries with them.
 *
 * This module is PURE: it has no store / IndexedDB import, so bundling it into
 * the third-party embed never pulls the device-storage code path into the iframe.
 * The write side (importing a decoded handoff into device storage) lives in
 * handoff-apply.ts, which only the first-party booth loads.
 *
 * No em-dashes or en-dashes anywhere per the project formatting rule.
 */

import type { Domain } from '@/types/database';

/**
 * The 8 policy domains in canonical order, so a domain rides the wire as a single
 * digit index rather than its full name. MUST stay in sync with weights.ts
 * ALL_DOMAINS (asserted at module load below).
 */
export const HANDOFF_DOMAIN_ORDER: Domain[] = [
  'economy',
  'social',
  'healthcare',
  'education',
  'environment',
  'governance',
  'public_safety',
  'infrastructure',
];

/**
 * Agree / disagree map onto the 0..1 axis with a small margin off the extremes,
 * IDENTICAL to the embed's embed-match.ts constants, so the phone reproduces
 * exactly the scoring the widget showed (a single binary tap is not read as
 * absolute certainty).
 */
export const HANDOFF_AGREE_SCORE = 0.85;
export const HANDOFF_DISAGREE_SCORE = 0.15;

/** Wire-format tag, the first two chars of the encoded value. Bump on change. */
const FORMAT_TAG = 'h1';

/**
 * Max encoded length we will place in a QR code. Above this the QR gets too dense
 * to scan reliably off a screen, so the caller drops the picks and links to a
 * bare booth URL (the voter re-answers on the phone). ~1400 base64url chars sits
 * comfortably inside a mid-version QR at error-correction level M.
 */
export const HANDOFF_MAX_ENCODED = 1400;

export interface HandoffAnswer {
  /** sub_dimensions.id the stance is on. */
  issueId: string;
  /** Binary stance. Skips are never encoded (abstention is not a side). */
  choice: 'agree' | 'disagree';
  /** Importance flag (Wahl-O-Mat double-weight); drives domain emphasis. */
  important: boolean;
  /** The issue's policy domain (rebuilds the voter's emphasis on the phone). */
  domain: Domain;
}

// ---------------------------------------------------------------------------
// base64url (browser + node safe)
// ---------------------------------------------------------------------------
// Payloads are pure ASCII (UUIDs + small integers), so a plain btoa/atob round
// trip is sufficient; we translate to the URL-safe alphabet and strip padding so
// the value drops cleanly into a URL fragment.

function toBase64Url(ascii: string): string {
  const b64 =
    typeof btoa === 'function'
      ? btoa(ascii)
      : Buffer.from(ascii, 'binary').toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): string {
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/');
  return typeof atob === 'function'
    ? atob(b64)
    : Buffer.from(b64, 'base64').toString('binary');
}

// ---------------------------------------------------------------------------
// Encode
// ---------------------------------------------------------------------------

/**
 * Encode the voter's binary answers into a compact fragment value. Returns null
 * when there is nothing to carry, or when the encoded value would exceed
 * HANDOFF_MAX_ENCODED (so the caller can fall back to a bare booth link). The
 * returned string does NOT include a leading '#'.
 *
 * Compact row shape: [issueId, choiceCode, importantCode, domainCode]
 *   choiceCode:    1 = agree, 0 = disagree
 *   importantCode: 1 = starred, 0 = not
 *   domainCode:    index into HANDOFF_DOMAIN_ORDER
 */
export function encodeHandoff(answers: HandoffAnswer[]): string | null {
  const rows = answers
    .filter((a) => a.choice === 'agree' || a.choice === 'disagree')
    .map((a) => [
      a.issueId,
      a.choice === 'agree' ? 1 : 0,
      a.important ? 1 : 0,
      Math.max(0, HANDOFF_DOMAIN_ORDER.indexOf(a.domain)),
    ]);

  if (rows.length === 0) return null;

  const encoded = FORMAT_TAG + toBase64Url(JSON.stringify(rows));
  if (encoded.length > HANDOFF_MAX_ENCODED) return null;
  return encoded;
}

// ---------------------------------------------------------------------------
// Decode
// ---------------------------------------------------------------------------

/**
 * Decode a fragment value back into answers. Fails CLOSED: any malformed,
 * wrong-version, or structurally invalid payload returns null (never throws, and
 * never fabricates an answer), so a corrupted QR simply lands the voter on an
 * empty booth rather than a wrong one.
 */
export function decodeHandoff(value: string | null | undefined): HandoffAnswer[] | null {
  if (!value || value.length < FORMAT_TAG.length + 1) return null;
  if (value.slice(0, FORMAT_TAG.length) !== FORMAT_TAG) return null;
  try {
    const json = fromBase64Url(value.slice(FORMAT_TAG.length));
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return null;

    const out: HandoffAnswer[] = [];
    for (const row of parsed) {
      if (!Array.isArray(row) || row.length < 4) return null;
      const [issueId, choiceCode, importantCode, domainCode] = row as unknown[];
      if (typeof issueId !== 'string' || issueId.length === 0) return null;
      if (choiceCode !== 0 && choiceCode !== 1) return null;
      const domain = HANDOFF_DOMAIN_ORDER[Number(domainCode)];
      if (!domain) return null;
      out.push({
        issueId,
        choice: choiceCode === 1 ? 'agree' : 'disagree',
        important: importantCode === 1,
        domain,
      });
    }
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Emphasis derivation (pure) — mirrors embed-match.buildEphemeralProfile
// ---------------------------------------------------------------------------

/**
 * Derive the voter's top-3 prioritized domains from their importance stars,
 * ranked by how many issues they starred in each domain. Empty when nothing was
 * starred, which yields an equal-weight emphasis downstream (every domain counts
 * at baseline) exactly as the widget scored.
 */
export function handoffChosenDomains(answers: HandoffAnswer[]): Domain[] {
  const importantByDomain = new Map<Domain, number>();
  for (const a of answers) {
    if (a.important) {
      importantByDomain.set(a.domain, (importantByDomain.get(a.domain) ?? 0) + 1);
    }
  }
  return [...importantByDomain.entries()]
    .sort((x, y) => y[1] - x[1])
    .map(([d]) => d)
    .slice(0, 3);
}
