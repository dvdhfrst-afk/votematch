/**
 * Regulations.gov API wrapper for federal public-comment window ingestion.
 *
 * API docs: https://open.gsa.gov/api/regulationsgov/
 * Rate limit: 50 req/min, 500 req/hr (documented).
 *
 * We query documents with `documentType=Proposed Rule` and filter to those
 * with an open comment period (commentEndDate >= today).
 */

const BASE = 'https://api.regulations.gov/v4';

function apiKey(): string | null {
  const k = process.env.REGULATIONS_API_KEY;
  if (!k) return null;
  return k;
}

export function isRegulationsApiConfigured(): boolean {
  return apiKey() !== null;
}

export type RegDocument = {
  id: string;
  type: string;
  attributes: {
    title: string;
    agencyId?: string;
    docketId?: string;
    commentStartDate?: string;
    commentEndDate?: string;
    documentType?: string;
    postedDate?: string;
    subtype?: string;
    withdrawn?: boolean;
  };
  links?: { self?: string };
};

async function api<T>(path: string, params: Record<string, string | number>): Promise<T> {
  const key = apiKey();
  if (!key) {
    throw new Error(
      'REGULATIONS_API_KEY is not configured. Sign up at https://api.data.gov/signup/ and set the env var, or skip regulations ingestion.',
    );
  }
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

  const res = await fetch(url.toString(), {
    headers: {
      'X-Api-Key': key,
      Accept: 'application/vnd.api+json',
    },
    signal: AbortSignal.timeout(20_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `Regulations.gov ${path} failed: ${res.status} ${res.statusText} ${body.slice(0, 200)}`,
    );
  }
  return (await res.json()) as T;
}

/**
 * Iterate over currently-open proposed rules. Uses `filter[commentEndDate][ge]`
 * to filter server-side to those whose comment period is still open.
 */
export async function* iterOpenProposedRules(opts: {
  sinceDate?: string;
  maxPages?: number;
}): AsyncGenerator<RegDocument> {
  let pageNumber = 1;
  const pageSize = 250;
  const maxPages = opts.maxPages ?? 20;
  const today = new Date().toISOString().slice(0, 10);

  while (pageNumber <= maxPages) {
    const params: Record<string, string | number> = {
      'filter[documentType]': 'Proposed Rule',
      'filter[commentEndDate][ge]': today,
      'page[size]': pageSize,
      'page[number]': pageNumber,
      sort: 'commentEndDate',
    };
    if (opts.sinceDate) {
      params['filter[postedDate][ge]'] = opts.sinceDate;
    }

    const data = await api<{ data: RegDocument[]; meta?: { totalPages?: number } }>(
      '/documents',
      params,
    );
    const batch = data.data ?? [];
    for (const d of batch) yield d;

    if (batch.length < pageSize) break;
    const totalPages = data.meta?.totalPages ?? pageNumber;
    if (pageNumber >= totalPages) break;
    pageNumber += 1;
  }
}
