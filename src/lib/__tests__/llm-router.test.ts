/**
 * LLM router tests — verify the routing decision matrix and fallback behavior.
 *
 * Strategy mirrors injection-defense.test.ts: no network by default. We stub
 * `globalThis.fetch` to simulate the Ollama /api/chat endpoint, and we stub
 * the Anthropic SDK by stashing a fake constructor on the module cache so
 * constructing `new Anthropic()` inside the router yields our mock.
 *
 * We exercise six cases:
 *   1. low_stakes → ollama (single call, no Anthropic mock needed)
 *   2. attributed_position with clean ollama response → ollama only
 *   3. attributed_position with broken ollama response → fall back to Claude
 *   4. ethics_or_character → Claude only, ollama never hit
 *   5. EXTRACTION_BACKEND_OVERRIDE=claude forces Claude even for low_stakes
 *      — verified via `resolveBackend()` against a manually-set override
 *   6. Cost-cap refusal → throws with a clear message
 *
 * Run:
 *   npx tsx --test src/lib/__tests__/llm-router.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import {
  callExtractor,
  resolveBackend,
  _setAnthropicForTests,
  _setCostCapForTests,
  type LlmRouterOptions,
} from '../llm-router';

// Bypass the real cost_caps RPC for every test — individual tests that want
// to exercise cap refusal override this again.
_setCostCapForTests(() => true);

// ---------------------------------------------------------------------------
// Shared schema and helpers
// ---------------------------------------------------------------------------

const ExtractionSchema = z.object({
  found: z.boolean(),
  count: z.number().int().min(0),
});

type FetchMock = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type MessagesCreate = (body: Record<string, unknown>) => Promise<unknown>;

function installOllamaFetchMock(
  responses: Array<string | { status: number; body: string }>,
): { calls: number; restore: () => void } {
  const orig = globalThis.fetch;
  const state = { calls: 0 };
  const mock: FetchMock = async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    // Only intercept ollama; everything else passes through.
    if (!url.includes('/api/chat') && !url.includes('11434')) {
      return (orig as FetchMock)(input);
    }
    const idx = Math.min(state.calls, responses.length - 1);
    const r = responses[idx]!;
    state.calls += 1;
    if (typeof r === 'string') {
      const body = JSON.stringify({
        model: 'phi4:14b',
        created_at: new Date().toISOString(),
        message: { role: 'assistant', content: r },
        done: true,
        total_duration: 1_000_000,
        prompt_eval_count: 100,
        eval_count: 50,
        eval_duration: 500_000,
      });
      return new Response(body, { status: 200 });
    }
    return new Response(r.body, { status: r.status });
  };
  globalThis.fetch = mock as typeof globalThis.fetch;
  return {
    get calls() {
      return state.calls;
    },
    restore: () => {
      globalThis.fetch = orig;
    },
  };
}

/**
 * Inject a fake Anthropic client via the router's test hook. Returns a
 * `callsRef` to inspect invocation count + a `restore` to unregister.
 */
function installAnthropicMock(
  impl: MessagesCreate,
): { callsRef: { n: number }; restore: () => void } {
  const callsRef = { n: 0 };
  _setAnthropicForTests({
    messages: {
      create: async (body: Record<string, unknown>) => {
        callsRef.n += 1;
        return impl(body);
      },
    },
  });
  return {
    callsRef,
    restore: () => {
      _setAnthropicForTests(null);
    },
  };
}

/** Build a valid claude-shaped response for our test schema. */
function fakeClaudeResponse(payload: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    usage: { input_tokens: 120, output_tokens: 30 },
  };
}

// Set a dummy ANTHROPIC_API_KEY so the router's requireRealAnthropicKey passes.
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? 'test-key-for-routing-tests';

// ---------------------------------------------------------------------------
// Test 1 — low_stakes routes to ollama
// ---------------------------------------------------------------------------

describe('low_stakes routing', () => {
  it('routes to ollama when backend=auto and riskClass=low_stakes', async () => {
    const ollama = installOllamaFetchMock([
      JSON.stringify({ found: true, count: 3 }),
    ]);
    const anthro = installAnthropicMock(async () => {
      throw new Error('Claude should NOT be called for low_stakes');
    });
    try {
      const opts: LlmRouterOptions<{ found: boolean; count: number }> = {
        riskClass: 'low_stakes',
        systemPrompt: 'sys',
        userMessage: 'usr',
        schema: ExtractionSchema,
      };
      const res = await callExtractor(opts);
      assert.equal(res.backend, 'ollama');
      assert.equal(res.parsed.count, 3);
      assert.equal(res.costUsd, 0);
      assert.equal(anthro.callsRef.n, 0, 'Claude should not have been called');
      assert.equal(ollama.calls, 1);
    } finally {
      ollama.restore();
      anthro.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Test 2 — attributed_position with clean ollama response
// ---------------------------------------------------------------------------

describe('attributed_position — clean ollama path', () => {
  it('returns ollama result without calling Claude', async () => {
    const ollama = installOllamaFetchMock([
      JSON.stringify({ found: true, count: 7 }),
    ]);
    const anthro = installAnthropicMock(async () => {
      throw new Error('Claude should NOT be called when ollama succeeded');
    });
    try {
      const res = await callExtractor({
        riskClass: 'attributed_position',
        systemPrompt: 'sys',
        userMessage: 'usr',
        schema: ExtractionSchema,
      });
      assert.equal(res.backend, 'ollama');
      assert.equal(res.fellBackToClaude, undefined);
      assert.equal(anthro.callsRef.n, 0);
      assert.equal(ollama.calls, 1);
    } finally {
      ollama.restore();
      anthro.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Test 3 — attributed_position with broken ollama response → falls back to Claude
// ---------------------------------------------------------------------------

describe('attributed_position — fallback on ollama failure', () => {
  it('falls back to Claude when ollama returns an invalid schema', async () => {
    const ollama = installOllamaFetchMock([
      // Shape is wrong: `count` is a string, not a number. schema.parse() throws.
      JSON.stringify({ found: true, count: 'three' }),
    ]);
    const anthro = installAnthropicMock(async () =>
      fakeClaudeResponse({ found: true, count: 3 }),
    );
    try {
      const res = await callExtractor({
        riskClass: 'attributed_position',
        systemPrompt: 'sys',
        userMessage: 'usr',
        schema: ExtractionSchema,
      });
      assert.equal(res.backend, 'claude');
      assert.equal(res.fellBackToClaude, true);
      assert.equal(res.parsed.count, 3);
      assert.equal(ollama.calls, 1, 'ollama attempted once');
      assert.equal(anthro.callsRef.n, 1, 'Claude attempted once as fallback');
    } finally {
      ollama.restore();
      anthro.restore();
    }
  });

  it('falls back when a caller postValidate callback rejects the ollama response', async () => {
    const ollama = installOllamaFetchMock([
      // Schema-valid, but postValidate rejects on the ollama-shaped response.
      JSON.stringify({ found: true, count: 3 }),
    ]);
    const anthro = installAnthropicMock(async () =>
      fakeClaudeResponse({ found: true, count: 99 }),
    );
    try {
      // postValidate rejects the ollama response (count=3) but accepts the
      // claude response (count=99). This matches the real extractor pattern
      // where the nonce-echo is the postValidate check — ollama missed the
      // nonce, claude echoed it correctly.
      const res = await callExtractor({
        riskClass: 'attributed_position',
        systemPrompt: 'sys',
        userMessage: 'usr',
        schema: ExtractionSchema,
        postValidate: (_raw, parsed) => {
          if ((parsed as { count: number }).count === 3) {
            return { ok: false, reason: 'nonce_mismatch' };
          }
          return { ok: true };
        },
      });
      assert.equal(res.backend, 'claude');
      assert.equal(res.fellBackToClaude, true);
      assert.equal(res.parsed.count, 99);
    } finally {
      ollama.restore();
      anthro.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Test 4 — ethics_or_character always routes to Claude
// ---------------------------------------------------------------------------

describe('ethics_or_character routing', () => {
  it('routes to Claude and never touches ollama', async () => {
    const ollama = installOllamaFetchMock([
      // We expect this to never be reached. If ollama.calls > 0 the test fails.
      JSON.stringify({ found: true, count: 1 }),
    ]);
    const anthro = installAnthropicMock(async () =>
      fakeClaudeResponse({ found: false, count: 0 }),
    );
    try {
      const res = await callExtractor({
        riskClass: 'ethics_or_character',
        systemPrompt: 'sys',
        userMessage: 'usr',
        schema: ExtractionSchema,
      });
      assert.equal(res.backend, 'claude');
      assert.equal(ollama.calls, 0, 'ollama must not be invoked for ethics_or_character');
      assert.equal(anthro.callsRef.n, 1);
    } finally {
      ollama.restore();
      anthro.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Test 5 — resolveBackend respects the routing matrix (covers env override path)
// ---------------------------------------------------------------------------

describe('resolveBackend matrix', () => {
  it('returns ollama for low_stakes under auto', () => {
    assert.equal(resolveBackend('low_stakes'), 'ollama');
    assert.equal(resolveBackend('low_stakes', 'auto'), 'ollama');
  });
  it('returns ollama for attributed_position under auto (first try)', () => {
    assert.equal(resolveBackend('attributed_position'), 'ollama');
  });
  it('returns claude for ethics_or_character under auto', () => {
    assert.equal(resolveBackend('ethics_or_character'), 'claude');
  });
  it('honors explicit claude override', () => {
    assert.equal(resolveBackend('low_stakes', 'claude'), 'claude');
  });
  it('honors explicit ollama override', () => {
    assert.equal(resolveBackend('ethics_or_character', 'ollama'), 'ollama');
  });
});

// Note: EXTRACTION_BACKEND_OVERRIDE is captured at module load. Testing that
// path requires spawning a subprocess with the env set, which we avoid here.
// The resolveBackend() unit tests above cover the logic; the env branch is
// a single-line guard at module init.

// ---------------------------------------------------------------------------
// Test 6 — Cost cap refusal
// ---------------------------------------------------------------------------

describe('cost cap refusal', () => {
  it('surfaces a clear error when the cap check refuses', async () => {
    // Override cost-cap to refuse for claude_api specifically.
    _setCostCapForTests((service) => service !== 'claude_api');

    const ollama = installOllamaFetchMock([
      JSON.stringify({ found: true, count: 3 }),
    ]);
    const anthro = installAnthropicMock(async () =>
      fakeClaudeResponse({ found: true, count: 3 }),
    );

    try {
      await assert.rejects(
        () =>
          callExtractor({
            riskClass: 'ethics_or_character', // forces Claude path
            systemPrompt: 'sys',
            userMessage: 'usr',
            schema: ExtractionSchema,
          }),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.match(err.message, /Cost cap exceeded.*claude_api/);
          return true;
        },
      );
    } finally {
      ollama.restore();
      anthro.restore();
      // Restore pass-through for the remaining tests.
      _setCostCapForTests(() => true);
    }
  });

  it('refuses ollama calls when the local cap is set to zero by override', async () => {
    _setCostCapForTests((service) => service !== 'ollama_local');
    const ollama = installOllamaFetchMock([
      JSON.stringify({ found: true, count: 3 }),
    ]);
    const anthro = installAnthropicMock(async () =>
      fakeClaudeResponse({ found: true, count: 1 }),
    );
    try {
      // low_stakes would route to ollama — the cap refusal should throw.
      await assert.rejects(
        () =>
          callExtractor({
            riskClass: 'low_stakes',
            systemPrompt: 'sys',
            userMessage: 'usr',
            schema: ExtractionSchema,
          }),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.match(err.message, /Cost cap exceeded.*ollama_local/);
          return true;
        },
      );
    } finally {
      ollama.restore();
      anthro.restore();
      _setCostCapForTests(() => true);
    }
  });
});
