/**
 * Security Audit finding M5 (task #1630) — audit-trail coverage of the
 * SESSION-authenticated surface, outside `/api/v1`.
 *
 * Why this file exists separately from `audit-trail.test.ts`: the two
 * highest-value events in the system are credential ISSUANCE
 * (`POST /auth/device/verify`, which mints a PAT) and credential REVOCATION
 * (`POST /me/tokens/:id/revoke`). Neither lives under `/api/v1`:
 *
 *   - `/auth/device/verify` is registered in the device-flow scope
 *     (`server.ts`, the `register(async (scope) => …)` block that owns
 *     `authPlugin` + the three device routes).
 *   - `POST /me/tokens/:id/revoke` is a top-level web HTML route registered
 *     OUTSIDE every `authPlugin` scope; it carries `config.skipAuth` and runs
 *     its own session gate via `resolveActiveSessionUser`.
 *
 * An audit hook registered only in the `/api/v1` scope records neither. These
 * tests drive the REAL routes against the REAL `createServer()` in OIDC-enabled
 * mode (nock-mocked discovery) — a stubbed Fastify instance would happily pass
 * while production recorded nothing, which is exactly the failure mode being
 * guarded.
 *
 * Both suites need OIDC enabled (device routes exist only when
 * `app.oidcConfig` is non-null; the web routes only register when
 * `SESSION_COOKIE_SECRET` is set), so they share one booted server. The env
 * mutation is why this is its own FILE rather than another `describe` in
 * `audit-trail.test.ts`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import nock from 'nock';
import * as cheerio from 'cheerio';
import type { FastifyInstance } from 'fastify';
import type Database from '../../db/driver.js';
import type { App } from '../../index.js';
import type { AuditEventRow } from '../../repositories/interfaces.js';
import { resetConfig } from '../../config/env.js';
import {
  createSession as createDeviceSession,
  _resetForTests as resetDeviceFlowStore,
  findByUserCode,
} from '../../services/device-flow-store.js';
import { generateToken } from '../../services/pat-hash.js';
import { extractSessionCookie } from '../../../tests/helpers/session-cookie.js';
import { getDiscoveryFixture } from '../../../tests/helpers/oidc-fixtures.js';

const ISSUER = 'https://accounts.example.com';
const CLIENT_ID = 'audit-m5-client.example.com';
const CLIENT_SECRET = 'audit-m5-secret';
const REDIRECT_URI = 'https://wft.example.com/auth/callback';
const SCOPES = 'openid email profile';
const SESSION_SECRET = randomBytes(32).toString('base64');

function setEnabledEnv(): void {
  process.env['OIDC_ISSUER_URL'] = ISSUER;
  process.env['OIDC_CLIENT_ID'] = CLIENT_ID;
  process.env['OIDC_CLIENT_SECRET'] = CLIENT_SECRET;
  process.env['OIDC_REDIRECT_URI'] = REDIRECT_URI;
  process.env['OIDC_SCOPES'] = SCOPES;
  process.env['SESSION_COOKIE_SECRET'] = SESSION_SECRET;
  process.env['NODE_ENV'] = 'test';
  resetConfig();
}

function clearEnabledEnv(): void {
  delete process.env['OIDC_ISSUER_URL'];
  delete process.env['OIDC_CLIENT_ID'];
  delete process.env['OIDC_CLIENT_SECRET'];
  delete process.env['OIDC_REDIRECT_URI'];
  delete process.env['OIDC_SCOPES'];
  delete process.env['SESSION_COOKIE_SECRET'];
  resetConfig();
}

/** See the identical helper in audit-trail.test.ts — `onResponse` is async
 * relative to `inject`'s settled promise, so poll rather than sleep. */
async function waitForRows(
  read: () => AuditEventRow[],
  expected: number,
  timeoutMs = 2000,
): Promise<AuditEventRow[]> {
  const deadline = Date.now() + timeoutMs;
  let rows = read();
  while (rows.length < expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    rows = read();
  }
  return rows;
}

/** Settle any pending `onResponse` work before asserting a ZERO-row outcome. */
async function settleResponseHooks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 25));
}

describe('REST audit trail — session-authenticated surface outside /api/v1', () => {
  let server: FastifyInstance;
  let app: App;
  let db: Database.Database;
  let userId: number;

  beforeAll(async () => {
    setEnabledEnv();
    nock.disableNetConnect();
    nock.enableNetConnect('127.0.0.1');
    nock(ISSUER).get('/.well-known/openid-configuration').reply(200, getDiscoveryFixture());

    const { createServer } = await import('../server.js');
    const result = await createServer({ dbPath: ':memory:' });
    server = result.server;
    app = result.app;
    db = result.app.db;

    // Stand-in for the OIDC callback: stamps `session.user` exactly as
    // `/auth/callback` does. `skipAuth` so the chain does not demand a
    // credential to mint the cookie. Being a top-level POST with no
    // principal, it is itself unauditable — asserted below.
    server.post('/__test/sign-in', { config: { skipAuth: true } }, async (request, reply) => {
      const { id } = request.body as { id: number };
      request.session.set('user', {
        id,
        displayName: 'Audit M5 Session User',
        email: 'audit-m5@example.com',
        isLegacy: false,
        isServiceAccount: false,
      });
      request.session.set('authenticatedAt', Date.now());
      return reply.code(204).send();
    });
    await server.ready();

    const info = db
      .prepare('INSERT INTO users (display_name, email) VALUES (?, ?)')
      .run('Audit M5 Session User', 'audit-m5@example.com');
    userId = Number(info.lastInsertRowid);
  });

  afterAll(async () => {
    await server.close();
    db.close();
    nock.cleanAll();
    nock.enableNetConnect();
    clearEnabledEnv();
  });

  /** Sign in and return a live session cookie. */
  async function signIn(): Promise<string> {
    const res = await server.inject({
      method: 'POST',
      url: '/__test/sign-in',
      payload: { id: userId },
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(204);
    const cookie = extractSessionCookie(res);
    if (!cookie) throw new Error('sign-in probe emitted no Set-Cookie');
    return cookie;
  }

  function rowsForUser(): AuditEventRow[] {
    return app.auditEventRepository.findByActor(String(userId), 50);
  }

  it('records POST /auth/device/verify — the route that MINTS a PAT', async () => {
    resetDeviceFlowStore();
    const before = rowsForUser().length;

    const cookie = await signIn();
    const deviceSession = createDeviceSession({ clientId: CLIENT_ID, hostname: 'audit-m5-host' });

    // GET seeds `session.csrf` and renders the verify form (a GET — it must
    // itself produce no row; the count assertion below covers that).
    const page = await server.inject({
      method: 'GET',
      url: `/auth/device?user_code=${deviceSession.userCode}`,
      headers: { cookie },
    });
    expect(page.statusCode).toBe(200);
    // secure-session rotates the cookie on mutation.
    const refreshed = extractSessionCookie(page) ?? cookie;
    const csrf = cheerio
      .load(page.body)('form[action="/auth/device/verify"]')
      .find('input[name="_csrf"]')
      .attr('value');
    expect(csrf).toMatch(/^[0-9a-f]{64}$/);

    const verified = await server.inject({
      method: 'POST',
      url: '/auth/device/verify',
      headers: { cookie: refreshed, 'content-type': 'application/x-www-form-urlencoded' },
      payload: `_csrf=${csrf}&user_code=${deviceSession.userCode}`,
    });
    expect(verified.statusCode).toBe(200);
    // The flow really completed — a PAT was minted for this user.
    expect(findByUserCode(deviceSession.userCode)?.status).toBe('approved');

    const rows = await waitForRows(rowsForUser, before + 1);
    // EXACTLY one new row: the sign-in probe (no principal) and the GET
    // (read verb) contributed nothing.
    expect(rows).toHaveLength(before + 1);
    const row = rows[0] as AuditEventRow;
    expect(row.action).toBe('POST /auth/device/verify');
    expect(row.actor_id).toBe(String(userId));
    expect(row.actor_type).toBe('user');
    // Session-authenticated: no PAT presented, so no token id to record.
    expect(row.token_id).toBeNull();
    expect(row.metadata).toMatchObject({ status: 200, authMethod: 'session' });
    expect(app.auditEventRepository.verifyChain()).toBeNull();
  });

  it('records POST /me/tokens/:id/revoke — a top-level, skipAuth, session-gated REVOCATION', async () => {
    const before = rowsForUser().length;
    const cookie = await signIn();

    // A token belonging to this user, so it renders a revoke form.
    const { prefix, suffix, hash } = generateToken();
    const tokenId = Number(
      db
        .prepare(
          `INSERT INTO api_tokens (user_id, name, prefix, suffix, hash, scopes, revoked_at, expires_at)
           VALUES (?, ?, ?, ?, ?, '[]', NULL, NULL)`,
        )
        .run(userId, 'audit-m5-revoke-target', prefix, suffix, hash).lastInsertRowid,
    );

    const page = await server.inject({ method: 'GET', url: '/me/tokens', headers: { cookie } });
    expect(page.statusCode).toBe(200);
    const refreshed = extractSessionCookie(page) ?? cookie;
    const csrf = cheerio
      .load(page.body)(`form[action="/me/tokens/${tokenId}/revoke"]`)
      .find('input[name="_csrf"]')
      .attr('value');
    expect(csrf).toMatch(/^[0-9a-f]{64}$/);

    const revoked = await server.inject({
      method: 'POST',
      url: `/me/tokens/${tokenId}/revoke`,
      headers: { cookie: refreshed, 'content-type': 'application/x-www-form-urlencoded' },
      payload: `_csrf=${csrf}`,
    });
    expect(revoked.statusCode).toBe(303);
    // The revocation really happened.
    expect(db.prepare('SELECT revoked_at FROM api_tokens WHERE id = ?').get(tokenId)).toMatchObject(
      { revoked_at: expect.any(String) },
    );

    const rows = await waitForRows(rowsForUser, before + 1);
    expect(rows).toHaveLength(before + 1);
    const row = rows[0] as AuditEventRow;
    expect(row.action).toBe('POST /me/tokens/:id/revoke');
    expect(row.actor_id).toBe(String(userId));
    expect(row.token_id).toBeNull();
    expect(row.metadata).toMatchObject({ status: 303, authMethod: 'session' });
    // The pattern ends in a static segment, so `resource_id` is null by the
    // documented rule — the revoked token's id is preserved in the params
    // blob rather than being lost.
    expect(row.resource_type).toBe('revoke');
    expect(row.metadata).toMatchObject({ params: { id: String(tokenId) } });
  });

  it('writes NOTHING for the same routes without a session (no principal to attribute to)', async () => {
    resetDeviceFlowStore();
    const before = rowsForUser().length;
    const deviceSession = createDeviceSession({ clientId: CLIENT_ID, hostname: 'anon-host' });

    const verify = await server.inject({
      method: 'POST',
      url: '/auth/device/verify',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `_csrf=nope&user_code=${deviceSession.userCode}`,
    });
    expect([401, 403]).toContain(verify.statusCode);

    const revoke = await server.inject({
      method: 'POST',
      url: '/me/tokens/1/revoke',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: '_csrf=nope',
    });
    // Redirected to sign-in rather than acted on.
    expect(revoke.statusCode).toBe(302);

    await settleResponseHooks();
    expect(rowsForUser()).toHaveLength(before);
    // `actor_id` is NOT NULL, so a row for an anonymous caller could not even
    // be written — assert the table gained nothing at all, for any actor.
    expect(
      app.auditEventRepository
        .findByTimeRange('1970-01-01T00:00:00.000Z', '2999-01-01T00:00:00.000Z', 500)
        .filter((row) => row.actor_id !== String(userId)),
    ).toEqual([]);
  });
});
