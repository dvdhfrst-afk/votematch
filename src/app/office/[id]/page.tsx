/**
 * Office detail page — wiki-layer voter surface for an elected seat.
 *
 * Prefers research-extracted editorial content (offices.meta.research_extracted
 * and governing_bodies.* when the office belongs to a body) over the legacy
 * office_type fallback. Sections:
 *   - Header + provenance badge
 *   - What this office does (description + powers_summary)
 *   - Governing body context (when applicable — body description + size + structure)
 *   - Term + cadence (length, limits, on-cycle pattern, selection method, next election)
 *   - Compensation + workload (salary, full/part time)
 *   - Vacancy rules (who appoints / when special)
 *   - How to participate (voter qualifications, polling info)
 *   - Current incumbent
 *   - Upcoming elections + candidates
 *   - Past officeholders
 *   - Sources
 *
 * Route: /office/[id]
 */

import { createClient } from '@/lib/supabase/server';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import DataQualityBadge, { type DataQualityTier } from '@/components/DataQualityBadge';
import DeepLinkConvertCTA from '@/components/ui/DeepLinkConvertCTA';

type PageProps = {
  params: Promise<{ id: string }>;
};

interface ResearchExtracted {
  canonical_name?: string;
  short_name?: string;
  description?: string;
  powers_summary?: string;
  term_length_years?: number | null;
  term_start_month?: number | null;
  max_consecutive_terms?: number | null;
  selection_method?: string;
  primary_required?: boolean;
  on_cycle_pattern?: string;
  next_regular_election_date?: string | null;
  workload?: string;
  salary_annual_usd?: number | null;
  salary_year?: number | null;
  vacancy_appointment_authority?: string;
  vacancy_triggers_special?: string[];
  special_election_timing_rule?: string;
  voter_qualifications_summary?: string;
  presides_over_body_canonical_name?: string;
  current_officeholder_extracted?: {
    person_name?: string;
    party?: string;
    term_start?: string;
    term_end?: string;
    bioguide_id?: string;
  };
  citations?: Array<{ url: string; title?: string; kind?: string; accessed_at?: string; relevant_snippet?: string }>;
  last_verified_at?: string;
  verified_by?: string;
  authoritative?: boolean;
}

interface GoverningBody {
  id: string;
  canonical_name: string;
  short_name: string | null;
  chamber_type: string;
  size_total: number | null;
  size_authoritative: boolean;
  seat_structure: Array<{ count: number; designation_kind?: string; term_length_years?: number | null; stagger_offset_years?: number | null }>;
  selection_method: string | null;
  primary_required: boolean | null;
  on_cycle_pattern: string | null;
  description: string | null;
  powers_summary: string | null;
  meeting_schedule: string | null;
  vacancy_appointment_authority: string | null;
  vacancy_triggers_special: string[] | null;
  special_election_timing_rule: string | null;
  voter_qualifications_summary: string | null;
  citations: Array<{ url: string; title?: string; kind?: string; accessed_at?: string; relevant_snippet?: string }>;
  last_verified_at: string | null;
  verified_by: string | null;
  meta: Record<string, unknown> | null;
}

async function loadData(officeId: string) {
  const supabase = await createClient();

  const { data: office, error: officeErr } = await supabase
    .from('offices')
    .select(`
      id, canonical_name, level, seat_designation, selection_method, is_partisan,
      term_length_months, meta, responsibilities_md, office_type_id, jurisdiction_id,
      governing_body_id, presides_over_body_id
    `)
    .eq('id', officeId)
    .maybeSingle();
  if (officeErr) console.error('office load:', officeErr);
  if (!office) return null;

  const research: ResearchExtracted | null =
    (office.meta && typeof office.meta === 'object' && (office.meta as Record<string, unknown>).research_extracted &&
     typeof (office.meta as Record<string, unknown>).research_extracted === 'object')
      ? ((office.meta as Record<string, unknown>).research_extracted as ResearchExtracted)
      : null;

  // Load office_type + jurisdiction separately
  const { data: officeType } = await supabase
    .from('office_types')
    .select('generic_name, description, typical_powers, branch')
    .eq('id', office.office_type_id)
    .maybeSingle();
  const { data: jurisdiction } = await supabase
    .from('jurisdictions')
    .select('name, type, short_name, fips_state')
    .eq('id', office.jurisdiction_id)
    .maybeSingle();

  // Load governing body (if any)
  let governingBody: GoverningBody | null = null;
  if (office.governing_body_id) {
    const { data: body } = await supabase
      .from('governing_bodies')
      .select('*')
      .eq('id', office.governing_body_id)
      .maybeSingle();
    governingBody = (body as GoverningBody | null) ?? null;
  }

  // Load body this office presides over (Lt Gov over Senate, etc.)
  let presidesOverBody: GoverningBody | null = null;
  if (office.presides_over_body_id) {
    const { data: body } = await supabase
      .from('governing_bodies')
      .select('id, canonical_name, chamber_type')
      .eq('id', office.presides_over_body_id)
      .maybeSingle();
    presidesOverBody = (body as GoverningBody | null) ?? null;
  }

  // All tenures (historical + current)
  const { data: tenures } = await supabase
    .from('office_tenures')
    .select('person_id, started_on, ended_on, party_at_tenure, people(canonical_name, photo_url)')
    .eq('office_id', officeId)
    .order('started_on', { ascending: false });

  // Elections
  const { data: elections } = await supabase
    .from('elections')
    .select('id, election_date, election_type, results_certified_at')
    .eq('office_id', officeId)
    .order('election_date', { ascending: false });

  const today = new Date().toISOString().slice(0, 10);
  const upcomingElections = (elections ?? []).filter((e) => e.election_date >= today);
  const upcomingElectionIds = upcomingElections.map((e) => e.id);
  let candidacies: Array<Record<string, unknown>> = [];
  if (upcomingElectionIds.length > 0) {
    const { data } = await supabase
      .from('candidacies')
      .select('election_id, party, status, people(id, canonical_name, photo_url)')
      .in('election_id', upcomingElectionIds);
    candidacies = data ?? [];
  }

  return { office, officeType, jurisdiction, governingBody, presidesOverBody, research, tenures: tenures ?? [], elections: elections ?? [], candidacies };
}

function pickFirst<T>(...vals: Array<T | null | undefined>): T | null {
  for (const v of vals) {
    if (v != null && (typeof v !== 'string' || v.trim() !== '')) return v;
  }
  return null;
}

function fmtSalary(amount: number | null | undefined, year: number | null | undefined): string | null {
  if (amount == null) return null;
  const formatted = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(amount);
  return year ? `${formatted} (${year})` : formatted;
}

function fmtTermLength(years: number | null | undefined, months: number | null | undefined): string | null {
  if (years) return `${years} year${years === 1 ? '' : 's'}`;
  if (months) {
    const y = months / 12;
    return Number.isInteger(y) ? `${y} year${y === 1 ? '' : 's'}` : `${months} months`;
  }
  return null;
}

export default async function OfficePage({ params }: PageProps) {
  const { id } = await params;
  const data = await loadData(id);
  if (!data) notFound();
  const { office, officeType, jurisdiction, governingBody, presidesOverBody, research, tenures, elections, candidacies } = data;

  const currentTenure = tenures.find((t) => t.ended_on === null);
  const pastTenures = tenures.filter((t) => t.ended_on !== null);
  const today = new Date().toISOString().slice(0, 10);
  const upcomingElections = elections.filter((e) => e.election_date >= today);
  const pastElections = elections.filter((e) => e.election_date < today);

  // Resolve editorial fields with priority: research_extracted > governing_body > office_type fallback
  const description = pickFirst(
    research?.description,
    governingBody?.description,
    officeType?.description,
    office.responsibilities_md,
  );
  const powersSummary = pickFirst(
    research?.powers_summary,
    governingBody?.powers_summary,
  );
  const termLength = pickFirst(
    fmtTermLength(research?.term_length_years, null),
    fmtTermLength(governingBody?.seat_structure?.[0]?.term_length_years, null),
    fmtTermLength(null, office.term_length_months),
  );
  const maxConsecutive = research?.max_consecutive_terms ?? null;
  const selectionMethod = pickFirst(
    research?.selection_method,
    governingBody?.selection_method,
    office.selection_method,
  );
  const primaryRequired = research?.primary_required ?? governingBody?.primary_required ?? null;
  const onCyclePattern = pickFirst(research?.on_cycle_pattern, governingBody?.on_cycle_pattern);
  const nextRegular = research?.next_regular_election_date;
  const workload = research?.workload;
  const salary = fmtSalary(research?.salary_annual_usd, research?.salary_year);
  const vacancyAuthority = pickFirst(research?.vacancy_appointment_authority, governingBody?.vacancy_appointment_authority);
  const vacancyTriggers = research?.vacancy_triggers_special ?? governingBody?.vacancy_triggers_special;
  const specialElectionRule = pickFirst(research?.special_election_timing_rule, governingBody?.special_election_timing_rule);
  const voterQualifications = pickFirst(research?.voter_qualifications_summary, governingBody?.voter_qualifications_summary);

  // Citations from research + body (deduped by URL)
  const citationSet = new Map<string, { url: string; title?: string; kind?: string; accessed_at?: string }>();
  for (const c of research?.citations ?? []) if (c?.url) citationSet.set(c.url, c);
  for (const c of governingBody?.citations ?? []) if (c?.url && !citationSet.has(c.url)) citationSet.set(c.url, c);
  const allCitations = [...citationSet.values()];

  const formallyVerified = research?.authoritative === true || governingBody?.size_authoritative === true;

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 text-gray-900">
      <DeepLinkConvertCTA />

      {/* Header */}
      <div className="mb-6">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <h1 className="text-3xl font-bold text-gray-900">{office.canonical_name}</h1>
          <DataQualityBadge
            tier={(((office.meta as Record<string, unknown>)?.data_quality_tier as DataQualityTier) ?? (formallyVerified ? 'authoritative' : 'compiled'))}
            sourceUrl={null}
            lastVerified={research?.last_verified_at ?? governingBody?.last_verified_at ?? null}
            size="sm"
          />
        </div>
        <div className="text-sm text-gray-600 mt-1">
          {jurisdiction?.name}
          {office.seat_designation && ` · ${office.seat_designation}`}
          {officeType?.branch && ` · ${officeType.branch}`}
          {office.is_partisan != null && (office.is_partisan ? ' · Partisan' : ' · Nonpartisan')}
          {governingBody && (
            <span>
              {' · Member of: '}
              <Link href={`/admin/office-review#body-${governingBody.id}`} className="text-blue-700 hover:underline">
                {governingBody.canonical_name}
              </Link>
            </span>
          )}
          {presidesOverBody && (
            <span>
              {' · Presides over: '}
              <Link href={`/admin/office-review#body-${presidesOverBody.id}`} className="text-blue-700 hover:underline">
                {presidesOverBody.canonical_name}
              </Link>
            </span>
          )}
        </div>
      </div>

      {/* What this office does */}
      {(description || powersSummary) && (
        <section className="mb-6 p-4 bg-gray-50 rounded border border-gray-200">
          <h2 className="text-xl font-semibold mb-2">What this office does</h2>
          {description && <p className="text-sm text-gray-800 leading-relaxed mb-2">{description}</p>}
          {powersSummary && (
            <details className="mt-2">
              <summary className="text-sm text-blue-700 cursor-pointer">Detailed powers</summary>
              <p className="text-sm text-gray-800 leading-relaxed mt-2">{powersSummary}</p>
            </details>
          )}
          {officeType?.typical_powers && officeType.typical_powers.length > 0 && !powersSummary && (
            <div className="mt-3 flex flex-wrap gap-2">
              {officeType.typical_powers.map((p: string) => (
                <span key={p} className="text-xs px-2 py-1 bg-white border border-gray-200 rounded">
                  {p.replaceAll('_', ' ')}
                </span>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Governing body context */}
      {governingBody && governingBody.description && (
        <section className="mb-6 p-4 bg-indigo-50 rounded border border-indigo-200">
          <h2 className="text-xl font-semibold mb-2">{governingBody.canonical_name}</h2>
          <p className="text-sm text-gray-800 leading-relaxed">{governingBody.description}</p>
          {governingBody.size_total != null && (
            <div className="mt-2 text-xs text-gray-700">
              <strong>{governingBody.size_total}</strong> total seats
              {governingBody.size_authoritative && <span className="ml-2 text-green-700">✓ verified</span>}
              {governingBody.seat_structure && governingBody.seat_structure.length > 0 && (
                <div className="mt-1">
                  {governingBody.seat_structure.map((sg, i) => (
                    <div key={i}>
                      {sg.count} seats · {sg.designation_kind ?? 'unknown'}
                      {sg.term_length_years && ` · ${sg.term_length_years}-year terms`}
                      {sg.stagger_offset_years != null && ` · staggered every ${sg.stagger_offset_years}y`}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          <div className="mt-3 text-xs">
            <Link href={`/admin/office-review#body-${governingBody.id}`} className="text-blue-700 hover:underline">
              See full body record on office-review →
            </Link>
          </div>
        </section>
      )}

      {/* Term + cadence */}
      {(termLength || selectionMethod || onCyclePattern || nextRegular) && (
        <section className="mb-6 p-4 bg-white rounded border border-gray-200">
          <h2 className="text-xl font-semibold mb-2">Term + election cadence</h2>
          <dl className="text-sm grid grid-cols-1 md:grid-cols-2 gap-2">
            {termLength && (
              <div>
                <dt className="text-gray-500 text-xs uppercase">Term length</dt>
                <dd className="font-medium">{termLength}{maxConsecutive ? ` · max ${maxConsecutive} consecutive` : ''}</dd>
              </div>
            )}
            {selectionMethod && (
              <div>
                <dt className="text-gray-500 text-xs uppercase">Selection</dt>
                <dd className="font-medium">{selectionMethod.replaceAll('_', ' ')}{primaryRequired === true ? ' · primary required' : ''}</dd>
              </div>
            )}
            {onCyclePattern && (
              <div>
                <dt className="text-gray-500 text-xs uppercase">Cycle</dt>
                <dd className="font-medium">{onCyclePattern}</dd>
              </div>
            )}
            {nextRegular && (
              <div>
                <dt className="text-gray-500 text-xs uppercase">Next regular election</dt>
                <dd className="font-medium">{nextRegular}</dd>
              </div>
            )}
          </dl>
        </section>
      )}

      {/* Compensation + workload */}
      {(salary || workload) && (
        <section className="mb-6 p-4 bg-white rounded border border-gray-200">
          <h2 className="text-xl font-semibold mb-2">Compensation + workload</h2>
          <dl className="text-sm grid grid-cols-1 md:grid-cols-2 gap-2">
            {salary && (
              <div>
                <dt className="text-gray-500 text-xs uppercase">Salary</dt>
                <dd className="font-medium">{salary}</dd>
              </div>
            )}
            {workload && (
              <div>
                <dt className="text-gray-500 text-xs uppercase">Workload</dt>
                <dd className="font-medium">{workload.replaceAll('_', ' ')}</dd>
              </div>
            )}
          </dl>
        </section>
      )}

      {/* Vacancy rules */}
      {(vacancyAuthority || vacancyTriggers || specialElectionRule) && (
        <section className="mb-6 p-4 bg-white rounded border border-gray-200">
          <h2 className="text-xl font-semibold mb-2">If the seat becomes vacant</h2>
          {vacancyAuthority && (
            <p className="text-sm text-gray-800 leading-relaxed mb-2"><strong>Who fills it:</strong> {vacancyAuthority}</p>
          )}
          {vacancyTriggers && vacancyTriggers.length > 0 && (
            <p className="text-sm text-gray-800 leading-relaxed mb-2">
              <strong>What triggers a vacancy:</strong> {vacancyTriggers.join(', ').replaceAll('_', ' ')}
            </p>
          )}
          {specialElectionRule && (
            <p className="text-sm text-gray-800 leading-relaxed"><strong>Special-election timing:</strong> {specialElectionRule}</p>
          )}
        </section>
      )}

      {/* How to participate */}
      {voterQualifications && (
        <section className="mb-6 p-4 bg-green-50 rounded border border-green-200">
          <h2 className="text-xl font-semibold mb-2">How to vote in this race</h2>
          <p className="text-sm text-gray-800 leading-relaxed">{voterQualifications}</p>
        </section>
      )}

      {/* Current incumbent */}
      {currentTenure && (
        <section className="mb-6 p-4 bg-blue-50 rounded border border-blue-200">
          <h2 className="text-xl font-semibold mb-2">Current Incumbent</h2>
          {(() => {
            const person = (currentTenure as unknown as { people?: { canonical_name?: string; photo_url?: string } }).people;
            return (
              <div className="flex items-center gap-4">
                {person?.photo_url && (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img src={person.photo_url} alt={person.canonical_name ?? ''} className="w-16 h-20 object-cover rounded border border-gray-200" />
                )}
                <div>
                  <Link href={`/person/${currentTenure.person_id}`} className="text-lg font-semibold text-blue-700 hover:underline">
                    {person?.canonical_name ?? 'Unknown'}
                  </Link>
                  <div className="text-sm text-gray-700">
                    {currentTenure.party_at_tenure && `${currentTenure.party_at_tenure} · `}
                    Serving since {currentTenure.started_on}
                  </div>
                </div>
              </div>
            );
          })()}
        </section>
      )}

      {/* Upcoming elections + candidates */}
      {upcomingElections.length > 0 && (
        <section className="mb-6">
          <h2 className="text-xl font-semibold mb-2">Upcoming Elections</h2>
          <div className="space-y-3">
            {upcomingElections.map((e) => {
              const electionCandidacies = candidacies.filter(
                (c) => (c as { election_id?: string }).election_id === e.id
              );
              return (
                <div key={e.id} className="p-3 border border-gray-200 rounded">
                  <div className="text-sm font-medium">
                    {e.election_type.toUpperCase()} · {e.election_date}
                  </div>
                  {electionCandidacies.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {electionCandidacies.map((c, i) => {
                        const p = (c as unknown as { people?: { id?: string; canonical_name?: string } }).people;
                        const isIncumbent = currentTenure && p?.id === currentTenure.person_id;
                        return (
                          <Link
                            key={i}
                            href={p?.id ? `/person/${p.id}` : '#'}
                            className={isIncumbent
                              ? "text-xs px-2 py-1 bg-blue-100 border border-blue-300 rounded hover:bg-blue-200"
                              : "text-xs px-2 py-1 bg-green-50 border border-green-200 rounded hover:bg-green-100"}
                            title={isIncumbent ? 'Current officeholder running for re-election' : undefined}
                          >
                            {isIncumbent && '★ '}
                            {p?.canonical_name ?? 'unknown'}
                            {c.party != null && ` · ${c.party as string}`}
                          </Link>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Past officeholders */}
      {pastTenures.length > 0 && (
        <section className="mb-6">
          <h2 className="text-xl font-semibold mb-2">Past Officeholders</h2>
          <div className="space-y-2 text-sm">
            {pastTenures.slice(0, 10).map((t, i) => {
              const person = (t as unknown as { people?: { canonical_name?: string } }).people;
              return (
                <div key={i} className="flex justify-between text-gray-700">
                  <Link href={`/person/${t.person_id}`} className="hover:underline">
                    {person?.canonical_name ?? 'Unknown'}
                  </Link>
                  <span className="text-gray-500">
                    {t.started_on} – {t.ended_on}
                    {t.party_at_tenure && ` · ${t.party_at_tenure}`}
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Past elections */}
      {pastElections.length > 0 && (
        <section className="mb-6">
          <h2 className="text-xl font-semibold mb-2">Past Elections</h2>
          <div className="space-y-1 text-sm text-gray-700">
            {pastElections.slice(0, 10).map((e) => (
              <div key={e.id}>
                {e.election_type} — {e.election_date}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Sources */}
      {allCitations.length > 0 && (
        <section className="mb-6 p-4 bg-gray-50 rounded border border-gray-200">
          <h2 className="text-xl font-semibold mb-2">Sources</h2>
          <ul className="text-sm space-y-2">
            {allCitations.map((c, i) => (
              <li key={i}>
                <a href={c.url} target="_blank" rel="noopener noreferrer" className="text-blue-700 hover:underline">
                  {c.title ?? c.url}
                </a>
                {c.kind && <span className="ml-2 text-xs text-gray-500">({c.kind})</span>}
                {c.accessed_at && <span className="ml-2 text-xs text-gray-500">accessed {c.accessed_at}</span>}
              </li>
            ))}
          </ul>
          {(research?.last_verified_at || governingBody?.last_verified_at) && (
            <div className="mt-3 text-xs text-gray-500">
              Last verified: {research?.last_verified_at ?? governingBody?.last_verified_at}
              {(research?.verified_by || governingBody?.verified_by) && (
                <span> · by <code>{research?.verified_by ?? governingBody?.verified_by}</code></span>
              )}
            </div>
          )}
        </section>
      )}

      <div className="mt-8 text-xs text-gray-500 flex gap-3">
        <Link href="/" className="underline">Home</Link>
        <span>·</span>
        <Link href="/admin/office-review" className="underline">Office Review</Link>
        <span>·</span>
        <span>Office ID: <code>{id}</code></span>
      </div>
    </div>
  );
}
