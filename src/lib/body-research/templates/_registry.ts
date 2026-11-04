/**
 * Per-level template registry. Routes a body to the appropriate research
 * template based on its chamber_type + jurisdiction.
 *
 * As templates are added, append to TEMPLATES below. The first matching
 * template wins (so put specific overrides before generic).
 */
import type { AgentInput, TemplateSpec } from '../types';
import { federalLegislativeUpper } from './federal_legislative_upper';
import { federalLegislativeLower } from './federal_legislative_lower';
import { federalSupremeCourt } from './federal_supreme_court';
import { stateLegislativeUpper } from './state_legislative_upper';
import { stateLegislativeLower } from './state_legislative_lower';
import { stateLegislativeUnicameral } from './state_legislative_unicameral';
import { stateJudicialSupreme } from './state_judicial_supreme';
import { stateJudicialAppellate } from './state_judicial_appellate';
import { stateBoard } from './state_board';
import { countyLegislative } from './county_legislative';
import { municipalLegislative } from './municipal_legislative';
import { schoolBoard } from './school_board';
import { townshipBoard } from './township_board';
import { selectboard } from './selectboard';
import { specialDistrictBoard } from './special_district_board';

export const TEMPLATES: TemplateSpec[] = [
  federalLegislativeUpper,
  federalLegislativeLower,
  federalSupremeCourt,
  stateLegislativeUpper,
  stateLegislativeLower,
  stateLegislativeUnicameral,
  stateJudicialSupreme,
  stateJudicialAppellate,
  stateBoard,
  countyLegislative,
  municipalLegislative,
  schoolBoard,
  townshipBoard,
  selectboard,
  specialDistrictBoard,
  // Future:
  // stateLegislativeUpper,
  // stateLegislativeLower,
  // stateJudicialSupreme,
  // stateBoard,
  // countyLegislative,
  // municipalLegislative,
  // schoolBoard,
  // specialDistrictBoard,
  // townshipBoard,
  // selectboard,
];

export function findTemplate(input: AgentInput): TemplateSpec | null {
  for (const t of TEMPLATES) {
    if (t.matches(input)) return t;
  }
  return null;
}
