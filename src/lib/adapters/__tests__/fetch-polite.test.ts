/**
 * Tests for politeFetch: identifying User-Agent, headers and rate limiting.
 *
 * Run:
 *   npx tsx --test src/lib/adapters/__tests__/fetch-polite.test.ts
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  politeFetch,
  POLITE_USER_AGENT,
  __setSupabaseClient,
  __clearPoliteFetchState,
} from '../fetch-polite';

// ---------------------------------------------------------------------------
// Fetch stub
// ---------------------------------------------------------------------------

type FetchCall = {
  url: string;
  init: RequestInit | undefined;
  firedAt: number;
};

function installFetchStub(options: {
  status?: number;
  body?: string;
}): { calls: FetchCall[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: FetchCall[] = [];
  const stub = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init, firedAt: Date.now() });
    return new Response(options.body ?? 'ok', {
      status: options.status ?? 200,
      headers: { 'content-type': 'text/plain' },
    });
  };
  globalThis.fetch = stub as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function headersToRecord(init: RequestInit | undefined): Record<string, string> {
  const h = init?.headers;
  if (!h) return {};
  const out: Record<string, string> = {};
  if (h instanceof Headers) {
    h.forEach((v, k) => (out[k.toLowerCase()] = v));
    return out;
  }
  if (Array.isArray(h)) {
    for (const [k, v] of h) out[k.toLowerCase()] = v;
    return out;
  }
  for (const [k, v] of Object.entries(h)) {
    if (typeof v === 'string') out[k.toLowerCase()] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

describe('POLITE_USER_AGENT', () => {
  it('is a single identifying bot UA with a contact URL', () => {
    assert.match(POLITE_USER_AGENT, /^HavesayBot\/\d+\.\d+ \(\+https:\/\/[^)]+\)$/);
    assert.ok(!POLITE_USER_AGENT.includes('Mozilla'), 'must not impersonate a browser');
  });
});

describe('politeFetch — default headers', () => {
  beforeEach(() => {
    __clearPoliteFetchState();
    __setSupabaseClient(null);
  });

  afterEach(() => {
    __clearPoliteFetchState();
  });

  it('sets the identifying UA and plain headers on every call', async () => {
    const stub = installFetchStub({});
    try {
      await politeFetch('https://example.com/path', { minIntervalMs: 0 });
      const h = headersToRecord(stub.calls[0]?.init);

      assert.equal(h['user-agent'], POLITE_USER_AGENT);
      assert.ok(
        (h['accept'] ?? '').includes('text/html'),
        `accept missing text/html: ${h['accept']}`,
      );
      assert.equal(h['accept-language'], 'en-US,en;q=0.9');
      assert.equal(h['sec-fetch-site'], undefined);
      assert.equal(h['referer'], undefined);
    } finally {
      stub.restore();
    }
  });
});

describe('politeFetch — caller headers override defaults', () => {
  beforeEach(() => {
    __clearPoliteFetchState();
    __setSupabaseClient(null);
  });

  afterEach(() => {
    __clearPoliteFetchState();
  });

  it('lets the caller override Accept', async () => {
    const stub = installFetchStub({});
    try {
      await politeFetch('https://example.com/', {
        minIntervalMs: 0,
        headers: { Accept: 'application/xml' },
      });
      const h = headersToRecord(stub.calls[0]?.init);
      assert.equal(h['accept'], 'application/xml');
      // UA stays the identifying default
      assert.equal(h['user-agent'], POLITE_USER_AGENT);
    } finally {
      stub.restore();
    }
  });

  it('lets the caller set a custom User-Agent', async () => {
    const stub = installFetchStub({});
    try {
      await politeFetch('https://example.com/', {
        minIntervalMs: 0,
        headers: { 'User-Agent': 'MyBot/9.9' },
      });
      const h = headersToRecord(stub.calls[0]?.init);
      assert.equal(h['user-agent'], 'MyBot/9.9');
    } finally {
      stub.restore();
    }
  });

  it('honors headers passed as a Headers object', async () => {
    const stub = installFetchStub({});
    try {
      const hdrs = new Headers();
      hdrs.set('X-Custom-Token', 'abc123');
      hdrs.set('Accept', 'application/json');
      await politeFetch('https://example.com/', {
        minIntervalMs: 0,
        headers: hdrs,
      });
      const h = headersToRecord(stub.calls[0]?.init);
      assert.equal(h['x-custom-token'], 'abc123');
      assert.equal(h['accept'], 'application/json');
    } finally {
      stub.restore();
    }
  });
});

describe('politeFetch — per-host rate limit', () => {
  beforeEach(() => {
    __clearPoliteFetchState();
    __setSupabaseClient(null);
  });

  afterEach(() => {
    __clearPoliteFetchState();
  });

  it('throttles same-host sequential calls', async () => {
    const stub = installFetchStub({});
    try {
      const start = Date.now();
      await politeFetch('https://slow.example.com/a', { minIntervalMs: 100 });
      await politeFetch('https://slow.example.com/b', { minIntervalMs: 100 });
      await politeFetch('https://slow.example.com/c', { minIntervalMs: 100 });
      const elapsed = Date.now() - start;
      // Two waits of ~100ms after the first call.
      assert.ok(elapsed >= 180, `expected >=180ms, got ${elapsed}ms`);
      assert.equal(stub.calls.length, 3);
    } finally {
      stub.restore();
    }
  });

  it('does NOT throttle across different hosts', async () => {
    const stub = installFetchStub({});
    try {
      const start = Date.now();
      await politeFetch('https://a.example.com/', { minIntervalMs: 500 });
      await politeFetch('https://b.example.com/', { minIntervalMs: 500 });
      await politeFetch('https://c.example.com/', { minIntervalMs: 500 });
      const elapsed = Date.now() - start;
      assert.ok(elapsed < 400, `different hosts should not throttle each other, got ${elapsed}ms`);
      assert.equal(stub.calls.length, 3);
    } finally {
      stub.restore();
    }
  });

  it('minIntervalMs=0 bypasses throttling', async () => {
    const stub = installFetchStub({});
    try {
      const start = Date.now();
      for (let i = 0; i < 5; i++) {
        await politeFetch('https://fast.example.com/', { minIntervalMs: 0 });
      }
      const elapsed = Date.now() - start;
      assert.ok(elapsed < 100, `expected near-instant (<100ms), got ${elapsed}ms`);
    } finally {
      stub.restore();
    }
  });
});

describe('politeFetch — passthrough semantics', () => {
  beforeEach(() => {
    __clearPoliteFetchState();
    __setSupabaseClient(null);
  });

  afterEach(() => {
    __clearPoliteFetchState();
  });

  it('returns a standard Response', async () => {
    const stub = installFetchStub({ status: 418, body: 'teapot' });
    try {
      const res = await politeFetch('https://example.com/', { minIntervalMs: 0 });
      assert.equal(res.status, 418);
      assert.equal(await res.text(), 'teapot');
    } finally {
      stub.restore();
    }
  });

  it('does NOT retry on 5xx — surfaces the response as-is', async () => {
    const stub = installFetchStub({ status: 503, body: 'unavailable' });
    try {
      const res = await politeFetch('https://example.com/', { minIntervalMs: 0 });
      assert.equal(res.status, 503);
      // Exactly one fetch — no retry.
      assert.equal(stub.calls.length, 1);
    } finally {
      stub.restore();
    }
  });

  it('does NOT retry on 403 — returns the refusal to the caller', async () => {
    const stub = installFetchStub({ status: 403, body: 'forbidden' });
    try {
      const res = await politeFetch('https://example.com/', { minIntervalMs: 0 });
      assert.equal(res.status, 403);
      assert.equal(stub.calls.length, 1);
    } finally {
      stub.restore();
    }
  });

  it('forwards method and body through to fetch', async () => {
    const stub = installFetchStub({});
    try {
      await politeFetch('https://example.com/post', {
        minIntervalMs: 0,
        method: 'POST',
        body: 'payload',
      });
      assert.equal(stub.calls[0]?.init?.method, 'POST');
      assert.equal(stub.calls[0]?.init?.body, 'payload');
    } finally {
      stub.restore();
    }
  });
});
