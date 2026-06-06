/**
 * Phase 29 Plan 08 — OIDC-disabled mode integration tests.
 *
 * Verifies that when OIDC_ISSUER_URL is unset:
 *   1. `createServer({ dbPath: ':memory:' })` boots successfully.
 *   2. `app.oidcConfig === null`.
 *   3. /auth/login, /auth/callback, /auth/logout return 501 with body
 *      `{ error: 'oidc_disabled', message: ... }` and content-type
 *      application/json.
 *   4. /auth/error still renders HTML (200 text/html) — the page is useful
 *      even in PAT-only mode (session expiry, 403s, etc.).
 *   5. Phase 28 invariants are preserved:
 *        - legacy X-API-Key on /api/v1/tasks → 200 (or at least < 500)
 *        - PAT-authed POST /api/v1/me/tokens → 403 session_required
 *        - /health → 200 anonymous
 *
 * This is the safety-net test for MIGR-01: OIDC enablement (or the lack
 * thereof) must NOT break the existing PAT / legacy auth surface.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type Database from '../../db/driver.js';
import nock from 'nock';
import type { App } from '../../index.js';
import { resetConfig } from '../../config/env.js';
import { generateToken, hashToken } from '../../services/pat-hash.js';

// vi.mock the session strategy so PAT-only callers fall through to the
// legacy / PAT branches rather than hitting the real (Phase 29) session
// backend that we DON'T configure here. Same pattern as me-tokens.test.ts.
import type { StrategyOutcome } from '../plugins/auth/strategies/types.js';
let nextSessionResult: StrategyOutcome = { kind: 'skip' };
vi.mock('../plugins/auth/strategies/session.js', () => ({
  tryAuth: async () => nextSessionResult,
}));

describe('OIDC disabled mode (no OIDC_ISSUER_URL)', () => {
  let server: FastifyInstance;
  let app: App;
  let db: Database.Database;
  let legacyUserId: number;

  beforeAll(async () => {
    // Hard-clear all OIDC vars and session secret so the env loader sees a
    // pristine disabled configuration. resetConfig() drops the Proxy cache.
    process.env.API_KEYS = 'test-key';
    delete process.env.OIDC_ISSUER_URL;
    delete process.env.OIDC_CLIENT_ID;
    delete process.env.OIDC_CLIENT_SECRET;
    delete process.env.OIDC_REDIRECT_URI;
    delete process.env.SESSION_COOKIE_SECRET;
    resetConfig();
    // Net hygiene: nothing in this test file should make outbound calls.
    nock.disableNetConnect();
    nock.enableNetConnect('127.0.0.1');

    const { createServer } = await import('../server.js');
    const result = await createServer({ dbPath: ':memory:' });
    server = result.server;
    app = result.app;
    db = result.app.db;

    // Resolve the seeded legacy user so we can mint PATs for the
    // session_required assertion.
    const row = db
      .prepare(`SELECT id FROM users WHERE display_name = ? AND is_legacy = 1`)
      .get('key_test-key') as { id: number } | undefined;
    if (row === undefined) {
      throw new Error('seeded legacy user not found');
    }
    legacyUserId = row.id;
  });

  afterAll(async () => {
    await server.close();
    db.close();
    nock.cleanAll();
    nock.enableNetConnect();
    resetConfig();
  });

  beforeEach(() => {
    nextSessionResult = { kind: 'skip' };
  });

  it('boots and exposes oidcConfig === null on the App', () => {
    expect(app.oidcConfig).toBeNull();
  });

  it('GET /auth/login → 501 oidc_disabled (JSON)', async () => {
    const r = await server.inject({ method: 'GET', url: '/auth/login' });
    expect(r.statusCode).toBe(501);
    expect(r.headers['content-type']).toMatch(/application\/json/);
    const body = JSON.parse(r.body);
    expect(body.error).toBe('oidc_disabled');
    expect(typeof body.message).toBe('string');
  });

  it('GET /auth/callback → 501 oidc_disabled (JSON)', async () => {
    const r = await server.inject({ method: 'GET', url: '/auth/callback' });
    expect(r.statusCode).toBe(501);
    expect(r.headers['content-type']).toMatch(/application\/json/);
    expect(JSON.parse(r.body).error).toBe('oidc_disabled');
  });

  it('POST /auth/logout → 501 oidc_disabled (JSON)', async () => {
    const r = await server.inject({ method: 'POST', url: '/auth/logout' });
    expect(r.statusCode).toBe(501);
    expect(r.headers['content-type']).toMatch(/application\/json/);
    expect(JSON.parse(r.body).error).toBe('oidc_disabled');
  });

  it('GET /auth/error → 200 text/html (still functional)', async () => {
    const r = await server.inject({ method: 'GET', url: '/auth/error' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/html/);
    expect(r.body).toMatch(/Sign-in failed/);
  });

  it('GET /auth/error?reason=state_mismatch → 200 with error code footer', async () => {
    const r = await server.inject({
      method: 'GET',
      url: '/auth/error?reason=state_mismatch',
    });
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatch(/state_mismatch/);
  });

  it('legacy X-API-Key on /api/v1/tasks → 200 (Phase 28 invariant)', async () => {
    const r = await server.inject({
      method: 'GET',
      url: '/api/v1/tasks',
      headers: { 'x-api-key': 'test-key' },
    });
    expect(r.statusCode).toBe(200);
  });

  it('PAT-authed POST /api/v1/me/tokens → 403 session_required (Phase 28 invariant)', async () => {
    // Insert a PAT bound to the legacy user. Auth chain's PAT strategy will
    // admit it; the route's `sessionOnly: true` config will reject.
    const { token, prefix, suffix, hash } = generateToken();
    db.prepare(
      `INSERT INTO api_tokens (user_id, name, prefix, suffix, hash, scopes, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(legacyUserId, 'disabled-mode-probe', prefix, suffix, hash, '[]', null);
    // hashToken sanity-check — fail loudly if generation drifts.
    expect(hashToken(token)).toBe(hash);

    const r = await server.inject({
      method: 'POST',
      url: '/api/v1/me/tokens',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'should-be-rejected' },
    });
    expect(r.statusCode).toBe(403);
    const body = JSON.parse(r.body);
    // The Phase 28 error code surfaced by enforceSessionOnly.
    expect(String(body.error ?? body.code ?? '')).toMatch(/session/i);
  });

  it('GET /health → 200 (anonymous, no auth chain)', async () => {
    const r = await server.inject({ method: 'GET', url: '/health' });
    expect(r.statusCode).toBe(200);
  });
});
