/**
 * Handoff codec tests (Booth Mode embed->phone transfer, V2 pillar 5b).
 *
 * The codec is the one piece of new logic with real correctness risk: it carries
 * the voter's opinions across devices inside a URL fragment, so a round-trip must
 * be exact, a corrupt payload must fail closed (never fabricate an answer), and
 * the size guard must protect QR scannability.
 */

import { describe, it, expect } from 'vitest';
import type { Domain } from '@/types/database';
import {
  decodeHandoff,
  encodeHandoff,
  handoffChosenDomains,
  HANDOFF_MAX_ENCODED,
  type HandoffAnswer,
} from '../handoff';

function ans(
  issueId: string,
  choice: 'agree' | 'disagree',
  important: boolean,
  domain: Domain,
): HandoffAnswer {
  return { issueId, choice, important, domain };
}

describe('handoff codec', () => {
  it('round-trips answers exactly', () => {
    const answers: HandoffAnswer[] = [
      ans('11111111-1111-1111-1111-111111111111', 'agree', true, 'economy'),
      ans('22222222-2222-2222-2222-222222222222', 'disagree', false, 'education'),
      ans('33333333-3333-3333-3333-333333333333', 'agree', false, 'infrastructure'),
    ];
    const encoded = encodeHandoff(answers);
    expect(encoded).not.toBeNull();
    const decoded = decodeHandoff(encoded);
    expect(decoded).toEqual(answers);
  });

  it('drops skip answers before encoding (only agree/disagree travel)', () => {
    const answers = [
      ans('a', 'agree', false, 'social'),
      { issueId: 'b', choice: 'skip', important: false, domain: 'social' } as unknown as HandoffAnswer,
    ];
    const decoded = decodeHandoff(encodeHandoff(answers));
    expect(decoded).toEqual([ans('a', 'agree', false, 'social')]);
  });

  it('returns null for an empty answer set', () => {
    expect(encodeHandoff([])).toBeNull();
  });

  it('fails closed on garbage / wrong version (never throws, never fabricates)', () => {
    expect(decodeHandoff(null)).toBeNull();
    expect(decodeHandoff('')).toBeNull();
    expect(decodeHandoff('not-base64!!')).toBeNull();
    expect(decodeHandoff('h9garbage')).toBeNull();
    expect(decodeHandoff('h1' + 'zzzz')).toBeNull();
  });

  it('produces a URL-fragment-safe value (no +, /, =, or #)', () => {
    const encoded = encodeHandoff([ans('x'.repeat(40), 'agree', true, 'governance')]);
    expect(encoded).toMatch(/^h1[A-Za-z0-9\-_]+$/);
  });

  it('returns null when the payload would exceed the QR size guard', () => {
    const many: HandoffAnswer[] = Array.from({ length: 400 }, (_, i) =>
      ans(`issue-${i}-${'u'.repeat(36)}`, 'agree', true, 'economy'),
    );
    const encoded = encodeHandoff(many);
    expect(encoded).toBeNull();
  });

  it('stays within the size guard for a realistic 20-card ballot', () => {
    const twenty: HandoffAnswer[] = Array.from({ length: 20 }, (_, i) =>
      ans(`${i}0000000-0000-4000-8000-000000000000`, i % 2 ? 'agree' : 'disagree', i % 3 === 0, 'healthcare'),
    );
    const encoded = encodeHandoff(twenty);
    expect(encoded).not.toBeNull();
    expect((encoded as string).length).toBeLessThanOrEqual(HANDOFF_MAX_ENCODED);
  });

  it('derives top-3 emphasis domains from importance stars', () => {
    const answers: HandoffAnswer[] = [
      ans('a', 'agree', true, 'economy'),
      ans('b', 'agree', true, 'economy'),
      ans('c', 'agree', true, 'education'),
      ans('d', 'agree', true, 'environment'),
      ans('e', 'agree', true, 'social'),
      ans('f', 'disagree', false, 'governance'),
    ];
    const chosen = handoffChosenDomains(answers);
    expect(chosen[0]).toBe('economy'); // starred twice -> ranks first
    expect(chosen).toHaveLength(3);
    expect(chosen).not.toContain('governance'); // never starred
  });
});
