/**
 * Illinois State Board of Elections — 2026 candidate-filings adapter (FIPS 17).
 *
 * Source pages (web-verified 2026-04-25):
 *   Search:     https://www.elections.il.gov/CampaignDisclosure/CandidateSearch.aspx
 *   List:       https://www.elections.il.gov/electionoperations/CandidatesList.aspx
 *   Default:    https://www.elections.il.gov/electionoperations/Default.aspx
 *
 * State of play
 * -------------
 * The Illinois SBE publishes its filed-candidate list through a classic
 * ASP.NET WebForms application. Both `CandidateSearch.aspx` and
 * `CandidatesList.aspx` render an empty form on initial GET — to surface
 * candidates the client must POST back with hidden `__VIEWSTATE`,
 * `__EVENTVALIDATION`, `__VIEWSTATEGENERATOR` plus an election ID
 * dropdown selection. That's a multi-step scrape: GET the form, harvest
 * the hidden fields, POST with the right ddl values. politeFetch (tier 1)
 * doesn't run a JS engine, so we can't expand the dynamic dropdown
 * options either; the IL SBE doesn't expose a static .csv / .xlsx /
 * .pdf alternative.
 *
 * Probes attempted (all returned the empty post-back-only shell):
 *   /electionoperations/CandidatesList.aspx?ID=<n>     (n=1..100)
 *   /electionoperations/CandidatesFiledForOffice.aspx  (renamed to ASP.NET error)
 *   /electionoperations/SBE_FilingPeriodCandidates.aspx (same)
 *   /Downloads/ElectionOperations/Pdf/2026/2026CandidatesFiledForOffice.pdf (404)
 *
 * Behaviour
 * ---------
 * Day 0: this adapter records provenance against `CandidateSearch.aspx`
 * (the longest-lived public surface) and returns []. The dispatcher
 * classifies the run as 'partial' which surfaces clearly in
 * ingestion_runs.
 *
 * Day-2 fix: build a small ASP.NET postback driver — GET the form,
 * harvest hidden `__VIEWSTATE`/`__EVENTVALIDATION`, POST with
 * `ctl00$ContentPlaceHolder1$ddlElection=<elec-id>`, parse the resulting
 * tabular HTML. We've already bumped against the same shape on a few
 * other state portals; an ASP.NET helper module will live in
 * `state-sos/shared/aspnet-postback.ts` once we have ≥2 customers.
 *
 * Illinois 2026 ballot scope (primary 2026-03-17, general 2026-11-03):
 *   - Governor + Lt. Governor (joint ticket)
 *   - U.S. Senate (Class II seat) + U.S. House (17 districts)
 *   - State Senate (~20 of 59 seats on the 2026 cycle)
 *   - State House (all 118 districts)
 *   - Statewide row offices (AG, SoS, Treasurer, Comptroller)
 *   - Cook County row offices + judicial retentions
 *
 * Note: IL primary is March 17, 2026 — already past at the time this
 * adapter ships. The historical filing list is still useful for
 * candidate dossier lookups, but going forward this adapter will run
 * mostly to capture write-ins / general-election ballot-line additions.
 */

import { createHash } from 'node:crypto';

import { politeFetch } from '../../fetch-polite';
import {
  insertCandidacies,
  type CandidacyInsertRow,
} from '../shared/candidacies-insert';
import type {
  AdapterContext,
  AdapterOutcome,
  DataSourceLicense,
  InsertRefs,
  InsertStats,
  SourceAdapter,
} from '../../types';
import { createTokenBucket } from '../../rate-limit';

const STATE_FIPS = '17';
const ELECTION_YEAR = 2026;
const PRIMARY_DATE = '2026-03-17';
const GENERAL_DATE = '2026-11-03';

const DEFAULT_SOURCE_URL =
  'https://www.elections.il.gov/CampaignDisclosure/CandidateSearch.aspx';
const ALT_LIST_URL =
  'https://www.elections.il.gov/electionoperations/CandidatesList.aspx';

// ---------------------------------------------------------------------------
// Row type
// ---------------------------------------------------------------------------

export type IlCandidacyRow = CandidacyInsertRow;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export type IlCandidaciesAdapterOptions = {
  sourceUrl?: string;
  electionYear?: number;
  license?: DataSourceLicense;
  tokenBucket?: { rps: number; burst: number };
  fetchOverride?: () => Promise<{ status: number; body: string; resolvedUrl?: string }>;
  parseOverride?: (html: string) => IlCandidacyRow[];
};

export function createIlCandidaciesAdapter(
  options: IlCandidaciesAdapterOptions = {},
): SourceAdapter<IlCandidacyRow> {
  const sourceUrl = options.sourceUrl ?? DEFAULT_SOURCE_URL;
  const electionYear = options.electionYear ?? ELECTION_YEAR;
  const license: DataSourceLicense = options.license ?? 'state_open_records';
  const tokenBucketCfg = options.tokenBucket ?? { rps: 0.5, burst: 2 };
  const bucket = createTokenBucket(tokenBucketCfg);

  const adapter: SourceAdapter<IlCandidacyRow> = {
    name: 'sos-illinois-sbe-candidacies',
    stateFips: STATE_FIPS,
    tokenBucket: tokenBucketCfg,
    costService: 'other',

    async run(ctx: AdapterContext): Promise<AdapterOutcome<IlCandidacyRow>> {
      await bucket.acquire();
      ctx.logger.info(`${adapter.name}: fetching`, {
        stateFips: STATE_FIPS,
        url: sourceUrl,
      });

      const fetchImpl =
        options.fetchOverride ??
        (async () => {
          const res = await politeFetch(sourceUrl, {
            headers: { Accept: 'text/html,*/*' },
          });
          return {
            status: res.status,
            body: await res.text(),
            resolvedUrl: res.url,
          };
        });

      const { status, body, resolvedUrl } = await fetchImpl();
      if (status >= 400) {
        throw new Error(
          `IL candidacies fetch failed: HTTP ${status} from ${sourceUrl}`,
        );
      }
      const contentHash = createHash('sha256').update(body).digest('hex');

      const isAspNetShell =
        body.includes('__VIEWSTATE') && body.includes('aspNetHidden');

      const rows: IlCandidacyRow[] = options.parseOverride
        ? options.parseOverride(body)
        : [];

      if (rows.length === 0 && isAspNetShell) {
        ctx.logger.warn(
          `${adapter.name}: ASP.NET WebForms shell — postback driver not yet wired; returning []`,
          { bytes: body.length, sourceUrl },
        );
      }

      return {
        rows,
        expectedMinRows: 1,
        source: {
          sourceType: 'sos_candidate_filing',
          name: 'illinois-sbe-candidacies',
          url: resolvedUrl ?? sourceUrl,
          contentHash,
          license,
          stateFips: STATE_FIPS,
          meta: {
            election_year: electionYear,
            primary_date: PRIMARY_DATE,
            general_date: GENERAL_DATE,
            byte_size: body.length,
            asp_net_shell: isAspNetShell,
            alternate_list_url: ALT_LIST_URL,
            note:
              'Illinois SBE candidate list lives behind an ASP.NET ' +
              '__VIEWSTATE postback. politeFetch alone cannot drive the form; ' +
              'a shared aspnet-postback helper is on the roadmap.',
          },
        },
      };
    },

    validateRow(row) {
      if (!row.reported_name || !row.reported_name.trim()) return 'missing reported_name';
      if (!row.office_name || !row.office_name.trim()) return 'missing office_name';
      return null;
    },

    async insert(
      rows: IlCandidacyRow[],
      refs: InsertRefs,
      ctx: AdapterContext,
    ): Promise<InsertStats> {
      return insertCandidacies(rows, refs, ctx, {
        stateFips: STATE_FIPS,
        source: 'sos-illinois-sbe-candidacies',
        electionYear,
      });
    },
  };

  return adapter;
}
