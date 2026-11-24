/**
 * Device sign-in: the token issued at approval (WFT #2609).
 *
 * Drives the device flow through `fastify.inject` with an in-memory database
 * and pins the contract of the token the approval step issues: its scope,
 * its lifetime, whom it belongs to, and how many are issued per session.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifySecureSession from '@fastify/secure-session';
import fastifyFormbody from '@fastify/formbody';
import { randomBytes } from 'node:crypto';
import * as cheerio from 'cheerio';
import type Database from '../../../../db/driver.js';

import authPlugin from '../../../plugins/auth.js';
import deviceCodeRoute from '../device-code.js';
import deviceTokenRoute from '../device-token.js';
import deviceHtmlRoute from '../device-html.js';
import { extractSessionCookie } from '../../../../../tests/helpers/session-cookie.js';
import { SESSION_LIFETIME_SECONDS } from '../../../../web/session-constants.js';
import {
  _resetForTests as resetDeviceFlowStore,
  findByDeviceCode,
} from '../../../../services/device-flow-store.js';
import { initDatabase } from '../../../../db/database.js';
import { runMigrations } from '../../../../db/migrate.js';
import { seedIdentities } from '../../../../services/identity-seeder.js';
import { UserRepository } from '../../../../repositories/user.repository.js';
import { ApiTokenRepository } from '../../../../repositories/api-token.repository.js';
import { grantSatisfiesScope, type PatScope } from '../../../../schemas/pat-scope.schema.js';

const ORIGIN = 'http://localhost:3000';
const CLIENT_ID = 'cli-issued-token-client.example.com';
const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';
const DAY_MS = 24 * 60 * 60 * 1000;

interface Harness {
  app: FastifyInstance;
  db: Database.Database;
  userA: number;
  userB: number;
}

async function buildHarness(): Promise<Harness> {
  const db = initDatabase(':memory:');
  await runMigrations(db);
  seedIdentities(db, [], { info: () => {}, warn: () => {} });
  const insertUser = db.prepare(`INSERT INTO users (display_name) VALUES (?) RETURNING id`);
  const userA = (insertUser.get('user-a') as { id: number }).id;
  const userB = (insertUser.get('user-b') as { id: number }).id;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const app: any = Fastify({ logger: false });
  app.decorate('userRepository', new UserRepository(db));
  app.decorate('apiTokenRepository', new ApiTokenRepository(db));

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
  await app.register(authPlugin);

  app.post(
    '/__test/sign-in',
    { config: { skipAuth: true } },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (request: any, reply: any) => {
      const { userId } = request.body as { userId: number };
      request.session.set('user', { id: userId });
      request.session.set('authenticatedAt', Date.now());
      return reply.code(204).send();
    },
  );

  await app.register(deviceCodeRoute, { origin: ORIGIN, expectedClientId: CLIENT_ID });
  await app.register(deviceTokenRoute, { expectedClientId: CLIENT_ID });
  await app.register(deviceHtmlRoute, { origin: ORIGIN });
  await app.ready();

  return { app, db, userA, userB };
}

async function signIn(app: FastifyInstance, userId: number): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/__test/sign-in',
    payload: { userId },
    headers: { 'content-type': 'application/json' },
  });
  expect(res.statusCode).toBe(204);
  const cookie = extractSessionCookie(res);
  if (!cookie) throw new Error('sign-in probe emitted no Set-Cookie');
  return cookie;
}

async function openApprovalPage(
  app: FastifyInstance,
  cookie: string,
  userCode: string,
): Promise<{ csrf: string; cookie: string; body: string }> {
  const r = await app.inject({
    method: 'GET',
    url: `/auth/device?user_code=${userCode}`,
    headers: { cookie },
  });
  expect(r.statusCode).toBe(200);
  const $ = cheerio.load(r.body);
  const csrf = $('input[name="_csrf"]').attr('value') ?? '';
  expect(csrf).toMatch(/^[0-9a-f]{64}$/);
  return { csrf, cookie: extractSessionCookie(r) ?? cookie, body: r.body };
}

async function startSignIn(
  app: FastifyInstance,
  hostname: string,
): Promise<{ device_code: string; user_code: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/device/code',
    headers: { 'content-type': 'application/json' },
    payload: { client_id: CLIENT_ID, hostname },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as { device_code: string; user_code: string };
}

async function approveAs(
  app: FastifyInstance,
  userId: number,
  userCode: string,
): Promise<{ statusCode: number; body: string }> {
  const cookie = await signIn(app, userId);
  const page = await openApprovalPage(app, cookie, userCode);
  const res = await app.inject({
    method: 'POST',
    url: '/auth/device/verify',
    payload: new URLSearchParams({ _csrf: page.csrf, user_code: userCode }).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: page.cookie },
  });
  return { statusCode: res.statusCode, body: res.body };
}

async function poll(
  app: FastifyInstance,
  deviceCode: string,
): Promise<{ statusCode: number; json: Record<string, unknown> }> {
  // Step past the poll-interval gate without sleeping.
  const s = findByDeviceCode(deviceCode);
  if (s) s.lastPollAt = Date.now() - 60_000;
  const res = await app.inject({
    method: 'POST',
    url: '/auth/device/token',
    headers: { 'content-type': 'application/json' },
    payload: { grant_type: GRANT_TYPE, device_code: deviceCode, client_id: CLIENT_ID },
  });
  return { statusCode: res.statusCode, json: res.json() as Record<string, unknown> };
}

interface TokenRow {
  id: number;
  user_id: number;
  scopes: string;
  expires_at: string | null;
  revoked_at: string | null;
}

function tokenRows(db: Database.Database): TokenRow[] {
  return db
    .prepare('SELECT id, user_id, scopes, expires_at, revoked_at FROM api_tokens ORDER BY id')
    .all() as TokenRow[];
}

describe('device sign-in: issued token', () => {
  let h: Harness;

  beforeEach(async () => {
    resetDeviceFlowStore();
    h = await buildHarness();
  });
  afterEach(async () => {
    await h.app.close();
    h.db.close();
  });

  describe('scope and lifetime', () => {
    it('the issued token carries the read and write scopes and expires in 90 days', async () => {
      const { user_code } = await startSignIn(h.app, 'laptop');
      const before = Date.now();
      const r = await approveAs(h.app, h.userA, user_code);
      const after = Date.now();
      expect(r.statusCode).toBe(200);

      const rows = tokenRows(h.db);
      expect(rows).toHaveLength(1);
      const row = rows[0] as TokenRow;
      expect(JSON.parse(row.scopes)).toEqual(['read', 'write']);
      expect(row.expires_at).not.toBeNull();
      const expiresMs = new Date(row.expires_at ?? '').getTime();
      expect(expiresMs).toBeGreaterThanOrEqual(before + 90 * DAY_MS);
      expect(expiresMs).toBeLessThanOrEqual(after + 90 * DAY_MS);
    });

    it('the issued token is never empty-scoped and does not reach the admin tier', async () => {
      const { user_code } = await startSignIn(h.app, 'laptop');
      expect((await approveAs(h.app, h.userA, user_code)).statusCode).toBe(200);

      const row = tokenRows(h.db)[0] as TokenRow;
      const scopes = JSON.parse(row.scopes) as PatScope[];
      expect(scopes.length).toBeGreaterThan(0);
      expect(scopes).not.toContain('admin');
      expect(grantSatisfiesScope(scopes, 'admin')).toBe(false);
      expect(grantSatisfiesScope(scopes, 'write')).toBe(true);
      expect(grantSatisfiesScope(scopes, 'read')).toBe(true);
    });
  });

  describe('one approver, one token per session', () => {
    it('two users: the second submission of an approved code is refused and the CLI receives the first approver’s token', async () => {
      // User A's CLI starts a sign-in and user A approves it.
      const { device_code, user_code } = await startSignIn(h.app, 'laptop-a');
      const first = await approveAs(h.app, h.userA, user_code);
      expect(first.statusCode).toBe(200);
      const afterFirst = findByDeviceCode(device_code);
      const tokenA = afterFirst?.mintedToken;
      const tokenIdA = afterFirst?.mintedTokenId;
      expect(tokenA).toMatch(/^wft_pat_/);

      // Before the CLI polls, user B submits the same code.
      const second = await approveAs(h.app, h.userB, user_code);
      expect(second.statusCode).toBe(400);
      expect(second.body.toLowerCase()).not.toContain('<h1>approved</h1>');

      // Nothing was issued to user B and the session still holds A's token.
      const rows = tokenRows(h.db);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.user_id).toBe(h.userA);
      expect(rows[0]?.revoked_at).toBeNull();
      const afterSecond = findByDeviceCode(device_code);
      expect(afterSecond?.approvedUserId).toBe(h.userA);
      expect(afterSecond?.mintedToken).toBe(tokenA);
      expect(afterSecond?.mintedTokenId).toBe(tokenIdA);

      // The CLI started by user A receives user A's token.
      const delivered = await poll(h.app, device_code);
      expect(delivered.statusCode).toBe(200);
      expect(delivered.json['token']).toBe(tokenA);
      expect(delivered.json['token_id']).toBe(tokenIdA);
      expect((delivered.json['user'] as { id: number }).id).toBe(h.userA);
    });

    it('the issued token belongs to the user who approved the session', async () => {
      const { device_code, user_code } = await startSignIn(h.app, 'laptop-b');
      expect((await approveAs(h.app, h.userB, user_code)).statusCode).toBe(200);
      const session = findByDeviceCode(device_code);
      expect(session?.approvedUserId).toBe(h.userB);
      const rows = tokenRows(h.db);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.user_id).toBe(h.userB);
      expect(rows[0]?.id).toBe(session?.mintedTokenId);
    });

    it('a repeat approval by the same user issues no second token', async () => {
      const { device_code, user_code } = await startSignIn(h.app, 'laptop-a');
      expect((await approveAs(h.app, h.userA, user_code)).statusCode).toBe(200);
      const tokenA = findByDeviceCode(device_code)?.mintedToken;

      const repeat = await approveAs(h.app, h.userA, user_code);
      expect(repeat.statusCode).toBe(200);

      const rows = tokenRows(h.db);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.revoked_at).toBeNull();
      expect(findByDeviceCode(device_code)?.mintedToken).toBe(tokenA);
    });
  });
});
