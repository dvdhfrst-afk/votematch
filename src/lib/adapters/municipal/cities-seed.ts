/**
 * Top-20 US cities seeded for the municipal-meetings ingestion adapter.
 *
 * Platform assignments
 * --------------------
 * Only platforms we can verify from existing public documentation are marked
 * 'legistar' or 'granicus'. Everything else is 'todo' — a concrete marker for
 * a follow-up that must confirm the portal by visiting the live site. We are
 * deliberately conservative: a wrong platform tag produces silent parse
 * failures at runtime. A 'todo' tag just forces the CLI to skip the city,
 * which is the safe default.
 *
 * Notes on the 2026-04-23 baseline (the operator's instructions):
 *   - Legistar is owned by Granicus; cities that use Legistar get the
 *     shared API at webapi.legistar.com/v1/<client>/Events even when the
 *     public UI is on <client>.legistar.com.
 *   - Generic "Granicus" here means the legacy Granicus calendar widget
 *     (MediaManager / ViewPublisher), not Legistar.
 *   - NYC and LA have bespoke portals — 'custom' flags them as "platform
 *     known, parser not shared".
 *
 * Schema shape is intentionally flat so the CLI can treat the seed as a
 * static dispatch table with no DB round-trip.
 */

export type MunicipalPlatform = 'legistar' | 'granicus' | 'custom' | 'todo';

export type MunicipalCitySeed = {
  /** Short lowercase identifier used by the CLI's --city flag. */
  cityKey: string;
  cityName: string;
  /** Two-character state FIPS. DC = '11'. */
  stateFips: string;
  /** Two-letter USPS state code; mirrors municipal_meetings.state. */
  stateCode: string;
  /** Census place FIPS (7 chars: SS + 5-digit place). Omitted when not yet verified. */
  fipsPlace?: string;
  platform: MunicipalPlatform;
  /**
   * Legistar: the short "client" slug used by webapi.legistar.com/v1/<client>.
   * Granicus: the base URL of the calendar page.
   * Custom:   the base URL of the portal.
   * Todo:     undefined.
   */
  endpoint?: string;
  notes?: string;
};

export const MUNICIPAL_CITIES: MunicipalCitySeed[] = [
  {
    cityKey: 'nyc',
    cityName: 'New York',
    stateFips: '36',
    stateCode: 'NY',
    fipsPlace: '3651000',
    platform: 'custom',
    endpoint: 'https://legistar.council.nyc.gov',
    notes:
      'Legistar-hosted but under the council.nyc.gov subdomain; API paths match the Legistar client "nyc".',
  },
  {
    cityKey: 'la',
    cityName: 'Los Angeles',
    stateFips: '06',
    stateCode: 'CA',
    fipsPlace: '0644000',
    platform: 'custom',
    endpoint: 'https://cityclerk.lacity.org',
    notes:
      'Bespoke Council File Management System (cityclerk.lacity.org); not Legistar, not Granicus.',
    // TODO: Legistar client discovery failed — manual research needed (la)
  },
  {
    cityKey: 'chicago',
    cityName: 'Chicago',
    stateFips: '17',
    stateCode: 'IL',
    fipsPlace: '1714000',
    platform: 'legistar',
    endpoint: 'chicago',
    notes: 'chicago.legistar.com — shared Legistar API.',
  },
  {
    cityKey: 'houston',
    cityName: 'Houston',
    stateFips: '48',
    stateCode: 'TX',
    fipsPlace: '4835000',
    platform: 'todo',
    notes:
      'Houston does NOT use Legistar — discovery run 2026-04-24 verified the "houston" slug is not a registered Legistar client (webapi 500 "LegistarConnectionString setting is not set up") and houston.legistar.com returns a 19-byte stub. Platform needs live verification (city agendas are on houstontx.gov with Granicus video embeds).',
    // TODO: Legistar client discovery failed — manual research needed (houston)
  },
  {
    cityKey: 'phoenix',
    cityName: 'Phoenix',
    stateFips: '04',
    stateCode: 'AZ',
    fipsPlace: '0455000',
    platform: 'todo',
    notes:
      'City of Phoenix uses custom iCompass / Granicus hybrid; platform needs live verification.',
  },
  {
    cityKey: 'philadelphia',
    cityName: 'Philadelphia',
    stateFips: '42',
    stateCode: 'PA',
    fipsPlace: '4260000',
    platform: 'legistar',
    endpoint: 'phila',
    notes: 'phila.legistar.com.',
  },
  {
    cityKey: 'san-antonio',
    cityName: 'San Antonio',
    stateFips: '48',
    stateCode: 'TX',
    fipsPlace: '4865000',
    platform: 'todo',
    notes: 'San Antonio uses sanantonio.primegov.com; PrimeGov is a third platform, not implemented yet.',
  },
  {
    cityKey: 'san-diego',
    cityName: 'San Diego',
    stateFips: '06',
    stateCode: 'CA',
    fipsPlace: '0666000',
    platform: 'todo',
    notes:
      'San Diego does NOT use Legistar — discovery run 2026-04-24 verified the "sandiego" slug is unregistered (webapi 500 "not set up"); sandiego.legistar.com serves a 19-byte stub. City agendas live on sandiego.gov via Granicus; needs dedicated adapter.',
    // TODO: Legistar client discovery failed — manual research needed (san-diego)
  },
  {
    cityKey: 'dallas',
    cityName: 'Dallas',
    stateFips: '48',
    stateCode: 'TX',
    fipsPlace: '4819000',
    platform: 'todo',
    notes: 'Dallas uses dallascityhall.com custom CMS; needs bespoke parser.',
  },
  {
    cityKey: 'jacksonville',
    cityName: 'Jacksonville',
    stateFips: '12',
    stateCode: 'FL',
    fipsPlace: '1235000',
    platform: 'legistar',
    endpoint: 'jaxcityc',
    notes: 'jaxcityc.legistar.com — Jacksonville City Council.',
  },
  {
    cityKey: 'austin',
    cityName: 'Austin',
    stateFips: '48',
    stateCode: 'TX',
    fipsPlace: '4805000',
    platform: 'granicus',
    endpoint: 'https://www.austintexas.gov/department/city-council/council/meeting_calendar',
    notes: 'Austin publishes on austintexas.gov with Granicus MediaManager video and a standard calendar widget.',
  },
  {
    cityKey: 'fort-worth',
    cityName: 'Fort Worth',
    stateFips: '48',
    stateCode: 'TX',
    fipsPlace: '4827000',
    platform: 'todo',
    notes: 'Fort Worth uses fortworthtexas.gov custom CMS; platform not yet verified.',
  },
  {
    cityKey: 'san-jose',
    cityName: 'San Jose',
    stateFips: '06',
    stateCode: 'CA',
    fipsPlace: '0668000',
    platform: 'granicus',
    endpoint: 'https://sanjoseca.gov/your-government/appointees/city-council/council-meetings',
    notes: 'sanjose.granicus.com used for video; HTML calendar lives on sanjoseca.gov.',
  },
  {
    cityKey: 'columbus',
    cityName: 'Columbus',
    stateFips: '39',
    stateCode: 'OH',
    fipsPlace: '3918000',
    platform: 'legistar',
    endpoint: 'columbus',
    notes: 'columbus.legistar.com.',
  },
  {
    cityKey: 'charlotte',
    cityName: 'Charlotte',
    stateFips: '37',
    stateCode: 'NC',
    fipsPlace: '3712000',
    platform: 'granicus',
    endpoint: 'https://charlottenc.gov/CityCouncil/Pages/Agendas.aspx',
    notes: 'Charlotte publishes agendas on charlottenc.gov with Granicus video integration.',
  },
  {
    cityKey: 'indianapolis',
    cityName: 'Indianapolis',
    stateFips: '18',
    stateCode: 'IN',
    fipsPlace: '1836003',
    platform: 'todo',
    notes:
      'Indianapolis does NOT use Legistar — discovery run 2026-04-24 verified the "indy" slug is unregistered (webapi 500 "not set up"); indy.legistar.com is a 19-byte stub. The City-County Council publishes agendas on citybase-cms.civiccms.com; needs bespoke adapter.',
    // TODO: Legistar client discovery failed — manual research needed (indianapolis)
  },
  {
    cityKey: 'sf',
    cityName: 'San Francisco',
    stateFips: '06',
    stateCode: 'CA',
    fipsPlace: '0667000',
    platform: 'legistar',
    endpoint: 'sfgov',
    notes: 'sfgov.legistar.com — Board of Supervisors.',
  },
  {
    cityKey: 'seattle',
    cityName: 'Seattle',
    stateFips: '53',
    stateCode: 'WA',
    fipsPlace: '5363000',
    platform: 'legistar',
    endpoint: 'seattle',
    notes: 'seattle.legistar.com.',
  },
  {
    cityKey: 'denver',
    cityName: 'Denver',
    stateFips: '08',
    stateCode: 'CO',
    fipsPlace: '0820000',
    platform: 'legistar',
    endpoint: 'denver',
    notes: 'denver.legistar.com.',
  },
  {
    cityKey: 'dc',
    cityName: 'Washington',
    stateFips: '11',
    stateCode: 'DC',
    fipsPlace: '1150000',
    platform: 'granicus',
    endpoint: 'https://dccouncil.gov/council-calendar/',
    notes: 'DC Council uses Granicus video + a standard HTML calendar on dccouncil.gov.',
  },
];

export function findCity(cityKey: string): MunicipalCitySeed | undefined {
  return MUNICIPAL_CITIES.find((c) => c.cityKey === cityKey);
}
