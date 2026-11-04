/**
 * State SoS candidacies — single source of truth for registered adapters.
 *
 * Both consumers import this map:
 *   - `scripts/ingest-state-candidacies.ts` — CLI dispatcher (one-state run)
 *   - `src/lib/inngest/functions/ingest-state-sos-wave.ts` — hourly Inngest
 *     wave (re-exported from `state-registry.ts` as
 *     `STATE_SOS_CANDIDACY_ADAPTERS` for backward compat with existing call
 *     sites)
 *
 * Why this module exists
 * ----------------------
 * Until 2026-04-26 the hourly wave registry (state-registry.ts) carried only
 * { IN: ... } while the CLI dispatcher carried 56 entries. The wave silently
 * fanned out to one state per hour and the other 55 jurisdictions never
 * ingested. Centralising the map here removes the drift risk: there is only
 * one place to add a new state, and both code paths see it immediately.
 *
 * Inclusion policy
 * ----------------
 * EVERY state/territory adapter that compiles is registered here, even if its
 * source URL is currently blocked (Cloudflare wall, Imperva, ASP.NET POSTback,
 * pre-deadline empty roster, PDF-only). Those adapters return an empty result
 * with `parserSignal='no_table' | 'table_empty'`; `runAdapter()` records the
 * outcome as `partial` (benign) and the daily refresh re-checks. This is the
 * "empty-but-correct" Day-0 contract — the alternative (registry omission)
 * would re-introduce the same artificial-scope bug this file was created to
 * fix.
 *
 * Row-shape note
 * --------------
 * Each per-state adapter has a state-specific Row type (OH carries
 * is_write_in + office_name, IN carries office_type_slug + date_filed, NY
 * carries fusion party_lines[], etc.). The dispatcher doesn't need to know
 * the row shape — `validateRow` + the per-adapter `insert()` handle it. We
 * therefore type factories as producers of `SourceAdapter<unknown>`.
 */

import type { SourceAdapter } from '../types';

import { createOhCandidaciesAdapter } from './oh/candidacies';
import { createInCandidaciesAdapter } from './in/candidacies';
import { createAlCandidaciesAdapter } from './al/candidacies';
import { createAkCandidaciesAdapter } from './ak/candidacies';
import { createAzCandidaciesAdapter } from './az/candidacies';
import { createArCandidaciesAdapter } from './ar/candidacies';
import { createCaCandidaciesAdapter } from './ca/candidacies';
import { createCoCandidaciesAdapter } from './co/candidacies';
import { createCtCandidaciesAdapter } from './ct/candidacies';
import { createMiCandidaciesAdapter } from './mi/candidacies';
import { createMnCandidaciesAdapter } from './mn/candidacies';
import { createMsCandidaciesAdapter } from './ms/candidacies';
import { createMoCandidaciesAdapter } from './mo/candidacies';
import { createMtCandidaciesAdapter } from './mt/candidacies';
import { createNeCandidaciesAdapter } from './ne/candidacies';
import { createNvCandidaciesAdapter } from './nv/candidacies';
import { createNhCandidaciesAdapter } from './nh/candidacies';
import { createNjCandidaciesAdapter } from './nj/candidacies';
import { createNmCandidaciesAdapter } from './nm/candidacies';
import { createNyCandidaciesAdapter } from './ny/candidacies';
import { createNcCandidaciesAdapter } from './nc/candidacies';
import { createNdCandidaciesAdapter } from './nd/candidacies';
import { createOkCandidaciesAdapter } from './ok/candidacies';
import { createAsCandidaciesAdapter } from './as/candidacies';
import { createGuCandidaciesAdapter } from './gu/candidacies';
import { createMpCandidaciesAdapter } from './mp/candidacies';
import { createPrCandidaciesAdapter } from './pr/candidacies';
import { createViCandidaciesAdapter } from './vi/candidacies';
import { createDcCandidaciesAdapter } from './dc/candidacies';
import { createDeCandidaciesAdapter } from './de/candidacies';
import { createFlCandidaciesAdapter } from './fl/candidacies';
import { createGaCandidaciesAdapter } from './ga/candidacies';
import { createHiCandidaciesAdapter } from './hi/candidacies';
import { createIdCandidaciesAdapter } from './id/candidacies';
import { createIlCandidaciesAdapter } from './il/candidacies';
import { createUtCandidaciesAdapter } from './ut/candidacies';
import { createVtCandidaciesAdapter } from './vt/candidacies';
import { createVaCandidaciesAdapter } from './va/candidacies';
import { createWaCandidaciesAdapter } from './wa/candidacies';
import { createWvCandidaciesAdapter } from './wv/candidacies';
import { createWiCandidaciesAdapter } from './wi/candidacies';
import { createWyCandidaciesAdapter } from './wy/candidacies';
import { createTxCandidaciesAdapter } from './tx/candidacies';
import { createTnCandidaciesAdapter } from './tn/candidacies';
import { createPaCandidaciesAdapter } from './pa/candidacies';
import { createSdCandidaciesAdapter } from './sd/candidacies';
import { createOrCandidaciesAdapter } from './or/candidacies';
import { createScCandidaciesAdapter } from './sc/candidacies';
import { createRiCandidaciesAdapter } from './ri/candidacies';
import { createIaCandidaciesAdapter } from './ia/candidacies';
import { createKsCandidaciesAdapter } from './ks/candidacies';
import { createKyCandidaciesAdapter } from './ky/candidacies';
import { createLaCandidaciesAdapter } from './la/candidacies';
import { createMeCandidaciesAdapter } from './me/candidacies';
import { createMdCandidaciesAdapter } from './md/candidacies';
import { createMaCandidaciesAdapter } from './ma/candidacies';

/**
 * Factory signature for every candidacy adapter. `electionYear` is optional;
 * adapters that don't honor it ignore the field. Wave calls pass `{}` and
 * accept the adapter's default (current UTC year).
 */
export type CandidacyAdapterFactory = (options: {
  electionYear?: number;
}) => SourceAdapter<unknown>;

/**
 * The 56-entry registry: 50 states + DC + 5 U.S. territories
 * (AS, GU, MP, PR, VI). Adapters that ship live structured-data parsers and
 * those that ship as empty-but-correct Day-0 stubs are BOTH registered —
 * see header for rationale.
 */
export const CANDIDACY_ADAPTERS: Record<string, CandidacyAdapterFactory> = {
  // Wave 0 — the two states the registry originally carried.
  OH: (opts) =>
    createOhCandidaciesAdapter({ electionYear: opts.electionYear }) as SourceAdapter<unknown>,
  IN: () =>
    createInCandidaciesAdapter() as SourceAdapter<unknown>,

  // Wave 1 (registered 2026-04-25): AL, AK, AZ, AR, CA, CO, CT.
  AL: (opts) =>
    createAlCandidaciesAdapter({ electionYear: opts.electionYear }) as SourceAdapter<unknown>,
  AK: (opts) =>
    createAkCandidaciesAdapter({ electionYear: opts.electionYear }) as SourceAdapter<unknown>,
  AZ: (opts) =>
    createAzCandidaciesAdapter({ electionYear: opts.electionYear }) as SourceAdapter<unknown>,
  AR: (opts) =>
    createArCandidaciesAdapter({ electionYear: opts.electionYear }) as SourceAdapter<unknown>,
  CA: (opts) =>
    createCaCandidaciesAdapter({ electionYear: opts.electionYear }) as SourceAdapter<unknown>,
  CO: (opts) =>
    createCoCandidaciesAdapter({ electionYear: opts.electionYear }) as SourceAdapter<unknown>,
  CT: (opts) =>
    createCtCandidaciesAdapter({ electionYear: opts.electionYear }) as SourceAdapter<unknown>,

  // Wave 2 (registered 2026-04-25): MI, MN, MS, MO, MT, NE, NV.
  MI: (opts) =>
    createMiCandidaciesAdapter({ electionYear: opts.electionYear }) as SourceAdapter<unknown>,
  MN: (opts) =>
    createMnCandidaciesAdapter({ electionYear: opts.electionYear }) as SourceAdapter<unknown>,
  MS: (opts) =>
    createMsCandidaciesAdapter({ electionYear: opts.electionYear }) as SourceAdapter<unknown>,
  MO: (opts) =>
    createMoCandidaciesAdapter({ electionYear: opts.electionYear }) as SourceAdapter<unknown>,
  MT: (opts) =>
    createMtCandidaciesAdapter({ electionYear: opts.electionYear }) as SourceAdapter<unknown>,
  NE: (opts) =>
    createNeCandidaciesAdapter({ electionYear: opts.electionYear }) as SourceAdapter<unknown>,
  NV: (opts) =>
    createNvCandidaciesAdapter({ electionYear: opts.electionYear }) as SourceAdapter<unknown>,

  // Wave 3 (registered 2026-04-25): NH, NJ, NM, NY, NC, ND, OK.
  NH: (opts) =>
    createNhCandidaciesAdapter({ electionYear: opts.electionYear }) as SourceAdapter<unknown>,
  NJ: (opts) =>
    createNjCandidaciesAdapter({ electionYear: opts.electionYear }) as SourceAdapter<unknown>,
  NM: (opts) =>
    createNmCandidaciesAdapter({ electionYear: opts.electionYear }) as SourceAdapter<unknown>,
  NY: (opts) =>
    createNyCandidaciesAdapter({ electionYear: opts.electionYear }) as SourceAdapter<unknown>,
  NC: (opts) =>
    createNcCandidaciesAdapter({ electionYear: opts.electionYear }) as SourceAdapter<unknown>,
  ND: (opts) =>
    createNdCandidaciesAdapter({ electionYear: opts.electionYear }) as SourceAdapter<unknown>,
  OK: (opts) =>
    createOkCandidaciesAdapter({ electionYear: opts.electionYear }) as SourceAdapter<unknown>,

  // U.S. territories (registered 2026-04-25). PR has no statewide 2026 cycle
  // (next: 2028) — adapter still registered so the doctor probes weekly.
  AS: (opts) =>
    createAsCandidaciesAdapter({ electionYear: opts.electionYear }) as SourceAdapter<unknown>,
  GU: (opts) =>
    createGuCandidaciesAdapter({ electionYear: opts.electionYear }) as SourceAdapter<unknown>,
  MP: (opts) =>
    createMpCandidaciesAdapter({ electionYear: opts.electionYear }) as SourceAdapter<unknown>,
  PR: (opts) =>
    createPrCandidaciesAdapter({ electionYear: opts.electionYear }) as SourceAdapter<unknown>,
  VI: (opts) =>
    createViCandidaciesAdapter({ electionYear: opts.electionYear }) as SourceAdapter<unknown>,

  // Wave 4 (registered 2026-04-25): DC, DE, FL, GA, HI, ID, IL.
  DC: (opts) =>
    createDcCandidaciesAdapter({ electionYear: opts.electionYear }) as SourceAdapter<unknown>,
  DE: (opts) =>
    createDeCandidaciesAdapter({ electionYear: opts.electionYear }) as SourceAdapter<unknown>,
  FL: (opts) =>
    createFlCandidaciesAdapter({ electionYear: opts.electionYear }) as SourceAdapter<unknown>,
  GA: (opts) =>
    createGaCandidaciesAdapter({ electionYear: opts.electionYear }) as SourceAdapter<unknown>,
  HI: (opts) =>
    createHiCandidaciesAdapter({ electionYear: opts.electionYear }) as SourceAdapter<unknown>,
  ID: (opts) =>
    createIdCandidaciesAdapter({ electionYear: opts.electionYear }) as SourceAdapter<unknown>,
  IL: (opts) =>
    createIlCandidaciesAdapter({ electionYear: opts.electionYear }) as SourceAdapter<unknown>,

  // Wave 5 (registered 2026-04-25): UT, VT, VA, WA, WV, WI, WY.
  UT: (opts) =>
    createUtCandidaciesAdapter({ electionYear: opts.electionYear }) as SourceAdapter<unknown>,
  VT: (opts) =>
    createVtCandidaciesAdapter({ electionYear: opts.electionYear }) as SourceAdapter<unknown>,
  VA: (opts) =>
    createVaCandidaciesAdapter({ electionYear: opts.electionYear }) as SourceAdapter<unknown>,
  WA: (opts) =>
    createWaCandidaciesAdapter({ electionYear: opts.electionYear }) as SourceAdapter<unknown>,
  WV: (opts) =>
    createWvCandidaciesAdapter({ electionYear: opts.electionYear }) as SourceAdapter<unknown>,
  WI: (opts) =>
    createWiCandidaciesAdapter({ electionYear: opts.electionYear }) as SourceAdapter<unknown>,
  WY: (opts) =>
    createWyCandidaciesAdapter({ electionYear: opts.electionYear }) as SourceAdapter<unknown>,

  // Wave 6 (registered 2026-04-25): OR, PA, RI, SC, SD, TN, TX.
  // These adapters' Options types don't expose electionYear (date is hard-
  // coded per-state from web-verified statute); the wrapper accepts but
  // ignores the field for API uniformity with the rest of the registry.
  TX: () =>
    createTxCandidaciesAdapter({}) as SourceAdapter<unknown>,
  TN: () =>
    createTnCandidaciesAdapter({}) as SourceAdapter<unknown>,
  PA: () =>
    createPaCandidaciesAdapter({}) as SourceAdapter<unknown>,
  SD: () =>
    createSdCandidaciesAdapter({}) as SourceAdapter<unknown>,
  OR: () =>
    createOrCandidaciesAdapter({}) as SourceAdapter<unknown>,
  SC: () =>
    createScCandidaciesAdapter({}) as SourceAdapter<unknown>,
  RI: () =>
    createRiCandidaciesAdapter({}) as SourceAdapter<unknown>,

  // Wave 7 (registered 2026-04-25): IA, KS, KY, LA, ME, MD, MA.
  IA: (opts) =>
    createIaCandidaciesAdapter({ electionYear: opts.electionYear }) as SourceAdapter<unknown>,
  KS: (opts) =>
    createKsCandidaciesAdapter({ electionYear: opts.electionYear }) as SourceAdapter<unknown>,
  KY: (opts) =>
    createKyCandidaciesAdapter({ electionYear: opts.electionYear }) as SourceAdapter<unknown>,
  LA: (opts) =>
    createLaCandidaciesAdapter({ electionYear: opts.electionYear }) as SourceAdapter<unknown>,
  ME: (opts) =>
    createMeCandidaciesAdapter({ electionYear: opts.electionYear }) as SourceAdapter<unknown>,
  MD: (opts) =>
    createMdCandidaciesAdapter({ electionYear: opts.electionYear }) as SourceAdapter<unknown>,
  MA: (opts) =>
    createMaCandidaciesAdapter({ electionYear: opts.electionYear }) as SourceAdapter<unknown>,
};
