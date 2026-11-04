/**
 * Questionnaire connector: ingests candidate-submitted questionnaire responses
 * as tier-1 source material.
 *
 * Per council 2026-04-19 (14-classifier-baseline/02-source-connector-council.md):
 * questionnaire responses are unanimous tier-1 material because the candidate
 * has directly answered our structured questions under an attestation — the
 * highest-authenticity source class we can get. They can't claim we
 * misrepresented their position when we're quoting their exact words.
 *
 * Unlike web-scraping connectors, this connector reads from our own DB. It
 * doesn't hit any external API. It's idempotent: on re-run for the same
 * candidate, the orchestrator's (candidate_id, source_type, url) upsert will
 * replace the existing row.
 */
import type { SourceConnector, SourceRow } from '../connector-types';

export const questionnaireConnector: SourceConnector = {
  name: 'questionnaire',

  applicable() {
    // Always eligible — the fetch() call is cheap and returns [] when no
    // questionnaire has been submitted.
    return { applicable: true };
  },

  async fetch(candidate, s) {
    const { data, error } = await s
      .from('questionnaire_responses')
      .select('id, response_data, attestation, submitted_at, updated_at')
      .eq('candidate_id', candidate.id)
      .order('submitted_at', { ascending: false })
      .limit(1);

    if (error || !data || data.length === 0) return [];

    const row = data[0] as {
      id: string;
      response_data: Record<string, unknown> | unknown[];
      attestation: string;
      submitted_at: string;
      updated_at: string | null;
    };

    // Serialize the structured response into readable text the classifier
    // can process. Each top-level key is one question/topic. If the shape
    // is { taxes: 'explains their tax stance', immigration: '...' } we get
    // one labeled paragraph per key. If the shape is array-of-qa, we format
    // q/a pairs.
    const lines: string[] = [];
    lines.push(`Candidate: ${candidate.name}`);
    lines.push(`Submitted: ${row.submitted_at}`);
    if (row.updated_at) lines.push(`Last edited: ${row.updated_at}`);
    lines.push(`Attestation: ${row.attestation}`);
    lines.push('');
    lines.push('=== Questionnaire responses ===');
    lines.push('');

    if (Array.isArray(row.response_data)) {
      for (const item of row.response_data as Array<Record<string, unknown>>) {
        const q =
          typeof item.question === 'string'
            ? item.question
            : typeof item.prompt === 'string'
              ? item.prompt
              : null;
        const a =
          typeof item.answer === 'string'
            ? item.answer
            : typeof item.response === 'string'
              ? item.response
              : null;
        if (q) lines.push(`Q: ${q}`);
        if (a) lines.push(`A: ${a}`);
        if (q || a) lines.push('');
      }
    } else if (row.response_data && typeof row.response_data === 'object') {
      for (const [key, value] of Object.entries(row.response_data as Record<string, unknown>)) {
        if (typeof value === 'string' && value.trim().length > 0) {
          lines.push(`${key.replace(/_/g, ' ')}:`);
          lines.push(value.trim());
          lines.push('');
        } else if (value && typeof value === 'object') {
          lines.push(`${key.replace(/_/g, ' ')}: ${JSON.stringify(value).slice(0, 800)}`);
          lines.push('');
        }
      }
    }

    return [
      {
        source_type: 'questionnaire',
        // Tier 1 — direct candidate words under attestation. Highest possible authenticity.
        authenticity_tier: 1,
        outlet_ideology: null, // candidate's own words — no outlet ideology
        // Stable URL-like reference so the orchestrator's upsert works across re-runs.
        // Not a public URL — the questionnaire response isn't publicly hosted
        // except through the candidate profile, so we link to our own canonical
        // representation.
        url: `https://ballotbridge.org/candidate/${candidate.id}#questionnaire`,
        title: `${candidate.name} — questionnaire response (submitted ${row.submitted_at.slice(0, 10)})`,
        raw_data: lines.join('\n'),
        published_at: row.updated_at ?? row.submitted_at,
      },
    ];
  },
};
