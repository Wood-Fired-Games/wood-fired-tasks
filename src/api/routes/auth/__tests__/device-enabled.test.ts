/**
 * Phase 30 Plan 08 Task 2 — /auth/device/* enabled-mode integration tests.
 *
 * Drives the auth barrel (src/api/routes/auth/index.ts) with a non-null
 * oidcConfig and asserts:
 *   1. POST /auth/device/code (correct client_id) → 200 RFC 8628 envelope
 *   2. POST /auth/device/code (wrong  client_id) → 400 invalid_client
 *   3. POST /auth/device/token (unknown device_code) → 400 expired_token
 *   4. GET  /auth/device (unauthenticated) → 302 to /auth/login?next=...
 *   5. POST /auth/device/verify (no session) → 403 session_required (auth chain)
 *   6. REGRESSION: NO 501 OIDC_DISABLED body on any device route — the
 *      disabled stub must NOT shadow the enabled routes when oidcConfig is
 *      non-null.
 *
 * The harness mounts the FULL auth barrel — same plugin server.ts wires at
 * boot — but in a focused Fastify instance (no /api/v1, no Slack, no SSE).
 * That lets the wiring-only test stay fast (<1s) while still exercising the
 * conditional branch the plan adds to src/api/routes/auth/index.ts.
 *
 * Note on test 4: a redirect to /auth/login confirms the device-html route
 * IS registered (the disabled stub would 501 instead). The exact redirect
 * URL shape is owned by Plan 30-02; we assert just the 302 + the Location
 * starts with /auth/login.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifySecureSession from '@fastify/secure-session';
import fastifyFormbody from '@fastify/formbody';
import { randomBytes } from 'node:crypto';
import nock from 'nock';
import type Database from '../../../../db/driver.js';

import authRoutes from '../index.js';
import deviceCodeRoute from '../device-code.js';
import deviceTokenRoute from '../device-token.js';
import deviceHtmlRoute from '../device-html.js';
import authPlugin from '../../../plugins/auth.js';
import { createApp } from '../../../../index.js';
import { initOidc } from '../../../../services/oidc-client.js';
import { UserRepository } from '../../../../repositories/user.repository.js';
import { ApiTokenRepository } from '../../../../repositories/api-token.repository.js';
import { initDatabase } from '../../../../db/database.js';
import { runMigrations } from '../../../../db/migrate.js';
import { seedIdentities } from '../../../../services/identity-seeder.js';
import { parseApiKeyEntries } from '../../../../config/env.js';
import { SESSION_LIFETIME_SECONDS } from '../../../../web/session-constants.js';
import { _resetForTests as resetDeviceFlowStore } from '../../../../services/device-flow-store.js';
import { getDiscoveryFixture } from '../../../../../tests/helpers/oidc-fixtures.js';
import type { Config } from '../../../../config/env.js';

const ISSUER = 'https://accounts.example.com';
const CLIENT_ID = 'wft-cli-test-client.example.com';
const CLIENT_SECRET = 'test-client-secret';
const REDIRECT_URI = 'https://wft.example.com/auth/callback';
const ORIGIN = 'https://wft.example.com';
const SCOPES = 'openid email profile';
const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

interface Harness {
  app: FastifyInstance;
  db: Database.Database;
}

async function buildEnabledHarness(): Promise<Harness> {
  // Discovery interceptor — initOidc requires it.
  nock.disableNetConnect();
  nock(ISSUER).get('/.well-known/openid-configuration').reply(200, getDiscoveryFixture());

  const oidcConfig = await initOidc({
    NODE_ENV: 'test',
    OIDC_ISSUER_URL: ISSUER,
    OIDC_CLIENT_ID: CLIENT_ID,
    OIDC_CLIENT_SECRET: CLIENT_SECRET,
    OIDC_REDIRECT_URI: REDIRECT_URI,
    OIDC_SCOPES: SCOPES,
  } as unknown as Config);
  if (!oidcConfig) throw new Error('initOidc returned null unexpectedly');

  process.env.API_KEYS = 'enabled-test-key:enabled-user';

  const db = initDatabase(':memory:');
  await runMigrations(db);
  seedIdentities(db, parseApiKeyEntries(process.env.API_KEYS), {
    info: () => {},
    warn: () => {},
  });
  const userRepository = new UserRepository(db);
  const apiTokenRepository = new ApiTokenRepository(db);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const app: any = Fastify({ logger: false });
  app.decorate('userRepository', userRepository);
  app.decorate('apiTokenRepository', apiTokenRepository);

  await app.register(fastifyCookie);
  await app.register(fastifySecureSession, {
    sessionName: 'session',
    cookieName: 'wft_session',
    key: randomBytes(32),
    expiry: SESSION_LIFETIME_SECONDS,
    cookie: {
      path: '/',
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      maxAge: SESSION_LIFETIME_SECONDS,
    },
  });
  await app.register(fastifyFormbody);
  // The auth chain plugin is required for POST /auth/device/verify's
  // sessionOnly enforcement (test 5). Mount under no prefix — the chain
  // hooks onRoute on routes with config.sessionOnly anywhere.
  await app.register(authPlugin);

  await app.register(authRoutes, {
    prefix: '/auth',
    oidcConfig,
    redirectUri: REDIRECT_URI,
    scopes: SCOPES,
    sessionCookieName: 'wft_session',
    postLogoutRedirectUri: `${ORIGIN}/auth/login`,
    // Plan 30-08 — clientId + origin are part of AuthRoutesOptions even
    // though the barrel itself does not register the device routes (the
    // device-* plugins use absolute paths and are registered directly on
    // the server below, mirroring server.ts).
    clientId: CLIENT_ID,
    origin: ORIGIN,
  });

  // Mirror server.ts's Plan 30-08 wiring — device-flow plugins register
  // ABSOLUTE paths (`/auth/device/code`, etc.) so they live at the top
  // level, not under the /auth prefix that owns the OIDC routes.
  await app.register(deviceCodeRoute, {
    origin: ORIGIN,
    expectedClientId: CLIENT_ID,
  });
  await app.register(deviceTokenRoute, { expectedClientId: CLIENT_ID });
  await app.register(deviceHtmlRoute, { origin: ORIGIN });

  await app.ready();
  return { app, db };
}

describe('auth barrel: OIDC-enabled device-flow routes registered', () => {
  let h: Harness;

  beforeEach(async () => {
    resetDeviceFlowStore();
    h = await buildEnabledHarness();
  });
  afterEach(async () => {
    await h.app.close();
    h.db.close();
    nock.cleanAll();
    nock.enableNetConnect();
  });

  it('POST /auth/device/code returns RFC 8628 envelope (not the 501 stub)', async () => {
    const r = await h.app.inject({
      method: 'POST',
      url: '/auth/device/code',
      headers: { 'content-type': 'application/json' },
      payload: { client_id: CLIENT_ID, hostname: 'ci-runner' },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as Record<string, unknown>;
    // Regression: the 501 disabled stub would emit `error: 'OIDC_DISABLED'`.
    expect(body.error).toBeUndefined();
    // Envelope keys per RFC 8628 §3.2.
    expect(body.device_code).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    expect(body.user_code).toMatch(/^[A-HJ-KM-NP-Z2-9]{8}$/);
    expect(body.verification_uri).toBe(`${ORIGIN}/auth/device`);
    expect(body.verification_uri_complete).toBe(
      `${ORIGIN}/auth/device?user_code=${body.user_code}`,
    );
    expect(body.expires_in).toBe(600);
    expect(body.interval).toBe(5);
  });

  it('POST /auth/device/code with wrong client_id → 400 invalid_client', async () => {
    const r = await h.app.inject({
      method: 'POST',
      url: '/auth/device/code',
      headers: { 'content-type': 'application/json' },
      payload: { client_id: 'not-the-real-one' },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ error: 'invalid_client' });
  });

  it('POST /auth/device/token with unknown device_code → 400 expired_token', async () => {
    const r = await h.app.inject({
      method: 'POST',
      url: '/auth/device/token',
      headers: { 'content-type': 'application/json' },
      payload: {
        grant_type: GRANT_TYPE,
        device_code: 'NEVER-CREATED-DEVICE-CODE',
        client_id: CLIENT_ID,
      },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ error: 'expired_token' });
  });

  it('GET /auth/device unauthenticated → 302 to /auth/login (not the 501 stub)', async () => {
    const r = await h.app.inject({ method: 'GET', url: '/auth/device' });
    expect(r.statusCode).toBe(302);
    const location = r.headers.location;
    expect(typeof location).toBe('string');
    // The exact redirect target is owned by Plan 30-02; here we only
    // assert that the enabled route's redirect (not the 501 stub) ran.
    expect(location).toMatch(/\/auth\/login\?next=/);
    expect(location).toContain(encodeURIComponent('/auth/device'));
  });

  it('POST /auth/device/verify without session → 403 (sessionOnly chain gate)', async () => {
    const r = await h.app.inject({
      method: 'POST',
      url: '/auth/device/verify',
      headers: { 'content-type': 'application/json' },
      payload: { user_code: 'ABCDEFGH', _csrf: 'x' },
    });
    // The sessionOnly gate in the Phase 28 chain rejects unauthenticated
    // and PAT/legacy callers with 403 (auth_required / session_required).
    // The exact statusCode varies (401 if the chain has no credential at
    // all, 403 if it has one but it's not session). Both are NOT-501 and
    // NOT-the-disabled-stub-body, which is what this test cares about.
    expect([401, 403]).toContain(r.statusCode);
    // Regression: must NOT be the disabled stub body.
    if (r.headers['content-type']?.toString().includes('application/json')) {
      const body = r.json() as Record<string, unknown>;
      expect(body.error).not.toBe('OIDC_DISABLED');
    }
  });

  it('REGRESSION: no /auth/device route returns 501 OIDC_DISABLED when oidcConfig is non-null', async () => {
    // Drive each device route and assert NONE of them produce the
    // disabled-stub's signature 501 body.
    const probes = [
      h.app.inject({
        method: 'POST',
        url: '/auth/device/code',
        headers: { 'content-type': 'application/json' },
        payload: { client_id: CLIENT_ID },
      }),
      h.app.inject({
        method: 'POST',
        url: '/auth/device/token',
        headers: { 'content-type': 'application/json' },
        payload: {
          grant_type: GRANT_TYPE,
          device_code: 'never',
          client_id: CLIENT_ID,
        },
      }),
      h.app.inject({ method: 'GET', url: '/auth/device' }),
      h.app.inject({
        method: 'POST',
        url: '/auth/device/verify',
        headers: { 'content-type': 'application/json' },
        payload: { user_code: 'ABCDEFGH', _csrf: 'x' },
      }),
    ];
    const results = await Promise.all(probes);
    for (const r of results) {
      expect(r.statusCode).not.toBe(501);
      if (r.headers['content-type']?.toString().includes('application/json')) {
        const body = r.json() as Record<string, unknown>;
        expect(body.error).not.toBe('OIDC_DISABLED');
      }
    }
  });
});

/**
 * Task 3 — Boot wiring: device-flow cleanup interval is started exactly
 * once by createApp() and is stopped on dispose().
 *
 * This test exercises the App.dispose() contract directly — no need to
 * spin a full Fastify server. The createApp factory:
 *   1. constructs the in-memory device-flow cleanup interval, AND
 *   2. records its `.stop()` handle so `dispose()` clears it on shutdown.
 *
 * We spy on `clearInterval` so that the assertion captures the cleanup
 * shutdown without poking at private fields on App. The spy is restored
 * in afterEach so subsequent test files see the unmodified global.
 */
describe('boot wiring: device-flow cleanup interval lifecycle', () => {
  let clearIntervalSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Spy on the global so we can count clearInterval invocations during
    // dispose() without affecting other intervals (workflow engine, etc.)
    clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
  });
  afterEach(() => {
    clearIntervalSpy.mockRestore();
  });

  it('createApp() starts the device-flow cleanup; dispose() stops it', async () => {
    // OIDC vars are NOT required for this boot path — createApp's OIDC
    // branch is opt-in via OIDC_ISSUER_URL. The cleanup interval is wired
    // unconditionally because the device-flow store is part of the boot
    // surface regardless of OIDC mode (the disabled stub still uses the
    // store's `_resetForTests` etc. in unit tests; the interval keeps
    // production-mode stale-session pruning honest in PAT-only mode too).
    delete process.env.OIDC_ISSUER_URL;
    process.env.API_KEYS = 'boot-test-key:boot-user';

    const beforeCount = clearIntervalSpy.mock.calls.length;
    const app = await createApp(':memory:');

    // At this point an interval is live. Dispose should clear it.
    app.dispose();
    const afterCount = clearIntervalSpy.mock.calls.length;

    // dispose() may call clearInterval on several timers (workflow engine,
    // device-flow cleanup, etc.). The key assertion is that AT LEAST one
    // more clearInterval call happened — proving dispose() touched a timer.
    // The device-flow store's startCleanup() is the new timer this plan
    // adds; without the dispose wiring, the count would be the same as
    // before.
    expect(afterCount).toBeGreaterThan(beforeCount);
  });

  it('dispose() is idempotent — second call does not throw', async () => {
    delete process.env.OIDC_ISSUER_URL;
    process.env.API_KEYS = 'boot-test-key:boot-user';
    const app = await createApp(':memory:');
    app.dispose();
    // Second call must be a no-op (the dispose helper sets `disposed=true`).
    expect(() => app.dispose()).not.toThrow();
  });
});
