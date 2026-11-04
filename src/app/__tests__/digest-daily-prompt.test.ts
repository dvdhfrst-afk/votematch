/**
 * Digest question-of-the-week block tests (work-order Phase 2B).
 *
 * The email carries a POINTER to the on-device guide and NEVER an opinion. These
 * tests assert the block renders, links to /guide?prompt=1, and that the digest
 * body contains no opinion/answer payload.
 *
 * digest.ts imports the Supabase server client (which pulls next/headers), so we
 * mock that module before importing the system under test - the render helpers
 * we exercise are pure and never call it.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
  createClient: vi.fn(),
}));

import { renderDailyPromptItem, renderDigestHtml } from '@/lib/retention/digest';

describe('renderDailyPromptItem (email pointer)', () => {
  it('renders a pointer block linking to the on-device guide prompt', () => {
    const html = renderDailyPromptItem('weekly');
    expect(html).toContain('/guide?prompt=1');
    expect(html.toLowerCase()).toContain('weekly');
    expect(html).toContain('saved only on your device');
  });

  it('never contains an opinion score or answer payload', () => {
    const html = renderDailyPromptItem('weekly');
    // No stance scores, no sub_dimension ids, no answer JSON.
    expect(html).not.toMatch(/"score"/);
    expect(html).not.toMatch(/sub_dimension/i);
  });
});

describe('renderDigestHtml includes the standing prompt block', () => {
  it('injects the question-of-the-week pointer even for a quiet period', () => {
    const { html } = renderDigestHtml({
      subscriberId: 'sub-1',
      state: 'AZ',
      items: [],
      period: 'weekly',
    });
    expect(html).toContain('/guide?prompt=1');
    expect(html).toContain('question is waiting');
  });

  it('carries no opinion bytes in the assembled digest', () => {
    const { html } = renderDigestHtml({
      subscriberId: 'sub-1',
      state: 'AZ',
      items: [],
      period: 'weekly',
    });
    expect(html).not.toMatch(/"answers"/);
    expect(html).not.toMatch(/stance_vector/i);
  });
});
