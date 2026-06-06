// Phase 30 Plan 30-03 — GET /api/v1/me profile endpoint.
//
// Verifies the new endpoint that backs `tasks whoami`:
//   - Accepts ANY chain strategy (session, PAT, legacy) — no sessionOnly gate.
//   - Returns the minimal AuthenticatedUser projection
//     `{ id, displayName, email, isLegacy, isServiceAccount }` plus
//     `authenticatedAt` (ISO-8601) ONLY when session-authed.
//   - Returns 401 on no credentials (chain emits it).
//   - The Zod response schema strips unknown fields, so server-side leakage
//     of internal-only columns (oidc_sub, provider, etc.) is structurally
//     impossible.
//
// Harness pattern mirrors `src/api/__tests__/me-tokens.test.ts` — boots a
// real server, seeds users + a PAT, and exercises the three auth methods
// against the live chain.

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
  legacyUser: UserRow; // is_legacy=1
  oidcUser: UserRow; // is_legacy=0, is_service_account=0, has email
  serviceUser: UserRow; // is_service_account=1
}

/** Mint a PAT for `userId` directly via SQL and return the plaintext. */
function mintPatViaDb(
  db: Database.Database,
  userId: number,
): { id: number; token: string } {
  const { token, prefix, suffix, hash } = generateToken();
  const info = db
    .prepare(
      `INSERT INTO api_tokens (user_id, name, prefix, suffix, hash, scopes, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(userId, 'profile-test-token', prefix, suffix, hash, '[]', null);
  return { id: Number(info.lastInsertRowid), token };
}

describe('Phase 30 Plan 30-03 — GET /api/v1/me', () => {
  let harness: Harness;
  let oidcUserCookie: string;

  beforeAll(async () => {
    process.env.API_KEYS = 'test-key';
    process.env.SESSION_COOKIE_SECRET = randomBytes(32).toString('base64');
    delete process.env.NODE_ENV;
    resetConfig();
    const { createServer } = await import('../../../server.js');
    const result = await createServer({ dbPath: ':memory:' });
    const server = result.server;
    const db = result.app.db;

    const legacyRow = db
      .prepare(
        `SELECT id, display_name, email, is_legacy, is_service_account
         FROM users WHERE display_name = ? AND is_legacy = 1`,
      )
      .get('key_test-key') as UserRow | undefined;
    if (legacyRow === undefined) {
      throw new Error('test setup: seeded legacy user not found');
    }

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

    const svcInfo = db
      .prepare(
        `INSERT INTO users (display_name, is_legacy, is_service_account)
         VALUES (?, 0, 1)`,
      )
      .run('ci-runner');
    const svcRow = db
      .prepare(
        `SELECT id, display_name, email, is_legacy, is_service_account
         FROM users WHERE id = ?`,
      )
      .get(Number(svcInfo.lastInsertRowid)) as UserRow;

    harness = {
      server,
      db,
      legacyUser: legacyRow,
      oidcUser: oidcRow,
      serviceUser: svcRow,
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
    oidcUserCookie = await signInSessionFor(
      harness.server,
      harness.oidcUser.id,
    );
  });

  it('1. session-authed: returns 200 with profile + ISO authenticatedAt', async () => {
    const res = await harness.server.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: oidcUserCookie },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toEqual({
      id: harness.oidcUser.id,
      displayName: 'Alice OIDC',
      email: 'alice@example.com',
      isLegacy: false,
      isServiceAccount: false,
      authenticatedAt: expect.any(String),
    });
    // ISO-8601 sanity check — Date.parse must round-trip.
    expect(Number.isNaN(Date.parse(body.authenticatedAt))).toBe(false);
  });

  it('2. PAT-authed: returns 200 with profile and OMITS authenticatedAt', async () => {
    const { token } = mintPatViaDb(harness.db, harness.oidcUser.id);

    const res = await harness.server.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toEqual({
      id: harness.oidcUser.id,
      displayName: 'Alice OIDC',
      email: 'alice@example.com',
      isLegacy: false,
      isServiceAccount: false,
    });
    expect(body).not.toHaveProperty('authenticatedAt');
  });

  it('3. legacy-authed (X-API-Key): returns 200 with isLegacy=true', async () => {
    const res = await harness.server.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { 'x-api-key': 'test-key' },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.id).toBe(harness.legacyUser.id);
    expect(body.displayName).toBe(harness.legacyUser.display_name);
    expect(body.isLegacy).toBe(true);
    expect(body.isServiceAccount).toBe(false);
    expect(body).not.toHaveProperty('authenticatedAt');
  });

  it('4. service-account user (PAT-authed): reflects isServiceAccount=true', async () => {
    const { token } = mintPatViaDb(harness.db, harness.serviceUser.id);

    const res = await harness.server.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toEqual({
      id: harness.serviceUser.id,
      displayName: 'ci-runner',
      email: null,
      isLegacy: false,
      isServiceAccount: true,
    });
  });

  it('5. no auth: returns 401', async () => {
    const res = await harness.server.inject({
      method: 'GET',
      url: '/api/v1/me',
    });
    expect(res.statusCode).toBe(401);
  });

  it('6. response schema strips unknown fields (no leakage)', async () => {
    // The Zod response schema enforces the exact envelope. We assert the
    // response body contains NO internal-only fields under any auth method.
    const { token } = mintPatViaDb(harness.db, harness.oidcUser.id);
    const res = await harness.server.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { authorization: `Bearer ${token}` },
    });
    const body = JSON.parse(res.body);
    const allowedKeys = new Set([
      'id',
      'displayName',
      'email',
      'isLegacy',
      'isServiceAccount',
      'authenticatedAt',
    ]);
    for (const key of Object.keys(body)) {
      expect(allowedKeys.has(key)).toBe(true);
    }
    // Explicit leakage probes — these fields exist on the users row but
    // MUST NEVER appear in the API envelope.
    expect(body).not.toHaveProperty('oidc_sub');
    expect(body).not.toHaveProperty('oidc_provider');
    expect(body).not.toHaveProperty('provider');
    expect(body).not.toHaveProperty('sub');
    expect(body).not.toHaveProperty('disabled_at');
    expect(body).not.toHaveProperty('slack_user_id');
    expect(body).not.toHaveProperty('googleAccessToken');
  });
});
