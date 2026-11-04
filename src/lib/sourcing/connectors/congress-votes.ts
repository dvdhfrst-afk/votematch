/**
 * Congress.gov voting-record connector — tier-1 source material for federal
 * incumbents via the official Congress.gov API.
 *
 * Per council 2026-04-19 (14-classifier-baseline/02-source-connector-council.md)
 * item 4: voting records are the highest-leverage per-candidate data source.
 * Government-published records have the strongest fair-report privilege
 * (Utah Code § 45-2-3(4); § 76-9-504), lowest defamation exposure, and richest
 * per-candidate signal — especially for incumbents.
 *
 * **Scope: federal only.** Council greenlit federal immediately; state-level
 * (OpenStates) deferred pending per-state quality audit. OpenStates has
 * documented TX/OH vote-data gaps per the 14-classifier-baseline research.
 *
 * Strategy:
 *   1. Only run for federal-level candidates whose name matches a current
 *      Congress.gov member (heuristic match on last-name + state).
 *   2. For matched members: fetch recent member detail + their sponsored
 *      legislation (up to N recent).
 *   3. Emit one tier-1 source per coherent chunk (member profile; sponsored
 *      bills summary). We don't emit one row per vote — too granular; the
 *      classifier benefits from aggregated context.
 *
 * Uses api.data.gov umbrella key (CONGRESS_API_KEY env var — same key as
 * FEC, Regulations.gov per prior legal-review onboarding).
 */
import type { SourceConnector, SourceRow, CandidateContext } from '../connector-types';

const BASE = 'https://api.congress.gov/v3';
const UA = 'Havesay/1.0 (nonpartisan voter-information project, in development)';

function apiKey(): string | null {
  const k = process.env.CONGRESS_API_KEY;
  if (!k || k.startsWith('your-')) return null;
  return k;
}

type CongressMember = {
  bioguideId: string;
  name: string;
  firstName?: string;
  lastName?: string;
  state?: string;
  district?: number;
  partyName?: string;
  terms?: { item?: { chamber?: string; startYear?: number; endYear?: number }[] };
  url?: string;
};

type MemberDetail = {
  bioguideId?: string;
  firstName?: string;
  lastName?: string;
  directOrderName?: string;
  state?: string;
  partyName?: string;
  district?: number;
  terms?: { item?: Array<{ chamber?: string; startYear?: number; endYear?: number }> };
  sponsoredLegislation?: { url?: string; count?: number };
  cosponsoredLegislation?: { url?: string; count?: number };
};

type SponsoredBill = {
  congress?: number;
  type?: string;
  number?: number | string;
  title?: string;
  introducedDate?: string;
  latestAction?: { actionDate?: string; text?: string };
  policyArea?: { name?: string };
};

async function apiGet<T>(
  path: string,
  params: Record<string, string | number> = {},
): Promise<T | null> {
  const key = apiKey();
  if (!key) return null;
  const url = new URL(`${BASE}${path}`);
  url.searchParams.set('api_key', key);
  url.searchParams.set('format', 'json');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

  try {
    const res = await fetch(url.toString(), {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/**
 * Find a Congress.gov member matching the candidate.
 *
 * **Strict match requirement** (hardened 2026-04-19 after smoke-test caught
 * one member matching a different member with the same last name in another state): we require state
 * to match AND (last name match + at least first-letter of first name match,
 * or explicit full first-name match). A lone last-name match within a state
 * is only used when state-filtering returns exactly ONE candidate with that
 * last name.
 *
 * Returns null if no unambiguous match — we'd rather return no data than
 * attribute another member's record to our candidate (defamation risk).
 */
async function findMember(candidate: CandidateContext): Promise<CongressMember | null> {
  // If we already know the bioguide_id, fetch by it — the most reliable path
  if (candidate.bioguide_id) {
    const data = await apiGet<{ member?: MemberDetail }>(`/member/${candidate.bioguide_id}`);
    if (data?.member) {
      return {
        bioguideId: data.member.bioguideId ?? candidate.bioguide_id,
        name: data.member.directOrderName ?? candidate.name,
        firstName: data.member.firstName,
        lastName: data.member.lastName,
        state: data.member.state,
        partyName: data.member.partyName,
        district: data.member.district,
        terms: data.member.terms,
      };
    }
  }

  // Parse candidate name
  const parts = candidate.name
    .replace(/^(Sen\.|Rep\.|Dr\.|Mr\.|Ms\.|Mrs\.)\s+/i, '')
    .replace(/\s+(Jr\.|Sr\.|II|III|IV)$/i, '')
    .trim()
    .split(/\s+/);
  const targetLastName = parts[parts.length - 1]?.toLowerCase();
  const targetFirstName = parts[0]?.toLowerCase();
  if (!targetLastName || !targetFirstName) return null;

  const stateCodeMap: Record<string, string> = {
    Alabama: 'AL', Alaska: 'AK', Arizona: 'AZ', Arkansas: 'AR', California: 'CA',
    Colorado: 'CO', Connecticut: 'CT', Delaware: 'DE', Florida: 'FL', Georgia: 'GA',
    Hawaii: 'HI', Idaho: 'ID', Illinois: 'IL', Indiana: 'IN', Iowa: 'IA',
    Kansas: 'KS', Kentucky: 'KY', Louisiana: 'LA', Maine: 'ME', Maryland: 'MD',
    Massachusetts: 'MA', Michigan: 'MI', Minnesota: 'MN', Mississippi: 'MS',
    Missouri: 'MO', Montana: 'MT', Nebraska: 'NE', Nevada: 'NV',
    'New Hampshire': 'NH', 'New Jersey': 'NJ', 'New Mexico': 'NM',
    'New York': 'NY', 'North Carolina': 'NC', 'North Dakota': 'ND', Ohio: 'OH',
    Oklahoma: 'OK', Oregon: 'OR', Pennsylvania: 'PA', 'Rhode Island': 'RI',
    'South Carolina': 'SC', 'South Dakota': 'SD', Tennessee: 'TN', Texas: 'TX',
    Utah: 'UT', Vermont: 'VT', Virginia: 'VA', Washington: 'WA',
    'West Virginia': 'WV', Wisconsin: 'WI', Wyoming: 'WY',
  };

  // Strict state-name extraction: whitelist-based regex, case-insensitive,
  // word-boundary anchored. Prior regex greedily captured "Utah District"
  // (see the same-last-name smoke-test incident 2026-04-19 — race_name was
  // "U.S. House — Utah District 1 (2024 primary)").
  const stateNames = Object.keys(stateCodeMap);
  const stateRe = new RegExp(
    `\\b(${stateNames.map((s) => s.replace(/ /g, '\\s+')).join('|')})\\b`,
    'i',
  );
  const stateMatch = candidate.race_name?.match(stateRe);
  const stateName = stateMatch?.[1];
  const stateCode = stateName
    ? stateCodeMap[
        stateName
          .toLowerCase()
          .split(/\s+/)
          .map((w) => w[0].toUpperCase() + w.slice(1))
          .join(' ')
      ]
    : null;

  // If we don't have a state, we refuse to match — too risky (see the
  // same-last-name incident 2026-04-19).
  if (!stateCode) return null;

  // Correct endpoint: /member/{stateCode} — the /member?stateCode=... query
  // param is silently ignored and returns a global list (another bug caught
  // by smoke test 2026-04-19).
  const data = await apiGet<{ members?: CongressMember[] }>(`/member/${stateCode}`, {
    currentMember: 'true',
    limit: 50,
  });
  const members = data?.members ?? [];

  // Step 1: last-name matches within state. The response uses name format
  // "Lastname, Firstname" and often lacks separate firstName/lastName fields;
  // parse from `name` when structured fields are missing.
  const extractNames = (m: CongressMember): { last: string; first: string } => {
    if (m.lastName && m.firstName) {
      return { last: m.lastName.toLowerCase(), first: m.firstName.toLowerCase() };
    }
    const nameParts = (m.name ?? '').split(',').map((s) => s.trim());
    return {
      last: (nameParts[0] ?? '').toLowerCase(),
      // Remove middle initials like "Blake D." → "blake"
      first: (nameParts[1] ?? '').split(/\s+/)[0]?.toLowerCase() ?? '',
    };
  };

  const lastHits = members.filter((m) => extractNames(m).last === targetLastName);

  if (lastHits.length === 0) return null;

  // Step 2: if single last-name hit within state, that's our match
  if (lastHits.length === 1) return lastHits[0];

  // Step 3: multiple people with same last name in same state — require
  // first-name match to disambiguate
  const firstHit = lastHits.find((m) => {
    const first = extractNames(m).first;
    return first === targetFirstName || (first && first[0] === targetFirstName[0]);
  });
  return firstHit ?? null;
}

async function fetchSponsoredBills(
  bioguideId: string,
  limit = 15,
): Promise<SponsoredBill[]> {
  const data = await apiGet<{ sponsoredLegislation?: SponsoredBill[] }>(
    `/member/${bioguideId}/sponsored-legislation`,
    { limit },
  );
  return data?.sponsoredLegislation ?? [];
}

export const congressVotesConnector: SourceConnector = {
  name: 'congress_votes',

  applicable(candidate) {
    if (candidate.race_level !== 'federal') {
      return {
        applicable: false,
        reason: `congress_votes requires race_level=federal; got ${candidate.race_level ?? '(unknown)'}`,
      };
    }
    if (apiKey() === null) {
      return {
        applicable: false,
        reason: 'CONGRESS_API_KEY env var not set or still the placeholder',
      };
    }
    return { applicable: true };
  },

  async fetch(candidate) {
    const member = await findMember(candidate);
    if (!member) return [];

    // Fetch full detail so we have sponsored/cosponsored URLs
    const detail = await apiGet<{ member?: MemberDetail }>(`/member/${member.bioguideId}`);
    const memberDetail = detail?.member;

    const bills = await fetchSponsoredBills(member.bioguideId, 15);

    const rows: SourceRow[] = [];
    const memberProfileLines: string[] = [
      `Congress.gov member profile for ${member.name}`,
      `Bioguide ID: ${member.bioguideId}`,
      `Party: ${memberDetail?.partyName ?? member.partyName ?? '(unknown)'}`,
      `State: ${memberDetail?.state ?? member.state ?? '(unknown)'}`,
    ];
    if (memberDetail?.district) memberProfileLines.push(`District: ${memberDetail.district}`);

    const currentTerm = memberDetail?.terms?.item?.[memberDetail.terms.item.length - 1];
    if (currentTerm) {
      memberProfileLines.push(
        `Current term: ${currentTerm.chamber ?? '?'} ${currentTerm.startYear ?? '?'}–${currentTerm.endYear ?? 'present'}`,
      );
    }

    if (memberDetail?.sponsoredLegislation?.count !== undefined) {
      memberProfileLines.push(
        `Sponsored legislation (total): ${memberDetail.sponsoredLegislation.count}`,
      );
    }
    if (memberDetail?.cosponsoredLegislation?.count !== undefined) {
      memberProfileLines.push(
        `Cosponsored legislation (total): ${memberDetail.cosponsoredLegislation.count}`,
      );
    }

    rows.push({
      source_type: 'voting_record',
      authenticity_tier: 1,
      outlet_ideology: null,
      url: memberDetail?.bioguideId
        ? `https://www.congress.gov/member/${memberDetail.firstName}-${memberDetail.lastName}/${memberDetail.bioguideId}`.toLowerCase()
        : `https://api.congress.gov/v3/member/${member.bioguideId}`,
      title: `${member.name} — Congress.gov member profile`,
      raw_data: memberProfileLines.join('\n'),
      published_at: new Date().toISOString(),
    });

    // Aggregate sponsored bills into one source row (classifier handles
    // structured text well; separating into 15 rows would bloat the DB).
    if (bills.length > 0) {
      const billLines: string[] = [
        `Sponsored legislation by ${member.name} (most recent ${bills.length}):`,
        '',
      ];
      for (const b of bills) {
        billLines.push(
          `- ${b.type?.toUpperCase() ?? '??'} ${b.number ?? '?'} (${b.congress ?? '?'}th Congress): ${b.title ?? '(no title)'}`,
        );
        if (b.policyArea?.name) billLines.push(`  policy area: ${b.policyArea.name}`);
        if (b.latestAction?.text) {
          billLines.push(
            `  latest action ${b.latestAction.actionDate ?? ''}: ${b.latestAction.text}`,
          );
        }
      }
      rows.push({
        source_type: 'voting_record',
        authenticity_tier: 1,
        outlet_ideology: null,
        url: `https://www.congress.gov/member/${member.bioguideId}/sponsored-legislation`,
        title: `${member.name} — Sponsored legislation (${bills.length} bills)`,
        raw_data: billLines.join('\n'),
        published_at: new Date().toISOString(),
      });
    }

    return rows;
  },
};
