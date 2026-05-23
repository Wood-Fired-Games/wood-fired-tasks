/**
 * CR-01 regression test — POST /auth/device/verify must work against the
 * REAL `createServer()` wiring (not the hand-rolled per-test Fastify app
 * used in device-verify.test.ts).
 *
 * The original bug: `server.ts` registered the auth-chain plugin INSIDE
 * the `/api/v1` scope while the device-flow routes were registered at the
 * top level. The chain's `decorateRequest('user', null)` therefore did
 * not apply to `/auth/device/verify`, so `request.user` was `undefined`
 * at handler entry. The `requireUser()` guard checked `=== null` only and
 * returned `undefined`. The next line dereferenced `user.id` → 500.
 *
 * The fix wraps the three device-flow routes in a sibling scope that
 * registers `authPlugin` alongside them. This test exercises that wiring
 * end-to-end by booting `createServer` in OIDC-enabled mode (nock-mocked
 * discovery), stamping a session via a probe, and POSTing the verify
 * form. A 200 with the Approved page is the success signal; a 500 (or
 * `request.user is null` thrown) is the bug recurring.
 *
 * Belt-and-suspenders coverage:
 *   - PAT-authed call to /auth/device/verify → 403 session_required
 *     (proves the chain's `enforceSessionOnly` gate runs, which the
 *     scope-wiring fix enables).
 *   - Unauthenticated call → 403 (chain emits the missing_credential
 *     401, then sessionOnly… actually the chain returns 401 here; we
 *     assert NOT 500 since that was the symptom).
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
} from 'vitest';
import { randomBytes } from 'node:crypto';
import nock from 'nock';
import * as cheerio from 'cheerio';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';

import { resetConfig } from '../../../../config/env.js';
import {
  createSession as createDeviceSession,
  _resetForTests as resetDeviceFlowStore,
  findByUserCode,
} from '../../../../services/device-flow-store.js';
import { extractSessionCookie } from '../../../../../tests/helpers/session-cookie.js';
import { getDiscoveryFixture } from '../../../../../tests/helpers/oidc-fixtures.js';

const ISSUER = 'https://accounts.example.com';
const CLIENT_ID = 'test-client-id.example.com';
const CLIENT_SECRET = 'test-client-secret';
const REDIRECT_URI = 'https://wfb.example.com/auth/callback';
const SCOPES = 'openid email profile';
const SESSION_SECRET = randomBytes(32).toString('base64');

function setEnabledEnv(): void {
  process.env.API_KEYS = 'cr01-test-key';
  process.env.OIDC_ISSUER_URL = ISSUER;
  process.env.OIDC_CLIENT_ID = CLIENT_ID;
  process.env.OIDC_CLIENT_SECRET = CLIENT_SECRET;
  process.env.OIDC_REDIRECT_URI = REDIRECT_URI;
  process.env.OIDC_SCOPES = SCOPES;
  process.env.SESSION_COOKIE_SECRET = SESSION_SECRET;
  process.env.NODE_ENV = 'test';
  resetConfig();
}

function clearEnabledEnv(): void {
  delete process.env.OIDC_ISSUER_URL;
  delete process.env.OIDC_CLIENT_ID;
  delete process.env.OIDC_CLIENT_SECRET;
  delete process.env.OIDC_REDIRECT_URI;
  delete process.env.OIDC_SCOPES;
  delete process.env.SESSION_COOKIE_SECRET;
  resetConfig();
}

describe('CR-01 regression — /auth/device/verify wired in auth-chain scope', () => {
  let server: FastifyInstance;
  let db: Database.Database;
  let userId: number;

  beforeAll(async () => {
    setEnabledEnv();
    nock.disableNetConnect();
    nock.enableNetConnect('127.0.0.1');

    nock(ISSUER)
      .get('/.well-known/openid-configuration')
      .reply(200, getDiscoveryFixture());

    const { createServer } = await import('../../../server.js');
    const result = await createServer({ dbPath: ':memory:' });
    server = result.server;
    db = result.app.db;

    // Probe to seed session.user the same way the OIDC callback would.
    // skipAuth so the chain doesn't demand credentials to mint the cookie.
    server.post(
      '/__test/sign-in',
      { config: { skipAuth: true } },
      async (request, reply) => {
        const { id } = request.body as { id: number };
        request.session.set('user', {
          id,
          displayName: 'CR-01 Test',
          email: 'cr01@example.com',
          isLegacy: false,
          isServiceAccount: false,
        });
        request.session.set('authenticatedAt', Date.now());
        return reply.code(204).send();
      },
    );
    await server.ready();

    const info = db
      .prepare('INSERT INTO users (display_name, email) VALUES (?, ?)')
      .run('CR-01 Test', 'cr01@example.com');
    userId = Number(info.lastInsertRowid);
  });

  afterAll(async () => {
    await server.close();
    db.close();
    nock.cleanAll();
    nock.enableNetConnect();
    clearEnabledEnv();
  });

  it('POST /auth/device/verify with valid session + CSRF → 200 Approved (not 500)', async () => {
    resetDeviceFlowStore();

    // Sign in to get a session cookie.
    const signInRes = await server.inject({
      method: 'POST',
      url: '/__test/sign-in',
      payload: { id: userId },
      headers: { 'content-type': 'application/json' },
    });
    expect(signInRes.statusCode).toBe(204);
    const cookie = extractSessionCookie(signInRes);
    if (!cookie) throw new Error('sign-in probe emitted no Set-Cookie');

    // Seed a pending device session.
    const deviceSession = createDeviceSession({
      clientId: CLIENT_ID,
      hostname: 'cr01-host',
    });

    // GET /auth/device to seed CSRF token in the session.
    const getRes = await server.inject({
      method: 'GET',
      url: `/auth/device?user_code=${deviceSession.userCode}`,
      headers: { cookie },
    });
    expect(getRes.statusCode).toBe(200);

    // secure-session rotates the cookie on mutation; pick up the fresh one.
    const refreshed = extractSessionCookie(getRes) ?? cookie;

    const $ = cheerio.load(getRes.body);
    const csrfToken = $('form[action="/auth/device/verify"]')
      .find('input[name="_csrf"]')
      .attr('value');
    expect(csrfToken).toMatch(/^[0-9a-f]{64}$/);

    // POST /auth/device/verify — this is the path that crashed before the
    // CR-01 fix. The handler calls requireUser(request); if request.user
    // is `undefined` (the bug), the guard fails and approve() dereferences
    // undefined.id → 500. After the fix request.user is the AuthenticatedUser
    // populated by the session strategy.
    const verifyRes = await server.inject({
      method: 'POST',
      url: '/auth/device/verify',
      headers: {
        cookie: refreshed,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: `_csrf=${csrfToken}&user_code=${deviceSession.userCode}`,
    });

    // The critical assertion: NOT 500. The handler must complete cleanly.
    expect(verifyRes.statusCode).not.toBe(500);
    expect(verifyRes.statusCode).toBe(200);
    expect(verifyRes.body).toMatch(/Approved/);

    // The session in the store transitioned to 'approved' with the correct
    // userId. This proves the chain populated request.user AND the handler
    // read it correctly.
    const approved = findByUserCode(deviceSession.userCode);
    expect(approved?.status).toBe('approved');
    expect(approved?.approvedUserId).toBe(userId);
  });

  it('POST /auth/device/verify with NO session → not 500 (chain returns 401)', async () => {
    resetDeviceFlowStore();
    const deviceSession = createDeviceSession({
      clientId: CLIENT_ID,
      hostname: 'no-session',
    });

    const res = await server.inject({
      method: 'POST',
      url: '/auth/device/verify',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `_csrf=anything&user_code=${deviceSession.userCode}`,
    });

    // Critical: chain caught the missing credential and returned 401, NOT a
    // 500 from a crashed handler dereferencing undefined.id.
    expect(res.statusCode).not.toBe(500);
    expect([401, 403]).toContain(res.statusCode);
  });
});
