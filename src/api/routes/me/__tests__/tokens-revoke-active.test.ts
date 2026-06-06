// Phase 30 Plan 30-03 — DELETE /api/v1/me/tokens/active self-revoke endpoint.
//
// Verifies the new Bearer-accepting revoke route the CLI's `tasks logout`
// command targets:
//   - PAT-authed → 204, the calling token is revoked, subsequent auth fails.
//   - Session-authed → 400 NO_TOKEN_ID (use the :id route).
//   - Legacy X-API-Key authed → 400 NO_TOKEN_ID (no token to revoke).
//   - No credentials → 401 (chain emits).
//   - The existing DELETE /:id route MUST keep its session-only contract;
//     numeric ids still route to the :id handler (no shadowing).

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomBytes } from 'crypto';
import type { FastifyInstance } from 'fastify';
import type Database from '../../../../db/driver.js';
import { resetConfig } from '../../../../config/env.js';
import { signInSessionFor } from '../../../../../tests/helpers/session-cookie.js';
import { generateToken } from '../../../../services/pat-hash.js';

interface UserRow {
  id: number;
  display_name: string;
  email: string | null;
  is_legacy: number;
  is_service_account: number;
}

interface Harness {
  server: FastifyInstance;
  db: Database.Database;
  legacyUser: UserRow;
  oidcUser: UserRow;
}

function mintPatViaDb(db: Database.Database, userId: number): { id: number; token: string } {
  const { token, prefix, suffix, hash } = generateToken();
  const info = db
    .prepare(
      `INSERT INTO api_tokens (user_id, name, prefix, suffix, hash, scopes, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(userId, 'active-revoke-test', prefix, suffix, hash, '[]', null);
  return { id: Number(info.lastInsertRowid), token };
}

describe('Phase 30 Plan 30-03 — DELETE /api/v1/me/tokens/active', () => {
  let harness: Harness;
  let oidcUserCookie: string;

  beforeAll(async () => {
    process.env.SESSION_COOKIE_SECRET = randomBytes(32).toString('base64');
    delete process.env.NODE_ENV;
    resetConfig();
    const { createServer } = await import('../../../server.js');
    const result = await createServer({ dbPath: ':memory:' });
    const server = result.server;
    const db = result.app.db;

    // v2.0 auth cutover (#799/#801): X-API-Key + legacy credential seeding
    // were removed. Seed a legacy-flagged user directly; the revoke-active
    // route's "no token id present" branch is now reachable only via session
    // (X-API-Key is gone), so this user is kept for the session-cookie path.
    const legacyInfo = db
      .prepare(`INSERT INTO users (display_name, is_legacy, is_service_account) VALUES (?, 1, 0)`)
      .run('legacy-user');
    const legacyRow = db
      .prepare(
        `SELECT id, display_name, email, is_legacy, is_service_account
         FROM users WHERE id = ?`,
      )
      .get(Number(legacyInfo.lastInsertRowid)) as UserRow;

    const oidcInfo = db
      .prepare(
        `INSERT INTO users (display_name, email, is_legacy, is_service_account)
         VALUES (?, ?, 0, 0)`,
      )
      .run('Alice OIDC', 'alice@example.com');
    const oidcRow = db
      .prepare(
        `SELECT id, display_name, email, is_legacy, is_service_account
         FROM users WHERE id = ?`,
      )
      .get(Number(oidcInfo.lastInsertRowid)) as UserRow;

    harness = {
      server,
      db,
      legacyUser: legacyRow,
      oidcUser: oidcRow,
    };
  });

  afterAll(async () => {
    await harness.server.close();
    harness.db.close();
    delete process.env.SESSION_COOKIE_SECRET;
    resetConfig();
    vi.restoreAllMocks();
  });

  beforeEach(async () => {
    harness.db.prepare('DELETE FROM api_tokens').run();
    oidcUserCookie = await signInSessionFor(harness.server, harness.oidcUser.id);
  });

  it('1. PAT-authed: returns 204 and the token row is now revoked', async () => {
    const { id, token } = mintPatViaDb(harness.db, harness.oidcUser.id);

    const res = await harness.server.inject({
      method: 'DELETE',
      url: '/api/v1/me/tokens/active',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');

    const row = harness.db.prepare('SELECT revoked_at FROM api_tokens WHERE id = ?').get(id) as {
      revoked_at: string | null;
    };
    expect(row.revoked_at).not.toBeNull();
  });

  it('2. revoked PAT can no longer authenticate → 401 on re-use', async () => {
    const { token } = mintPatViaDb(harness.db, harness.oidcUser.id);

    const first = await harness.server.inject({
      method: 'DELETE',
      url: '/api/v1/me/tokens/active',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(first.statusCode).toBe(204);

    // Same token, second request — chain should reject because the row
    // is now revoked.
    const second = await harness.server.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(second.statusCode).toBe(401);
  });

  it('3. session-authed: returns 400 NO_TOKEN_ID', async () => {
    const res = await harness.server.inject({
      method: 'DELETE',
      url: '/api/v1/me/tokens/active',
      headers: { cookie: oidcUserCookie },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('NO_TOKEN_ID');
    expect(typeof body.message).toBe('string');
    expect(body.message.length).toBeGreaterThan(0);
  });

  it('4. legacy-flagged user (session-authed, no token id): returns 400 NO_TOKEN_ID', async () => {
    // v2.0: X-API-Key is gone, so a non-PAT principal can only reach this
    // route via a session cookie. A legacy-flagged user with no carried
    // tokenId must still hit the NO_TOKEN_ID branch.
    const legacyCookie = await signInSessionFor(harness.server, harness.legacyUser.id);
    const res = await harness.server.inject({
      method: 'DELETE',
      url: '/api/v1/me/tokens/active',
      headers: { cookie: legacyCookie },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('NO_TOKEN_ID');
  });

  it('5. no auth: returns 401', async () => {
    const res = await harness.server.inject({
      method: 'DELETE',
      url: '/api/v1/me/tokens/active',
    });
    expect(res.statusCode).toBe(401);
  });

  it('6. revoke returns false (already-revoked) → 404 NOT_FOUND', async () => {
    // Mint then pre-revoke via SQL — the route should see revoke() return
    // false on its second-pass attempt and respond 404. This exercises the
    // defense-in-depth branch even though it's structurally hard to hit
    // (the chain would normally 401 before reaching the handler).
    const { id, token } = mintPatViaDb(harness.db, harness.oidcUser.id);

    // Spy on the repository so the first chain pass treats the token as
    // active (so the request reaches the handler), then the handler's
    // revoke() returns false.
    const revokeSpy = vi
      .spyOn(harness.server.apiTokenRepository, 'revoke')
      .mockReturnValueOnce(false);

    const res = await harness.server.inject({
      method: 'DELETE',
      url: '/api/v1/me/tokens/active',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('NOT_FOUND');

    revokeSpy.mockRestore();
    // Defensive cleanup — the mock returned false but the row is still
    // active in the DB. Revoke it for isolation.
    harness.server.apiTokenRepository.revoke(id, harness.oidcUser.id);
  });

  it('7. existing /:id route still works for numeric ids (no shadowing)', async () => {
    // The new `/active` literal route MUST be registered BEFORE `/:id`. If
    // the order is wrong, Fastify's radix tree matches `/active` against
    // `/:id` (id='active') and the new handler is unreachable. Conversely,
    // numeric ids like `/17` MUST still resolve to the existing :id handler
    // with its sessionOnly contract intact.
    const { id } = mintPatViaDb(harness.db, harness.oidcUser.id);

    const res = await harness.server.inject({
      method: 'DELETE',
      url: `/api/v1/me/tokens/${id}`,
      headers: { cookie: oidcUserCookie },
    });

    // Session-authed call on a numeric id → 204 (existing /:id route).
    expect(res.statusCode).toBe(204);

    const row = harness.db.prepare('SELECT revoked_at FROM api_tokens WHERE id = ?').get(id) as {
      revoked_at: string | null;
    };
    expect(row.revoked_at).not.toBeNull();
  });

  it('8. /:id route still rejects PATs with 403 (sessionOnly preserved)', async () => {
    // Sanity: the addition of /active must NOT relax the /:id route's
    // sessionOnly enforcement.
    const { id, token } = mintPatViaDb(harness.db, harness.oidcUser.id);

    const res = await harness.server.inject({
      method: 'DELETE',
      url: `/api/v1/me/tokens/${id}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('session_required');
  });
});
