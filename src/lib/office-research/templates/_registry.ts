/**
 * Per-level template registry for standalone offices. First-matching
 * template wins.
 */
import type { OfficeInput, OfficeTemplateSpec } from '../types';
import { federalExecutiveStandalone } from './federal_executive_standalone';
import { stateExecutiveStandalone } from './state_executive_standalone';
import { countyStandalone } from './county_standalone';
import { municipalStandalone } from './municipal_standalone';

export const OFFICE_TEMPLATES: OfficeTemplateSpec[] = [
  federalExecutiveStandalone,
  stateExecutiveStandalone,
  countyStandalone,
  municipalStandalone,
  // Future: judicial_standalone (single-judge courts), school_standalone, etc.
];

export function findOfficeTemplate(input: OfficeInput): OfficeTemplateSpec | null {
  for (const t of OFFICE_TEMPLATES) {
    if (t.matches(input)) return t;
  }
  return null;
}
