import { inngest } from '../client';
import { createServiceClient } from '@/lib/supabase/server';
import { extractPositionsFromText } from '@/lib/claude';
import { assertSafeUrl, SSRFBlockedError } from '@/lib/adapters/fetch-polite';
import type { Candidate } from '@/types/database';

/**
 * Inngest function: scrape candidate data from various sources.
 * Triggered by "candidate/scrape" event.
 *
 * Steps:
 * 1. Fetch candidate's campaign website and extract text
 * 2. Use Claude to extract position statements from page text
 * 3. If incumbent, fetch voting records (OpenStates for state, Congress.gov for federal)
 * 4. Fetch campaign finance data from FEC API (federal only)
 * 5. Store all raw data in candidate_sources table
 * 6. Trigger classification pipeline
 */
export const scrapeCandidate = inngest.createFunction(
  {
    id: 'scrape-candidate',
    retries: 2,
    // Throttle prevents a bulk candidate-scrape event burst from hammering
    // campaign sites + our DB. 10 scrapes/min × 3 parallel ≈ safe ceiling
    // for a cron-fan-out and stays polite to the third-party sites.
    throttle: { limit: 10, period: '1m' },
    concurrency: [{ limit: 3 }],
    triggers: [{ event: 'candidate/scrape' }],
  },
  async ({ event, step }: { event: any; step: any }) => {
    const { candidate_id, website_url } = event.data as {
      candidate_id: string;
      website_url?: string;
    };

    // Step 1: Fetch campaign website and extract text
    const websiteContent = await step.run(
      'fetch-campaign-site',
      async () => {
        const supabase = await createServiceClient();

        const { data: candidate, error } = await supabase
          .from('candidates')
          .select('*, race:races(*)')
          .eq('id', candidate_id)
          .single();

        if (error || !candidate) {
          throw new Error(
            `Candidate ${candidate_id} not found: ${error?.message}`
          );
        }

        const url = website_url || candidate.website_url;
        if (!url) {
          return {
            candidateName: candidate.name,
            url: null,
            text: null,
            party: candidate.party,
            raceLevel: (candidate.race as { level?: string } | null)?.level ?? null,
          };
        }

        // SSRF guard on the candidate-supplied website URL. Candidate
        // websites come from third-party rosters and could in principle
        // point at internal IPs (cloud metadata, RFC1918, etc.). Bail
        // early before the robots.txt fetch so we never even touch the
        // internal target.
        try {
          await assertSafeUrl(String(url));
        } catch (ssrfErr) {
          return {
            candidateName: candidate.name,
            url: String(url),
            text: null,
            party: candidate.party,
            raceLevel: (candidate.race as { level?: string } | null)?.level ?? null,
            error:
              ssrfErr instanceof SSRFBlockedError
                ? `SSRF blocked: ${ssrfErr.reason}`
                : 'SSRF guard error',
          };
        }

        // Check robots.txt before scraping
        try {
          const urlObj = new URL(String(url));
          const robotsUrl = `${urlObj.protocol}//${urlObj.host}/robots.txt`;
          // robots.txt lives on the same host we already validated above,
          // but re-run the guard so a future refactor that swaps in a
          // different host can't slip past.
          await assertSafeUrl(robotsUrl);
          const robotsRes = await fetch(robotsUrl, {
            signal: AbortSignal.timeout(5_000),
            headers: {
              'User-Agent': 'Havesay/1.0 (civic-voter-guide)',
            },
          });
          if (robotsRes.ok) {
            const robotsTxt = await robotsRes.text();
            // Basic robots.txt check: if our user-agent or * is disallowed for /
            const lines = robotsTxt.toLowerCase().split('\n');
            let inOurSection = false;
            for (const line of lines) {
              const trimmed = line.trim();
              if (trimmed.startsWith('user-agent:')) {
                const agent = trimmed.split(':')[1]?.trim();
                inOurSection = agent === '*' || agent === 'ballotbridge';
              }
              if (inOurSection && trimmed.startsWith('disallow:')) {
                const path = trimmed.split(':')[1]?.trim();
                if (path === '/' || path === '/*') {
                  return {
                    candidateName: candidate.name,
                    url: String(url),
                    text: null,
                    party: candidate.party,
                    raceLevel: (candidate.race as { level?: string } | null)?.level ?? null,
                    error: 'Blocked by robots.txt',
                  };
                }
              }
            }
          }
        } catch {
          // robots.txt check is non-fatal; proceed with scraping
        }

        try {
          const response = await fetch(String(url), {
            headers: {
              'User-Agent':
                'Havesay/1.0 (nonpartisan voter-information project, in development)',
            },
            signal: AbortSignal.timeout(15_000),
          });

          if (!response.ok) {
            return {
              candidateName: candidate.name,
              url: String(url),
              text: null,
              party: candidate.party,
              raceLevel: (candidate.race as { level?: string } | null)?.level ?? null,
              error: `HTTP ${response.status}`,
            };
          }

          const html = await response.text();

          // Basic HTML-to-text: strip scripts/styles/nav/footer/header, decode entities
          // NOTE: This will fail on JS-rendered sites (React, NationBuilder, etc.).
          // For production, consider a headless browser service (Firecrawl, ScrapingBee).
          const text = html
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
            .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
            .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
            .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/\s+/g, ' ')
            .trim();

          return {
            candidateName: candidate.name,
            url: String(url),
            text: text.slice(0, 100_000),
            party: candidate.party,
            raceLevel: (candidate.race as { level?: string } | null)?.level ?? null,
          };
        } catch (fetchErr) {
          return {
            candidateName: candidate.name,
            url: String(url),
            text: null,
            party: candidate.party,
            raceLevel: (candidate.race as { level?: string } | null)?.level ?? null,
            error:
              fetchErr instanceof Error ? fetchErr.message : 'Fetch failed',
          };
        }
      }
    );

    // Step 2: Parse positions from website text using Claude
    const extractedPositions = await step.run(
      'parse-positions',
      async () => {
        if (!websiteContent.text) {
          return [];
        }

        return extractPositionsFromText(
          websiteContent.text,
          websiteContent.candidateName
        );
      }
    );

    // Step 3: Fetch voting records if incumbent
    const votingRecords = await step.run(
      'fetch-voting-records',
      async () => {
        const raceLevel = websiteContent.raceLevel;
        const records: { bill: string; vote: string; date: string }[] = [];
        let source: string | null = null;

        if (raceLevel === 'state') {
          // OpenStates API for Utah state legislature voting records
          const openstatesKey = process.env.OPENSTATES_API_KEY;
          if (!openstatesKey) {
            return { records: [], source: null, error: 'OPENSTATES_API_KEY not configured' };
          }

          try {
            // Step 3a: Find legislator by name
            const searchUrl = new URL('https://v3.openstates.org/people');
            searchUrl.searchParams.set('jurisdiction', 'ut');
            searchUrl.searchParams.set('name', websiteContent.candidateName);
            searchUrl.searchParams.set('org_classification', 'legislature');

            const personRes = await fetch(searchUrl.toString(), {
              headers: { 'X-API-KEY': openstatesKey },
              signal: AbortSignal.timeout(10_000),
            });

            if (!personRes.ok) {
              return { records, source: null, error: `OpenStates ${personRes.status}` };
            }

            const personData = await personRes.json();
            const person = personData.results?.[0];
            if (!person) {
              return { records, source: null, error: 'Legislator not found in OpenStates' };
            }

            const personId = person.id;

            // Step 3b: Fetch recent bills with votes
            const currentYear = new Date().getFullYear();
            const billsUrl = new URL('https://v3.openstates.org/bills');
            billsUrl.searchParams.set('jurisdiction', 'ut');
            billsUrl.searchParams.set('session', String(currentYear));
            billsUrl.searchParams.set('include', 'votes');
            billsUrl.searchParams.set('per_page', '50');

            const billsRes = await fetch(billsUrl.toString(), {
              headers: { 'X-API-KEY': openstatesKey },
              signal: AbortSignal.timeout(15_000),
            });

            if (!billsRes.ok) {
              return { records, source: 'openstates', error: `Bills fetch ${billsRes.status}` };
            }

            const billsData = await billsRes.json();
            source = 'openstates';

            // Extract this legislator's votes from each bill
            for (const bill of billsData.results ?? []) {
              for (const voteEvent of bill.votes ?? []) {
                for (const v of voteEvent.votes ?? []) {
                  if (v.voter?.id === personId || v.voter_name === websiteContent.candidateName) {
                    records.push({
                      bill: `${bill.identifier}: ${bill.title}`,
                      vote: v.option, // 'yes', 'no', 'absent', etc.
                      date: voteEvent.start_date || '',
                    });
                  }
                }
              }
            }
          } catch {
            // Non-fatal
          }
        } else if (raceLevel === 'federal') {
          // Congress.gov API for federal voting records
          const congressKey = process.env.CONGRESS_API_KEY;
          if (!congressKey) {
            return { records: [], source: null, error: 'CONGRESS_API_KEY not configured' };
          }

          try {
            // Search for member by state
            const memberUrl =
              `https://api.congress.gov/v3/member` +
              `?stateCode=UT&currentMember=true&api_key=${congressKey}`;

            const memberRes = await fetch(memberUrl, {
              signal: AbortSignal.timeout(10_000),
            });

            if (!memberRes.ok) {
              return { records, source: null, error: `Congress API ${memberRes.status}` };
            }

            const memberData = await memberRes.json();
            source = 'congress.gov';

            // Find matching member by name similarity
            const targetName = websiteContent.candidateName.toLowerCase();
            const member = (memberData.members ?? []).find(
              (m: { name: string }) =>
                m.name.toLowerCase().includes(targetName) ||
                targetName.includes(m.name.toLowerCase().split(', ').reverse().join(' '))
            );

            if (member?.bioguideId) {
              // Fetch member details (includes recent activity)
              const detailUrl =
                `https://api.congress.gov/v3/member/${member.bioguideId}` +
                `?api_key=${congressKey}`;

              const detailRes = await fetch(detailUrl, {
                signal: AbortSignal.timeout(10_000),
              });

              if (detailRes.ok) {
                const detailData = await detailRes.json();
                // Store for classification — full member record includes
                // sponsoredLegislation, cosponsoredLegislation references
                if (detailData.member) {
                  records.push({
                    bill: 'Member Profile',
                    vote: JSON.stringify({
                      bioguideId: member.bioguideId,
                      party: detailData.member.partyName,
                      state: detailData.member.state,
                      district: detailData.member.district,
                      terms: detailData.member.terms?.length ?? 0,
                    }),
                    date: new Date().toISOString().split('T')[0],
                  });
                }
              }
            }
          } catch {
            // Non-fatal
          }
        }

        return { records, source };
      }
    );

    // Step 4: Fetch campaign finance data from FEC API (federal candidates only)
    const fecData = await step.run('fetch-fec-data', async () => {
      // FEC only covers federal candidates (President, Senate, House)
      if (websiteContent.raceLevel !== 'federal') {
        return { data: null, error: 'Skipped: FEC only covers federal candidates' };
      }

      const fecApiKey = process.env.FEC_API_KEY;
      if (!fecApiKey) {
        return { data: null, error: 'FEC_API_KEY not configured' };
      }

      try {
        const searchUrl = `https://api.open.fec.gov/v1/candidates/search/?q=${encodeURIComponent(websiteContent.candidateName)}&api_key=${fecApiKey}`;
        const response = await fetch(searchUrl, {
          signal: AbortSignal.timeout(10_000),
        });

        if (!response.ok) {
          return { data: null, error: `FEC API returned ${response.status}` };
        }

        const result = await response.json();
        const candidates = result.results || [];

        if (candidates.length === 0) {
          return { data: null, error: 'No FEC candidate match found' };
        }

        const fecCandidate = candidates[0];
        const fecCandidateId = fecCandidate.candidate_id;

        // Fetch financial totals
        const financialsUrl = `https://api.open.fec.gov/v1/candidates/${fecCandidateId}/totals/?api_key=${fecApiKey}`;
        const finResponse = await fetch(financialsUrl, {
          signal: AbortSignal.timeout(10_000),
        });

        let financials = null;
        if (finResponse.ok) {
          const finData = await finResponse.json();
          financials = finData.results?.[0] || null;
        }

        return {
          data: {
            fec_candidate_id: fecCandidateId,
            name: fecCandidate.name,
            party: fecCandidate.party,
            office: fecCandidate.office_full,
            state: fecCandidate.state,
            district: fecCandidate.district,
            financials,
          },
          error: null,
        };
      } catch (err) {
        return {
          data: null,
          error: err instanceof Error ? err.message : 'FEC fetch failed',
        };
      }
    });

    // Step 5: Store all raw data in candidate_sources table
    await step.run('store-raw-data', async () => {
      const supabase = await createServiceClient();

      // 11-value source_type taxonomy per migration 20260420000004.
      // Old enum values (campaign_website, extracted_positions, fec_financials)
      // are preserved via source_subtype for analytics.
      const sourcesToInsert: {
        candidate_id: string;
        source_type: string;
        source_subtype: string | null;
        raw_data: string;
        url: string | null;
        title: string | null;
      }[] = [];

      if (websiteContent.text) {
        sourcesToInsert.push({
          candidate_id,
          source_type: 'website',
          source_subtype: 'campaign_site',
          raw_data: websiteContent.text,
          url: websiteContent.url,
          title: `${websiteContent.candidateName} - Campaign Website`,
        });
      }

      if (extractedPositions.length > 0) {
        sourcesToInsert.push({
          candidate_id,
          source_type: 'news',
          source_subtype: 'extracted_positions',
          raw_data: JSON.stringify(extractedPositions),
          url: websiteContent.url,
          title: `${websiteContent.candidateName} - Extracted Position Statements`,
        });
      }

      if (votingRecords.source && votingRecords.records.length > 0) {
        sourcesToInsert.push({
          candidate_id,
          source_type: 'voting_record',
          source_subtype: null,
          raw_data: JSON.stringify(votingRecords.records),
          url: null,
          title: `${websiteContent.candidateName} - Voting Records (${votingRecords.source})`,
        });
      }

      if (fecData.data) {
        sourcesToInsert.push({
          candidate_id,
          source_type: 'filing',
          source_subtype: 'fec_financials',
          raw_data: JSON.stringify(fecData.data),
          url: `https://www.fec.gov/data/candidate/${fecData.data.fec_candidate_id}/`,
          title: `${websiteContent.candidateName} - FEC Campaign Finance Data`,
        });
      }

      if (sourcesToInsert.length === 0) {
        throw new Error(
          `No data collected for candidate ${candidate_id}. Website: ${websiteContent.error || 'no URL'}, FEC: ${fecData.error || 'no data'}`
        );
      }

      // Delete existing sources for this candidate before inserting fresh data
      await supabase
        .from('candidate_sources')
        .delete()
        .eq('candidate_id', candidate_id);

      const { error } = await supabase
        .from('candidate_sources')
        .insert(sourcesToInsert);

      if (error) {
        throw new Error(`Failed to store raw data: ${error.message}`);
      }

      return { sources_stored: sourcesToInsert.length };
    });

    // Step 6: Trigger classification
    await step.sendEvent('trigger-classify', {
      name: 'candidate/classify',
      data: { candidate_id },
    });

    return {
      candidate_id,
      website_scraped: !!websiteContent.text,
      positions_extracted: extractedPositions.length,
      voting_records_source: votingRecords.source,
      fec_data_found: !!fecData.data,
    };
  }
);
