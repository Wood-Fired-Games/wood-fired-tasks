/**
 * Phase 29 Plan 07 — content-negotiation tests for POST /api/v1/me/tokens
 * AND the revoke flow at POST /me/tokens/:id/revoke.
 *
 * Covers WEB-02 (mint via HTML form), WEB-03 (one-shot minted-token
 * flash), and AUTH-06 (CSRF protection) end-to-end.
 *
 * Test harness:
 *   - Real Fastify server (createServer with SESSION_COOKIE_SECRET set).
 *   - Probe route /_test/sign-in stamps session.user so the Phase 28
 *     /api/v1 chain admits the request as session-authed. The Phase 28
 *     session strategy is a stub that returns `{ kind: 'skip' }`, so we
 *     ALSO inject a vi.mock for the strategy that returns the
 *     match-shape when our cookie is present. The cookie itself carries
 *     `session.user` (consumed by the web routes' in-handler session
 *     check + by the mocked strategy via shared session state).
 *
 * cheerio asserts DOM structure post-redirect.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from 'vitest';
import { randomBytes } from 'crypto';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import * as cheerio from 'cheerio';
import type {
  AuthenticatedUser,
  AuthResult,
} from '../../../../types/identity.js';
import type { StrategyOutcome } from '../../../plugins/auth/strategies/types.js';
import { resetConfig } from '../../../../config/env.js';
import { extractSessionCookie } from '../../../../../tests/helpers/session-cookie.js';

// ─── Session-strategy mock ──────────────────────────────────────────────────
// The Phase 28 stub at strategies/session.js returns `{ kind: 'skip' }`
// unconditionally, so the /api/v1/me/tokens POST would fall through to
// legacy / no-auth even when our probe-route stamped `session.user`. We
// mock the strategy so it inspects request.session.get('user') at runtime
// and returns a real `match` outcome. This keeps the test self-contained
// without waiting for Plan 29-05's real-session-strategy implementation.
let stubAuthenticatedUser: AuthenticatedUser | null = null;

vi.mock('../../../plugins/auth/strategies/session.js', () => ({
  tryAuth: async (request: {
    session?: { get: (k: string) => unknown };
  }): Promise<StrategyOutcome> => {
    const sessUser = request.session?.get('user') as
      | AuthenticatedUser
      | undefined;
    if (!sessUser && !stubAuthenticatedUser) return { kind: 'skip' };
    const user = (sessUser ?? stubAuthenticatedUser)!;
    const result: AuthResult = {
      user,
      authMethod: 'session',
      tokenId: null,
    };
    return { kind: 'match', result };
  },
}));

const validSecret32 = randomBytes(32).toString('base64');

interface Harness {
  server: FastifyInstance;
  db: Database.Database;
  userId: number;
}

describe('Phase 29 Plan 07 — content negotiation + revoke flow', () => {
  let harness: Harness;
  let sessionCookie: string;
  let csrfToken: string;

  beforeAll(async () => {
    process.env.API_KEYS = 'test-key';
    process.env.SESSION_COOKIE_SECRET = validSecret32;
    delete process.env.NODE_ENV;
    resetConfig();
    const { createServer } = await import('../../../server.js');
    const result = await createServer({ dbPath: ':memory:' });
    const server = result.server;
    const db = result.app.db;

    // Probe: stamp session.user so the mocked strategy + web routes
    // both see the same user.
    server.post(
      '/_test/sign-in',
      { config: { skipAuth: true } },
      async (request, reply) => {
        const body = request.body as {
          id: number;
          displayName: string;
          email: string | null;
        };
        request.session.set('user', {
          id: body.id,
          displayName: body.displayName,
          email: body.email,
          isLegacy: false,
          isServiceAccount: false,
        });
        request.session.set('authenticatedAt', Date.now());
        return reply.send({ ok: true });
      },
    );
    await server.ready();

    const userInfo = db
      .prepare('INSERT INTO users (display_name, email) VALUES (?, ?)')
      .run('Mint Tester', 'mint@example.com');
    const userId = Number(userInfo.lastInsertRowid);
    stubAuthenticatedUser = {
      id: userId,
      displayName: 'Mint Tester',
      email: 'mint@example.com',
      isLegacy: false,
      isServiceAccount: false,
    };

    harness = { server, db, userId };

    const signInRes = await server.inject({
      method: 'POST',
      url: '/_test/sign-in',
      payload: {
        id: userId,
        displayName: 'Mint Tester',
        email: 'mint@example.com',
      },
    });
    const cookie = extractSessionCookie(signInRes);
    expect(cookie).not.toBeNull();
    sessionCookie = cookie!;

    // Prime CSRF token by loading the tokens page once (the page handler
    // calls getOrCreateCsrfToken). Parse out the token from the page.
    const primer = await harness.server.inject({
      method: 'GET',
      url: '/me/tokens',
      headers: { cookie: sessionCookie },
    });
    expect(primer.statusCode).toBe(200);
    // Update cookie with the new one carrying csrf — secure-session
    // re-issues the cookie when the session is mutated.
    const refreshed = extractSessionCookie(primer);
    if (refreshed) sessionCookie = refreshed;
    const $ = cheerio.load(primer.body);
    csrfToken = $('form[action="/api/v1/me/tokens"]')
      .find('input[name="_csrf"]')
      .attr('value')!;
    expect(csrfToken).toMatch(/^[0-9a-f]{64}$/);
  });

  afterAll(async () => {
    await harness.server.close();
    harness.db.close();
    delete process.env.SESSION_COOKIE_SECRET;
    resetConfig();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    harness.db.prepare('DELETE FROM api_tokens').run();
  });

  // -------------------------------------------------------------------------
  // 1. HTML form mint → 303 redirect to /me/tokens?just_minted=N
  // -------------------------------------------------------------------------
  it('POST /api/v1/me/tokens with Accept: text/html + valid CSRF → 303 redirect to /me/tokens', async () => {
    const res = await harness.server.inject({
      method: 'POST',
      url: '/api/v1/me/tokens',
      headers: {
        cookie: sessionCookie,
        accept: 'text/html,application/xhtml+xml',
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: `_csrf=${csrfToken}&name=html-minted`,
    });

    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toMatch(/^\/me\/tokens\?just_minted=\d+$/);
    expect(res.headers['cache-control']).toBe('no-store');

    // The token row was persisted.
    const count = harness.db
      .prepare(
        "SELECT COUNT(*) as c FROM api_tokens WHERE name = 'html-minted'",
      )
      .get() as { c: number };
    expect(count.c).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 2. Follow the redirect: minted-token aside renders ONCE
  // -------------------------------------------------------------------------
  it('follows the redirect; .minted-token aside shows the full token + Copy button + warning', async () => {
    const mintRes = await harness.server.inject({
      method: 'POST',
      url: '/api/v1/me/tokens',
      headers: {
        cookie: sessionCookie,
        accept: 'text/html',
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: `_csrf=${csrfToken}&name=flash-token`,
    });
    expect(mintRes.statusCode).toBe(303);

    // secure-session re-issues the cookie when the session is mutated
    // (session.mintedToken was just set). Use the fresh cookie.
    const postMintCookie = extractSessionCookie(mintRes) ?? sessionCookie;

    const followRes = await harness.server.inject({
      method: 'GET',
      url: mintRes.headers.location as string,
      headers: { cookie: postMintCookie },
    });
    expect(followRes.statusCode).toBe(200);

    const $ = cheerio.load(followRes.body);
    const aside = $('aside.minted-token');
    expect(aside.length).toBe(1);
    expect(aside.text()).toMatch(/wfb_pat_[A-Z2-7]{32}/);
    expect(aside.text()).toContain('will not be shown again');
    // Copy button present.
    const copyBtn = aside.find('button');
    expect(copyBtn.length).toBeGreaterThanOrEqual(1);
    expect(copyBtn.text()).toContain('Copy');
  });

  // -------------------------------------------------------------------------
  // 3. Refresh after flash → aside is GONE (one-shot)
  // -------------------------------------------------------------------------
  it('refreshing /me/tokens after the post-mint render does NOT show the flash again', async () => {
    const mintRes = await harness.server.inject({
      method: 'POST',
      url: '/api/v1/me/tokens',
      headers: {
        cookie: sessionCookie,
        accept: 'text/html',
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: `_csrf=${csrfToken}&name=one-shot-token`,
    });
    expect(mintRes.statusCode).toBe(303);
    const postMintCookie = extractSessionCookie(mintRes) ?? sessionCookie;

    // First GET — consumes the flash.
    const firstGet = await harness.server.inject({
      method: 'GET',
      url: '/me/tokens',
      headers: { cookie: postMintCookie },
    });
    expect(firstGet.statusCode).toBe(200);
    expect(cheerio.load(firstGet.body)('aside.minted-token').length).toBe(1);

    // Use the refreshed cookie from the first GET — flash-and-clear
    // mutated the session so secure-session re-issued Set-Cookie.
    const refreshedCookie = extractSessionCookie(firstGet) ?? postMintCookie;

    // Second GET — flash is gone.
    const secondGet = await harness.server.inject({
      method: 'GET',
      url: '/me/tokens',
      headers: { cookie: refreshedCookie },
    });
    expect(secondGet.statusCode).toBe(200);
    expect(cheerio.load(secondGet.body)('aside.minted-token').length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 4. Wrong CSRF → 403
  // -------------------------------------------------------------------------
  it('POST with Accept: text/html + WRONG _csrf → 403 csrf_invalid', async () => {
    const bogus = 'a'.repeat(64);
    const res = await harness.server.inject({
      method: 'POST',
      url: '/api/v1/me/tokens',
      headers: {
        cookie: sessionCookie,
        accept: 'text/html',
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: `_csrf=${bogus}&name=should-not-mint`,
    });

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('csrf_invalid');

    const count = harness.db
      .prepare(
        "SELECT COUNT(*) as c FROM api_tokens WHERE name = 'should-not-mint'",
      )
      .get() as { c: number };
    expect(count.c).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 5. Phase 28 invariant: JSON contract on POST /api/v1/me/tokens unchanged
  // -------------------------------------------------------------------------
  it('POST with Accept: application/json (existing JSON contract) → 201 + body.token preserved', async () => {
    const res = await harness.server.inject({
      method: 'POST',
      url: '/api/v1/me/tokens',
      headers: {
        cookie: sessionCookie,
        accept: 'application/json',
      },
      payload: { name: 'json-minted' },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.name).toBe('json-minted');
    expect(typeof body.token).toBe('string');
    expect(body.token).toMatch(/^wfb_pat_[A-Z2-7]{32}$/);
    expect(body.prefix).toBe('wfb_pat_');
  });

  // -------------------------------------------------------------------------
  // 6. Revoke via POST /me/tokens/:id/revoke → 303; row moves to Revoked section
  // -------------------------------------------------------------------------
  it('POST /me/tokens/:id/revoke with valid CSRF → 303; revoked row appears in Revoked tokens section', async () => {
    // Mint via JSON for speed (and to keep the test independent of the
    // HTML branch being broken).
    const mintRes = await harness.server.inject({
      method: 'POST',
      url: '/api/v1/me/tokens',
      headers: {
        cookie: sessionCookie,
        accept: 'application/json',
      },
      payload: { name: 'to-be-revoked' },
    });
    expect(mintRes.statusCode).toBe(201);
    const mintBody = JSON.parse(mintRes.body);
    const tokenId = mintBody.id as number;

    // Revoke.
    const revokeRes = await harness.server.inject({
      method: 'POST',
      url: `/me/tokens/${tokenId}/revoke`,
      headers: {
        cookie: sessionCookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: `_csrf=${csrfToken}`,
    });
    expect(revokeRes.statusCode).toBe(303);
    expect(revokeRes.headers.location).toBe('/me/tokens');

    // Verify the row's revoked_at is set.
    const row = harness.db
      .prepare('SELECT revoked_at FROM api_tokens WHERE id = ?')
      .get(tokenId) as { revoked_at: string | null };
    expect(row.revoked_at).not.toBeNull();

    // Subsequent GET shows it under "Revoked tokens".
    const followCookie = extractSessionCookie(revokeRes) ?? sessionCookie;
    const followRes = await harness.server.inject({
      method: 'GET',
      url: '/me/tokens',
      headers: { cookie: followCookie },
    });
    expect(followRes.statusCode).toBe(200);
    const $ = cheerio.load(followRes.body);
    const h2s = $('h2')
      .map((_i, el) => $(el).text())
      .get();
    expect(h2s).toContain('Revoked tokens');
    const revokedRow = $('tr.revoked');
    expect(revokedRow.length).toBe(1);
    expect(revokedRow.text()).toContain('to-be-revoked');
  });

  // -------------------------------------------------------------------------
  // 7. Revoke with WRONG csrf → 403
  // -------------------------------------------------------------------------
  it('POST /me/tokens/:id/revoke with WRONG _csrf → 403 csrf_invalid', async () => {
    const mintRes = await harness.server.inject({
      method: 'POST',
      url: '/api/v1/me/tokens',
      headers: { cookie: sessionCookie, accept: 'application/json' },
      payload: { name: 'csrf-test' },
    });
    const tokenId = JSON.parse(mintRes.body).id as number;

    const res = await harness.server.inject({
      method: 'POST',
      url: `/me/tokens/${tokenId}/revoke`,
      headers: {
        cookie: sessionCookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: `_csrf=${'b'.repeat(64)}`,
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toBe('csrf_invalid');

    // Row NOT revoked.
    const row = harness.db
      .prepare('SELECT revoked_at FROM api_tokens WHERE id = ?')
      .get(tokenId) as { revoked_at: string | null };
    expect(row.revoked_at).toBeNull();
  });
});
