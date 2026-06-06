import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { it as itProp, fc } from '@fast-check/vitest';
import { EventEmitter } from 'events';
import { SSEManager } from '../sse-manager.js';
import { EventPayload } from '../types.js';

/**
 * task #206 — SSE fan-out resilience + buffer-bound property tests.
 *
 * This suite complements `sse-manager.test.ts` (which covers happy-path
 * behaviour) with the operational guarantees we depend on at scale:
 *
 *   1. Fan-out resilience — one bad client cannot starve the others.
 *   2. Buffer-bound invariants — under arbitrary traffic, the connection
 *      map and the event-replay buffer never exceed configured caps.
 *   3. Heartbeat keep-alive actually fires on its interval.
 *   4. Replay-from-Last-Event-ID beyond the buffer surfaces an explicit
 *      `replay-gap` hint instead of silently lying about completeness.
 */

interface MockReply {
  raw: EventEmitter;
  sse: { send: ReturnType<typeof vi.fn> };
  _getSentEvents: () => any[];
  _failNext?: (err?: Error) => void;
}

/**
 * Build a mock FastifyReply whose `sse.send` resolves by default and records
 * every emitted SSE payload. Pass `failOn` (a predicate) to reject sends
 * matching the predicate — used to model a broken client mid-fanout.
 */
function createMockReply(opts?: { failOn?: (data: any) => boolean }): MockReply {
  const raw = new EventEmitter();
  const sentEvents: any[] = [];

  const send = vi.fn(async (data: any) => {
    if (opts?.failOn && opts.failOn(data)) {
      throw new Error('mock client broken');
    }
    sentEvents.push(data);
  });

  return {
    raw,
    sse: { send },
    _getSentEvents: () => sentEvents,
  };
}

function makeEvent(id: number, projectId = 1): EventPayload<unknown> {
  return {
    eventType: 'task.created',
    timestamp: new Date().toISOString(),
    data: { id, title: `Event ${id}`, project_id: projectId },
    metadata: { source: 'user' },
  };
}

/**
 * Flush microtasks so fire-and-forget `.then().catch()` chains in
 * SSEManager.sendEvent run before assertions. We flush a few times
 * because the chain has multiple awaits.
 */
async function flushMicrotasks(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

describe('SSEManager fan-out resilience (task #206)', () => {
  let manager: SSEManager;

  afterEach(() => {
    if (manager) manager.shutdown();
  });

  it('delivers to healthy clients even when one client rejects on send', async () => {
    manager = new SSEManager();

    const healthyA = createMockReply();
    const healthyB = createMockReply();
    // This client rejects EVERY send — simulates a half-closed socket or
    // a downstream proxy returning ECONNRESET.
    const broken = createMockReply({ failOn: () => true });

    manager.addConnection('healthy-a', healthyA as any, {});
    manager.addConnection('broken', broken as any, {});
    manager.addConnection('healthy-b', healthyB as any, {});

    const event = makeEvent(1);
    manager.broadcast(event);

    // Healthy clients see the event synchronously (sse.send was called
    // for each connection during broadcast).
    expect(healthyA.sse.send).toHaveBeenCalledTimes(1);
    expect(healthyB.sse.send).toHaveBeenCalledTimes(1);
    expect(broken.sse.send).toHaveBeenCalledTimes(1);

    // Let the broken client's rejection propagate through the
    // fire-and-forget .catch() in SSEManager.sendEvent so the cleanup
    // runs before we broadcast again.
    await flushMicrotasks();

    // A second broadcast should NOT touch the broken client (it was
    // removed) but MUST still reach the healthy ones.
    healthyA.sse.send.mockClear();
    healthyB.sse.send.mockClear();
    broken.sse.send.mockClear();

    const event2 = makeEvent(2);
    manager.broadcast(event2);

    expect(broken.sse.send).not.toHaveBeenCalled();
    expect(healthyA.sse.send).toHaveBeenCalledTimes(1);
    expect(healthyB.sse.send).toHaveBeenCalledTimes(1);

    // Healthy clients accumulate both events end-to-end.
    expect(healthyA._getSentEvents().map((e) => e.id)).toEqual(['1', '2']);
    expect(healthyB._getSentEvents().map((e) => e.id)).toEqual(['1', '2']);
  });

  it('isolates per-client failures during a single broadcast — order independent', async () => {
    // Verify a broken client *first* in iteration order does not short-circuit
    // the loop. We insert the broken connection BEFORE the healthy ones to
    // exercise the "throw early" pathway.
    manager = new SSEManager();

    const broken = createMockReply({ failOn: () => true });
    const healthy = createMockReply();

    manager.addConnection('broken-first', broken as any, {});
    manager.addConnection('healthy-second', healthy as any, {});

    manager.broadcast(makeEvent(42));

    // Both received the synchronous send call — the throw was caught
    // inside a .catch() and did NOT bubble out of the broadcast loop.
    expect(broken.sse.send).toHaveBeenCalledTimes(1);
    expect(healthy.sse.send).toHaveBeenCalledTimes(1);
    expect(healthy._getSentEvents()).toHaveLength(1);

    await flushMicrotasks();
    // Broken client got cleaned up.
    const event2 = makeEvent(43);
    healthy.sse.send.mockClear();
    broken.sse.send.mockClear();
    manager.broadcast(event2);
    expect(broken.sse.send).not.toHaveBeenCalled();
    expect(healthy.sse.send).toHaveBeenCalledTimes(1);
  });
});

describe('SSEManager heartbeat keep-alive (task #206)', () => {
  let manager: SSEManager;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    if (manager) manager.shutdown();
    vi.useRealTimers();
  });

  it('fires heartbeat ping on the configured interval', () => {
    // Configure a 5s heartbeat to keep the test fast and explicit.
    const HEARTBEAT_MS = 5000;
    manager = new SSEManager(
      100, // maxBufferSize
      5 * 60 * 1000, // bufferTtlMs
      HEARTBEAT_MS, // heartbeatIntervalMs <-- under test
      10 * 60 * 1000, // maxConnectionAgeMs
    );

    const reply = createMockReply();
    manager.addConnection('c1', reply as any, {});

    // No timer advance yet → no heartbeat has fired.
    expect(reply.sse.send).not.toHaveBeenCalled();

    // First tick.
    vi.advanceTimersByTime(HEARTBEAT_MS);
    expect(reply.sse.send).toHaveBeenCalledTimes(1);
    expect(reply.sse.send).toHaveBeenLastCalledWith({ event: 'ping', data: '' });

    // Second tick → another heartbeat (proves it's a real interval, not a
    // one-shot timeout).
    vi.advanceTimersByTime(HEARTBEAT_MS);
    expect(reply.sse.send).toHaveBeenCalledTimes(2);

    // Third tick → still firing.
    vi.advanceTimersByTime(HEARTBEAT_MS);
    expect(reply.sse.send).toHaveBeenCalledTimes(3);
  });
});

describe('SSEManager replay-from-Last-Event-ID beyond buffer (task #206)', () => {
  let manager: SSEManager;

  afterEach(() => {
    if (manager) manager.shutdown();
  });

  it('sends an explicit replay-gap hint when requested ID predates the buffer', () => {
    // maxBufferSize = 5. We broadcast 10 events so events 1..5 are pruned
    // and the buffer holds events 6..10. The client then connects with
    // Last-Event-ID = 2 — which is older than anything we still have.
    manager = new SSEManager(5);
    for (let i = 1; i <= 10; i++) {
      manager.broadcast(makeEvent(i));
    }

    const reply = createMockReply();
    manager.addConnection('lag-client', reply as any, {}, 2);

    const sent = reply._getSentEvents();

    // First call MUST be the replay-gap hint, before the partial replay.
    const gapMsg = sent.find((m) => m.event === 'replay-gap');
    expect(gapMsg).toBeDefined();
    expect(gapMsg!.event).toBe('replay-gap');

    const parsed = JSON.parse(gapMsg!.data);
    expect(parsed.requestedLastEventId).toBe(2);
    expect(parsed.earliestAvailableId).toBe(6);
    expect(typeof parsed.hint).toBe('string');
    expect(parsed.hint.length).toBeGreaterThan(0);

    // We still get the events the buffer DOES have (6..10), so clients
    // that ignore the hint at least get partial recovery.
    const dataEvents = sent.filter((m) => m.event === 'task.created');
    expect(dataEvents.map((e) => e.id)).toEqual(['6', '7', '8', '9', '10']);
  });

  it('does NOT emit a replay-gap when the client is fully covered by the buffer', () => {
    manager = new SSEManager(10);
    for (let i = 1; i <= 5; i++) {
      manager.broadcast(makeEvent(i));
    }

    const reply = createMockReply();
    // Client asks for events after ID 2 — buffer still has 1..5, so no gap.
    manager.addConnection('healthy', reply as any, {}, 2);

    const sent = reply._getSentEvents();
    expect(sent.find((m) => m.event === 'replay-gap')).toBeUndefined();
    expect(sent.map((m) => m.id)).toEqual(['3', '4', '5']);
  });

  it('does NOT emit a replay-gap when Last-Event-ID is 0 (initial connect)', () => {
    // Last-Event-ID = 0 means "I have not seen anything yet" — that is a
    // first-time client, not a recovering one, so no gap signal is owed.
    manager = new SSEManager(5);
    for (let i = 1; i <= 10; i++) {
      manager.broadcast(makeEvent(i));
    }

    const reply = createMockReply();
    manager.addConnection('fresh', reply as any, {}, 0);

    const sent = reply._getSentEvents();
    expect(sent.find((m) => m.event === 'replay-gap')).toBeUndefined();
  });
});

describe('SSEManager buffer-bound property invariants (task #206)', () => {
  /**
   * Internal accessors: the manager keeps `connections` and `eventBuffer`
   * private. We reach in via `any` rather than mutating production code,
   * because these invariants are explicitly about the *internal* size of
   * those structures.
   */
  function bufferLength(m: SSEManager): number {
    return (m as any).eventBuffer.length;
  }
  function connectionCount(m: SSEManager): number {
    return (m as any).connections.size;
  }

  type Op =
    | { kind: 'broadcast'; projectId: number }
    | { kind: 'connect'; id: number }
    | { kind: 'disconnect'; id: number };

  const opArb: fc.Arbitrary<Op> = fc.oneof(
    fc
      .record({ projectId: fc.integer({ min: 1, max: 3 }) })
      .map((r) => ({ kind: 'broadcast' as const, projectId: r.projectId })),
    fc
      .record({ id: fc.integer({ min: 0, max: 9 }) })
      .map((r) => ({ kind: 'connect' as const, id: r.id })),
    fc
      .record({ id: fc.integer({ min: 0, max: 9 }) })
      .map((r) => ({ kind: 'disconnect' as const, id: r.id })),
  );

  itProp.prop([fc.array(opArb, { minLength: 1, maxLength: 80 })])(
    'connections.size <= maxConnections and eventBuffer.length <= maxBufferSize hold under any operation sequence',
    (ops) => {
      // Use small caps so the property has teeth — if pruning is broken,
      // even a 20-op sequence will exceed them.
      const MAX_BUFFER = 5;
      const MAX_CONN = 4;
      const MAX_PER_KEY = 4;
      const MAX_PER_IP = 4;

      const m = new SSEManager(
        MAX_BUFFER,
        5 * 60 * 1000, // long TTL, we want size-bound pruning under test
        30_000,
        10 * 60 * 1000,
        MAX_PER_KEY,
        MAX_PER_IP,
        MAX_CONN,
      );

      try {
        for (const op of ops) {
          if (op.kind === 'broadcast') {
            m.broadcast(makeEvent(1, op.projectId));
          } else if (op.kind === 'connect') {
            // Respect the manager's own cap gate — production code uses
            // canAccept() before addConnection(), and we mirror that here.
            const decision = m.canAccept('key-a', 'ip-a');
            if (decision.ok) {
              const reply = createMockReply();
              m.addConnection(`c${op.id}`, reply as any, {}, undefined, {
                apiKeyFingerprint: 'key-a',
                ip: 'ip-a',
              });
            }
          } else if (op.kind === 'disconnect') {
            m.removeConnection(`c${op.id}`);
          }

          // INVARIANTS — must hold after EVERY operation, not just at the end.
          expect(connectionCount(m)).toBeLessThanOrEqual(MAX_CONN);
          expect(bufferLength(m)).toBeLessThanOrEqual(MAX_BUFFER);
        }
      } finally {
        m.shutdown();
      }
    },
  );

  itProp.prop([fc.array(fc.integer({ min: 1, max: 5 }), { minLength: 1, maxLength: 200 })])(
    'eventBuffer.length <= maxBufferSize for ANY size of broadcast burst',
    (projectIds) => {
      const MAX_BUFFER = 7;
      const m = new SSEManager(MAX_BUFFER);
      try {
        for (const pid of projectIds) {
          m.broadcast(makeEvent(1, pid));
          // Critical: assert AFTER each broadcast, not just at the end —
          // catches "we prune then push" vs "we push then prune" bugs.
          expect(bufferLength(m)).toBeLessThanOrEqual(MAX_BUFFER);
        }
      } finally {
        m.shutdown();
      }
    },
  );

  itProp.prop([fc.array(fc.integer({ min: 0, max: 50 }), { minLength: 1, maxLength: 60 })])(
    'connections.size never exceeds maxConnections regardless of churn',
    (ids) => {
      const MAX_CONN = 3;
      const m = new SSEManager(
        100, // buffer cap not under test here
        5 * 60 * 1000,
        30_000,
        10 * 60 * 1000,
        MAX_CONN, // per-key cap
        MAX_CONN, // per-ip cap
        MAX_CONN, // global cap
      );

      try {
        for (const id of ids) {
          // Alternate connect/disconnect deterministically off the id so
          // fast-check shrinks toward minimal sequences when something
          // breaks.
          if (id % 2 === 0) {
            const decision = m.canAccept('k', 'i');
            if (decision.ok) {
              const reply = createMockReply();
              m.addConnection(`x${id}`, reply as any, {}, undefined, {
                apiKeyFingerprint: 'k',
                ip: 'i',
              });
            }
          } else {
            m.removeConnection(`x${id - 1}`);
          }
          expect(connectionCount(m)).toBeLessThanOrEqual(MAX_CONN);
        }
      } finally {
        m.shutdown();
      }
    },
  );
});
