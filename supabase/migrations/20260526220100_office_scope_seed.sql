-- Seed chamber_type_defaults + authority_statement (council-approved v1).
--
-- chamber_type_defaults: one row per chamber_type currently in the catalog.
-- Defaults represent the 95% case for that chamber type's authority profile.
-- Per-body deviations from these defaults require a primary-source citation
-- (enforced in write.ts).
--
-- requires_voter_scope_copy: false for chambers voters generally recognize
-- (legislatures, councils, school boards, federal). true for obscure
-- special-purpose bodies where the office name alone leaves voters unclear.

INSERT INTO chamber_type_defaults
  (chamber_type, jurisdiction_level, default_domains_v1, default_authority_mode, requires_voter_scope_copy)
VALUES
  -- Federal
  ('legislative_upper', 'federal',
   ARRAY['land_use_housing','transportation_infrastructure','public_safety','justice','utilities','education','health_environment','parks_culture','fiscal','economic_regulation','elections_governance','social_services']::policy_authority_domain_t[],
   'legislative', false),
  ('legislative_lower', 'federal',
   ARRAY['land_use_housing','transportation_infrastructure','public_safety','justice','utilities','education','health_environment','parks_culture','fiscal','economic_regulation','elections_governance','social_services']::policy_authority_domain_t[],
   'legislative', false),
  -- (state legislative chambers also use legislative_upper / lower / unicameral;
  -- we keep one row per (chamber_type, level) by adding a level-qualifier row
  -- below. PG enums don't support compound primary keys, so we'll partition
  -- via the matching logic in write.ts: state bodies get the state row.)
  ('legislative_unicameral', 'state',
   ARRAY['land_use_housing','transportation_infrastructure','public_safety','justice','utilities','education','health_environment','parks_culture','fiscal','economic_regulation','elections_governance','social_services']::policy_authority_domain_t[],
   'legislative', false),

  -- State judicial
  ('state_supreme_court', 'state',
   ARRAY['justice']::policy_authority_domain_t[],
   'quasi_judicial', false),
  ('appellate_court', 'state',
   ARRAY['justice']::policy_authority_domain_t[],
   'quasi_judicial', false),

  -- State boards (executive/quasi-judicial scope)
  ('state_board_of_education', 'state',
   ARRAY['education']::policy_authority_domain_t[],
   'executive', false),
  ('state_board_of_regents', 'state',
   ARRAY['education']::policy_authority_domain_t[],
   'executive', true),
  ('public_service_commission', 'state',
   ARRAY['utilities','economic_regulation']::policy_authority_domain_t[],
   'quasi_judicial', true),

  -- County legislative
  ('county_commission', 'county',
   ARRAY['land_use_housing','transportation_infrastructure','public_safety','justice','utilities','health_environment','parks_culture','fiscal','economic_regulation','elections_governance','social_services']::policy_authority_domain_t[],
   'legislative', false),
  ('county_council', 'county',
   ARRAY['land_use_housing','transportation_infrastructure','public_safety','justice','utilities','health_environment','parks_culture','fiscal','economic_regulation','elections_governance','social_services']::policy_authority_domain_t[],
   'legislative', false),

  -- Municipal legislative
  ('city_council', 'municipal',
   ARRAY['land_use_housing','transportation_infrastructure','public_safety','utilities','parks_culture','fiscal','economic_regulation','elections_governance']::policy_authority_domain_t[],
   'legislative', false),
  ('city_commission', 'municipal',
   ARRAY['land_use_housing','transportation_infrastructure','public_safety','utilities','parks_culture','fiscal','economic_regulation','elections_governance']::policy_authority_domain_t[],
   'legislative', false),
  ('town_council', 'municipal',
   ARRAY['land_use_housing','transportation_infrastructure','public_safety','utilities','parks_culture','fiscal','economic_regulation']::policy_authority_domain_t[],
   'legislative', false),
  ('township_board', 'sub_municipal',
   ARRAY['land_use_housing','transportation_infrastructure','public_safety','parks_culture','fiscal']::policy_authority_domain_t[],
   'legislative', true),
  ('selectboard', 'municipal',
   ARRAY['land_use_housing','transportation_infrastructure','public_safety','utilities','parks_culture','fiscal','economic_regulation']::policy_authority_domain_t[],
   'legislative', true),

  -- Schools
  ('school_board', 'special_district',
   ARRAY['education','fiscal']::policy_authority_domain_t[],
   'legislative', false),

  -- Special purpose / obscure
  ('special_district_board', 'special_district',
   ARRAY['utilities']::policy_authority_domain_t[],  -- usually water/fire/parks; agent overrides
   'legislative', true),
  ('municipal_court', 'judicial',
   ARRAY['justice']::policy_authority_domain_t[],
   'quasi_judicial', true),
  ('other', 'state',
   ARRAY[]::policy_authority_domain_t[],
   'advisory', true);

-- ─────────────────────────────────────────────────────────────────────────
-- authority_statement seed (the templated can_do / cannot_do bullets).
--
-- One row per (domain, mode, level). Reviewed by humans; agent never writes
-- to this table. Update one row → every body rendering that bullet updates.
--
-- can_do_text is what the body has authority to do in this domain.
-- cannot_do_text is the common "but you can't ..." caveat for that combo.
-- ─────────────────────────────────────────────────────────────────────────

INSERT INTO authority_statement
  (domain, authority_mode, jurisdiction_level, can_do_text, cannot_do_text)
VALUES
  -- Federal legislative
  ('land_use_housing', 'legislative', 'federal',
   'Pass federal laws on housing finance, fair housing, and federally-funded land programs', NULL),
  ('transportation_infrastructure', 'legislative', 'federal',
   'Authorize federal highway, rail, aviation, and waterway programs', NULL),
  ('public_safety', 'legislative', 'federal',
   'Set federal criminal law, fund federal law enforcement (FBI, ATF, DEA), and oversee federal disaster response', NULL),
  ('justice', 'legislative', 'federal',
   'Confirm federal judges, write federal statutes, fund the federal court system',
   'Cannot decide individual cases; that is the courts'' role'),
  ('utilities', 'legislative', 'federal',
   'Regulate interstate energy, pipelines, broadcasting, and broadband',
   'Cannot set local utility rates'),
  ('education', 'legislative', 'federal',
   'Fund federal student aid, set civil-rights standards for schools, authorize Title I and IDEA',
   'Cannot set curriculum — that''s reserved to states'),
  ('health_environment', 'legislative', 'federal',
   'Authorize Medicare, Medicaid, and federal environmental laws (EPA, CDC, FDA)', NULL),
  ('parks_culture', 'legislative', 'federal',
   'Designate national parks, fund Smithsonian/NEA/NEH, regulate the arts', NULL),
  ('fiscal', 'legislative', 'federal',
   'Set federal tax rates, appropriate the federal budget, authorize federal debt', NULL),
  ('economic_regulation', 'legislative', 'federal',
   'Regulate interstate commerce, antitrust, securities, banking, and labor', NULL),
  ('elections_governance', 'legislative', 'federal',
   'Set federal election standards (Voting Rights Act, NVRA, HAVA)',
   'Cannot administer state or local elections'),
  ('social_services', 'legislative', 'federal',
   'Authorize Social Security, SNAP, TANF, and federal disability programs', NULL),

  -- State legislative
  ('land_use_housing', 'legislative', 'state',
   'Set state zoning enabling law, housing finance authority, and statewide rent / eviction rules', NULL),
  ('transportation_infrastructure', 'legislative', 'state',
   'Authorize state highways, transit funding, and motor-vehicle laws', NULL),
  ('public_safety', 'legislative', 'state',
   'Set state criminal law, fund state police / corrections, authorize emergency powers', NULL),
  ('justice', 'legislative', 'state',
   'Write state statutes, fund the state court system, set sentencing law',
   'Cannot decide individual cases'),
  ('utilities', 'legislative', 'state',
   'Set utility law and authorize the Public Service / Utilities Commission', NULL),
  ('education', 'legislative', 'state',
   'Set K-12 standards, fund state schools and universities, set graduation requirements', NULL),
  ('health_environment', 'legislative', 'state',
   'Set state public-health law, environmental regulation, and air / water quality standards', NULL),
  ('parks_culture', 'legislative', 'state',
   'Designate state parks, fund state museums and libraries', NULL),
  ('fiscal', 'legislative', 'state',
   'Set state tax law (income, sales, property cap), appropriate the state budget', NULL),
  ('economic_regulation', 'legislative', 'state',
   'License professions, regulate insurance, alcohol, cannabis, and consumer protection', NULL),
  ('elections_governance', 'legislative', 'state',
   'Set state election law, redistrict, regulate campaign finance and lobbying', NULL),
  ('social_services', 'legislative', 'state',
   'Run state-administered Medicaid, child welfare, unemployment, and disability programs', NULL),

  -- County legislative
  ('land_use_housing', 'legislative', 'county',
   'Set zoning and land-use rules for unincorporated areas',
   'Cannot override municipal zoning inside incorporated cities'),
  ('transportation_infrastructure', 'legislative', 'county',
   'Maintain county roads, fund county transit, oversee county-owned airports', NULL),
  ('public_safety', 'legislative', 'county',
   'Fund the sheriff''s office, county EMS, jail, and emergency management', NULL),
  ('justice', 'legislative', 'county',
   'Fund the district / county court system and prosecutor''s office',
   'Cannot decide individual cases'),
  ('utilities', 'legislative', 'county',
   'Operate county water / sewer / waste services where the county provides them', NULL),
  ('health_environment', 'legislative', 'county',
   'Run county public health, environmental health inspections, animal control', NULL),
  ('parks_culture', 'legislative', 'county',
   'Operate county parks, county libraries, fairgrounds', NULL),
  ('fiscal', 'legislative', 'county',
   'Set the county property-tax rate (subject to state cap), appropriate the county budget', NULL),
  ('economic_regulation', 'legislative', 'county',
   'License business activities in unincorporated areas, regulate certain industries (alcohol, cannabis) per state law', NULL),
  ('elections_governance', 'legislative', 'county',
   'Administer elections via the county clerk; certify results', NULL),
  ('social_services', 'legislative', 'county',
   'Run county-administered welfare, homelessness, indigent burial, and veterans services', NULL),

  -- Municipal legislative
  ('land_use_housing', 'legislative', 'municipal',
   'Pass municipal zoning ordinances, set housing rules, designate historic districts',
   'Cannot override state preemption (e.g. statewide rent control bans where they exist)'),
  ('transportation_infrastructure', 'legislative', 'municipal',
   'Maintain city streets, set parking and traffic ordinances, fund city transit', NULL),
  ('public_safety', 'legislative', 'municipal',
   'Fund the city police, fire, and EMS; set municipal nuisance and curfew ordinances', NULL),
  ('utilities', 'legislative', 'municipal',
   'Set water / sewer / waste rates and operate city utilities where the city provides them',
   'Cannot regulate utilities provided by separate special districts'),
  ('parks_culture', 'legislative', 'municipal',
   'Operate city parks, libraries, recreation programs, and cultural facilities', NULL),
  ('fiscal', 'legislative', 'municipal',
   'Set the city property-tax rate (subject to state cap), authorize bonds (subject to voter approval above limit), appropriate the city budget', NULL),
  ('economic_regulation', 'legislative', 'municipal',
   'License businesses operating in the city, regulate signage, hours, and zoning-related commerce', NULL),
  ('elections_governance', 'legislative', 'municipal',
   'Set the rules for municipal elections, including primaries and runoffs where the city runs them', NULL),

  -- Schools (school_board: legislative scope is K-12 governance + budget)
  ('education', 'legislative', 'special_district',
   'Set district policy, hire / oversee the superintendent, approve curriculum and personnel decisions, set graduation and discipline policy',
   'Cannot override state academic standards or federal civil-rights requirements'),
  ('fiscal', 'legislative', 'special_district',
   'Approve the district budget, authorize school bonds (subject to voter approval), set local school-related property tax within statutory limits', NULL),

  -- Judicial (quasi_judicial scope at all levels)
  ('justice', 'quasi_judicial', 'state',
   'Decide cases under state law, issue binding interpretations of state statutes and constitution',
   'Cannot create new laws — only interpret existing ones'),
  ('justice', 'quasi_judicial', 'judicial',
   'Decide cases brought under municipal ordinances and within statutory jurisdiction',
   'Cannot issue rulings beyond the court''s statutory subject-matter jurisdiction'),

  -- PSC (utilities/economic_regulation in quasi_judicial mode)
  ('utilities', 'quasi_judicial', 'state',
   'Set rates and service standards for regulated utilities; approve mergers and infrastructure projects',
   'Cannot regulate municipally-owned utilities in most states'),
  ('economic_regulation', 'quasi_judicial', 'state',
   'Enforce consumer protections in regulated industries (electricity, gas, telecom, water)', NULL),

  -- Executive boards (state_board_of_education in executive mode)
  ('education', 'executive', 'state',
   'Set K-12 academic standards, approve curriculum frameworks, oversee state education department',
   'Cannot override federal civil-rights law or set local school district policy directly'),

  -- Generic special district board (utilities default)
  ('utilities', 'legislative', 'special_district',
   'Set rates and policy for the district''s service area (water, sewer, fire, mosquito, etc.)',
   'Cannot extend service or change rates outside the district''s statutory boundaries');
