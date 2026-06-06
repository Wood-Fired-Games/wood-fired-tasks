import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { EventEmitter } from 'events';
import { SSEManager } from '../../events/sse-manager.js';
import { createServer } from '../server.js';
import { resetConfig } from '../../config/env.js';
import { generateToken } from '../../services/pat-hash.js';
import type { FastifyInstance } from 'fastify';
import type Database from '../../db/driver.js';
import type { App } from '../../index.js';

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

    manager.addConnection('c1', makeMockReply(), {}, undefined, {
      apiKeyFingerprint: 'A',
      ip: '1.1.1.1',
    });
    expect(manager.canAccept('A', '1.1.1.1')).toEqual({ ok: true });

    manager.addConnection('c2', makeMockReply(), {}, undefined, {
      apiKeyFingerprint: 'A',
      ip: '1.1.1.1',
    });
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

    manager.addConnection('c1', makeMockReply(), {}, undefined, {
      apiKeyFingerprint: 'A',
      ip: '1.1.1.1',
    });
    manager.addConnection('c2', makeMockReply(), {}, undefined, {
      apiKeyFingerprint: 'B',
      ip: '1.1.1.1',
    });

    const decision = manager.canAccept('C', '1.1.1.1');
    expect(decision.ok).toBe(false);
    if (decision.ok === false) {
      expect(decision.reason).toBe('per-ip');
    }
  });

  it('global cap: rejects the (N+1)th connection regardless of key/IP', () => {
    // maxPerKey=10, maxPerIp=10, maxTotal=2 — only the global cap should bite
    manager = new SSEManager(100, 5 * 60 * 1000, 30000, 10 * 60 * 1000, 10, 10, 2);

    manager.addConnection('c1', makeMockReply(), {}, undefined, {
      apiKeyFingerprint: 'A',
      ip: '1.1.1.1',
    });
    manager.addConnection('c2', makeMockReply(), {}, undefined, {
      apiKeyFingerprint: 'B',
      ip: '2.2.2.2',
    });

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
    manager.addConnection('c1', makeMockReply(), {}, undefined, {
      apiKeyFingerprint: 'A',
      ip: '1.1.1.1',
    });
    expect(manager.canAccept('A', '1.1.1.1').ok).toBe(true);
    manager.addConnection('c2', makeMockReply(), {}, undefined, {
      apiKeyFingerprint: 'A',
      ip: '1.1.1.1',
    });
    expect(manager.canAccept('A', '1.1.1.1').ok).toBe(true);
    manager.addConnection('c3', makeMockReply(), {}, undefined, {
      apiKeyFingerprint: 'A',
      ip: '1.1.1.1',
    });
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
    // task #393: the inject() request below authenticates via the legacy
    // x-api-key strategy, so its derived per-principal cap id is
    // `legacy:<apiKeyLabel>`. The seeded label for the bare `test-key`
    // API_KEYS entry is `key_test-key` (see auth-chain.test.ts). Saturate
    // THAT bucket so the per-key cap bites — we no longer fingerprint the
    // raw header.
    const saturator = makeMockReply();
    server.sseManager.addConnection('saturator', saturator, {}, undefined, {
      apiKeyFingerprint: 'legacy:key_test-key',
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

    // task #393: saturate from the same IP under a DIFFERENT principal id so
    // it's the per-IP cap (not per-key) that bites the legacy inject request
    // (`legacy:key_test-key`). Any distinct principal works.
    const saturator = makeMockReply();
    server.sseManager.addConnection('saturator', saturator, {}, undefined, {
      apiKeyFingerprint: 'legacy:some-other-principal',
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

/**
 * task #393: per-PRINCIPAL SSE cap attribution.
 *
 * Codex P0.1 — the events route's cap preHandler used to fingerprint the raw
 * `x-api-key` header. PAT and session principals send NO such header, so they
 * all collapsed to `fingerprintApiKey('')` and SHARED a single cap bucket.
 * The fix derives the cap identity from authenticated request state:
 *   pat:<tokenId> / session:<user.id> / legacy:<apiKeyLabel|hash>.
 *
 * This suite drives the REAL events route + `derivePrincipalId` through a
 * minimal Fastify harness whose preHandler injects a configurable principal
 * (so we can exercise PAT, session, AND legacy without OIDC cookie plumbing),
 * plus a full `createServer` PAT path to prove end-to-end PAT attribution.
 */
describe('per-principal SSE cap attribution (task #393)', () => {
  // Build a minimal Fastify instance that mounts the real events route and
  // lets the test set the authenticated principal slots before the route's
  // cap preHandler runs. The injected `sseManager` is supplied per-call so
  // each test controls the saturation state and the caps.
  async function buildPrincipalHarness(
    manager: SSEManager,
    principal: {
      authMethod: 'pat' | 'session' | 'legacy' | null;
      tokenId?: number | null;
      userId?: number | null;
      apiKeyLabel?: string;
    },
  ): Promise<FastifyInstance> {
    const Fastify = (await import('fastify')).default;
    const { validatorCompiler, serializerCompiler } = await import('fastify-type-provider-zod');
    const eventsRoute = (await import('../routes/events.js')).default;
    const server: any = Fastify();
    // The events route declares its schema via fastify-type-provider-zod, so
    // the minimal harness must register the same compilers createServer uses.
    server.setValidatorCompiler(validatorCompiler);
    server.setSerializerCompiler(serializerCompiler);
    server.decorate('sseManager', manager);
    // Match the auth-chain decorations the events route relies on.
    server.decorateRequest('user', null);
    server.decorateRequest('authMethod', null);
    server.decorateRequest('tokenId', null);
    server.decorateRequest('apiKeyLabel', undefined);
    // Simulate the auth chain populating principal slots before the route's
    // own cap preHandler runs (global preHandler hooks fire first).
    server.addHook('preHandler', async (request: any) => {
      request.authMethod = principal.authMethod;
      request.tokenId = principal.tokenId ?? null;
      if (principal.userId !== undefined && principal.userId !== null) {
        request.user = { id: principal.userId } as any;
      }
      if (principal.apiKeyLabel !== undefined) {
        request.apiKeyLabel = principal.apiKeyLabel;
      }
    });
    await server.register(eventsRoute, { prefix: '/events' });
    await server.ready();
    return server;
  }

  let manager: SSEManager;
  let harness: FastifyInstance | undefined;

  afterEach(async () => {
    if (harness) {
      await harness.close();
      harness = undefined;
    }
    manager?.shutdown();
  });

  it('PAT principal → cap keyed by pat:<tokenId> (429 when that bucket is saturated)', async () => {
    // per-key cap = 1; saturate the pat:42 bucket, then a PAT request with
    // tokenId=42 must be rejected — proving attribution came from the PAT
    // token id, not the (absent) x-api-key header.
    manager = new SSEManager(100, 5 * 60 * 1000, 30000, 10 * 60 * 1000, 1, 10, 10);
    manager.addConnection('sat', makeMockReply(), {}, undefined, {
      apiKeyFingerprint: 'pat:42',
      ip: '127.0.0.1',
    });
    harness = await buildPrincipalHarness(manager, {
      authMethod: 'pat',
      tokenId: 42,
    });
    const r = await harness.inject({ method: 'GET', url: '/events' });
    expect(r.statusCode).toBe(429);
    expect(JSON.parse(r.payload).message).toMatch(/per-key/);
  });

  it('session principal → cap keyed by session:<user.id> (429 when that bucket is saturated)', async () => {
    manager = new SSEManager(100, 5 * 60 * 1000, 30000, 10 * 60 * 1000, 1, 10, 10);
    manager.addConnection('sat', makeMockReply(), {}, undefined, {
      apiKeyFingerprint: 'session:7',
      ip: '127.0.0.1',
    });
    harness = await buildPrincipalHarness(manager, {
      authMethod: 'session',
      userId: 7,
    });
    const r = await harness.inject({ method: 'GET', url: '/events' });
    expect(r.statusCode).toBe(429);
    expect(JSON.parse(r.payload).message).toMatch(/per-key/);
  });

  it('legacy principal → cap keyed by legacy:<apiKeyLabel> (429 when that bucket is saturated)', async () => {
    manager = new SSEManager(100, 5 * 60 * 1000, 30000, 10 * 60 * 1000, 1, 10, 10);
    manager.addConnection('sat', makeMockReply(), {}, undefined, {
      apiKeyFingerprint: 'legacy:key_test-key',
      ip: '127.0.0.1',
    });
    harness = await buildPrincipalHarness(manager, {
      authMethod: 'legacy',
      apiKeyLabel: 'key_test-key',
    });
    const r = await harness.inject({ method: 'GET', url: '/events' });
    expect(r.statusCode).toBe(429);
    expect(JSON.parse(r.payload).message).toMatch(/per-key/);
  });

  it('per-principal SEPARATION: a PAT and a session principal do NOT share a cap bucket', async () => {
    // per-key cap = 1. Saturate ONLY the pat:42 bucket. A session principal
    // (session:7) must still be admitted — distinct principals get distinct
    // buckets. Under the OLD raw-header behaviour BOTH would have hashed the
    // empty x-api-key to one shared bucket and the session request would be
    // wrongly rejected with 429.
    manager = new SSEManager(100, 5 * 60 * 1000, 30000, 10 * 60 * 1000, 1, 10, 10);
    manager.addConnection('sat', makeMockReply(), {}, undefined, {
      apiKeyFingerprint: 'pat:42',
      ip: '127.0.0.1',
    });
    harness = await buildPrincipalHarness(manager, {
      authMethod: 'session',
      userId: 7,
    });
    const r = await harness.inject({ method: 'GET', url: '/events' });
    // Not 429 (cap not hit for this principal). It returns 400 because no
    // Accept: text/event-stream header → reply.sse is undefined; what matters
    // is the cap gate PASSED for the distinct principal.
    expect(r.statusCode).not.toBe(429);
    expect(r.statusCode).toBe(400);
  });

  it('per-principal SEPARATION: two distinct PAT token ids get independent caps', async () => {
    // Saturate pat:42; pat:99 must still be admitted.
    manager = new SSEManager(100, 5 * 60 * 1000, 30000, 10 * 60 * 1000, 1, 10, 10);
    manager.addConnection('sat', makeMockReply(), {}, undefined, {
      apiKeyFingerprint: 'pat:42',
      ip: '127.0.0.1',
    });
    harness = await buildPrincipalHarness(manager, {
      authMethod: 'pat',
      tokenId: 99,
    });
    const r = await harness.inject({ method: 'GET', url: '/events' });
    expect(r.statusCode).not.toBe(429);
    expect(r.statusCode).toBe(400);
  });
});

/**
 * task #393: end-to-end PAT SSE attribution via the full createServer stack.
 * Proves the route derives `pat:<tokenId>` from a REAL PAT auth match (not the
 * raw header) and that a saturated PAT bucket rejects the matching PAT while a
 * saturated legacy bucket does NOT bleed into the PAT principal.
 */
describe('/api/v1/events PAT principal end-to-end (task #393)', () => {
  let server: FastifyInstance;
  let app: App;
  let db: Database.Database;
  let patTokenId: number;
  let patToken: string;
  const originalKey = process.env.SSE_MAX_CONNECTIONS_PER_KEY;
  const originalIp = process.env.SSE_MAX_CONNECTIONS_PER_IP;
  const originalTotal = process.env.SSE_MAX_CONNECTIONS;
  const originalApiKeys = process.env.API_KEYS;

  beforeAll(async () => {
    process.env.API_KEYS = 'test-key';
    process.env.SSE_MAX_CONNECTIONS_PER_KEY = '1';
    process.env.SSE_MAX_CONNECTIONS_PER_IP = '50';
    process.env.SSE_MAX_CONNECTIONS = '50';
    resetConfig();
    const result = await createServer({ dbPath: ':memory:' });
    server = result.server;
    app = result.app;
    db = result.app.db;

    // Mint a PAT row tied to the seeded legacy user (any real users.id works).
    const legacyUser = db.prepare('SELECT id FROM users WHERE is_legacy = 1 LIMIT 1').get() as {
      id: number;
    };
    const { token, prefix, suffix, hash } = generateToken();
    const info = db
      .prepare(
        `INSERT INTO api_tokens (user_id, name, prefix, suffix, hash, scopes)
         VALUES (?, 'sse-test', ?, ?, ?, '[]')`,
      )
      .run(legacyUser.id, prefix, suffix, hash);
    patTokenId = Number(info.lastInsertRowid);
    patToken = token;
  });

  afterAll(async () => {
    await server.close();
    db.close();
    if (originalKey === undefined) delete process.env.SSE_MAX_CONNECTIONS_PER_KEY;
    else process.env.SSE_MAX_CONNECTIONS_PER_KEY = originalKey;
    if (originalIp === undefined) delete process.env.SSE_MAX_CONNECTIONS_PER_IP;
    else process.env.SSE_MAX_CONNECTIONS_PER_IP = originalIp;
    if (originalTotal === undefined) delete process.env.SSE_MAX_CONNECTIONS;
    else process.env.SSE_MAX_CONNECTIONS = originalTotal;
    if (originalApiKeys === undefined) delete process.env.API_KEYS;
    else process.env.API_KEYS = originalApiKeys;
    resetConfig();
    void app;
  });

  it('saturating pat:<tokenId> rejects the matching PAT request with 429 per-key', async () => {
    server.sseManager.addConnection('sat-pat', makeMockReply(), {}, undefined, {
      apiKeyFingerprint: `pat:${patTokenId}`,
      ip: '127.0.0.1',
    });
    const r = await server.inject({
      method: 'GET',
      url: '/api/v1/events',
      headers: { authorization: `Bearer ${patToken}` },
    });
    expect(r.statusCode).toBe(429);
    expect(JSON.parse(r.payload).message).toMatch(/per-key/);
    server.sseManager.removeConnection('sat-pat');
  });

  it('a saturated legacy bucket does NOT reject the PAT principal (no shared empty bucket)', async () => {
    // Saturate the legacy:key_test-key bucket. Under the old behaviour both
    // legacy and PAT collapsed to fingerprintApiKey('') and this would 429
    // the PAT. Now the PAT is keyed pat:<id>, so it passes the cap gate.
    server.sseManager.addConnection('sat-legacy', makeMockReply(), {}, undefined, {
      apiKeyFingerprint: 'legacy:key_test-key',
      ip: '127.0.0.1',
    });
    const r = await server.inject({
      method: 'GET',
      url: '/api/v1/events',
      headers: { authorization: `Bearer ${patToken}` },
    });
    expect(r.statusCode).not.toBe(429);
    expect(r.statusCode).not.toBe(401);
    server.sseManager.removeConnection('sat-legacy');
  });
});
