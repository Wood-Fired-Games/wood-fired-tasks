/**
 * Phase 29 Plan 07 — DOM-structure integration tests for the HTML web
 * pages (/login, /me, /me/tokens).
 *
 * The tests run against a real Fastify server (createServer with
 * SESSION_COOKIE_SECRET set) so secure-session, formbody, and the
 * /api/v1 chain are all live. Session-presence is faked by setting
 * `session.user` via a probe route (matches the pattern used by
 * 29-04 session-plugins.test.ts) and replaying the resulting cookie.
 *
 * cheerio is used to assert structure (form actions, link hrefs,
 * CSRF input presence). NO visual regression.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'crypto';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import * as cheerio from 'cheerio';
import { resetConfig } from '../../../../config/env.js';
import { extractSessionCookie } from '../../../../../tests/helpers/session-cookie.js';
import { generateToken } from '../../../../services/pat-hash.js';

const validSecret32 = randomBytes(32).toString('base64');

interface Harness {
  server: FastifyInstance;
  db: Database.Database;
  userId: number;
}

/**
 * Insert a row directly via SQL and stamp it with explicit createdAt so
 * the listByUser ORDER BY is deterministic across consecutive inserts.
 */
function seedToken(
  db: Database.Database,
  opts: {
    userId: number;
    name: string;
    revoked?: boolean;
    createdAt?: string;
  },
): { id: number } {
  const { prefix, suffix, hash } = generateToken();
  const info = db
    .prepare(
      `INSERT INTO api_tokens (user_id, name, prefix, suffix, hash, scopes, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, '[]', NULL, ?)`,
    )
    .run(
      opts.userId,
      opts.name,
      prefix,
      suffix,
      hash,
      opts.createdAt ?? new Date().toISOString(),
    );
  const id = Number(info.lastInsertRowid);
  if (opts.revoked) {
    db.prepare(
      "UPDATE api_tokens SET revoked_at = datetime('now') WHERE id = ?",
    ).run(id);
  }
  return { id };
}

describe('Phase 29 Plan 07 — web pages (DOM structure)', () => {
  let harness: Harness;
  let sessionCookie: string;

  beforeAll(async () => {
    process.env.API_KEYS = 'test-key';
    process.env.SESSION_COOKIE_SECRET = validSecret32;
    delete process.env.NODE_ENV;
    resetConfig();
    const { createServer } = await import('../../../server.js');
    const result = await createServer({ dbPath: ':memory:' });
    const server = result.server;
    const db = result.app.db;

    // Probe route: set session.user for tests. Mounted at top level so it
    // shares the secure-session scope.
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

    // Insert a real user row so apiTokenRepository writes have a valid FK.
    const userInfo = db
      .prepare('INSERT INTO users (display_name, email) VALUES (?, ?)')
      .run('Test User <html>', 'test@example.com');
    const userId = Number(userInfo.lastInsertRowid);

    harness = { server, db, userId };

    // Sign in and capture the encrypted session cookie for downstream tests.
    const signInRes = await server.inject({
      method: 'POST',
      url: '/_test/sign-in',
      payload: {
        id: userId,
        displayName: 'Test User <html>',
        email: 'test@example.com',
      },
    });
    expect(signInRes.statusCode).toBe(200);
    const cookie = extractSessionCookie(signInRes);
    expect(cookie).not.toBeNull();
    sessionCookie = cookie!;
  });

  afterAll(async () => {
    await harness.server.close();
    harness.db.close();
    delete process.env.SESSION_COOKIE_SECRET;
    resetConfig();
  });

  // -------------------------------------------------------------------------
  // GET /login
  // -------------------------------------------------------------------------
  describe('GET /login', () => {
    it('returns 200 + text/html + Cache-Control no-store; has Sign-in link', async () => {
      const res = await harness.server.inject({ method: 'GET', url: '/login' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.headers['cache-control']).toBe('no-store');

      const $ = cheerio.load(res.body);
      const link = $('a[href^="/auth/login"]');
      expect(link.length).toBeGreaterThanOrEqual(1);
      expect(link.first().text()).toContain('Sign in with Google');
    });

    it('forwards ?next=... into the /auth/login href', async () => {
      const res = await harness.server.inject({
        method: 'GET',
        url: '/login?next=/me/tokens',
      });
      expect(res.statusCode).toBe(200);
      const $ = cheerio.load(res.body);
      const href = $('a[href^="/auth/login"]').first().attr('href');
      expect(href).toContain('next=');
      expect(href).toContain(encodeURIComponent('/me/tokens'));
    });
  });

  // -------------------------------------------------------------------------
  // GET /me
  // -------------------------------------------------------------------------
  describe('GET /me', () => {
    it('redirects to /auth/login?next=/me when no session present', async () => {
      const res = await harness.server.inject({ method: 'GET', url: '/me' });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/auth/login?next=/me');
    });

    it('renders the displayName (HTML-escaped), email, and logout form with CSRF', async () => {
      const res = await harness.server.inject({
        method: 'GET',
        url: '/me',
        headers: { cookie: sessionCookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.headers['cache-control']).toBe('no-store');

      // displayName MUST be HTML-escaped (we deliberately injected <html>
      // in the name to verify XSS protection).
      expect(res.body).toContain('Test User &lt;html&gt;');
      expect(res.body).not.toContain('Test User <html>');

      const $ = cheerio.load(res.body);
      // The h1 contains the (decoded) displayName.
      expect($('h1').text()).toContain('Test User <html>');
      // Email row.
      expect(res.body).toContain('test@example.com');

      // Logout form: POST /auth/logout, CSRF hidden input present.
      const form = $('form[action="/auth/logout"]');
      expect(form.length).toBe(1);
      expect(form.attr('method')?.toLowerCase()).toBe('post');
      const csrfInput = form.find('input[name="_csrf"]');
      expect(csrfInput.length).toBe(1);
      const csrfValue = csrfInput.attr('value');
      expect(csrfValue).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  // -------------------------------------------------------------------------
  // GET /me/tokens
  // -------------------------------------------------------------------------
  describe('GET /me/tokens', () => {
    it('redirects to /auth/login?next=/me/tokens when no session present', async () => {
      const res = await harness.server.inject({
        method: 'GET',
        url: '/me/tokens',
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/auth/login?next=/me/tokens');
    });

    it('lists active tokens with revoke forms, AND the New-token form action is /api/v1/me/tokens (B1)', async () => {
      // Wipe state — other tests in the suite may have seeded.
      harness.db.prepare('DELETE FROM api_tokens').run();
      seedToken(harness.db, {
        userId: harness.userId,
        name: 'first-pat',
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      seedToken(harness.db, {
        userId: harness.userId,
        name: 'second-pat',
        createdAt: '2026-02-01T00:00:00.000Z',
      });

      const res = await harness.server.inject({
        method: 'GET',
        url: '/me/tokens',
        headers: { cookie: sessionCookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');

      const $ = cheerio.load(res.body);

      // PLAN-CHECK B1: New-token form action MUST be /api/v1/me/tokens.
      const newForm = $('form[action="/api/v1/me/tokens"]');
      expect(newForm.length).toBe(1);
      expect(newForm.attr('method')?.toLowerCase()).toBe('post');
      // Name field required; CSRF hidden input present.
      expect(newForm.find('input[name="name"]').length).toBe(1);
      expect(newForm.find('input[name="_csrf"]').length).toBe(1);
      const csrfValue = newForm.find('input[name="_csrf"]').attr('value');
      expect(csrfValue).toMatch(/^[0-9a-f]{64}$/);

      // Revoke forms: one per active token, action /me/tokens/:id/revoke.
      const revokeForms = $('form[action^="/me/tokens/"][action$="/revoke"]');
      expect(revokeForms.length).toBe(2);
      revokeForms.each((_i, el) => {
        const f = $(el);
        expect(f.attr('method')?.toLowerCase()).toBe('post');
        expect(f.find('input[name="_csrf"]').length).toBe(1);
      });

      // Both token names appear; the post-mint flash aside is NOT present.
      expect(res.body).toContain('first-pat');
      expect(res.body).toContain('second-pat');
      expect($('aside.minted-token').length).toBe(0);
    });

    it('renders without active rows AND still shows the New-token form when user has no tokens', async () => {
      harness.db.prepare('DELETE FROM api_tokens').run();

      const res = await harness.server.inject({
        method: 'GET',
        url: '/me/tokens',
        headers: { cookie: sessionCookie },
      });
      expect(res.statusCode).toBe(200);

      const $ = cheerio.load(res.body);
      // Active tbody has no rows (whitespace only).
      const activeTbody = $('table').first().find('tbody');
      expect(activeTbody.find('tr').length).toBe(0);
      // New-token form still present.
      expect($('form[action="/api/v1/me/tokens"]').length).toBe(1);
    });

    // CR-02 fix: disabling a user mid-session must lock them out of the
    // web HTML routes immediately, not 8 hours from now. resolveActiveSessionUser
    // re-reads the user row + checks disabled_at on every request.
    it('CR-02: GET /me redirects to /auth/login when user is disabled mid-session', async () => {
      // Disable the test user.
      harness.db
        .prepare("UPDATE users SET disabled_at = datetime('now') WHERE id = ?")
        .run(harness.userId);

      const res = await harness.server.inject({
        method: 'GET',
        url: '/me',
        headers: { cookie: sessionCookie },
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/auth/login?next=/me');

      // Re-enable so subsequent tests reuse the user.
      harness.db
        .prepare('UPDATE users SET disabled_at = NULL WHERE id = ?')
        .run(harness.userId);
    });

    it('CR-02: GET /me/tokens redirects to /auth/login when user is disabled mid-session', async () => {
      harness.db
        .prepare("UPDATE users SET disabled_at = datetime('now') WHERE id = ?")
        .run(harness.userId);

      const res = await harness.server.inject({
        method: 'GET',
        url: '/me/tokens',
        headers: { cookie: sessionCookie },
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/auth/login?next=/me/tokens');

      harness.db
        .prepare('UPDATE users SET disabled_at = NULL WHERE id = ?')
        .run(harness.userId);
    });

    it('renders revoked tokens in a separate section (greyed)', async () => {
      harness.db.prepare('DELETE FROM api_tokens').run();
      seedToken(harness.db, {
        userId: harness.userId,
        name: 'live-token',
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      seedToken(harness.db, {
        userId: harness.userId,
        name: 'killed-token',
        revoked: true,
        createdAt: '2025-12-01T00:00:00.000Z',
      });

      const res = await harness.server.inject({
        method: 'GET',
        url: '/me/tokens',
        headers: { cookie: sessionCookie },
      });
      expect(res.statusCode).toBe(200);

      const $ = cheerio.load(res.body);
      // Revoked tokens section heading present.
      const headings = $('h2')
        .map((_i, el) => $(el).text())
        .get();
      expect(headings).toContain('Revoked tokens');
      // The revoked row has the .revoked class.
      const revokedRow = $('tr.revoked');
      expect(revokedRow.length).toBe(1);
      expect(revokedRow.text()).toContain('killed-token');
    });
  });
});
