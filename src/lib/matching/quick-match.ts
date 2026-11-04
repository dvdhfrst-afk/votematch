import type { Domain, SubDimension } from '@/types/database';
import { deriveWeights } from './weights';

// ---------------------------------------------------------------------------
// Domain option presented to the user in the quick-match flow
// ---------------------------------------------------------------------------

export interface DomainOption {
  id: Domain;
  label: string;
  description: string;
}

// ---------------------------------------------------------------------------
// Position question shown for a single domain's calibration step
// ---------------------------------------------------------------------------

export interface PositionQuestion {
  sub_dimension_id: string;
  sub_dimension_name: string;
  domain: Domain;
  prompt: string;
  options: {
    label: string;
    score: number; // 0-1
  }[];
}

// ---------------------------------------------------------------------------
// getDomainOptions
// ---------------------------------------------------------------------------
// Returns all 8 policy domains with user-friendly labels and descriptions
// for the "pick your top 3" step.
// ---------------------------------------------------------------------------

export function getDomainOptions(): DomainOption[] {
  return [
    {
      id: 'economy',
      label: 'Economy & Jobs',
      description:
        'Taxes, wages, trade, cost of living, and economic opportunity',
    },
    {
      id: 'social',
      label: 'Social & Civil Rights',
      description:
        'Immigration, voting rights, LGBTQ+ equality, religious liberty, and criminal justice reform',
    },
    {
      id: 'healthcare',
      label: 'Healthcare',
      description:
        'Insurance coverage, drug pricing, mental health, and reproductive rights',
    },
    {
      id: 'education',
      label: 'Education',
      description:
        'Public schools, higher education, school choice, and student debt',
    },
    {
      id: 'environment',
      label: 'Environment & Energy',
      description:
        'Climate change, clean energy, public lands, water, and air quality',
    },
    {
      id: 'governance',
      label: 'Government & Democracy',
      description:
        'Election integrity, government spending, transparency, and term limits',
    },
    {
      id: 'public_safety',
      label: 'Public Safety',
      description:
        'Policing, gun policy, drug policy, and community safety',
    },
    {
      id: 'infrastructure',
      label: 'Infrastructure & Housing',
      description:
        'Transportation, broadband, housing affordability, and urban planning',
    },
  ];
}

// ---------------------------------------------------------------------------
// Fallback calibration questions per domain
// ---------------------------------------------------------------------------
// These are used when sub-dimension metadata doesn't contain enough info to
// auto-generate a question.  Keyed by domain, each entry maps to a
// sub-dimension name pattern and a set of answer options with 0-1 scores.
// ---------------------------------------------------------------------------

interface FallbackQuestion {
  subDimensionPattern: string; // substring match against sd.name
  prompt: string;
  options: { label: string; score: number }[];
}

// Wording convention: each option describes a policy direction in its own
// terms without embedding a value judgment about the other end. Pairs are
// audited for symmetry — both poles get active verbs of equal valence
// ("lower / raise", "fewer / more", "shrink / expand"), neither side gets
// bundled with a positive-affect purpose clause (e.g. "to fund public
// services"), and scare-word modifiers ("significantly", "dramatically",
// "reasonable") are avoided on both ends. Rewritten 2026-04-20 after the
// UX council flagged the prior set as asymmetric. Future edits must
// preserve symmetry; run the bias-eval harness if in doubt.
const FALLBACK_QUESTIONS: Record<Domain, FallbackQuestion> = {
  economy: {
    subDimensionPattern: 'tax',
    prompt: 'What best describes your view on taxes and government spending?',
    options: [
      { label: 'Lower taxes and shrink the government\u2019s role', score: 0.15 },
      { label: 'Smaller tax cuts with targeted spending adjustments', score: 0.4 },
      { label: 'Keep current tax and spending levels', score: 0.6 },
      { label: 'Raise taxes on higher earners and expand public programs', score: 0.85 },
    ],
  },
  social: {
    subDimensionPattern: 'immigration',
    prompt: 'What best describes your view on immigration policy?',
    options: [
      { label: 'Tighter limits on immigration and stronger border enforcement', score: 0.15 },
      { label: 'Stricter enforcement of current law with less new immigration', score: 0.35 },
      { label: 'A mix of legal pathways and border enforcement', score: 0.6 },
      { label: 'More legal immigration and pathways to citizenship', score: 0.85 },
    ],
  },
  healthcare: {
    subDimensionPattern: 'coverage',
    prompt: 'What best describes your view on healthcare coverage?',
    options: [
      { label: 'Mostly private, market-based healthcare', score: 0.15 },
      { label: 'Mostly private insurance with a government safety net', score: 0.4 },
      { label: 'A public option available alongside private insurance', score: 0.65 },
      { label: 'A single, government-run healthcare system', score: 0.9 },
    ],
  },
  education: {
    subDimensionPattern: 'school',
    prompt: 'What best describes your view on education policy?',
    options: [
      { label: 'More school choice \u2014 vouchers, charters, homeschool options', score: 0.15 },
      { label: 'Charters and alternatives alongside public schools', score: 0.4 },
      { label: 'Public schools as the main focus, with some choice options', score: 0.65 },
      { label: 'Public schools as the focus, fewer publicly-funded private options', score: 0.9 },
    ],
  },
  environment: {
    subDimensionPattern: 'energy',
    prompt: 'What best describes your view on energy and climate?',
    options: [
      { label: 'Keep producing all energy sources, including oil and gas', score: 0.15 },
      { label: 'Gradual shift to cleaner sources, natural gas as a bridge', score: 0.4 },
      { label: 'Faster move to clean energy, with attention to economic impact', score: 0.65 },
      { label: 'Rapid shift to renewables and tighter emissions limits', score: 0.9 },
    ],
  },
  governance: {
    subDimensionPattern: 'spending',
    prompt: 'What best describes your view on government spending and accountability?',
    options: [
      { label: 'Shrink the size and spending of government', score: 0.15 },
      { label: 'Reduce spending and trim inefficiency', score: 0.4 },
      { label: 'Keep spending roughly where it is, with stronger oversight', score: 0.6 },
      { label: 'Expand public programs and infrastructure spending', score: 0.85 },
    ],
  },
  public_safety: {
    subDimensionPattern: 'gun',
    prompt: 'What best describes your view on gun policy?',
    options: [
      { label: 'Few restrictions on gun ownership', score: 0.2 },
      { label: 'Limited regulations such as background checks', score: 0.5 },
      { label: 'Broader gun regulations and purchase limits', score: 0.8 },
    ],
  },
  infrastructure: {
    subDimensionPattern: 'housing',
    prompt: 'What best describes your view on housing policy?',
    options: [
      { label: 'Let the private market drive housing with fewer regulations', score: 0.15 },
      { label: 'Reduce zoning barriers to allow more private building', score: 0.4 },
      { label: 'A mix of market approaches and public affordable-housing programs', score: 0.6 },
      { label: 'Substantial public investment in affordable housing', score: 0.85 },
    ],
  },
};

// ---------------------------------------------------------------------------
// getPositionQuestions
// ---------------------------------------------------------------------------
// For a given domain, selects the most polarizing sub-dimension (the one with
// the widest ideological range) and generates a calibration question with 3-4
// answer options mapped to 0-1 scores.
//
// If no sub-dimensions exist for the domain, falls back to a hardcoded
// question.
// ---------------------------------------------------------------------------

export function getPositionQuestions(
  domain: Domain,
  subDimensions: SubDimension[],
): PositionQuestion {
  // Filter to sub-dimensions in this domain
  const domainSubs = subDimensions.filter((sd) => sd.domain === domain);

  const fallback = FALLBACK_QUESTIONS[domain];

  if (domainSubs.length === 0) {
    // No sub-dimensions available; use fallback
    return {
      sub_dimension_id: `${domain}_fallback`,
      sub_dimension_name: fallback.subDimensionPattern,
      domain,
      prompt: fallback.prompt,
      options: fallback.options,
    };
  }

  // Try to find a sub-dimension matching the fallback pattern (these are the
  // most polarizing / recognizable issues per domain).
  const preferred = domainSubs.find((sd) =>
    sd.name.toLowerCase().includes(fallback.subDimensionPattern.toLowerCase()),
  );

  // If no match, pick the first sub-dimension by display_order
  const chosen = preferred ?? domainSubs.sort((a, b) => a.display_order - b.display_order)[0];

  // Generate options from the sub-dimension's spectrum labels
  const options = fallback.options.length > 0
    ? fallback.options
    : [
        { label: chosen.spectrum_low, score: 0.15 },
        { label: `Lean toward: ${chosen.spectrum_low}`, score: 0.35 },
        { label: `Lean toward: ${chosen.spectrum_high}`, score: 0.65 },
        { label: chosen.spectrum_high, score: 0.85 },
      ];

  return {
    sub_dimension_id: chosen.id,
    sub_dimension_name: chosen.name,
    domain,
    prompt: fallback.prompt,
    options,
  };
}

// ---------------------------------------------------------------------------
// processQuickMatch
// ---------------------------------------------------------------------------
// Takes the raw answers from the 3-question quick-match flow and produces
// the weight vector and position estimates ready to store on the user record.
// ---------------------------------------------------------------------------

export interface QuickMatchInput {
  domains: Domain[]; // user's top 3 domains, ordered
  positions: { sub_dimension_id: string; score: number }[];
}

export interface QuickMatchOutput {
  weights: Record<string, number>;
  positions: { sub_dimension_id: string; score: number }[];
}

export function processQuickMatch(answers: QuickMatchInput): QuickMatchOutput {
  const quickMatchAnswers = {
    domains: answers.domains,
    positions: answers.positions,
  };

  const weights = deriveWeights(quickMatchAnswers);

  return {
    weights,
    positions: answers.positions,
  };
}
