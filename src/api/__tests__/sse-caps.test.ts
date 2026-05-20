import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { SSEManager } from '../../events/sse-manager.js';
import { createServer } from '../server.js';
import { resetConfig } from '../../config/env.js';
import { hashKey } from '../plugins/auth.js';
import type { FastifyInstance } from 'fastify';
import type { App } from '../../index.js';

// task #194: helper to derive the same fingerprint the events route uses.
// Tests that saturate the per-key cap must hash the raw key here so the
// fingerprint matches what the route computes for inject() requests.
function fp(rawKey: string): string {
  return hashKey(rawKey).toString('hex').slice(0, 16);
}

/**
 * task #185: per-key / per-IP / global SSE connection caps.
 *
 * Two surfaces are exercised:
 * 1. `SSEManager.canAccept` / `addConnection` directly — mirrors the
 *    `sse-manager.test.ts` mock-reply pattern. This is the unit-level
 *    contract used by the route.
 * 2. The `/api/v1/events` route via `server.inject` — confirms the route
 *    actually rejects over-cap requests with 429 + Retry-After: 30.
 *    @fastify/sse does not fully support inject(), so we trigger the cap
 *    rejection by saturating the manager in-process first, then attempt
 *    an `inject` call that hits the canAccept gate BEFORE any SSE setup.
 */
function makeMockReply() {
  const raw = new EventEmitter();
  return {
    raw,
    sse: { send: () => Promise.resolve() },
  } as any;
}

describe('SSEManager connection caps (task #185)', () => {
  let manager: SSEManager;

  afterEach(() => {
    manager?.shutdown();
  });

  it('per-key cap: rejects the (N+1)th connection from the same key', () => {
    // maxPerKey=2, maxPerIp=10, maxTotal=10 — only the per-key cap should bite
    manager = new SSEManager(100, 5 * 60 * 1000, 30000, 10 * 60 * 1000, 2, 10, 10);

    manager.addConnection('c1', makeMockReply(), {}, undefined, { apiKeyFingerprint: 'A', ip: '1.1.1.1' });
    expect(manager.canAccept('A', '1.1.1.1')).toEqual({ ok: true });

    manager.addConnection('c2', makeMockReply(), {}, undefined, { apiKeyFingerprint: 'A', ip: '1.1.1.1' });
    const decision = manager.canAccept('A', '1.1.1.1');
    expect(decision.ok).toBe(false);
    if (decision.ok === false) {
      expect(decision.reason).toBe('per-key');
      expect(decision.retryAfterSeconds).toBe(30);
    }
  });

  it('per-IP cap: rejects the (N+1)th connection from the same IP (different keys)', () => {
    // maxPerKey=10, maxPerIp=2, maxTotal=10 — only the per-IP cap should bite
    manager = new SSEManager(100, 5 * 60 * 1000, 30000, 10 * 60 * 1000, 10, 2, 10);

    manager.addConnection('c1', makeMockReply(), {}, undefined, { apiKeyFingerprint: 'A', ip: '1.1.1.1' });
    manager.addConnection('c2', makeMockReply(), {}, undefined, { apiKeyFingerprint: 'B', ip: '1.1.1.1' });

    const decision = manager.canAccept('C', '1.1.1.1');
    expect(decision.ok).toBe(false);
    if (decision.ok === false) {
      expect(decision.reason).toBe('per-ip');
    }
  });

  it('global cap: rejects the (N+1)th connection regardless of key/IP', () => {
    // maxPerKey=10, maxPerIp=10, maxTotal=2 — only the global cap should bite
    manager = new SSEManager(100, 5 * 60 * 1000, 30000, 10 * 60 * 1000, 10, 10, 2);

    manager.addConnection('c1', makeMockReply(), {}, undefined, { apiKeyFingerprint: 'A', ip: '1.1.1.1' });
    manager.addConnection('c2', makeMockReply(), {}, undefined, { apiKeyFingerprint: 'B', ip: '2.2.2.2' });

    const decision = manager.canAccept('C', '3.3.3.3');
    expect(decision.ok).toBe(false);
    if (decision.ok === false) {
      expect(decision.reason).toBe('global');
    }
  });

  it('graceful cleanup: closing a connection frees a slot for a new connection', () => {
    manager = new SSEManager(100, 5 * 60 * 1000, 30000, 10 * 60 * 1000, 1, 10, 10);

    const r1 = makeMockReply();
    manager.addConnection('c1', r1, {}, undefined, { apiKeyFingerprint: 'A', ip: '1.1.1.1' });

    // Cap is 1 → second attempt rejected
    expect(manager.canAccept('A', '1.1.1.1').ok).toBe(false);

    // Simulate raw close — existing connection cleaned up gracefully
    r1.raw.emit('close');

    // Now a new connection should be accepted
    expect(manager.canAccept('A', '1.1.1.1').ok).toBe(true);
  });

  it('accepts up to but not exceeding the per-key cap', () => {
    manager = new SSEManager(100, 5 * 60 * 1000, 30000, 10 * 60 * 1000, 3, 10, 10);

    expect(manager.canAccept('A', '1.1.1.1').ok).toBe(true);
    manager.addConnection('c1', makeMockReply(), {}, undefined, { apiKeyFingerprint: 'A', ip: '1.1.1.1' });
    expect(manager.canAccept('A', '1.1.1.1').ok).toBe(true);
    manager.addConnection('c2', makeMockReply(), {}, undefined, { apiKeyFingerprint: 'A', ip: '1.1.1.1' });
    expect(manager.canAccept('A', '1.1.1.1').ok).toBe(true);
    manager.addConnection('c3', makeMockReply(), {}, undefined, { apiKeyFingerprint: 'A', ip: '1.1.1.1' });
    // 4th would exceed cap
    expect(manager.canAccept('A', '1.1.1.1').ok).toBe(false);
  });
});

describe('/api/v1/events route cap rejection (task #185)', () => {
  let server: FastifyInstance;
  let app: App;
  const originalKey = process.env.SSE_MAX_CONNECTIONS_PER_KEY;
  const originalIp = process.env.SSE_MAX_CONNECTIONS_PER_IP;
  const originalTotal = process.env.SSE_MAX_CONNECTIONS;
  const originalApiKeys = process.env.API_KEYS;

  beforeEach(async () => {
    // Tight caps so we can exhaust them in-process.
    process.env.API_KEYS = 'test-key';
    process.env.SSE_MAX_CONNECTIONS_PER_KEY = '1';
    process.env.SSE_MAX_CONNECTIONS_PER_IP = '10';
    process.env.SSE_MAX_CONNECTIONS = '10';
    resetConfig();
    const result = await createServer({ dbPath: ':memory:' });
    server = result.server;
    app = result.app;
  });

  afterEach(async () => {
    await server.close();
    app.db.close();
    if (originalKey === undefined) delete process.env.SSE_MAX_CONNECTIONS_PER_KEY;
    else process.env.SSE_MAX_CONNECTIONS_PER_KEY = originalKey;
    if (originalIp === undefined) delete process.env.SSE_MAX_CONNECTIONS_PER_IP;
    else process.env.SSE_MAX_CONNECTIONS_PER_IP = originalIp;
    if (originalTotal === undefined) delete process.env.SSE_MAX_CONNECTIONS;
    else process.env.SSE_MAX_CONNECTIONS = originalTotal;
    if (originalApiKeys === undefined) delete process.env.API_KEYS;
    else process.env.API_KEYS = originalApiKeys;
    resetConfig();
  });

  it('returns 429 + Retry-After header when the per-key cap is exceeded', async () => {
    // Saturate the per-key cap directly on the in-process manager. The
    // route's `preHandler` runs canAccept BEFORE the @fastify/sse plugin
    // wraps the handler, so the rejection short-circuits cleanly even
    // when inject() would otherwise hang on the SSE keep-alive path.
    const saturator = makeMockReply();
    server.sseManager.addConnection('saturator', saturator, {}, undefined, {
      apiKeyFingerprint: fp('test-key'),
      ip: '127.0.0.1',
    });

    // Note: we deliberately do NOT send `Accept: text/event-stream` —
    // the cap check runs in preHandler before the SSE wrap, so a normal
    // inject() works either way. Omitting it also keeps the test fast
    // because @fastify/sse never enters its heartbeat path.
    const r = await server.inject({
      method: 'GET',
      url: '/api/v1/events',
      headers: {
        'X-API-Key': 'test-key',
      },
    });

    expect(r.statusCode).toBe(429);
    expect(r.headers['retry-after']).toBe('30');
    const body = JSON.parse(r.payload);
    expect(body.error).toBe('TOO_MANY_CONNECTIONS');
    expect(body.message).toMatch(/per-key/);
    expect(body.message).toMatch(/30 seconds/);
  });

  it('returns 429 with per-IP reason when per-IP cap exceeded', async () => {
    // Reconfigure: per-IP cap = 1, per-key high. Saturate from same IP
    // with a different key so it's the IP cap, not the key cap, that
    // bites the inject request.
    await server.close();
    process.env.SSE_MAX_CONNECTIONS_PER_KEY = '10';
    process.env.SSE_MAX_CONNECTIONS_PER_IP = '1';
    process.env.SSE_MAX_CONNECTIONS = '10';
    resetConfig();
    const result = await createServer({ dbPath: ':memory:' });
    server = result.server;
    app = result.app;

    const saturator = makeMockReply();
    server.sseManager.addConnection('saturator', saturator, {}, undefined, {
      apiKeyFingerprint: fp('other-key'),
      ip: '127.0.0.1',
    });

    const r = await server.inject({
      method: 'GET',
      url: '/api/v1/events',
      headers: { 'X-API-Key': 'test-key' },
    });

    expect(r.statusCode).toBe(429);
    expect(r.headers['retry-after']).toBe('30');
    const body = JSON.parse(r.payload);
    expect(body.error).toBe('TOO_MANY_CONNECTIONS');
    expect(body.message).toMatch(/per-IP/);
  });

  it('normal authenticated subscription passes auth + cap (no 401 / no 429)', async () => {
    // No saturation — cap is not exceeded. The cap check passes in
    // preHandler. We omit Accept: text/event-stream so the route's
    // own `if (!reply.sse)` branch returns 400 quickly under inject()
    // — what matters here is that auth (401) and cap (429) BOTH
    // passed, not the SSE happy path.
    const r = await server.inject({
      method: 'GET',
      url: '/api/v1/events',
      headers: { 'X-API-Key': 'test-key' },
    });

    expect(r.statusCode).not.toBe(401);
    expect(r.statusCode).not.toBe(429);
  });
});
