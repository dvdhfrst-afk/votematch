/**
 * Smoke tests for the API-mode fallback path.
 *
 * Tests the parsing layer with a mocked Anthropic client — verifies the
 * wiring works without making any real API calls (the account is exhausted
 * and we should never depend on it in CI anyway).
 *
 * Per notes/ballot-bridge-execution-order.md Week 3 item 14, the brief
 * says "smoke-tested once, then dormant." These are the smoke tests.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  runViaApi,
  extractJsonBlock,
  looksLikeAgentResult,
  isApiFallbackEnabled,
} from '../api-fallback';
import type { AgentResult } from '../types';

// ---------------------------------------------------------------------------
// extractJsonBlock — pulls JSON from various wrapper formats
// ---------------------------------------------------------------------------

describe('extractJsonBlock', () => {
  it('extracts JSON from a ```json fenced block', () => {
    const text = 'Here is the result:\n```json\n{"body":{"a":1}}\n```\nDone.';
    expect(extractJsonBlock(text)).toBe('{"body":{"a":1}}');
  });

  it('extracts JSON from a plain fenced block (no language tag)', () => {
    const text = '```\n{"body":{"a":1}}\n```';
    expect(extractJsonBlock(text)).toBe('{"body":{"a":1}}');
  });

  it('extracts the first balanced JSON object when no fences are used', () => {
    const text = 'Some prose first.\n{"body":{"a":1,"b":{"c":2}}}\nAnd more prose.';
    expect(extractJsonBlock(text)).toBe('{"body":{"a":1,"b":{"c":2}}}');
  });

  it('returns null when there is no JSON object', () => {
    expect(extractJsonBlock('Just prose. No JSON.')).toBeNull();
  });

  it('handles deeply nested braces correctly', () => {
    const text = '{"a":{"b":{"c":{"d":1}}}}';
    expect(extractJsonBlock(text)).toBe(text);
  });
});

// ---------------------------------------------------------------------------
// looksLikeAgentResult — structural validation
// ---------------------------------------------------------------------------

describe('looksLikeAgentResult', () => {
  it('accepts the minimum valid shape', () => {
    expect(
      looksLikeAgentResult({
        body: {},
        seats: [],
        citations: [],
        authoritative: false,
      }),
    ).toBe(true);
  });

  it('rejects when body is missing', () => {
    expect(
      looksLikeAgentResult({ seats: [], citations: [], authoritative: false }),
    ).toBe(false);
  });

  it('rejects when seats is not an array', () => {
    expect(
      looksLikeAgentResult({
        body: {},
        seats: 'three',
        citations: [],
        authoritative: false,
      }),
    ).toBe(false);
  });

  it('rejects when authoritative is missing', () => {
    expect(
      looksLikeAgentResult({ body: {}, seats: [], citations: [] }),
    ).toBe(false);
  });

  it('rejects null and primitives', () => {
    expect(looksLikeAgentResult(null)).toBe(false);
    expect(looksLikeAgentResult('a string')).toBe(false);
    expect(looksLikeAgentResult(42)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runViaApi — end-to-end with a mocked Anthropic client
// ---------------------------------------------------------------------------

function makeMockClient(text: string, usage = { input_tokens: 100, output_tokens: 50 }) {
  return {
    messages: {
      create: async () => ({
        content: [{ type: 'text' as const, text }],
        usage,
        // Other fields the real response has — we don't use them
        id: 'msg_mock', type: 'message', role: 'assistant', model: 'mock',
        stop_reason: 'end_turn', stop_sequence: null,
      }),
    },
  };
}

describe('runViaApi', () => {
  it('parses a clean JSON response into an AgentResult', async () => {
    const fakeAgentResult: AgentResult = {
      body: { canonical_name: 'US Senate' } as AgentResult['body'],
      seats: [],
      citations: [{ url: 'https://senate.gov', title: 'US Senate', accessed_at: '2026-05-26' } as AgentResult['citations'][0]],
      authoritative: true, // model claims authoritative — we should override to false
    };

    const out = await runViaApi(
      { prompt: 'research this body' },
      () => makeMockClient(JSON.stringify(fakeAgentResult)) as never,
    );

    expect(out.parsed).toBe(true);
    expect(out.result).not.toBeNull();
    // SAFETY OVERRIDE: authoritative MUST be forced false by the fallback,
    // regardless of what the model said.
    expect(out.result!.authoritative).toBe(false);
    expect(out.result!.notes).toMatch(/api-fallback/);
    expect(out.usage.output_tokens).toBe(50);
  });

  it('parses JSON wrapped in a ```json fence', async () => {
    const wrapped = '```json\n{"body":{},"seats":[],"citations":[],"authoritative":false}\n```';
    const out = await runViaApi(
      { prompt: 'x' },
      () => makeMockClient(wrapped) as never,
    );
    expect(out.parsed).toBe(true);
    expect(out.result!.authoritative).toBe(false);
  });

  it('returns parsed=false with reason when no JSON is present', async () => {
    const out = await runViaApi(
      { prompt: 'x' },
      () => makeMockClient('I refuse to answer this question.') as never,
    );
    expect(out.parsed).toBe(false);
    expect(out.parseError).toBe('no_json_block_found');
    expect(out.result).toBeNull();
  });

  it('returns parsed=false on shape mismatch', async () => {
    // Valid JSON, wrong shape (missing seats array)
    const wrong = '{"body":{},"authoritative":true}';
    const out = await runViaApi(
      { prompt: 'x' },
      () => makeMockClient(wrong) as never,
    );
    expect(out.parsed).toBe(false);
    expect(out.parseError).toBe('shape_mismatch_not_agent_result');
  });

  it('returns parsed=false on malformed JSON', async () => {
    // Unclosed brace — extractJsonBlock returns null (no balanced object),
    // so we get no_json_block_found rather than a JSON parse error.
    const out = await runViaApi(
      { prompt: 'x' },
      () => makeMockClient('{"unclosed') as never,
    );
    expect(out.parsed).toBe(false);
    expect(out.parseError).toBe('no_json_block_found');
  });

  it('returns parsed=false on syntactically-broken JSON inside braces', async () => {
    // Balanced braces but invalid syntax inside (trailing comma).
    const out = await runViaApi(
      { prompt: 'x' },
      () => makeMockClient('{"body":{},"seats":[],"citations":[],"authoritative":false,}') as never,
    );
    expect(out.parsed).toBe(false);
    expect(out.parseError).toMatch(/json_parse_error/);
  });
});

// ---------------------------------------------------------------------------
// isApiFallbackEnabled — env var honored
// ---------------------------------------------------------------------------

describe('isApiFallbackEnabled', () => {
  const originalEnv = process.env.BB_RESEARCH_USE_API_FALLBACK;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.BB_RESEARCH_USE_API_FALLBACK;
    } else {
      process.env.BB_RESEARCH_USE_API_FALLBACK = originalEnv;
    }
  });

  it('returns true when env var is exactly "true"', () => {
    process.env.BB_RESEARCH_USE_API_FALLBACK = 'true';
    expect(isApiFallbackEnabled()).toBe(true);
  });

  it('returns false when env var is "false"', () => {
    process.env.BB_RESEARCH_USE_API_FALLBACK = 'false';
    expect(isApiFallbackEnabled()).toBe(false);
  });

  it('returns false when env var is unset', () => {
    delete process.env.BB_RESEARCH_USE_API_FALLBACK;
    expect(isApiFallbackEnabled()).toBe(false);
  });

  it('returns false on any non-"true" string (no fuzzy match)', () => {
    process.env.BB_RESEARCH_USE_API_FALLBACK = '1';
    expect(isApiFallbackEnabled()).toBe(false);
    process.env.BB_RESEARCH_USE_API_FALLBACK = 'yes';
    expect(isApiFallbackEnabled()).toBe(false);
  });
});
