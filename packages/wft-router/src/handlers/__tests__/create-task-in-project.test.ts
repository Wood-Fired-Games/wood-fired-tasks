/**
 * Tests for the wft-router `create_task_in_project` handler (task #428).
 *
 * Coverage per the task's acceptance criteria:
 *   - SUCCESS:            2xx → store SUCCEEDED, { kind: 'succeeded' }, POST fired.
 *   - 4xx:                terminal → store PERMANENTLY_FAILED, retryable:false.
 *   - 5xx WITH RETRY:     retryable → store FAILED, retryable:true.
 *   - IDEMPOTENT REPLAY:  second call (or pre-claimed row) suppresses the
 *                         POST entirely.
 *
 * Plus supporting cases:
 *   - Integration against an in-process API stub (a fake `fetch` impl,
 *     following the SSE-client injection style) verifies the wire shape:
 *     URL path, auth header selection, Content-Type, and rendered body.
 *   - Network error + timeout → retryable.
 *   - Missing `project` → terminal config failure.
 *   - Template rendering of `{{task.*}}` tokens into the body.
 *
 * A REAL in-memory `IdempotencyStore` (`:memory:`) is used so the
 * PENDING→terminal protocol is exercised end-to-end, not mocked. The HTTP
 * surface is the only injected fake — mirroring `sse-client.test.ts`.
 *
 * Test files MAY use vendor names in example URLs; the vendor-neutrality
 * scan excludes `__tests__/`.
 */

import { describe, expect, it, vi } from 'vitest';

import { IdempotencyStore, type DispatchStatus } from '../../dispatch/index.js';
import type { EventPayloadShape } from '../../dispatch/index.js';
import { createTaskInProject } from '../create-task-in-project.js';
import type { HandlerContext, HandlerLogger } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A no-op logger that satisfies the HandlerLogger surface. */
function silentLogger(): HandlerLogger {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

/** Fresh in-memory idempotency store per test. */
function makeStore(): IdempotencyStore {
  return new IdempotencyStore({ dbPath: ':memory:' });
}

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

/**
 * Recording fetch fake. Returns a fixed status/body and records every call's
 * wire shape so assertions can inspect URL, headers, and body. Mirrors the
 * `recordingFetch` pattern in sse-client.test.ts.
 */
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
    withBlock: 'withBlock' in over ? over.withBlock : { project: 7, title: 'hello', body: 'world' },
    renderedWith: over.renderedWith,
    apiBaseUrl: over.apiBaseUrl ?? 'https://tasks.example.com',
    authToken: over.authToken ?? 'wft_pat_abc123',
    timeoutMs: over.timeoutMs,
    fetchImpl: over.fetchImpl,
  };
}

/** Read the terminal status of a (rule, event) row directly from the store db. */
function statusOf(
  store: IdempotencyStore,
  ruleName: string,
  eventId: string,
): DispatchStatus | undefined {
  // Re-claim would mutate; instead use the public secondary path is N/A here,
  // so we observe via a second claim attempt: ALREADY_DONE carries the status.
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
  return undefined; // freshly CLAIMED → there was no prior row
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createTaskInProject', () => {
  it('SUCCESS: 2xx → succeeded outcome, SUCCEEDED row, POST fired with correct wire shape', async () => {
    const store = makeStore();
    const { fetchImpl, calls } = recordingFetch(201, '{"id":99}');
    const ctx = baseContext({ store, fetchImpl });

    const outcome = await createTaskInProject(ctx);

    expect(outcome).toEqual({ kind: 'succeeded' });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe('https://tasks.example.com/api/v1/projects/7/tasks');
    // PAT token → Bearer
    expect(call.headers['Authorization']).toBe('Bearer wft_pat_abc123');
    expect(call.headers['Content-Type']).toBe('application/json');
    // project stripped from body; other fields preserved
    const sent = JSON.parse(call.body ?? '{}');
    expect(sent).toEqual({ title: 'hello', body: 'world' });
    // store transitioned to SUCCEEDED
    expect(statusOf(store, 'rule-A', 'evt-1')).toBe('SUCCEEDED');
  });

  it('uses X-API-Key for a non-PAT token', async () => {
    const { fetchImpl, calls } = recordingFetch(200);
    const ctx = baseContext({ fetchImpl, authToken: 'legacy-key-xyz' });

    await createTaskInProject(ctx);

    expect(calls[0]!.headers['X-API-Key']).toBe('legacy-key-xyz');
    expect(calls[0]!.headers['Authorization']).toBeUndefined();
  });

  it('renders {{task.*}} tokens into the POST body, type-preserving', async () => {
    const { fetchImpl, calls } = recordingFetch(200);
    const ctx = baseContext({
      fetchImpl,
      withBlock: {
        project: '{{task.project_slug}}',
        title: 'static title',
        external_id: '{{task.id}}',
      },
      event: {
        type: 'task.created',
        task: { id: 42, project_slug: 'demo' },
      },
    });

    await createTaskInProject(ctx);

    // project_slug resolved into the path
    expect(calls[0]!.url).toBe('https://tasks.example.com/api/v1/projects/demo/tasks');
    const sent = JSON.parse(calls[0]!.body ?? '{}');
    // pure-substitution preserves the number type
    expect(sent.external_id).toBe(42);
    // a static (token-free) string passes through unchanged
    expect(sent.title).toBe('static title');
  });

  it('4xx: terminal → failed non-retryable, PERMANENTLY_FAILED row', async () => {
    const store = makeStore();
    const { fetchImpl } = recordingFetch(422, '{"error":"bad title"}');
    const ctx = baseContext({ store, fetchImpl });

    const outcome = await createTaskInProject(ctx);

    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect(outcome.retryable).toBe(false);
    }
    expect(statusOf(store, 'rule-A', 'evt-1')).toBe('PERMANENTLY_FAILED');
  });

  it('5xx WITH RETRY: retryable → failed retryable, FAILED row', async () => {
    const store = makeStore();
    const { fetchImpl } = recordingFetch(503, 'upstream down');
    const ctx = baseContext({ store, fetchImpl });

    const outcome = await createTaskInProject(ctx);

    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect(outcome.retryable).toBe(true);
    }
    expect(statusOf(store, 'rule-A', 'evt-1')).toBe('FAILED');
  });

  it('IDEMPOTENT REPLAY: a second call suppresses the POST (already terminal)', async () => {
    const store = makeStore();
    const { fetchImpl, calls } = recordingFetch(200);

    // First call succeeds and POSTs.
    const first = await createTaskInProject(baseContext({ store, fetchImpl }));
    expect(first).toEqual({ kind: 'succeeded' });
    expect(calls).toHaveLength(1);

    // Second call for the SAME (rule, event) must NOT POST again.
    const second = await createTaskInProject(baseContext({ store, fetchImpl }));
    expect(second).toEqual({ kind: 'suppressed', reason: 'already_done' });
    expect(calls).toHaveLength(1); // no new POST
  });

  it('IDEMPOTENT REPLAY: an already-PENDING row suppresses with reason already_pending', async () => {
    const store = makeStore();
    const { fetchImpl, calls } = recordingFetch(200);

    // Pre-claim the row to simulate another worker holding it PENDING.
    store.claim({
      rule_name: 'rule-A',
      event_id: 'evt-1',
      rendered_with_json: '{}',
      task_id: 42,
      to_status: 'open',
      emitted_at_ms: 1_700_000_000_000,
    });

    const outcome = await createTaskInProject(baseContext({ store, fetchImpl }));

    expect(outcome).toEqual({ kind: 'suppressed', reason: 'already_pending' });
    expect(calls).toHaveLength(0); // no POST while another worker owns it
  });

  it('network error → failed retryable, FAILED row', async () => {
    const store = makeStore();
    const fetchImpl = (() => Promise.reject(new Error('ECONNREFUSED'))) as typeof fetch;
    const ctx = baseContext({ store, fetchImpl });

    const outcome = await createTaskInProject(ctx);

    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect(outcome.retryable).toBe(true);
      expect(outcome.detail).toBe('network error');
    }
    expect(statusOf(store, 'rule-A', 'evt-1')).toBe('FAILED');
  });

  it('timeout → failed retryable with timeout detail', async () => {
    vi.useFakeTimers();
    const store = makeStore();
    // fetch that never resolves until aborted.
    const fetchImpl = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }
      })) as typeof fetch;
    const ctx = baseContext({ store, fetchImpl, timeoutMs: 50 });

    const promise = createTaskInProject(ctx);
    // Keep a handler attached across the clock advance so the inner fetch
    // rejection is never observed as "unhandled".
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

  it('missing project → terminal config failure, no POST after claim', async () => {
    const store = makeStore();
    const { fetchImpl, calls } = recordingFetch(200);
    const ctx = baseContext({
      store,
      fetchImpl,
      withBlock: { title: 'no project here' },
    });

    const outcome = await createTaskInProject(ctx);

    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect(outcome.retryable).toBe(false);
    }
    expect(calls).toHaveLength(0);
    expect(statusOf(store, 'rule-A', 'evt-1')).toBe('PERMANENTLY_FAILED');
  });

  it('renderedWith bypasses rendering (crash-replay path)', async () => {
    const { fetchImpl, calls } = recordingFetch(200);
    const ctx = baseContext({
      fetchImpl,
      withBlock: undefined,
      renderedWith: { project: 'replayed', title: 'from-replay' },
    });

    const outcome = await createTaskInProject(ctx);

    expect(outcome).toEqual({ kind: 'succeeded' });
    expect(calls[0]!.url).toBe('https://tasks.example.com/api/v1/projects/replayed/tasks');
    expect(JSON.parse(calls[0]!.body ?? '{}')).toEqual({ title: 'from-replay' });
  });

  it('no payload at all → non-retryable failure without touching the store', async () => {
    const store = makeStore();
    const { fetchImpl, calls } = recordingFetch(200);
    const ctx = baseContext({ store, fetchImpl, withBlock: undefined, renderedWith: undefined });

    const outcome = await createTaskInProject(ctx);

    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect(outcome.retryable).toBe(false);
    }
    expect(calls).toHaveLength(0);
    // never claimed → fresh claim now succeeds (no prior row)
    expect(statusOf(store, 'rule-A', 'evt-1')).toBeUndefined();
  });
});
