/**
 * Compat shim — re-exports state-cf/shared/base.ts with F1c naming.
 *
 * Three agents worked on state-cf adapters in parallel; F1a/F1b used
 * `shared/base.ts` while F1c imported from `../base`. This shim bridges
 * the two conventions so both import paths resolve to the same symbols.
 */

export {
  createStateCfAdapter,
  fetchCfHtml,
  emptyCfParser,
} from './shared/base';

export type {
  CfEventType,
  StateCfEventRow,
  CfFetchResult,
  StateCfAdapterOptions,
} from './shared/base';

// Aliases used by F1c Mountain/Pacific agents
export type { StateCfEventRow as StateCfRow } from './shared/base';
export type { CfFetchResult as StateCfFetchResult } from './shared/base';

// Helper re-exports used by F1c Mountain/Pacific agents
// (naming difference — F1c calls them parseIsoDateOrNull/parseMoneyOrNull/normalizeEventType
//  while html-parsers.ts exposes them as parseDate/parseAmount/inferEventType)
import {
  parseDate as _parseDate,
  parseAmount as _parseAmount,
  inferEventType as _inferEventType,
} from './shared/html-parsers';
import type { CfEventType } from './shared/base';

export const parseIsoDateOrNull = _parseDate;
export const parseMoneyOrNull = _parseAmount;

export function normalizeEventType(
  value: string | null | undefined,
  fallback: CfEventType = 'filing',
): CfEventType {
  if (!value) return fallback;
  const normalized = value.toLowerCase().trim();
  // Plural → singular normalization (F1c uses 'contributions'/'expenditures')
  if (normalized === 'contributions' || normalized === 'contribution') return 'contribution';
  if (normalized === 'expenditures' || normalized === 'expenditure') return 'expenditure';
  if (normalized === 'loans' || normalized === 'loan') return 'loan';
  if (normalized === 'in_kind' || normalized === 'in-kind') return 'in_kind';
  if (normalized === 'independent_expenditure' || normalized === 'ie') return 'independent_expenditure';
  return _inferEventType(value) ?? fallback;
}
