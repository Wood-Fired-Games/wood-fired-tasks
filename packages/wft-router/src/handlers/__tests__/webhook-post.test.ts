/**
 * Tests for the wft-router `webhook_post` handler (task #429).
 *
 * Coverage per the task's acceptance criteria:
 *   - HTTPS HAPPY PATH:        2xx over https → SUCCEEDED, { succeeded }, POST fired.
 *   - HTTP NON-LOOPBACK REFUSAL: http:// to a routable host → refused, no POST,
 *                               PERMANENTLY_FAILED, retryable:false.
 *   - LOOPBACK HTTP ALLOWED:   http://127.0.0.1 (and ::1 / localhost / RFC1918)
 *                               → allowed, POST fired.
 *   - TIMEOUT:                 fetch that never resolves → retryable timeout.
 *   - IDEMPOTENT REPLAY:       a second call suppresses the POST entirely.
 *
 * Plus supporting cases: header/body forwarding, 4xx/5xx mapping, network
 * error, missing url, and the pure `assertEndpointAllowed` posture table.
 *
 * A REAL in-memory `IdempotencyStore` (`:memory:`) exercises the
 * PENDING→terminal protocol end-to-end; only the HTTP surface is faked via
 * `fetchImpl`, mirroring `create-task-in-project.test.ts` / `sse-client.test.ts`.
 *
 * Example hostnames use reserved / documentation ranges (TEST-NET-3
 * `203.0.113.0/24`, `example.com`) and are vendor-neutral.
 */

import { describe, expect, it, vi } from 'vitest';

import { IdempotencyStore, type DispatchStatus } from '../../dispatch/index.js';
import type { EventPayloadShape } from '../../dispatch/index.js';
import { assertEndpointAllowed, webhookPost } from '../webhook-post.js';
import type { HandlerContext, HandlerLogger } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function silentLogger(): HandlerLogger {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

function makeStore(): IdempotencyStore {
  return new IdempotencyStore({ dbPath: ':memory:' });
}

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

/** Recording fetch fake — fixed status/body, records every call's wire shape. */
function recordingFetch(
  status: number,
  responseBody = '{}',
): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl = ((url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    const headers: Record<string, string> = {};
    const h = init?.headers;
    if (h instanceof Headers) {
      h.forEach((v, k) => {
        headers[k] = v;
      });
    } else if (Array.isArray(h)) {
      for (const [k, v] of h) headers[k] = v;
    } else if (h && typeof h === 'object') {
      for (const [k, v] of Object.entries(h as Record<string, string>)) headers[k] = v;
    }
    calls.push({
      url: urlStr,
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    return Promise.resolve(new Response(responseBody, { status }));
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** Build a base context. Caller overrides store / fetchImpl / payload. */
function baseContext(over: Partial<HandlerContext> = {}): HandlerContext {
  const event: EventPayloadShape = {
    type: 'task.created',
    task: { id: 42, project_id: 7, project_slug: 'demo', status: 'open' },
  };
  return {
    store: over.store ?? makeStore(),
    logger: over.logger ?? silentLogger(),
    event: over.event ?? event,
    identity: over.identity ?? {
      rule_name: 'rule-A',
      event_id: 'evt-1',
      task_id: 42,
      to_status: 'open',
      emitted_at_ms: 1_700_000_000_000,
    },
    withBlock:
      'withBlock' in over
        ? over.withBlock
        : { url: 'https://hooks.example.com/in', body: { text: 'hi' } },
    renderedWith: over.renderedWith,
    apiBaseUrl: over.apiBaseUrl ?? 'https://tasks.example.com',
    authToken: over.authToken ?? 'wft_pat_abc123',
    timeoutMs: over.timeoutMs,
    fetchImpl: over.fetchImpl,
  };
}

/** Observe the terminal status of a (rule, event) row via a second claim. */
function statusOf(
  store: IdempotencyStore,
  ruleName: string,
  eventId: string,
): DispatchStatus | undefined {
  const res = store.claim({
    rule_name: ruleName,
    event_id: eventId,
    rendered_with_json: '{}',
    task_id: null,
    to_status: null,
    emitted_at_ms: null,
  });
  if (res.kind === 'ALREADY_DONE') return res.status;
  if (res.kind === 'ALREADY_PENDING') return 'PENDING';
  return undefined;
}

// ---------------------------------------------------------------------------
// assertEndpointAllowed — pure posture table
// ---------------------------------------------------------------------------

describe('assertEndpointAllowed', () => {
  it('always allows https:// regardless of host', () => {
    expect(assertEndpointAllowed('https://example.com/in').allowed).toBe(true);
    expect(assertEndpointAllowed('https://203.0.113.10/in').allowed).toBe(true);
    expect(assertEndpointAllowed('https://127.0.0.1:8443/in').allowed).toBe(true);
  });

  it('allows http:// to loopback hosts', () => {
    expect(assertEndpointAllowed('http://127.0.0.1:9000/in').allowed).toBe(true);
    expect(assertEndpointAllowed('http://localhost/in').allowed).toBe(true);
    expect(assertEndpointAllowed('http://[::1]:9000/in').allowed).toBe(true);
    expect(assertEndpointAllowed('http://127.5.5.5/in').allowed).toBe(true);
  });

  it('allows http:// to RFC1918 / link-local / ULA private hosts', () => {
    expect(assertEndpointAllowed('http://10.1.2.3/in').allowed).toBe(true);
    expect(assertEndpointAllowed('http://172.16.0.1/in').allowed).toBe(true);
    expect(assertEndpointAllowed('http://172.31.255.255/in').allowed).toBe(true);
    expect(assertEndpointAllowed('http://192.168.1.1/in').allowed).toBe(true);
    expect(assertEndpointAllowed('http://169.254.1.1/in').allowed).toBe(true);
    expect(assertEndpointAllowed('http://[fd00::1]/in').allowed).toBe(true);
  });

  it('refuses http:// to routable hosts (credential-exposure guard)', () => {
    const d = assertEndpointAllowed('http://example.com/in');
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain('credential-exposure');
    expect(assertEndpointAllowed('http://203.0.113.10/in').allowed).toBe(false);
    expect(assertEndpointAllowed('http://172.32.0.1/in').allowed).toBe(false); // outside /12
    expect(assertEndpointAllowed('http://8.8.8.8/in').allowed).toBe(false);
  });

  it('refuses unparseable URLs and non-http(s) schemes', () => {
    expect(assertEndpointAllowed('not a url').allowed).toBe(false);
    expect(assertEndpointAllowed('ftp://example.com/in').allowed).toBe(false);
    expect(assertEndpointAllowed('file:///etc/passwd').allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// webhookPost handler
// ---------------------------------------------------------------------------

describe('webhookPost', () => {
  it('HTTPS HAPPY PATH: 2xx → succeeded, SUCCEEDED row, POST fired with body + headers', async () => {
    const store = makeStore();
    const { fetchImpl, calls } = recordingFetch(200, '{"ok":true}');
    const ctx = baseContext({
      store,
      fetchImpl,
      withBlock: {
        url: 'https://hooks.example.com/in',
        headers: { authorization: 'Bearer s3cret', 'X-Trace': 'abc' },
        body: { text: 'hello' },
      },
    });

    const outcome = await webhookPost(ctx);

    expect(outcome).toEqual({ kind: 'succeeded' });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe('https://hooks.example.com/in');
    // headers forwarded verbatim (delivery is NOT redacted)
    expect(call.headers['authorization']).toBe('Bearer s3cret');
    expect(call.headers['X-Trace']).toBe('abc');
    // object body JSON-encoded + content-type defaulted
    expect(call.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(call.body ?? '{}')).toEqual({ text: 'hello' });
    expect(statusOf(store, 'rule-A', 'evt-1')).toBe('SUCCEEDED');
  });

  it('LOOPBACK HTTP ALLOWED: http://127.0.0.1 → POSTs and succeeds', async () => {
    const store = makeStore();
    const { fetchImpl, calls } = recordingFetch(200, '');
    const ctx = baseContext({
      store,
      fetchImpl,
      withBlock: { url: 'http://127.0.0.1:9000/hook', body: 'raw-string-body' },
    });

    const outcome = await webhookPost(ctx);

    expect(outcome).toEqual({ kind: 'succeeded' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://127.0.0.1:9000/hook');
    // a string body is sent verbatim, no JSON content-type defaulted
    expect(calls[0]!.body).toBe('raw-string-body');
    expect(calls[0]!.headers['Content-Type']).toBeUndefined();
    expect(statusOf(store, 'rule-A', 'evt-1')).toBe('SUCCEEDED');
  });

  it('LOOPBACK HTTP ALLOWED: http://localhost also POSTs', async () => {
    const { fetchImpl, calls } = recordingFetch(200);
    const ctx = baseContext({
      fetchImpl,
      withBlock: { url: 'http://localhost:8080/hook', body: { a: 1 } },
    });

    const outcome = await webhookPost(ctx);

    expect(outcome).toEqual({ kind: 'succeeded' });
    expect(calls[0]!.url).toBe('http://localhost:8080/hook');
  });

  it('HTTP NON-LOOPBACK REFUSAL: http:// to a routable host → refused, no POST, PERMANENTLY_FAILED', async () => {
    const store = makeStore();
    const { fetchImpl, calls } = recordingFetch(200);
    const ctx = baseContext({
      store,
      fetchImpl,
      withBlock: { url: 'http://example.com/in', body: { x: 1 } },
    });

    const outcome = await webhookPost(ctx);

    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect(outcome.retryable).toBe(false);
      expect(outcome.detail).toBe(
        'http:// to non-loopback target refused (credential-exposure guard)',
      );
    }
    expect(calls).toHaveLength(0); // NEVER POSTed
    expect(statusOf(store, 'rule-A', 'evt-1')).toBe('PERMANENTLY_FAILED');
  });

  it('TIMEOUT: a fetch that never resolves → failed retryable with timeout detail, FAILED row', async () => {
    vi.useFakeTimers();
    const store = makeStore();
    const fetchImpl = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }
      })) as typeof fetch;
    const ctx = baseContext({
      store,
      fetchImpl,
      timeoutMs: 50,
      withBlock: { url: 'https://hooks.example.com/in', body: { x: 1 } },
    });

    const promise = webhookPost(ctx);
    promise.catch(() => {});
    await vi.advanceTimersByTimeAsync(60);
    const outcome = await promise;

    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect(outcome.retryable).toBe(true);
      expect(outcome.detail).toBe('request timed out');
    }
    expect(statusOf(store, 'rule-A', 'evt-1')).toBe('FAILED');
    vi.useRealTimers();
  });

  it('IDEMPOTENT REPLAY: a second call suppresses the POST (already terminal)', async () => {
    const store = makeStore();
    const { fetchImpl, calls } = recordingFetch(200);

    const first = await webhookPost(baseContext({ store, fetchImpl }));
    expect(first).toEqual({ kind: 'succeeded' });
    expect(calls).toHaveLength(1);

    const second = await webhookPost(baseContext({ store, fetchImpl }));
    expect(second).toEqual({ kind: 'suppressed', reason: 'already_done' });
    expect(calls).toHaveLength(1); // no new POST
  });

  it('IDEMPOTENT REPLAY: an already-PENDING row suppresses with reason already_pending', async () => {
    const store = makeStore();
    const { fetchImpl, calls } = recordingFetch(200);
    store.claim({
      rule_name: 'rule-A',
      event_id: 'evt-1',
      rendered_with_json: '{}',
      task_id: 42,
      to_status: 'open',
      emitted_at_ms: 1_700_000_000_000,
    });

    const outcome = await webhookPost(baseContext({ store, fetchImpl }));

    expect(outcome).toEqual({ kind: 'suppressed', reason: 'already_pending' });
    expect(calls).toHaveLength(0);
  });

  it('4xx: terminal → failed non-retryable, PERMANENTLY_FAILED row', async () => {
    const store = makeStore();
    const { fetchImpl } = recordingFetch(400, '{"error":"bad"}');
    const ctx = baseContext({ store, fetchImpl });

    const outcome = await webhookPost(ctx);

    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect(outcome.retryable).toBe(false);
    }
    expect(statusOf(store, 'rule-A', 'evt-1')).toBe('PERMANENTLY_FAILED');
  });

  it('5xx: retryable → failed retryable, FAILED row', async () => {
    const store = makeStore();
    const { fetchImpl } = recordingFetch(502, 'bad gateway');
    const ctx = baseContext({ store, fetchImpl });

    const outcome = await webhookPost(ctx);

    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect(outcome.retryable).toBe(true);
    }
    expect(statusOf(store, 'rule-A', 'evt-1')).toBe('FAILED');
  });

  it('network error → failed retryable, FAILED row', async () => {
    const store = makeStore();
    const fetchImpl = (() => Promise.reject(new Error('ECONNREFUSED'))) as typeof fetch;
    const ctx = baseContext({ store, fetchImpl });

    const outcome = await webhookPost(ctx);

    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect(outcome.retryable).toBe(true);
      expect(outcome.detail).toBe('network error');
    }
    expect(statusOf(store, 'rule-A', 'evt-1')).toBe('FAILED');
  });

  it('missing url → terminal config failure, no POST after claim', async () => {
    const store = makeStore();
    const { fetchImpl, calls } = recordingFetch(200);
    const ctx = baseContext({ store, fetchImpl, withBlock: { body: { x: 1 } } });

    const outcome = await webhookPost(ctx);

    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect(outcome.retryable).toBe(false);
    }
    expect(calls).toHaveLength(0);
    expect(statusOf(store, 'rule-A', 'evt-1')).toBe('PERMANENTLY_FAILED');
  });

  it('renders {{task.*}} tokens into the url and body (whole-string substitution)', async () => {
    const { fetchImpl, calls } = recordingFetch(200);
    const ctx = baseContext({
      fetchImpl,
      withBlock: {
        url: '{{task.webhook_url}}',
        body: { external_id: '{{task.id}}' },
      },
      event: {
        type: 'task.created',
        task: { id: 42, webhook_url: 'https://hooks.example.com/demo' },
      },
    });

    await webhookPost(ctx);

    expect(calls[0]!.url).toBe('https://hooks.example.com/demo');
    // pure-substitution preserves the number type
    expect(JSON.parse(calls[0]!.body ?? '{}').external_id).toBe(42);
  });

  it('renderedWith bypasses rendering (crash-replay path)', async () => {
    const { fetchImpl, calls } = recordingFetch(200);
    const ctx = baseContext({
      fetchImpl,
      withBlock: undefined,
      renderedWith: { url: 'https://hooks.example.com/replay', body: 'replayed' },
    });

    const outcome = await webhookPost(ctx);

    expect(outcome).toEqual({ kind: 'succeeded' });
    expect(calls[0]!.url).toBe('https://hooks.example.com/replay');
    expect(calls[0]!.body).toBe('replayed');
  });
});
