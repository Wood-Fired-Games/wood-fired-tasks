// Phase 28 Plan 28-05 — full-stack tests for /api/v1/me/tokens routes.
//
// Three routes under test (all config: { sessionOnly: true }):
//   POST   /api/v1/me/tokens         — mint
//   GET    /api/v1/me/tokens         — list
//   DELETE /api/v1/me/tokens/:id     — revoke
//
// PHASE 29 REFACTOR (Plan 29-09) — real session injection
// -------------------------------------------------------
// The Phase 28 version of this file used `vi.mock('...session.js', ...)`
// because no real session backend existed (Phase 28's session strategy
// returned `{ kind: 'skip' }` unconditionally). Phase 29 ships the real
// strategy + @fastify/secure-session cookie plumbing, so this file now
// uses the production cookie path end-to-end via `signInSessionFor`:
//
//   1. `SESSION_COOKIE_SECRET` is set in `beforeAll` so the boot-time
//      conditional at `src/api/server.ts:301` registers secure-session.
//   2. `signInSessionFor(harness.server, userId)` mounts a one-time
//      `/__test/session-sign-in` probe route, calls it, and returns the
//      production session cookie. Subsequent `inject()` calls attach the
//      cookie via `headers.cookie`; the production session strategy in
//      `src/api/plugins/auth/strategies/session.ts` reads it, calls
//      `userRepository.findById`, and emits a real `{ kind: 'match' }`.
//
// Strictly stronger than the Phase 28 mock: exercises the real session
// strategy + cookie crypto + auth chain instead of stubbing the strategy's
// return value. The 21 existing test cases retain their original
// assertions.

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
import type { AuthenticatedUser } from '../../types/identity.js';
import { resetConfig } from '../../config/env.js';
import { signInSessionFor } from '../../../tests/helpers/session-cookie.js';
import { generateToken, hashToken } from '../../services/pat-hash.js';

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

process.env.API_KEYS = 'test-key';

interface Harness {
  server: FastifyInstance;
  db: Database.Database;
  legacyUser: AuthenticatedUser;
  secondUser: AuthenticatedUser;
}

function asAuthenticated(row: {
  id: number;
  display_name: string;
  email: string | null;
  is_legacy: number;
  is_service_account: number;
}): AuthenticatedUser {
  return {
    id: row.id,
    displayName: row.display_name,
    email: row.email,
    isLegacy: row.is_legacy === 1,
    isServiceAccount: row.is_service_account === 1,
  };
}

/**
 * Insert an api_tokens row directly via SQL. Used to set up cross-user
 * state, pre-existing tokens for list assertions, etc. Mirrors the helper
 * pattern in src/api/__tests__/auth-chain.test.ts:mintPatRow.
 *
 * `createdAt` lets callers stamp explicit timestamps so list-ordering
 * assertions are deterministic — `datetime('now')` only resolves to the
 * nearest second, and two consecutive inserts in the same test would
 * otherwise tie on `created_at` and the repository's `ORDER BY created_at
 * DESC` would produce a SQLite-implementation-defined ordering for the
 * tied rows.
 */
function mintPatViaDb(
  db: Database.Database,
  opts: {
    userId: number;
    name?: string;
    scopes?: string;
    expiresAt?: string | null;
    revoked?: boolean;
    createdAt?: string;
  },
): { id: number; token: string } {
  const { token, prefix, suffix, hash } = generateToken();
  if (opts.createdAt !== undefined) {
    const info = db
      .prepare(
        `INSERT INTO api_tokens (user_id, name, prefix, suffix, hash, scopes, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        opts.userId,
        opts.name ?? 'seed-token',
        prefix,
        suffix,
        hash,
        opts.scopes ?? '[]',
        opts.expiresAt ?? null,
        opts.createdAt,
      );
    const id = Number(info.lastInsertRowid);
    if (opts.revoked) {
      db.prepare(
        "UPDATE api_tokens SET revoked_at = datetime('now') WHERE id = ?",
      ).run(id);
    }
    return { id, token };
  }
  const info = db
    .prepare(
      `INSERT INTO api_tokens (user_id, name, prefix, suffix, hash, scopes, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.userId,
      opts.name ?? 'seed-token',
      prefix,
      suffix,
      hash,
      opts.scopes ?? '[]',
      opts.expiresAt ?? null,
    );
  const id = Number(info.lastInsertRowid);
  if (opts.revoked) {
    db.prepare(
      "UPDATE api_tokens SET revoked_at = datetime('now') WHERE id = ?",
    ).run(id);
  }
  return { id, token };
}

describe('Phase 28 Plan 05 — /api/v1/me/tokens routes', () => {
  let harness: Harness;
  // Per-test session cookie for the legacy user. Re-issued in beforeEach
  // so a previous test's session-mutation can't leak across boundaries.
  // The second user's cookie is intentionally NOT minted — cross-user
  // isolation tests exercise the case where legacyUser holds the cookie
  // and targets a row belonging to secondUser.
  let legacyUserCookie: string;

  beforeAll(async () => {
    process.env.API_KEYS = 'test-key';
    // Phase 29: enable @fastify/secure-session so the production session
    // strategy can read `session.user`. The boot-time conditional at
    // `src/api/server.ts:301` gates secure-session on this var.
    process.env.SESSION_COOKIE_SECRET = randomBytes(32).toString('base64');
    delete process.env.NODE_ENV;
    resetConfig();
    const { createServer } = await import('../server.js');
    const result = await createServer({ dbPath: ':memory:' });
    const server = result.server;
    const db = result.app.db;

    // Resolve the seeded legacy user.
    const legacyRow = db
      .prepare(
        `SELECT id, display_name, email, is_legacy, is_service_account
         FROM users WHERE display_name = ? AND is_legacy = 1`,
      )
      .get('key_test-key') as
      | {
          id: number;
          display_name: string;
          email: string | null;
          is_legacy: number;
          is_service_account: number;
        }
      | undefined;
    if (legacyRow === undefined) {
      throw new Error('test setup: seeded legacy user not found');
    }

    // Insert a second, independent legacy user so we can test cross-user
    // isolation on revoke.
    const secondInfo = db
      .prepare(
        `INSERT INTO users (display_name, is_legacy) VALUES (?, 1)`,
      )
      .run('test-user-b');
    const secondRow = db
      .prepare(
        `SELECT id, display_name, email, is_legacy, is_service_account
         FROM users WHERE id = ?`,
      )
      .get(Number(secondInfo.lastInsertRowid)) as {
      id: number;
      display_name: string;
      email: string | null;
      is_legacy: number;
      is_service_account: number;
    };

    harness = {
      server,
      db,
      legacyUser: asAuthenticated(legacyRow),
      secondUser: asAuthenticated(secondRow),
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
    // Wipe any leftover tokens so list / revoke counts are deterministic
    // per test.
    harness.db.prepare('DELETE FROM api_tokens').run();
    // Re-mint the legacy user's session cookie via the production cookie
    // path (signInSessionFor mounts a /__test/session-sign-in probe route
    // on first call). Tests that need to be unauthenticated simply omit
    // the cookie header.
    legacyUserCookie = await signInSessionFor(
      harness.server,
      harness.legacyUser.id,
    );
  });

  // -------------------------------------------------------------------------
  // Mint — POST /api/v1/me/tokens
  // -------------------------------------------------------------------------
  describe('POST /api/v1/me/tokens', () => {
    it('1. mints a token with session auth and returns the full token exactly once', async () => {
      const res = await harness.server.inject({
        method: 'POST',
        url: '/api/v1/me/tokens',
        headers: { cookie: legacyUserCookie },
        payload: { name: 'laptop' },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.id).toBeTypeOf('number');
      expect(typeof body.token).toBe('string');
      expect(body.token).toMatch(/^wft_pat_[A-Z2-7]{32}$/);
      expect(body.name).toBe('laptop');
      expect(body.prefix).toBe('wft_pat_');
      expect(body.suffix).toHaveLength(4);
      expect(body.scopes).toEqual([]);
      expect(body.expiresAt).toBeNull();
      expect(typeof body.createdAt).toBe('string');

      // The persisted hash matches what would be computed from the
      // one-time `token` field.
      const row = harness.db
        .prepare('SELECT * FROM api_tokens WHERE id = ?')
        .get(body.id) as {
        user_id: number;
        name: string;
        prefix: string;
        suffix: string;
        hash: string;
        scopes: string;
      };
      expect(row.user_id).toBe(harness.legacyUser.id);
      expect(row.name).toBe('laptop');
      expect(row.hash).toBe(hashToken(body.token));
      expect(row.scopes).toBe('[]');
    });

    it('2. rejects PAT auth with 403 session_required (PATs cannot mint PATs)', async () => {
      const { token } = mintPatViaDb(harness.db, {
        userId: harness.legacyUser.id,
      });

      const before = harness.db
        .prepare('SELECT COUNT(*) as c FROM api_tokens')
        .get() as { c: number };

      const res = await harness.server.inject({
        method: 'POST',
        url: '/api/v1/me/tokens',
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'should-not-mint' },
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('session_required');
      expect(body.message).toContain('Personal Access Token');

      const after = harness.db
        .prepare('SELECT COUNT(*) as c FROM api_tokens')
        .get() as { c: number };
      expect(after.c).toBe(before.c);
    });

    it('3. rejects with 401 when no credentials are presented', async () => {
      const res = await harness.server.inject({
        method: 'POST',
        url: '/api/v1/me/tokens',
        payload: { name: 'no-auth' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('4. persists scopes and expiresAt when supplied', async () => {
      const expiresAt = '2099-01-01T00:00:00.000Z';

      const res = await harness.server.inject({
        method: 'POST',
        url: '/api/v1/me/tokens',
        headers: { cookie: legacyUserCookie },
        payload: {
          name: 'with-scopes',
          scopes: ['a', 'b'],
          expiresAt,
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.scopes).toEqual(['a', 'b']);
      expect(body.expiresAt).toBe(expiresAt);

      const row = harness.db
        .prepare('SELECT scopes, expires_at FROM api_tokens WHERE id = ?')
        .get(body.id) as { scopes: string; expires_at: string };
      expect(row.scopes).toBe('["a","b"]');
      expect(row.expires_at).toBe(expiresAt);
    });

    it('also rejects legacy x-api-key auth with 403 session_required', async () => {
      const res = await harness.server.inject({
        method: 'POST',
        url: '/api/v1/me/tokens',
        headers: { 'x-api-key': 'test-key' },
        payload: { name: 'legacy-mint' },
      });
      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('session_required');
    });

    it('rejects invalid body (missing name) with 400', async () => {
      const res = await harness.server.inject({
        method: 'POST',
        url: '/api/v1/me/tokens',
        headers: { cookie: legacyUserCookie },
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });

    it('WR-02: rejects oversized scopes array (>32 elements) with 400', async () => {
      const res = await harness.server.inject({
        method: 'POST',
        url: '/api/v1/me/tokens',
        headers: { cookie: legacyUserCookie },
        payload: {
          name: 'too-many-scopes',
          scopes: Array.from({ length: 33 }, (_, i) => `scope${i}`),
        },
      });
      expect(res.statusCode).toBe(400);
      // No row persisted.
      const count = harness.db
        .prepare("SELECT COUNT(*) as c FROM api_tokens WHERE name = 'too-many-scopes'")
        .get() as { c: number };
      expect(count.c).toBe(0);
    });

    it('WR-02: rejects oversized scope string (>64 chars) with 400', async () => {
      const res = await harness.server.inject({
        method: 'POST',
        url: '/api/v1/me/tokens',
        headers: { cookie: legacyUserCookie },
        payload: {
          name: 'oversized-scope-elem',
          scopes: ['a'.repeat(65)],
        },
      });
      expect(res.statusCode).toBe(400);
      const count = harness.db
        .prepare("SELECT COUNT(*) as c FROM api_tokens WHERE name = 'oversized-scope-elem'")
        .get() as { c: number };
      expect(count.c).toBe(0);
    });

    it('WR-02: accepts the cap exactly (32 scopes, 64-char elements)', async () => {
      const res = await harness.server.inject({
        method: 'POST',
        url: '/api/v1/me/tokens',
        headers: { cookie: legacyUserCookie },
        payload: {
          name: 'at-the-cap',
          scopes: Array.from({ length: 32 }, () => 'a'.repeat(64)),
        },
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.scopes).toHaveLength(32);
      expect(body.scopes[0]).toHaveLength(64);
    });

    it('WR-02: rejects empty-string scope element (min(1)) with 400', async () => {
      const res = await harness.server.inject({
        method: 'POST',
        url: '/api/v1/me/tokens',
        headers: { cookie: legacyUserCookie },
        payload: {
          name: 'empty-scope',
          scopes: [''],
        },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  // List — GET /api/v1/me/tokens
  // -------------------------------------------------------------------------
  describe('GET /api/v1/me/tokens', () => {
    it('5. returns the caller\'s tokens (no hash, no token, no cross-user rows)', async () => {
      // Seed 2 tokens for the legacy user + 1 for the second user. Explicit
      // `createdAt` timestamps so the repository's `ORDER BY created_at
      // DESC` produces a deterministic newest-first ordering — without
      // them, two inserts in the same test tick share a one-second
      // `datetime('now')` value and the tie ordering is undefined.
      mintPatViaDb(harness.db, {
        userId: harness.legacyUser.id,
        name: 'first',
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      mintPatViaDb(harness.db, {
        userId: harness.legacyUser.id,
        name: 'second',
        createdAt: '2026-02-01T00:00:00.000Z',
      });
      mintPatViaDb(harness.db, {
        userId: harness.secondUser.id,
        name: 'other-user-token',
        createdAt: '2026-03-01T00:00:00.000Z',
      });

      const res = await harness.server.inject({
        method: 'GET',
        url: '/api/v1/me/tokens',
        headers: { cookie: legacyUserCookie },
      });

      expect(res.statusCode).toBe(200);
      const list = JSON.parse(res.body);
      expect(Array.isArray(list)).toBe(true);
      expect(list).toHaveLength(2);
      // newest-first ordering (DESC by created_at). The 'second' insert is
      // newer than the 'first'.
      expect(list[0].name).toBe('second');
      expect(list[1].name).toBe('first');
      // Per-item shape: no hash, no token plaintext.
      for (const item of list) {
        expect(item).not.toHaveProperty('hash');
        expect(item).not.toHaveProperty('token');
        expect(item.prefix).toBe('wft_pat_');
        expect(item.suffix).toHaveLength(4);
        expect(item.scopes).toEqual([]);
        expect(item).toHaveProperty('createdAt');
        expect(item).toHaveProperty('lastUsedAt');
        expect(item).toHaveProperty('revokedAt');
        expect(item).toHaveProperty('expiresAt');
      }
    });

    it('6. rejects PAT auth with 403 session_required', async () => {
      const { token } = mintPatViaDb(harness.db, {
        userId: harness.legacyUser.id,
      });
      const res = await harness.server.inject({
        method: 'GET',
        url: '/api/v1/me/tokens',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('session_required');
    });

    it('rejects with 401 when no credentials are presented', async () => {
      const res = await harness.server.inject({
        method: 'GET',
        url: '/api/v1/me/tokens',
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns an empty array when the user has no tokens', async () => {
      const res = await harness.server.inject({
        method: 'GET',
        url: '/api/v1/me/tokens',
        headers: { cookie: legacyUserCookie },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Revoke — DELETE /api/v1/me/tokens/:id
  // -------------------------------------------------------------------------
  describe('DELETE /api/v1/me/tokens/:id', () => {
    it('7. revokes own token with session, returns 204 with empty body', async () => {
      const { id } = mintPatViaDb(harness.db, {
        userId: harness.legacyUser.id,
      });

      const res = await harness.server.inject({
        method: 'DELETE',
        url: `/api/v1/me/tokens/${id}`,
        headers: { cookie: legacyUserCookie },
      });
      expect(res.statusCode).toBe(204);
      expect(res.body).toBe('');

      const row = harness.db
        .prepare('SELECT revoked_at FROM api_tokens WHERE id = ?')
        .get(id) as { revoked_at: string | null };
      expect(row.revoked_at).not.toBeNull();
    });

    it('8. returns 404 (no existence leak) when revoking another user\'s token', async () => {
      const { id } = mintPatViaDb(harness.db, {
        userId: harness.secondUser.id,
        name: 'belongs-to-user-b',
      });

      // Authenticate AS legacyUser; the target id belongs to secondUser.
      const res = await harness.server.inject({
        method: 'DELETE',
        url: `/api/v1/me/tokens/${id}`,
        headers: { cookie: legacyUserCookie },
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      // 404 body shape MUST be identical to "doesn't exist" to avoid
      // leaking whether the id belongs to another user.
      expect(body.error).toBe('NOT_FOUND');

      // Token still NOT revoked.
      const row = harness.db
        .prepare('SELECT revoked_at FROM api_tokens WHERE id = ?')
        .get(id) as { revoked_at: string | null };
      expect(row.revoked_at).toBeNull();
    });

    it('9. returns 404 for already-revoked token (idempotent twice)', async () => {
      const { id } = mintPatViaDb(harness.db, {
        userId: harness.legacyUser.id,
      });

      const first = await harness.server.inject({
        method: 'DELETE',
        url: `/api/v1/me/tokens/${id}`,
        headers: { cookie: legacyUserCookie },
      });
      expect(first.statusCode).toBe(204);

      const second = await harness.server.inject({
        method: 'DELETE',
        url: `/api/v1/me/tokens/${id}`,
        headers: { cookie: legacyUserCookie },
      });
      expect(second.statusCode).toBe(404);
      const body = JSON.parse(second.body);
      expect(body.error).toBe('NOT_FOUND');
    });

    it('returns 404 for a nonexistent token id', async () => {
      const res = await harness.server.inject({
        method: 'DELETE',
        url: '/api/v1/me/tokens/999999',
        headers: { cookie: legacyUserCookie },
      });
      expect(res.statusCode).toBe(404);
    });

    it('rejects PAT auth with 403 session_required', async () => {
      const { token, id } = mintPatViaDb(harness.db, {
        userId: harness.legacyUser.id,
      });
      const res = await harness.server.inject({
        method: 'DELETE',
        url: `/api/v1/me/tokens/${id}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('session_required');
    });

    it('rejects with 401 when no credentials are presented', async () => {
      const { id } = mintPatViaDb(harness.db, {
        userId: harness.legacyUser.id,
      });
      const res = await harness.server.inject({
        method: 'DELETE',
        url: `/api/v1/me/tokens/${id}`,
      });
      expect(res.statusCode).toBe(401);
    });
  });

  // -------------------------------------------------------------------------
  // Case 10 — end-to-end: mint → authenticate → list → revoke → re-auth fails
  // -------------------------------------------------------------------------
  describe('end-to-end lifecycle (case 10)', () => {
    it('mint → use as PAT → list → revoke → re-use returns 401', async () => {
      // 1. Mint via session-authed POST.
      const mintRes = await harness.server.inject({
        method: 'POST',
        url: '/api/v1/me/tokens',
        headers: { cookie: legacyUserCookie },
        payload: { name: 'lifecycle-token' },
      });
      expect(mintRes.statusCode).toBe(201);
      const mintBody = JSON.parse(mintRes.body);
      const fullToken = mintBody.token as string;
      const tokenId = mintBody.id as number;

      // 2. Use the minted PAT to hit a non-sessionOnly route. /api/v1/tasks
      //    accepts any auth method; we expect 200 because the PAT now
      //    resolves the legacy user. No cookie — Bearer-only path.
      const tasksOk = await harness.server.inject({
        method: 'GET',
        url: '/api/v1/tasks',
        headers: { authorization: `Bearer ${fullToken}` },
      });
      expect(tasksOk.statusCode).toBe(200);

      // 3. List my tokens via session — the minted token appears.
      const listRes = await harness.server.inject({
        method: 'GET',
        url: '/api/v1/me/tokens',
        headers: { cookie: legacyUserCookie },
      });
      expect(listRes.statusCode).toBe(200);
      const listBody = JSON.parse(listRes.body) as Array<{
        id: number;
        name: string;
      }>;
      expect(listBody.some((t) => t.id === tokenId)).toBe(true);

      // 4. Revoke via session.
      const revokeRes = await harness.server.inject({
        method: 'DELETE',
        url: `/api/v1/me/tokens/${tokenId}`,
        headers: { cookie: legacyUserCookie },
      });
      expect(revokeRes.statusCode).toBe(204);

      // 5. Re-authenticate with the (now revoked) token — auth chain
      //    short-circuits to 401 via the PAT strategy's revoked branch.
      const tasksFail = await harness.server.inject({
        method: 'GET',
        url: '/api/v1/tasks',
        headers: { authorization: `Bearer ${fullToken}` },
      });
      expect(tasksFail.statusCode).toBe(401);
    });
  });
});
