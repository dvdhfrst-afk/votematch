/**
 * Declaration-of-candidacy PDF extractor.
 *
 * Utah's Lt. Gov publishes every candidate's declaration of candidacy as a
 * scanned PDF at vote.utah.gov/wp-content/uploads/2026/NN/ (where NN is the
 * month subdir). These are legally attested filings — the highest-certainty
 * identity + contact source we have.
 *
 * This module: download the PDF, submit it to Claude Opus 4.7 with a strict
 * Zod schema, get structured JSON back. Works because Claude reads PDF natively
 * (no separate OCR step required).
 *
 * Council-review provenance: contrarian D1 flagged that we'd dismissed these
 * PDFs without investigating. OCR feasibility research confirmed Claude's
 * native vision handles them at ~$0.01-0.03/PDF for Opus 4.7.
 */
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';

const UA =
  'Havesay/1.0 (nonpartisan voter-information project, in development)';

function requireRealApiKey(): void {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || key.startsWith('your-')) {
    throw new Error(
      'ANTHROPIC_API_KEY is missing or a placeholder. Declaration extraction ' +
        'requires a real key; mock mode was removed after council round-2 review.',
    );
  }
}

// ---------------------------------------------------------------------------
// Extraction schema
// ---------------------------------------------------------------------------

/**
 * What we aim to extract from a Utah declaration of candidacy. Every field is
 * nullable because scanned forms are imperfect — handwriting is variable,
 * some fields may be blank, etc. Never impute: if the PDF doesn't contain it,
 * return null and let downstream code flag the gap.
 */
export const DeclarationExtractionSchema = z.object({
  candidate_legal_name: z
    .string()
    .nullable()
    .describe('Full legal name as printed on the form'),
  candidate_display_name: z
    .string()
    .nullable()
    .describe(
      'Name as the candidate wishes to appear on the ballot (often the same, sometimes a nickname)',
    ),
  office_sought: z
    .string()
    .nullable()
    .describe('Office the candidate is running for, verbatim'),
  party_affiliation: z
    .string()
    .nullable()
    .describe('Party printed on the form (Republican, Democratic, etc.)'),
  residence_street: z
    .string()
    .nullable()
    .describe('Street address where candidate resides'),
  residence_city: z.string().nullable(),
  residence_zip: z.string().nullable(),
  mailing_address: z
    .string()
    .nullable()
    .describe('Mailing address if different from residence'),
  contact_email: z.string().nullable(),
  contact_phone: z.string().nullable(),
  filing_date: z
    .string()
    .nullable()
    .describe('ISO date (YYYY-MM-DD) the declaration was filed'),
  notary_date: z.string().nullable().describe('ISO date of notarization'),
  is_signed: z
    .boolean()
    .describe('Is there a signature visible in the signature box?'),
  is_notarized: z
    .boolean()
    .describe('Is there a notary seal / stamp on the form?'),
  party_affiliation_duration: z
    .string()
    .nullable()
    .describe(
      'If the form asks how long they have been affiliated with the party, that value',
    ),
  extraction_confidence: z
    .enum(['high', 'medium', 'low'])
    .describe(
      'Your confidence that the extraction reflects what the form actually says. Low = handwriting too ambiguous or form damaged.',
    ),
  extraction_notes: z
    .string()
    .nullable()
    .describe(
      'Any caveats, ambiguities, or pieces the form asked for but you could not read. Keep to 1-2 sentences.',
    ),
});

export type DeclarationExtraction = z.infer<typeof DeclarationExtractionSchema>;

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are extracting structured data from a Utah declaration of candidacy form.

These forms are filed by every candidate with the Utah Lt. Governor's office. They are legally attested and notarized. The PDFs are typically scanned images of handwritten forms, sometimes with typed fields.

Your job is to read the form carefully and populate the provided schema. For every field:

1. Return exactly what the form says. Do not interpret, normalize, or correct beyond basic formatting (e.g., converting a written-out date to ISO).
2. If a field is illegible, blank, or not present on the form, return null. DO NOT guess or impute.
3. For dates, return ISO format (YYYY-MM-DD). If the form shows "1/15/2026" or "January 15 2026", convert.
4. For phone numbers, return digits-only or in a canonical format like "801-555-0123".
5. Trust the form over any other knowledge — if the form says party is "Democratic" but you know this person ran as a Republican in another race, return "Democratic" per the form.

Your confidence rating:
- high = all major fields legible, signature/notary present, no ambiguity
- medium = most fields legible, one or two handwritten fields required interpretation
- low = form is damaged, heavily redacted, major fields illegible, or key sections appear blank

Do not fabricate. Null is always better than a guess.`;

export interface ExtractionResult {
  extraction: DeclarationExtraction;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  model: string;
}

/**
 * Download a PDF from a URL and base64-encode it.
 */
export async function downloadPdfAsBase64(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`PDF download failed ${res.status}: ${url}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  // Node Buffer available in tsx env
  return Buffer.from(bytes).toString('base64');
}

/**
 * Extract structured data from a single declaration PDF. Opus 4.7 with
 * adaptive thinking. Non-streaming because the output is short (one JSON
 * object) and the PDF can be pre-downloaded.
 */
export async function extractDeclaration(
  client: Anthropic,
  pdfBase64: string,
  options: { candidateHint?: string } = {},
): Promise<ExtractionResult> {
  requireRealApiKey();
  const userContent: Anthropic.Messages.ContentBlockParam[] = [
    {
      type: 'document',
      source: {
        type: 'base64',
        media_type: 'application/pdf',
        data: pdfBase64,
      },
    } as Anthropic.Messages.ContentBlockParam,
    {
      type: 'text',
      text: options.candidateHint
        ? `Extract the declaration data. Expected candidate: ${options.candidateHint}. If the form's name field disagrees with the hint, trust the form.`
        : 'Extract the declaration data from the form.',
    },
  ];

  const response = await client.messages.parse({
    model: 'claude-opus-4-7',
    max_tokens: 4000,
    thinking: { type: 'adaptive' },
    output_config: {
      format: zodOutputFormat(DeclarationExtractionSchema),
    },
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userContent }],
  });

  const parsed = (response as unknown as { parsed_output: DeclarationExtraction | null }).parsed_output;
  if (!parsed) {
    throw new Error(
      `extraction returned no parsed output (stop_reason=${response.stop_reason})`,
    );
  }

  return {
    extraction: parsed,
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      cache_creation_input_tokens:
        response.usage.cache_creation_input_tokens ?? undefined,
      cache_read_input_tokens:
        response.usage.cache_read_input_tokens ?? undefined,
    },
    model: response.model,
  };
}

/**
 * Convenience: download + extract in one call. Pass the URL directly.
 */
export async function extractDeclarationFromUrl(
  client: Anthropic,
  pdfUrl: string,
  options: { candidateHint?: string } = {},
): Promise<ExtractionResult> {
  requireRealApiKey();
  const pdfBase64 = await downloadPdfAsBase64(pdfUrl);
  return extractDeclaration(client, pdfBase64, options);
}

// Mock extraction helper removed 2026-04-17 after council round-2 review.
