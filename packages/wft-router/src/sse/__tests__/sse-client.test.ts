/**
 * Tests for the wft-router SSE client slice (task #424).
 *
 * Coverage per the task's acceptance criteria:
 *   - Happy path: yields events and exits cleanly when the stream ends.
 *   - Reconnect carries `Last-Event-Id` forward.
 *   - Watchdog: >15 min of unreachability → ExitCode 4. Test must finish
 *     in <1 s wall-clock, so the clock + sleep are fully mocked.
 *   - Auth header selection mirrors `src/mcp/remote/rest-client.ts:80-84`.
 *   - HTTP 410 → `cursor_gap` warn + reconnect with NO Last-Event-Id.
 *   - 401 on startup → ExitCode 3.
 *   - `event_types` filter renders into the URL.
 *
 * Plus parser-level cases (single, multi-line data, id+event+data,
 * comments, CRLF, trailing-no-blank-line).
 *
 * All external surfaces (`fetch`, `clock`, `randomFn`, `logger`) are
 * injected via opts so no real I/O happens. The fake clock advances
 * synchronously via test-controlled `sleep` resolution — there is NO
 * real `setTimeout` in any test.
 */

import { describe, expect, it, vi } from 'vitest';

import { authHeader, PAT_PREFIX } from '../auth.js';
import { createSSEParser } from '../parser.js';
import {
  computeBackoffMs,
  ExitCode,
  runSSEClient,
  type SSEClock,
  type SSEClientOptions,
  type SSELogger,
} from '../client.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a `Response` whose body is an SSE-formatted UTF-8 ReadableStream. */
function sseResponse(body: string, status = 200, headers: HeadersInit = {}): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { 'Content-Type': 'text/event-stream', ...headers },
  });
}

/** Build a non-2xx response with an empty body. */
function statusResponse(status: number): Response {
  return new Response('', { status });
}

interface FetchCall {
  url: string;
  headers: Record<string, string>;
}

/**
 * Recording fetch fake. Given an array of responses (or thunks producing
 * them), returns each in order. Records every call's URL + headers so the
 * test can assert the wire shape.
 */
function recordingFetch(
  responses: ReadonlyArray<Response | (() => Response | Promise<Response>) | Error>,
): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  let idx = 0;
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
    calls.push({ url: urlStr, headers });
    const next = responses[idx++];
    if (next === undefined) {
      // After the script is exhausted, pretend the network is hung —
      // tests should abort before reaching this point.
      return Promise.reject(new Error('fetch script exhausted'));
    }
    if (next instanceof Error) return Promise.reject(next);
    if (typeof next === 'function') return Promise.resolve(next());
    return Promise.resolve(next);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/**
 * Synthetic clock. `now` returns whatever the test has set. `sleep`
 * advances the clock by `advanceOnSleep` ms and resolves immediately —
 * keeps the watchdog test under 1 s wall-clock.
 */
function fakeClock(advanceOnSleep: number): SSEClock & {
  setNow(n: number): void;
  getNow(): number;
} {
  let now = 0;
  return {
    now: () => now,
    sleep: (_ms, signal) => {
      if (signal.aborted) return Promise.resolve(true);
      now += advanceOnSleep;
      return Promise.resolve(false);
    },
    setNow: (n) => {
      now = n;
    },
    getNow: () => now,
  };
}

/** Collect the first N events from a generator, then abort and read the return. */
async function takeEvents<T, R>(
  gen: AsyncGenerator<T, R>,
  n: number,
  onTaken?: () => void,
): Promise<{ events: T[]; result: R | undefined }> {
  const events: T[] = [];
  for (let i = 0; i < n; i++) {
    const step = await gen.next();
    if (step.done) {
      return { events, result: step.value };
    }
    events.push(step.value);
  }
  if (onTaken) onTaken();
  const final = await gen.next();
  return { events, result: final.done ? final.value : undefined };
}

/** Drain a generator to completion (or until the abort signal trips). */
async function drainToExit<T, R>(gen: AsyncGenerator<T, R>): Promise<{ events: T[]; exit: R }> {
  const events: T[] = [];
  for (;;) {
    const step = await gen.next();
    if (step.done) return { events, exit: step.value };
    events.push(step.value);
  }
}

function spyLogger(): SSELogger & {
  warns: Array<{ msg: string; fields?: Record<string, unknown> }>;
  infos: Array<{ msg: string; fields?: Record<string, unknown> }>;
} {
  const warns: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
  const infos: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
  return {
    warns,
    infos,
    warn: (msg, fields) => warns.push({ msg, ...(fields !== undefined && { fields }) }),
    info: (msg, fields) => infos.push({ msg, ...(fields !== undefined && { fields }) }),
  };
}

/** Default opts factory — keeps tests terse. */
function baseOpts(
  overrides: Partial<SSEClientOptions> & Pick<SSEClientOptions, 'fetchImpl'>,
): SSEClientOptions {
  return {
    endpoint: 'http://localhost:3000',
    apiKey: 'wft_pat_ABCDEFG1234567890',
    randomFn: () => 0.5,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// auth.ts
// ---------------------------------------------------------------------------

describe('authHeader — mirrors src/mcp/remote/rest-client.ts:80-84', () => {
  it('uses Authorization: Bearer when the key starts with wft_pat_', () => {
    const h = authHeader(`${PAT_PREFIX}deadbeef-cafe`);
    expect(h.name).toBe('Authorization');
    expect(h.value).toBe(`Bearer ${PAT_PREFIX}deadbeef-cafe`);
  });

  it('uses X-API-Key for any non-PAT value (legacy path)', () => {
    const h = authHeader('legacy-key-zzz');
    expect(h.name).toBe('X-API-Key');
    expect(h.value).toBe('legacy-key-zzz');
  });

  it('does NOT use Authorization for a near-miss prefix', () => {
    // Defensive check — case-sensitive, no leading whitespace tolerated.
    expect(authHeader('WFT_PAT_X').name).toBe('X-API-Key');
    expect(authHeader(' wft_pat_X').name).toBe('X-API-Key');
  });
});

// ---------------------------------------------------------------------------
// parser.ts
// ---------------------------------------------------------------------------

describe('createSSEParser', () => {
  it('parses a single complete event', () => {
    const p = createSSEParser();
    const events = p.feed('data: hello\n\n');
    expect(events).toEqual([{ data: 'hello' }]);
  });

  it('concatenates multi-line data with \\n (per spec)', () => {
    const p = createSSEParser();
    const events = p.feed('data: line one\ndata: line two\n\n');
    expect(events).toEqual([{ data: 'line one\nline two' }]);
  });

  it('captures id + event + data on one event', () => {
    const p = createSSEParser();
    const events = p.feed('id: 42\nevent: task.created\ndata: {"x":1}\n\n');
    expect(events).toEqual([{ id: '42', event: 'task.created', data: '{"x":1}' }]);
  });

  it('ignores SSE comment lines (": keep-alive")', () => {
    const p = createSSEParser();
    const events = p.feed(': heartbeat\ndata: payload\n\n');
    expect(events).toEqual([{ data: 'payload' }]);
  });

  it('accepts CRLF line endings', () => {
    const p = createSSEParser();
    const events = p.feed('id: 7\r\ndata: hi\r\n\r\n');
    expect(events).toEqual([{ id: '7', data: 'hi' }]);
  });

  it('holds a partial event in the buffer until flush()', () => {
    const p = createSSEParser();
    expect(p.feed('data: incomplete\n')).toEqual([]);
    expect(p.flush()).toEqual([{ data: 'incomplete' }]);
  });

  it('emits two events when two complete blocks arrive in one chunk', () => {
    const p = createSSEParser();
    const events = p.feed('data: one\n\ndata: two\n\n');
    expect(events).toEqual([{ data: 'one' }, { data: 'two' }]);
  });

  it('parses retry: as an integer hint', () => {
    const p = createSSEParser();
    const events = p.feed('retry: 5000\ndata: x\n\n');
    expect(events).toEqual([{ data: 'x', retry: 5000 }]);
  });
});

// ---------------------------------------------------------------------------
// computeBackoffMs
// ---------------------------------------------------------------------------

describe('computeBackoffMs', () => {
  it('respects the cap and applies jitter in [0.5, 1.0]', () => {
    // attempts=10, base=2^9 * 1000 = 512000 → capped at 60000.
    const max = 60_000;
    expect(computeBackoffMs(10, max, () => 0)).toBe(Math.floor(max * 0.5));
    expect(computeBackoffMs(10, max, () => 0.999_999)).toBeLessThanOrEqual(max);
    expect(computeBackoffMs(10, max, () => 0.999_999)).toBeGreaterThanOrEqual(
      Math.floor(max * 0.9),
    );
  });

  it('grows exponentially below the cap', () => {
    const max = 60_000;
    expect(computeBackoffMs(1, max, () => 0)).toBe(500); // 1000 * 0.5
    expect(computeBackoffMs(2, max, () => 0)).toBe(1000); // 2000 * 0.5
    expect(computeBackoffMs(3, max, () => 0)).toBe(2000); // 4000 * 0.5
  });
});

// ---------------------------------------------------------------------------
// runSSEClient — integration-style with fake fetch + fake clock
// ---------------------------------------------------------------------------

describe('runSSEClient — happy path', () => {
  it('yields one event and exits cleanly when the server aborts', async () => {
    const { fetchImpl, calls } = recordingFetch([
      sseResponse('id: 1\ndata: hello\n\n'),
    ]);
    const controller = new AbortController();
    const logger = spyLogger();
    const clock = fakeClock(0);

    const gen = runSSEClient(
      baseOpts({ fetchImpl, logger, clock }),
      controller.signal,
    );

    const first = await gen.next();
    expect(first.done).toBe(false);
    expect(first.value).toEqual({ id: '1', data: 'hello' });

    // Server closed, so the client will try to reconnect. Abort before
    // the next fetch to keep the test deterministic.
    controller.abort();
    const final = await gen.next();
    expect(final.done).toBe(true);
    expect(final.value).toBe(ExitCode.CleanShutdown);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://localhost:3000/api/v1/events');
    expect(calls[0]?.headers['Authorization']).toBe(
      `Bearer ${PAT_PREFIX}abcdef0123456789`,
    );
    expect(calls[0]?.headers['Last-Event-Id']).toBeUndefined();
  });

  it('legacy key uses X-API-Key, not Authorization', async () => {
    const { fetchImpl, calls } = recordingFetch([sseResponse('data: ok\n\n')]);
    const controller = new AbortController();
    const gen = runSSEClient(
      baseOpts({
        fetchImpl,
        apiKey: 'legacy-key-xyz',
        clock: fakeClock(0),
        logger: spyLogger(),
      }),
      controller.signal,
    );
    await gen.next();
    controller.abort();
    await gen.next();

    expect(calls[0]?.headers['X-API-Key']).toBe('legacy-key-xyz');
    expect(calls[0]?.headers['Authorization']).toBeUndefined();
  });

  it('applies event_types filter as ?event_types=a,b in the URL', async () => {
    const { fetchImpl, calls } = recordingFetch([sseResponse('data: ok\n\n')]);
    const controller = new AbortController();
    const gen = runSSEClient(
      baseOpts({
        fetchImpl,
        eventTypes: ['task.status_changed', 'task.created'],
        clock: fakeClock(0),
        logger: spyLogger(),
      }),
      controller.signal,
    );
    await gen.next();
    controller.abort();
    await gen.next();

    const url = new URL(calls[0]?.url ?? '');
    expect(url.pathname).toBe('/api/v1/events');
    expect(url.searchParams.get('event_types')).toBe(
      'task.status_changed,task.created',
    );
  });
});

describe('runSSEClient — reconnect with Last-Event-Id', () => {
  it('sends Last-Event-Id on the second connection', async () => {
    const { fetchImpl, calls } = recordingFetch([
      sseResponse('id: 42\ndata: first\n\n'),
      sseResponse('id: 43\ndata: second\n\n'),
    ]);
    const controller = new AbortController();
    const gen = runSSEClient(
      baseOpts({
        fetchImpl,
        clock: fakeClock(0),
        logger: spyLogger(),
      }),
      controller.signal,
    );

    const first = await gen.next();
    expect(first.value).toEqual({ id: '42', data: 'first' });

    const second = await gen.next();
    expect(second.value).toEqual({ id: '43', data: 'second' });

    controller.abort();
    await gen.next();

    expect(calls).toHaveLength(2);
    expect(calls[0]?.headers['Last-Event-Id']).toBeUndefined();
    expect(calls[1]?.headers['Last-Event-Id']).toBe('42');
  });
});

describe('runSSEClient — HTTP 410 cursor_gap', () => {
  it('clears Last-Event-Id and logs cursor_gap', async () => {
    const { fetchImpl, calls } = recordingFetch([
      sseResponse('id: 10\ndata: pre-gap\n\n'),
      statusResponse(410),
      sseResponse('id: 11\ndata: post-gap\n\n'),
    ]);
    const controller = new AbortController();
    const logger = spyLogger();
    const gen = runSSEClient(
      baseOpts({ fetchImpl, logger, clock: fakeClock(0) }),
      controller.signal,
    );

    const first = await gen.next();
    expect(first.value).toEqual({ id: '10', data: 'pre-gap' });
    const second = await gen.next();
    expect(second.value).toEqual({ id: '11', data: 'post-gap' });

    controller.abort();
    await gen.next();

    expect(calls).toHaveLength(3);
    expect(calls[0]?.headers['Last-Event-Id']).toBeUndefined();
    expect(calls[1]?.headers['Last-Event-Id']).toBe('10');
    // Critical: the THIRD call (after 410) MUST omit Last-Event-Id.
    expect(calls[2]?.headers['Last-Event-Id']).toBeUndefined();

    expect(logger.warns.find((w) => w.msg === 'cursor_gap')).toBeDefined();
  });
});

describe('runSSEClient — auth failure on startup', () => {
  it('returns ExitCode.AuthFailedStartup (3) on initial 401', async () => {
    const { fetchImpl } = recordingFetch([statusResponse(401)]);
    const controller = new AbortController();
    const logger = spyLogger();
    const gen = runSSEClient(
      baseOpts({ fetchImpl, logger, clock: fakeClock(0) }),
      controller.signal,
    );
    const step = await gen.next();
    expect(step.done).toBe(true);
    expect(step.value).toBe(ExitCode.AuthFailedStartup);
    expect(logger.warns.find((w) => w.msg === 'sse_auth_failed')).toBeDefined();
  });

  it('returns ExitCode.AuthFailedStartup (3) on initial 403', async () => {
    const { fetchImpl } = recordingFetch([statusResponse(403)]);
    const controller = new AbortController();
    const gen = runSSEClient(
      baseOpts({ fetchImpl, clock: fakeClock(0), logger: spyLogger() }),
      controller.signal,
    );
    const step = await gen.next();
    expect(step.done).toBe(true);
    expect(step.value).toBe(ExitCode.AuthFailedStartup);
  });
});

describe('runSSEClient — >15 min watchdog', () => {
  it('returns ExitCode.EndpointUnreachable (4) after sustained failures', async () => {
    const start = vi.useFakeTimers ? Date.now() : 0;
    // Advance the fake clock by 5 min each sleep — three failures total
    // crosses the 15-min limit.
    const clock = fakeClock(5 * 60_000);
    clock.setNow(start);
    // Every fetch attempt rejects with a network error.
    const responses: Error[] = Array.from({ length: 20 }, () => new Error('ECONNREFUSED'));
    const { fetchImpl, calls } = recordingFetch(responses);

    const controller = new AbortController();
    const logger = spyLogger();
    const t0 = Date.now();
    const gen = runSSEClient(
      baseOpts({
        fetchImpl,
        logger,
        clock,
        unreachableLimitMs: 15 * 60_000,
        maxBackoffMs: 60_000,
      }),
      controller.signal,
    );
    const step = await gen.next();
    const elapsed = Date.now() - t0;

    expect(step.done).toBe(true);
    expect(step.value).toBe(ExitCode.EndpointUnreachable);
    // Wall-clock under 1s — proves the watchdog ran on the fake clock.
    expect(elapsed).toBeLessThan(1000);
    // Multiple connection attempts were tried before the watchdog tripped.
    expect(calls.length).toBeGreaterThan(1);
    // The watchdog logged its trip reason.
    expect(
      logger.warns.find((w) => w.msg === 'sse_endpoint_unreachable'),
    ).toBeDefined();
  });

  it('does NOT trip the watchdog when a healthy connection resets failure tracking', async () => {
    // Pattern: error → success-with-event → error → success-with-event ...
    // Each success resets firstFailureAt, so even with hours of fake-clock
    // advancement the watchdog never trips.
    const clock = fakeClock(10 * 60_000); // 10 min per sleep
    const script: Array<Response | Error> = [];
    for (let i = 0; i < 8; i++) {
      script.push(new Error('transient'));
      script.push(sseResponse(`id: ${String(i)}\ndata: keepalive\n\n`));
    }
    const { fetchImpl } = recordingFetch(script);
    const controller = new AbortController();
    const gen = runSSEClient(
      baseOpts({
        fetchImpl,
        clock,
        logger: spyLogger(),
        unreachableLimitMs: 15 * 60_000,
      }),
      controller.signal,
    );
    // Collect 4 events — proves the run loop kept healing.
    const got = await takeEvents(gen, 4, () => controller.abort());
    expect(got.events).toHaveLength(4);
    expect(got.events[0]).toEqual({ id: '0', data: 'keepalive' });
    expect(got.events[3]).toEqual({ id: '3', data: 'keepalive' });
  });
});

describe('runSSEClient — clean shutdown', () => {
  it('returns ExitCode.CleanShutdown (0) when aborted between connections', async () => {
    const { fetchImpl } = recordingFetch([sseResponse('id: 1\ndata: hi\n\n')]);
    const controller = new AbortController();
    const gen = runSSEClient(
      baseOpts({ fetchImpl, clock: fakeClock(0), logger: spyLogger() }),
      controller.signal,
    );
    await gen.next(); // event
    controller.abort();
    const final = await gen.next();
    expect(final.done).toBe(true);
    expect(final.value).toBe(ExitCode.CleanShutdown);
  });
});

describe('runSSEClient — incremental delivery on a long-lived stream (regression)', () => {
  // Regression guard for the buffer-until-close bug: the client used to push
  // parsed events onto an array and only yield them AFTER the connection
  // returned. A real SSE connection is long-lived and never closes on its
  // own, so a healthy stream delivered ZERO events in real time — the daemon
  // blocked on gen.next() forever. This test feeds a stream that enqueues
  // events and then STAYS OPEN (no controller.close()): the buggy client
  // would hang here (no yield → this test times out); the fixed client
  // yields each event the instant it is parsed.
  it('yields events as they arrive, before the stream closes', async () => {
    const ac = new AbortController();
    const body =
      'id: 1\nevent: task.status_changed\ndata: {"x":1}\n\n' +
      'id: 2\nevent: ping\ndata: {}\n\n';
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        // Deliberately NO controller.close() — mimic a live, open SSE stream.
      },
    });
    const response = new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
    const { fetchImpl } = recordingFetch([response]);
    const gen = runSSEClient(
      baseOpts({ fetchImpl, clock: fakeClock(0), logger: spyLogger() }),
      ac.signal,
    );

    // Both pulls must resolve even though the stream never closes.
    const first = await gen.next();
    const second = await gen.next();
    ac.abort(); // leave the suspended generator parked; no third pull.

    expect(first.done).toBe(false);
    expect(second.done).toBe(false);
    expect((first.value as { id?: string }).id).toBe('1');
    expect((first.value as { event?: string }).event).toBe('task.status_changed');
    expect((second.value as { id?: string }).id).toBe('2');
  });
});

// Reassure linters that drainToExit is exercised (kept for the public
// helper surface even if every test today uses takeEvents instead).
void drainToExit;
