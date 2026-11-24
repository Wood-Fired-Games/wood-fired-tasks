/**
 * Device sign-in: the token issued at approval (WFT #2609).
 *
 * Drives the device flow through `fastify.inject` with an in-memory database
 * and pins the contract of the token the approval step issues: its scope,
 * its lifetime, whom it belongs to, and how many are issued per session.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
  remove as removeDeviceSession,
} from '../../../../services/device-flow-store.js';
import { initDatabase } from '../../../../db/database.js';
import { runMigrations } from '../../../../db/migrate.js';
import { seedIdentities } from '../../../../services/identity-seeder.js';
import { UserRepository } from '../../../../repositories/user.repository.js';
import { ApiTokenRepository } from '../../../../repositories/api-token.repository.js';
import { AuditEventRepository } from '../../../../repositories/audit-event.repository.js';
import type { AuditEventRow } from '../../../../repositories/interfaces.js';
import { hashToken } from '../../../../services/pat-hash.js';
import { grantSatisfiesScope, type PatScope } from '../../../../schemas/pat-scope.schema.js';

const ORIGIN = 'http://localhost:3000';
const CLIENT_ID = 'cli-issued-token-client.example.com';
const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';
const DAY_MS = 24 * 60 * 60 * 1000;

interface Harness {
  app: FastifyInstance;
  db: Database.Database;
  auditEvents: AuditEventRepository;
  logs: Record<string, unknown>[];
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

  const logs: Record<string, unknown>[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const app: any = Fastify({
    logger: {
      level: 'info',
      stream: { write: (line: string) => logs.push(JSON.parse(line) as Record<string, unknown>) },
    },
  });
  app.decorate('userRepository', new UserRepository(db));
  app.decorate('apiTokenRepository', new ApiTokenRepository(db));
  const auditEvents = new AuditEventRepository(db);
  app.decorate('auditEventRepository', auditEvents);

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

  return { app, db, auditEvents, logs, userA, userB };
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
  return postVerify(app, page.cookie, {
    ...hiddenFields(page.body),
    user_code: userCode,
    action: 'approve',
  });
}

/** The hidden inputs of the page's verify form, as the browser would send them. */
function hiddenFields(body: string): Record<string, string> {
  const $ = cheerio.load(body);
  const out: Record<string, string> = {};
  $('form[action="/auth/device/verify"] input[type="hidden"]').each((_, el) => {
    const name = $(el).attr('name');
    if (name) out[name] = $(el).attr('value') ?? '';
  });
  return out;
}

async function postVerify(
  app: FastifyInstance,
  cookie: string,
  fields: Record<string, string>,
): Promise<{ statusCode: number; body: string; cookie: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/device/verify',
    payload: new URLSearchParams(fields).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
  });
  return {
    statusCode: res.statusCode,
    body: res.body,
    cookie: extractSessionCookie(res) ?? cookie,
  };
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

    it('the issued token satisfies read and write and not admin', async () => {
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

  describe('approval page: requesting machine and Deny', () => {
    async function submit(
      userId: number,
      userCode: string,
      action: 'approve' | 'deny',
    ): Promise<{ statusCode: number; body: string }> {
      const cookie = await signIn(h.app, userId);
      const page = await openApprovalPage(h.app, cookie, userCode);
      return postVerify(h.app, page.cookie, {
        ...hiddenFields(page.body),
        user_code: userCode,
        action,
      });
    }

    it('the approval page names the machine that started the sign-in', async () => {
      const { user_code } = await startSignIn(h.app, 'Build Box 7');
      const cookie = await signIn(h.app, h.userA);
      const page = await openApprovalPage(h.app, cookie, user_code);
      const $ = cheerio.load(page.body);
      expect($('.requesting-machine').text()).toContain('build-box-7');
    });

    it('Deny marks the session denied, issues no token, and the CLI is told access_denied', async () => {
      const { device_code, user_code } = await startSignIn(h.app, 'laptop');
      const denied = await submit(h.userA, user_code, 'deny');
      expect(denied.statusCode).toBe(200);
      expect(denied.body.toLowerCase()).toContain('denied');
      expect(findByDeviceCode(device_code)?.status).toBe('denied');
      expect(tokenRows(h.db)).toHaveLength(0);

      const polled = await poll(h.app, device_code);
      expect(polled.statusCode).toBe(400);
      expect(polled.json['error']).toBe('access_denied');
    });

    it('a denied session cannot later be approved', async () => {
      const { device_code, user_code } = await startSignIn(h.app, 'laptop');
      expect((await submit(h.userA, user_code, 'deny')).statusCode).toBe(200);

      const approveAfter = await submit(h.userA, user_code, 'approve');
      expect(approveAfter.statusCode).toBe(400);
      expect(findByDeviceCode(device_code)?.status).toBe('denied');
      expect(findByDeviceCode(device_code)?.approvedUserId).toBeNull();
      expect(tokenRows(h.db)).toHaveLength(0);
    });

    it('Deny on an already approved session is refused and leaves the approval in place', async () => {
      const { device_code, user_code } = await startSignIn(h.app, 'laptop');
      expect((await submit(h.userA, user_code, 'approve')).statusCode).toBe(200);
      const denyAfter = await submit(h.userB, user_code, 'deny');
      expect(denyAfter.statusCode).toBe(400);
      expect(findByDeviceCode(device_code)?.status).toBe('approved');
    });
  });

  describe('confirmation before approval', () => {
    async function blankPage(userId: number): Promise<{ cookie: string; body: string }> {
      const cookie = await signIn(h.app, userId);
      const r = await h.app.inject({ method: 'GET', url: '/auth/device', headers: { cookie } });
      expect(r.statusCode).toBe(200);
      return { cookie: extractSessionCookie(r) ?? cookie, body: r.body };
    }

    it('a typed code is shown back with the machine name before anything is approved', async () => {
      const { device_code, user_code } = await startSignIn(h.app, 'Build Box 7');
      const blank = await blankPage(h.userA);
      const $blank = cheerio.load(blank.body);
      expect($blank('button[value="approve"]').length).toBe(0);
      expect($blank('button[value="continue"]').length).toBe(1);

      const shown = await postVerify(h.app, blank.cookie, {
        ...hiddenFields(blank.body),
        user_code,
        action: 'continue',
      });
      expect(shown.statusCode).toBe(200);
      const $shown = cheerio.load(shown.body);
      expect($shown('.requesting-machine').text()).toContain('build-box-7');
      expect($shown('button[value="approve"]').length).toBe(1);
      expect($shown('button[value="deny"]').length).toBe(1);
      expect(findByDeviceCode(device_code)?.status).toBe('pending');
      expect(tokenRows(h.db)).toHaveLength(0);

      // Approving from the page that named the machine completes the sign-in.
      const done = await postVerify(h.app, shown.cookie, {
        ...hiddenFields(shown.body),
        user_code,
        action: 'approve',
      });
      expect(done.statusCode).toBe(200);
      expect(findByDeviceCode(device_code)?.status).toBe('approved');
      expect(tokenRows(h.db)).toHaveLength(1);
    });

    it('approve without confirmation from a page naming the machine shows that page and approves nothing', async () => {
      const { device_code, user_code } = await startSignIn(h.app, 'laptop');
      const blank = await blankPage(h.userA);
      const r = await postVerify(h.app, blank.cookie, {
        ...hiddenFields(blank.body),
        user_code,
        action: 'approve',
      });
      expect(r.statusCode).toBe(200);
      expect(cheerio.load(r.body)('.requesting-machine').text()).toContain('laptop');
      expect(findByDeviceCode(device_code)?.status).toBe('pending');
      expect(tokenRows(h.db)).toHaveLength(0);
    });

    it('a confirmation for a different code does not approve this one', async () => {
      const other = await startSignIn(h.app, 'other');
      const { device_code, user_code } = await startSignIn(h.app, 'laptop');
      const cookie = await signIn(h.app, h.userA);
      const page = await openApprovalPage(h.app, cookie, other.user_code);
      const r = await postVerify(h.app, page.cookie, {
        ...hiddenFields(page.body),
        user_code,
        action: 'approve',
      });
      expect(r.statusCode).toBe(200);
      expect(findByDeviceCode(device_code)?.status).toBe('pending');
      expect(findByDeviceCode(other.device_code)?.status).toBe('pending');
      expect(tokenRows(h.db)).toHaveLength(0);
    });
  });

  describe('accepted actions', () => {
    it.each([
      ['missing (a form submitted without a button)', undefined],
      ['empty', ''],
      ['another word', 'yes'],
      ['different case', 'APPROVE'],
      ['padded', ' approve'],
    ])('action %s is refused and approves nothing', async (_label, action) => {
      const { device_code, user_code } = await startSignIn(h.app, 'laptop');
      const cookie = await signIn(h.app, h.userA);
      const page = await openApprovalPage(h.app, cookie, user_code);
      const fields: Record<string, string> = { ...hiddenFields(page.body), user_code };
      if (action !== undefined) fields['action'] = action;
      const r = await postVerify(h.app, page.cookie, fields);
      expect(r.statusCode).toBe(400);
      expect(findByDeviceCode(device_code)?.status).toBe('pending');
      expect(tokenRows(h.db)).toHaveLength(0);
    });

    it('continue with a confirmed code shows the page again and approves nothing', async () => {
      const { device_code, user_code } = await startSignIn(h.app, 'laptop');
      const cookie = await signIn(h.app, h.userA);
      const page = await openApprovalPage(h.app, cookie, user_code);
      const r = await postVerify(h.app, page.cookie, {
        ...hiddenFields(page.body),
        user_code,
        action: 'continue',
      });
      expect(r.statusCode).toBe(200);
      expect(findByDeviceCode(device_code)?.status).toBe('pending');
      expect(tokenRows(h.db)).toHaveLength(0);
    });
  });

  describe('audit trail', () => {
    const ISSUED = 'device_sign_in.token_issued';

    function allRows(): AuditEventRow[] {
      return h.auditEvents.findByTimeRange(
        '1970-01-01T00:00:00.000Z',
        '9999-12-31T23:59:59.999Z',
        500,
      );
    }

    function issuanceRows(): AuditEventRow[] {
      return allRows().filter((e) => e.action === ISSUED);
    }

    it('records the issuance with the approving user and the token id', async () => {
      const { device_code, user_code } = await startSignIn(h.app, 'laptop');
      expect((await approveAs(h.app, h.userA, user_code)).statusCode).toBe(200);
      const session = findByDeviceCode(device_code);

      const rows = issuanceRows();
      expect(rows).toHaveLength(1);
      const row = rows[0] as AuditEventRow;
      expect(row.actor_type).toBe('user');
      expect(row.actor_id).toBe(String(h.userA));
      expect(row.resource_type).toBe('api_tokens');
      expect(row.resource_id).toBe(String(session?.mintedTokenId));
      expect(h.auditEvents.verifyChain()).toBeNull();
    });

    it('never writes the token or its hash into the audit trail', async () => {
      const { device_code, user_code } = await startSignIn(h.app, 'laptop');
      expect((await approveAs(h.app, h.userA, user_code)).statusCode).toBe(200);
      const token = findByDeviceCode(device_code)?.mintedToken ?? '';
      expect(token).toMatch(/^wft_pat_/);

      const rows = allRows();
      expect(rows.length).toBeGreaterThan(0);
      const dump = JSON.stringify(rows);
      expect(dump).not.toContain(token);
      expect(dump).not.toContain(hashToken(token));
      // No fragment either: no 6-character run of the token's random part
      // or of its hash appears anywhere in the trail.
      const secretPart = token.slice('wft_pat_'.length);
      const hash = hashToken(token);
      for (const s of [secretPart, hash]) {
        for (let i = 0; i + 6 <= s.length; i++) {
          expect(dump).not.toContain(s.slice(i, i + 6));
        }
      }
    });

    it('records no issuance when nothing is issued (Deny, refused second submission)', async () => {
      const a = await startSignIn(h.app, 'laptop');
      const cookie = await signIn(h.app, h.userA);
      const page = await openApprovalPage(h.app, cookie, a.user_code);
      const denied = await h.app.inject({
        method: 'POST',
        url: '/auth/device/verify',
        payload: new URLSearchParams({
          _csrf: page.csrf,
          user_code: a.user_code,
          action: 'deny',
        }).toString(),
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: page.cookie },
      });
      expect(denied.statusCode).toBe(200);
      expect(issuanceRows()).toHaveLength(0);

      const b = await startSignIn(h.app, 'laptop');
      expect((await approveAs(h.app, h.userA, b.user_code)).statusCode).toBe(200);
      expect((await approveAs(h.app, h.userB, b.user_code)).statusCode).toBe(400);
      const rows = issuanceRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.actor_id).toBe(String(h.userA));
    });

    it('no token is delivered when the issuance cannot be recorded', async () => {
      const spy = vi.spyOn(h.auditEvents, 'append').mockImplementation(() => {
        throw new Error('audit store unavailable');
      });
      const { device_code, user_code } = await startSignIn(h.app, 'laptop');
      const r = await approveAs(h.app, h.userA, user_code);
      spy.mockRestore();

      expect(r.statusCode).toBe(500);
      expect(cheerio.load(r.body)('p.error').text()).toContain('Could not complete sign-in');
      const rows = tokenRows(h.db);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.revoked_at).not.toBeNull();
      expect(findByDeviceCode(device_code)?.mintedToken).toBeNull();
      expect((await poll(h.app, device_code)).json['error']).toBe('authorization_pending');
      const failure = h.logs.find((l) => l['msg'] === 'audit.append_failed');
      expect(failure).toBeDefined();
      expect(failure?.['level']).toBe(50);
      expect(failure?.['tokenId']).toBe(rows[0]?.id);
    });

    it('a token withdrawn because it could not be handed to the session is recorded', async () => {
      const { device_code, user_code } = await startSignIn(h.app, 'laptop');
      // The session disappears between issuing the token and storing it.
      const repo = h.app.apiTokenRepository;
      const realInsert = repo.insert.bind(repo);
      const spy = vi.spyOn(repo, 'insert').mockImplementation((input) => {
        const row = realInsert(input);
        removeDeviceSession(device_code);
        return row;
      });
      const r = await approveAs(h.app, h.userA, user_code);
      spy.mockRestore();

      expect(r.statusCode).toBe(500);
      const token = tokenRows(h.db)[0] as TokenRow;
      expect(token.revoked_at).not.toBeNull();
      const revoked = allRows().filter((e) => e.action === 'device_sign_in.token_revoked');
      expect(revoked).toHaveLength(1);
      expect(revoked[0]?.actor_id).toBe(String(h.userA));
      expect(revoked[0]?.resource_type).toBe('api_tokens');
      expect(revoked[0]?.resource_id).toBe(String(token.id));
    });

    it('a denial is recorded with the denying user', async () => {
      const { user_code } = await startSignIn(h.app, 'laptop');
      const cookie = await signIn(h.app, h.userB);
      const page = await openApprovalPage(h.app, cookie, user_code);
      const r = await postVerify(h.app, page.cookie, {
        ...hiddenFields(page.body),
        user_code,
        action: 'deny',
      });
      expect(r.statusCode).toBe(200);
      const denied = allRows().filter((e) => e.action === 'device_sign_in.denied');
      expect(denied).toHaveLength(1);
      expect(denied[0]?.actor_type).toBe('user');
      expect(denied[0]?.actor_id).toBe(String(h.userB));
      expect(JSON.stringify(denied)).not.toContain(user_code);
    });

    it('the approval route refuses to register without the audit repository', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const bare: any = Fastify({ logger: false });
      bare.decorate('apiTokenRepository', {});
      await expect(bare.register(deviceHtmlRoute, { origin: ORIGIN }).ready()).rejects.toThrow(
        /auditEventRepository/,
      );
      await bare.close();
    });
  });

  describe('one approver, one token per session', () => {
    it('two users: the CLI receives the approving user’s token and a later submission is answered with 400', async () => {
      // User A's CLI starts a sign-in and user A approves it.
      const { device_code, user_code } = await startSignIn(h.app, 'laptop-a');
      const first = await approveAs(h.app, h.userA, user_code);
      expect(first.statusCode).toBe(200);
      const afterFirst = findByDeviceCode(device_code);
      const tokenA = afterFirst?.mintedToken;
      const tokenIdA = afterFirst?.mintedTokenId;
      expect(tokenA).toMatch(/^wft_pat_/);

      // User B then submits the same code.
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

    it('after a failed issue the same approver can retry; another user cannot', async () => {
      const { device_code, user_code } = await startSignIn(h.app, 'laptop');
      const repo = h.app.apiTokenRepository;
      const spy = vi.spyOn(repo, 'insert').mockImplementationOnce(() => {
        throw new Error('database busy');
      });
      expect((await approveAs(h.app, h.userA, user_code)).statusCode).toBe(500);
      spy.mockRestore();
      expect(findByDeviceCode(device_code)?.status).toBe('approved');
      expect(findByDeviceCode(device_code)?.mintedToken).toBeNull();
      expect(tokenRows(h.db)).toHaveLength(0);

      expect((await approveAs(h.app, h.userB, user_code)).statusCode).toBe(400);
      expect(tokenRows(h.db)).toHaveLength(0);

      expect((await approveAs(h.app, h.userA, user_code)).statusCode).toBe(200);
      const rows = tokenRows(h.db);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.user_id).toBe(h.userA);
      const delivered = await poll(h.app, device_code);
      expect(delivered.statusCode).toBe(200);
      expect(delivered.json['token_id']).toBe(rows[0]?.id);
    });

    it('concurrent approvals of one code by two users issue exactly one token', async () => {
      const { device_code, user_code } = await startSignIn(h.app, 'laptop');
      const pages = await Promise.all(
        [h.userA, h.userB].map(async (u) => {
          const cookie = await signIn(h.app, u);
          return openApprovalPage(h.app, cookie, user_code);
        }),
      );
      const results = await Promise.all(
        pages.map((p) =>
          postVerify(h.app, p.cookie, { ...hiddenFields(p.body), user_code, action: 'approve' }),
        ),
      );
      const codes = results.map((r) => r.statusCode).sort();
      expect(codes).toEqual([200, 400]);
      const rows = tokenRows(h.db);
      expect(rows).toHaveLength(1);
      const session = findByDeviceCode(device_code);
      expect(rows[0]?.user_id).toBe(session?.approvedUserId);
      expect(rows[0]?.id).toBe(session?.mintedTokenId);
    });

    it('concurrent approvals of one code by the same user issue exactly one token', async () => {
      const { user_code } = await startSignIn(h.app, 'laptop');
      const cookie = await signIn(h.app, h.userA);
      const page = await openApprovalPage(h.app, cookie, user_code);
      const fields = { ...hiddenFields(page.body), user_code, action: 'approve' };
      const results = await Promise.all([
        postVerify(h.app, page.cookie, fields),
        postVerify(h.app, page.cookie, fields),
        postVerify(h.app, page.cookie, fields),
      ]);
      expect(results.every((r) => r.statusCode === 200)).toBe(true);
      expect(tokenRows(h.db)).toHaveLength(1);
    });
  });
});
