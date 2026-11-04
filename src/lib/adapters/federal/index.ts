/**
 * Federal-source adapter exports.
 *
 * Three pilot adapters wired through the SourceAdapter framework:
 *   - federalBillsAdapter  — Congress.gov v3 bills
 *   - federalVotesAdapter  — Congress.gov v3 House roll-call votes
 *   - createFecAlertsAdapter — FEC OpenFEC filings + contributions (per-call)
 */

export {
  createFederalBillsAdapter,
  federalBillsAdapter,
  type FederalBillRow,
  type FederalBillsAdapterOptions,
} from './federal-bills-adapter';

export {
  createFederalVotesAdapter,
  federalVotesAdapter,
  type FederalVoteRow,
  type FederalVotesAdapterOptions,
} from './federal-votes-adapter';

export {
  createFecAlertsAdapter,
  type FecAlertRow,
  type FecAlertsAdapterOptions,
  type FecFollowedMember,
} from './fec-alerts-adapter';
