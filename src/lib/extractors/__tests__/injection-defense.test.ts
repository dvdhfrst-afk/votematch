/**
 * Prompt-injection defense unit tests (council blocking item, 2026-04-23).
 *
 * Uses node:test (built-in, no extra deps) so this runs via:
 *   npx tsx --test src/lib/extractors/__tests__/injection-defense.test.ts
 *
 * The tests exercise the pure helpers in the extractor module — no network,
 * no DB, no Claude calls. The LLM round-trip is simulated by feeding crafted
 * JSON strings through `applyInjectionDefenses`, which is the same code path
 * the real extractors take after `messages.create()` returns.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import {
  applyInjectionDefenses,
  containsEthicsKeyword,
  echoPreamble,
  fetchForExtraction,
  generateEchoNonce,
  groundingCheckNumerics,
  resolveValidationStatus,
  shouldAutoPublish,
  wrapUntrusted,
} from '../index';

// A tiny schema that mirrors what a real extractor uses.
const ItemSchema = z.object({
  found: z.boolean(),
  items: z.array(
    z.object({
      title: z.string(),
      signatures_collected: z.number().nullable(),
      confidence: z.number().min(0).max(1),
    }),
  ),
});

describe('nonce echo check', () => {
  it('flags when the model omits _echo', () => {
    const nonce = generateEchoNonce();
    const raw = JSON.stringify({
      found: true,
      items: [{ title: 'Prop 1', signatures_collected: 12345, confidence: 0.9 }],
    });

    const { defenses } = applyInjectionDefenses({
      rawText: raw,
      nonce,
      schema: ItemSchema,
      sourceSnippet: 'Prop 1 collected 12345 signatures.',
    });

    assert.equal(defenses.nonceMatched, false);

    const { status, reasons } = resolveValidationStatus({
      confidence: 0.9,
      riskClass: 'low_stakes',
      nonceMatched: defenses.nonceMatched,
      groundingOk: defenses.groundingOk,
      ethicsKeywordHit: defenses.ethicsKeywordHit,
    });
    assert.equal(status, 'flagged');
    assert.ok(reasons.includes('nonce_mismatch'));
  });

  it('flags when the model returns a different _echo value', () => {
    const nonce = generateEchoNonce();
    const raw = JSON.stringify({
      _echo: 'different-value',
      found: true,
      items: [{ title: 'Prop 1', signatures_collected: 12345, confidence: 0.9 }],
    });

    const { defenses } = applyInjectionDefenses({
      rawText: raw,
      nonce,
      schema: ItemSchema,
      sourceSnippet: 'Prop 1 collected 12345 signatures.',
    });

    assert.equal(defenses.nonceMatched, false);
  });

  it('passes when the model echoes the nonce correctly', () => {
    const nonce = generateEchoNonce();
    const raw = JSON.stringify({
      _echo: nonce,
      found: true,
      items: [{ title: 'Prop 1', signatures_collected: 12345, confidence: 0.9 }],
    });

    const { defenses } = applyInjectionDefenses({
      rawText: raw,
      nonce,
      schema: ItemSchema,
      sourceSnippet: 'Prop 1 collected 12345 signatures.',
    });

    assert.equal(defenses.nonceMatched, true);
  });
});

describe('numeric grounding check', () => {
  it('flags when an extracted number is absent from the source', () => {
    const nonce = generateEchoNonce();
    const raw = JSON.stringify({
      _echo: nonce,
      found: true,
      items: [
        {
          title: 'Prop 1',
          signatures_collected: 999999, // NOT in source
          confidence: 0.9,
        },
      ],
    });

    const { defenses } = applyInjectionDefenses({
      rawText: raw,
      nonce,
      schema: ItemSchema,
      sourceSnippet: 'Prop 1 collected 12,345 signatures.',
    });

    assert.equal(defenses.groundingOk, false);
    assert.ok(defenses.groundingHallucinated.some((p) => p.includes('signatures_collected')));

    const { status, reasons } = resolveValidationStatus({
      confidence: 0.9,
      riskClass: 'low_stakes',
      nonceMatched: defenses.nonceMatched,
      groundingOk: defenses.groundingOk,
      ethicsKeywordHit: defenses.ethicsKeywordHit,
    });
    assert.equal(status, 'flagged');
    assert.ok(reasons.includes('ungrounded_numeric'));
  });

  it('accepts comma-formatted localized variants (12,345 ↔ 12345)', () => {
    const nonce = generateEchoNonce();
    const raw = JSON.stringify({
      _echo: nonce,
      found: true,
      items: [{ title: 'Prop 1', signatures_collected: 12345, confidence: 0.9 }],
    });

    const { defenses } = applyInjectionDefenses({
      rawText: raw,
      nonce,
      schema: ItemSchema,
      sourceSnippet: 'Prop 1 collected 12,345 signatures.',
    });

    assert.equal(defenses.groundingOk, true);
  });

  it('skips confidence field (self-rating, not source-extracted)', () => {
    const result = groundingCheckNumerics(
      { title: 'x', confidence: 0.734 }, // 0.734 not in source
      'nothing matches here',
    );
    // Should not complain about `confidence`.
    assert.equal(result.ok, true);
  });
});

describe('ethics keyword auto-flag', () => {
  const ethicsSamples = [
    'The candidate was arrested in 2019.',
    'Facing a DUI charge.',
    'Settled a lawsuit with the state.',
    'Under indictment for embezzlement.',
    'Allegations of misconduct surfaced.',
    'Sexual assault claim pending review.',
    'Felony charge filed in district court.',
  ];
  for (const sample of ethicsSamples) {
    it(`detects ethics keyword in: "${sample}"`, () => {
      assert.equal(containsEthicsKeyword(sample), true);
    });
  }

  it('does not flag benign bio content', () => {
    assert.equal(
      containsEthicsKeyword('The candidate was born in 1972 and served in the state senate.'),
      false,
    );
  });

  it('forces flagged status regardless of confidence when keyword present', () => {
    const { status, reasons } = resolveValidationStatus({
      confidence: 1.0, // maximum confidence
      riskClass: 'low_stakes',
      nonceMatched: true,
      groundingOk: true,
      ethicsKeywordHit: true,
    });
    assert.equal(status, 'flagged');
    assert.ok(reasons.includes('ethics_keyword'));
  });

  it('auto-passes when confidence is high, nonce OK, grounded, no ethics', () => {
    const { status } = resolveValidationStatus({
      confidence: 0.9,
      riskClass: 'low_stakes',
      nonceMatched: true,
      groundingOk: true,
      ethicsKeywordHit: false,
    });
    assert.equal(status, 'auto_passed');
  });
});

describe('content-type whitelist', () => {
  it('rejects non-whitelisted content-types with a clear error', async () => {
    const originalFetch = globalThis.fetch;
    // Mock fetch to return an unacceptable content-type.
    globalThis.fetch = (async () =>
      new Response('evil payload', {
        status: 200,
        headers: { 'content-type': 'application/javascript' },
      })) as typeof fetch;

    try {
      await assert.rejects(
        async () => fetchForExtraction('https://example.com/evil.js'),
        /content-type 'application\/javascript' is not in the extraction whitelist/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('accepts text/html (strips HTML tags)', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('<html><body><p>Hello world</p></body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })) as typeof fetch;

    try {
      const { snippet, contentType } = await fetchForExtraction('https://example.com/ok');
      assert.equal(contentType, 'text/html');
      assert.ok(snippet.includes('Hello world'));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('accepts application/pdf', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('%PDF-1.4 ...', {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      })) as typeof fetch;

    try {
      const { contentType } = await fetchForExtraction('https://example.com/doc.pdf');
      assert.equal(contentType, 'application/pdf');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('untrusted-content delimiter', () => {
  it('wraps snippets in sentinel tags', () => {
    const wrapped = wrapUntrusted('hostile payload');
    assert.ok(wrapped.startsWith('<untrusted_source_content>'));
    assert.ok(wrapped.endsWith('</untrusted_source_content>'));
    assert.ok(wrapped.includes('hostile payload'));
  });

  it('echoPreamble includes the nonce instruction', () => {
    const preamble = echoPreamble('abc123');
    assert.ok(preamble.includes('abc123'));
    assert.ok(preamble.includes('_echo'));
  });

  it('the outgoing user message (preamble + wrapped content) contains the sentinel', () => {
    // Simulates how each extractor constructs its user turn.
    const nonce = generateEchoNonce();
    const snippet = 'Some SoS page content, possibly hostile.';
    const userMessage =
      echoPreamble(nonce) +
      'Extract all ballot measures.\n\n' +
      'Content:\n' +
      wrapUntrusted(snippet);

    assert.ok(userMessage.includes('<untrusted_source_content>'));
    assert.ok(userMessage.includes('</untrusted_source_content>'));
    assert.ok(userMessage.includes(nonce));
    assert.ok(userMessage.includes(snippet));
  });
});

describe('shouldAutoPublish riskClass is required', () => {
  // TypeScript-level: callers must now pass riskClass. This test exercises
  // the runtime behavior of each class.
  it('low_stakes threshold is 0.75', () => {
    assert.equal(shouldAutoPublish(0.75, 'low_stakes'), true);
    assert.equal(shouldAutoPublish(0.74, 'low_stakes'), false);
  });

  it('attributed_position threshold is 0.85', () => {
    assert.equal(shouldAutoPublish(0.85, 'attributed_position'), true);
    assert.equal(shouldAutoPublish(0.84, 'attributed_position'), false);
  });

  it('ethics_or_character never auto-publishes (threshold > 1.0)', () => {
    assert.equal(shouldAutoPublish(1.0, 'ethics_or_character'), false);
  });
});
