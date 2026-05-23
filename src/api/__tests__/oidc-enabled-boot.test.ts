/**
 * Phase 29 Plan 08 — OIDC-enabled boot integration tests.
 *
 * Verifies that when all four OIDC_* vars (plus SESSION_COOKIE_SECRET) are
 * set:
 *   1. `createServer({ dbPath: ':memory:' })` performs discovery via nock,
 *      App.oidcConfig is non-null, and authRoutes is registered under
 *      /auth (not the disabled-stub).
 *   2. GET /auth/login returns 302 to the IdP authorization endpoint with
 *      code_challenge_method=S256, state, and the configured scopes.
 *   3. GET /auth/error still renders HTML (200 text/html) in enabled mode.
 *
 * AND a third describe block proves the exit-78 path:
 *   4. When discovery fails (nock returns 500 on the well-known endpoint),
 *      createServer rejects with an Error whose message contains "OIDC
 *      discovery failed" — proxy for the exit-78 branch (NODE_ENV=test
 *      rethrows so the test process is not killed).
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from 'vitest';
import { randomBytes } from 'crypto';
import nock from 'nock';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { App } from '../../index.js';
import { resetConfig } from '../../config/env.js';
import {
  getDiscoveryFixture,
  installOidcInterceptors,
} from '../../../tests/helpers/oidc-fixtures.js';

const ISSUER = 'https://accounts.example.com';
const CLIENT_ID = 'test-client-id.example.com';
const CLIENT_SECRET = 'test-client-secret';
const REDIRECT_URI = 'https://wfb.example.com/auth/callback';
const SCOPES = 'openid email profile';
const SESSION_SECRET = randomBytes(32).toString('base64');

function setEnabledEnv(): void {
  process.env.API_KEYS = 'test-key';
  process.env.OIDC_ISSUER_URL = ISSUER;
  process.env.OIDC_CLIENT_ID = CLIENT_ID;
  process.env.OIDC_CLIENT_SECRET = CLIENT_SECRET;
  process.env.OIDC_REDIRECT_URI = REDIRECT_URI;
  process.env.OIDC_SCOPES = SCOPES;
  process.env.SESSION_COOKIE_SECRET = SESSION_SECRET;
  // NODE_ENV must be 'test' so initOidc rethrows on discovery failure
  // instead of process.exit(78).
  process.env.NODE_ENV = 'test';
  resetConfig();
}

function clearEnabledEnv(): void {
  delete process.env.OIDC_ISSUER_URL;
  delete process.env.OIDC_CLIENT_ID;
  delete process.env.OIDC_CLIENT_SECRET;
  delete process.env.OIDC_REDIRECT_URI;
  delete process.env.SESSION_COOKIE_SECRET;
  resetConfig();
}

describe('OIDC enabled boot — happy path', () => {
  let server: FastifyInstance;
  let app: App;
  let db: Database.Database;

  beforeAll(async () => {
    setEnabledEnv();
    nock.disableNetConnect();
    nock.enableNetConnect('127.0.0.1');

    // Discovery interceptor must be installed BEFORE createServer runs
    // initOidc; the discovery doc only needs to be served once at boot.
    nock(ISSUER)
      .get('/.well-known/openid-configuration')
      .reply(200, getDiscoveryFixture());

    const { createServer } = await import('../server.js');
    const result = await createServer({ dbPath: ':memory:' });
    server = result.server;
    app = result.app;
    db = result.app.db;
  });

  afterAll(async () => {
    await server.close();
    db.close();
    nock.cleanAll();
    nock.enableNetConnect();
    clearEnabledEnv();
  });

  it('App.oidcConfig is populated after boot discovery', () => {
    expect(app.oidcConfig).not.toBeNull();
    expect(app.oidcConfig).toBeDefined();
  });

  it('GET /auth/login → 302 to the IdP authorize endpoint with PKCE+state+scopes', async () => {
    const r = await server.inject({ method: 'GET', url: '/auth/login' });
    expect(r.statusCode).toBe(302);

    const location = r.headers.location;
    expect(typeof location).toBe('string');
    const u = new URL(location as string);

    // Authorize endpoint host matches the discovery fixture.
    const expected = new URL(getDiscoveryFixture().authorization_endpoint);
    expect(u.origin).toBe(expected.origin);
    expect(u.pathname).toBe(expected.pathname);

    // Required query params per AUTH-01.
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('state')).toBeTruthy();
    expect(u.searchParams.get('scope')).toBe(SCOPES);
    expect(u.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
  });

  it('GET /auth/error → 200 text/html (still functional in enabled mode)', async () => {
    const r = await server.inject({ method: 'GET', url: '/auth/error' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/html/);
    expect(r.body).toMatch(/Sign-in failed/);
  });
});

describe('OIDC enabled boot — discovery failure exits via thrown error', () => {
  beforeEach(() => {
    setEnabledEnv();
    nock.disableNetConnect();
    nock.enableNetConnect('127.0.0.1');
  });

  afterEach(() => {
    nock.cleanAll();
    nock.enableNetConnect();
    clearEnabledEnv();
  });

  it('createServer rejects with "OIDC discovery failed" when discovery 500s (proxy for exit 78)', async () => {
    // Simulate IdP outage at boot — the well-known endpoint returns 500.
    nock(ISSUER)
      .get('/.well-known/openid-configuration')
      .reply(500, 'IdP unavailable');

    const { createServer } = await import('../server.js');
    await expect(createServer({ dbPath: ':memory:' })).rejects.toThrow(
      /OIDC discovery failed/,
    );
  });
});

// Sanity assert: the interceptor helper is intact (this is what 29-09's
// end-to-end tests will rely on).
describe('OIDC fixtures intact', () => {
  it('installOidcInterceptors is exported and callable', () => {
    expect(typeof installOidcInterceptors).toBe('function');
  });
});
