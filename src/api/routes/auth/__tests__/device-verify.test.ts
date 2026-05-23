/**
 * Phase 30 Plan 02 Task 3 — POST /auth/device/verify integration tests.
 *
 * The verify handler runs with `config: { sessionOnly: true }` so the Phase
 * 28 auth chain enforces session-only access BEFORE the handler. Tests
 * mount: cookie + secure-session + formbody + auth-chain plugin + the
 * deviceHtmlRoute factory. A probe seeds session.user (mirrors what the
 * OIDC callback does); CSRF is read out of the GET /auth/device response.
 *
 * Coverage (mirrors plan §Task 3 done-criteria):
 *   1. No session → 403 (session_required).
 *   2. PAT-only session (Bearer auth, no cookie) → 403 session_required.
 *   3. Valid session, no _csrf → 403.
 *   4. Valid session, mismatched _csrf → 403.
 *   5. Valid session, valid _csrf, malformed user_code → 400 + format error.
 *   6. Valid session, valid _csrf, unknown user_code → 400 + expired error.
 *   7. Valid session, valid _csrf, expired session in store → 400 + expired error.
 *   8. Valid session, valid _csrf, fresh pending → 200 + Approved page;
 *      device-flow session transitions to 'approved' with approvedUserId.
 *   9. Second verify on already-approved session (same user) → 200 idempotent.
 *  10. Log payload contains event=device_flow_approved + userId; NEVER the user_code.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Writable } from 'stream';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifySecureSession from '@fastify/secure-session';
import fastifyFormbody from '@fastify/formbody';
import pino from 'pino';
import { randomBytes } from 'node:crypto';
import * as cheerio from 'cheerio';
import type Database from 'better-sqlite3';

import authPlugin from '../../../plugins/auth.js';
import deviceHtmlRoute from '../device-html.js';
import { extractSessionCookie } from '../../../../../tests/helpers/session-cookie.js';
import { SESSION_LIFETIME_SECONDS } from '../../../../web/session-constants.js';
import {
  createSession as createDeviceSession,
  findByUserCode,
  _resetForTests as resetDeviceFlowStore,
} from '../../../../services/device-flow-store.js';
import { initDatabase } from '../../../../db/database.js';
import { runMigrations } from '../../../../db/migrate.js';
import { seedIdentities } from '../../../../services/identity-seeder.js';
import { parseApiKeyEntries } from '../../../../config/env.js';
import { UserRepository } from '../../../../repositories/user.repository.js';
import { ApiTokenRepository } from '../../../../repositories/api-token.repository.js';
import { generateToken } from '../../../../services/pat-hash.js';
import { LOGGER_REDACT_CONFIG } from '../../../server.js';

const ORIGIN = 'http://localhost:3000';

interface Harness {
  app: FastifyInstance;
  db: Database.Database;
  legacyUserId: number;
  capturedLogs: string[];
  drainLogs: () => void;
}

async function buildHarness(): Promise<Harness> {
  // Label syntax `key:label` so display_name is deterministically the label.
  process.env.API_KEYS = 'verify-test-key:verify-key';

  const captured: string[] = [];
  const dest = new Writable({
    write(chunk, _enc, cb) {
      captured.push(chunk.toString());
      cb();
    },
  });
  const logger = pino(
    {
      level: 'info',
      redact: {
        paths: [...LOGGER_REDACT_CONFIG.paths],
        censor: LOGGER_REDACT_CONFIG.censor,
      },
    },
    dest,
  );

  const db = initDatabase(':memory:');
  await runMigrations(db);
  const apiKeyEntries = parseApiKeyEntries(process.env.API_KEYS);
  seedIdentities(db, apiKeyEntries, { info: () => {}, warn: () => {} });
  const userRepo = new UserRepository(db);
  const apiTokenRepo = new ApiTokenRepository(db);
  const legacyUser = userRepo.findLegacyByDisplayName('verify-key');
  if (legacyUser === null) {
    throw new Error('test setup: legacy user not seeded');
  }

  // Pino / Fastify logger type mismatch — `as any` is the project pattern
  // (see auth-chain.test.ts:86).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const app: any = Fastify({ loggerInstance: logger as any });
  app.decorate('userRepository', userRepo);
  app.decorate('apiTokenRepository', apiTokenRepo);

  await app.register(fastifyCookie);
  await app.register(fastifySecureSession, {
    sessionName: 'session',
    cookieName: 'wfb_session',
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

  // Probe — seeds session.user the way the OIDC callback does. skipAuth so
  // the chain doesn't need credentials to set the cookie.
  app.post(
    '/__test/sign-in',
    { config: { skipAuth: true } },
    async (request: any, reply: any) => {
      const { userId } = request.body as { userId: number };
      request.session.set('user', { id: userId });
      request.session.set('authenticatedAt', Date.now());
      return reply.code(204).send();
    },
  );

  await app.register(deviceHtmlRoute, { origin: ORIGIN });
  await app.ready();

  return {
    app,
    db,
    legacyUserId: legacyUser.id,
    capturedLogs: captured,
    drainLogs: () => {
      captured.length = 0;
    },
  };
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

/**
 * GET /auth/device with the supplied session cookie, parse out the csrf
 * token from the hidden input. The returned cookie may be rotated by
 * @fastify/secure-session when the csrf write lands — return the latest.
 */
async function fetchCsrf(
  app: FastifyInstance,
  cookie: string,
): Promise<{ csrf: string; cookie: string }> {
  const r = await app.inject({
    method: 'GET',
    url: '/auth/device',
    headers: { cookie },
  });
  expect(r.statusCode).toBe(200);
  const $ = cheerio.load(r.body);
  const csrf = $('input[name="_csrf"]').attr('value') ?? '';
  expect(csrf).toMatch(/^[0-9a-f]{64}$/);
  const rotated = extractSessionCookie(r);
  return { csrf, cookie: rotated ?? cookie };
}

function postVerify(
  app: FastifyInstance,
  body: Record<string, string>,
  headers: Record<string, string> = {},
) {
  const params = new URLSearchParams(body).toString();
  return app.inject({
    method: 'POST',
    url: '/auth/device/verify',
    payload: params,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...headers,
    },
  });
}

function mintPatRow(
  db: Database.Database,
  userId: number,
): { token: string; tokenId: number } {
  const { token, prefix, suffix, hash } = generateToken();
  const info = db
    .prepare(
      `INSERT INTO api_tokens (user_id, name, prefix, suffix, hash, scopes, revoked_at, expires_at)
       VALUES (?, 'verify-test-pat', ?, ?, ?, '[]', NULL, NULL)`,
    )
    .run(userId, prefix, suffix, hash);
  return { token, tokenId: Number(info.lastInsertRowid) };
}

describe('POST /auth/device/verify', () => {
  let harness: Harness;

  beforeEach(async () => {
    resetDeviceFlowStore();
    harness = await buildHarness();
  });
  afterEach(async () => {
    await harness.app.close();
    harness.db.close();
  });

  it('1. no credentials at all → 401 (auth chain runs first before sessionOnly check)', async () => {
    // Plan §Task 3 done-criteria #1 originally specified "403 / SESSION_REQUIRED",
    // but the Phase 28 chain returns 401 for `no credentials` — sessionOnly only
    // fires AFTER a strategy matches. This matches the documented contract in
    // auth-chain.test.ts ('sessionOnly=true + no credentials → 401').
    const r = await postVerify(harness.app, {
      _csrf: 'a'.repeat(64),
      user_code: 'ABCDEFGH',
    });
    expect(r.statusCode).toBe(401);
  });

  it('2. PAT-only auth (Bearer, no cookie) → 403 session_required', async () => {
    const { token } = mintPatRow(harness.db, harness.legacyUserId);
    const r = await postVerify(
      harness.app,
      { _csrf: 'a'.repeat(64), user_code: 'ABCDEFGH' },
      { authorization: `Bearer ${token}` },
    );
    expect(r.statusCode).toBe(403);
    expect(r.json()).toMatchObject({ error: 'session_required' });
  });

  it('3. valid session, no _csrf field → 403 (renders device page with CSRF error)', async () => {
    const cookie = await signIn(harness.app, harness.legacyUserId);
    const r = await postVerify(
      harness.app,
      { user_code: 'ABCDEFGH' },
      { cookie },
    );
    expect(r.statusCode).toBe(403);
    expect(String(r.headers['content-type'])).toMatch(/text\/html/);
    const $ = cheerio.load(r.body);
    expect($('p.error').length).toBe(1);
  });

  it('4. valid session, mismatched _csrf → 403', async () => {
    const cookie = await signIn(harness.app, harness.legacyUserId);
    const { cookie: c2 } = await fetchCsrf(harness.app, cookie);
    const r = await postVerify(
      harness.app,
      // 64 hex chars but wrong bytes
      { _csrf: 'b'.repeat(64), user_code: 'ABCDEFGH' },
      { cookie: c2 },
    );
    expect(r.statusCode).toBe(403);
  });

  it('5. valid session + csrf, malformed user_code → 400 + format error in page', async () => {
    const cookie = await signIn(harness.app, harness.legacyUserId);
    const { csrf, cookie: c2 } = await fetchCsrf(harness.app, cookie);
    const r = await postVerify(
      harness.app,
      { _csrf: csrf, user_code: 'lowercase' },
      { cookie: c2 },
    );
    expect(r.statusCode).toBe(400);
    const $ = cheerio.load(r.body);
    const err = $('p.error');
    expect(err.length).toBe(1);
    expect(err.text().toLowerCase()).toContain('format');
  });

  it('6. valid session + csrf, unknown user_code → 400 + expired error', async () => {
    const cookie = await signIn(harness.app, harness.legacyUserId);
    const { csrf, cookie: c2 } = await fetchCsrf(harness.app, cookie);
    const r = await postVerify(
      harness.app,
      // Well-formed but no device-flow session created for it.
      { _csrf: csrf, user_code: 'ABCDEFGH' },
      { cookie: c2 },
    );
    expect(r.statusCode).toBe(400);
    const $ = cheerio.load(r.body);
    const err = $('p.error');
    expect(err.length).toBe(1);
    expect(err.text().toLowerCase()).toContain('expired');
  });

  it('7. valid session + csrf, expired session in store → 400 + expired error', async () => {
    const cookie = await signIn(harness.app, harness.legacyUserId);
    const { csrf, cookie: c2 } = await fetchCsrf(harness.app, cookie);
    const ds = createDeviceSession({
      clientId: 'verify-test-key',
      hostname: null,
    });
    // Force expiry into the past.
    const session = findByUserCode(ds.userCode);
    if (!session) throw new Error('device-flow session missing');
    session.expiresAt = Date.now() - 1000;
    const r = await postVerify(
      harness.app,
      { _csrf: csrf, user_code: ds.userCode },
      { cookie: c2 },
    );
    expect(r.statusCode).toBe(400);
    const $ = cheerio.load(r.body);
    expect($('p.error').text().toLowerCase()).toContain('expired');
    // Session must remain un-approved.
    expect(findByUserCode(ds.userCode)?.status).toBe('pending');
    expect(findByUserCode(ds.userCode)?.approvedUserId).toBeNull();
  });

  it('8. valid session + csrf, fresh pending → 200 + Approved page + session approved', async () => {
    const cookie = await signIn(harness.app, harness.legacyUserId);
    const { csrf, cookie: c2 } = await fetchCsrf(harness.app, cookie);
    const ds = createDeviceSession({
      clientId: 'verify-test-key',
      hostname: 'laptop',
    });
    const r = await postVerify(
      harness.app,
      { _csrf: csrf, user_code: ds.userCode },
      { cookie: c2 },
    );
    expect(r.statusCode).toBe(200);
    expect(String(r.headers['content-type'])).toMatch(/text\/html/);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body.toLowerCase()).toContain('approved');
    expect(r.body.toLowerCase()).toContain('close this window');

    const after = findByUserCode(ds.userCode);
    expect(after?.status).toBe('approved');
    expect(after?.approvedUserId).toBe(harness.legacyUserId);
  });

  it('9. second verify on already-approved session (same user) → 200 idempotent', async () => {
    const cookie = await signIn(harness.app, harness.legacyUserId);
    const { csrf, cookie: c2 } = await fetchCsrf(harness.app, cookie);
    const ds = createDeviceSession({
      clientId: 'verify-test-key',
      hostname: null,
    });
    // First approve.
    const r1 = await postVerify(
      harness.app,
      { _csrf: csrf, user_code: ds.userCode },
      { cookie: c2 },
    );
    expect(r1.statusCode).toBe(200);
    // Second submission with the same code by the same user — idempotent.
    const r2 = await postVerify(
      harness.app,
      { _csrf: csrf, user_code: ds.userCode },
      { cookie: c2 },
    );
    expect(r2.statusCode).toBe(200);
    expect(r2.body.toLowerCase()).toContain('approved');
  });

  it('10. log payload contains event=device_flow_approved + userId; user_code NEVER appears', async () => {
    const cookie = await signIn(harness.app, harness.legacyUserId);
    const { csrf, cookie: c2 } = await fetchCsrf(harness.app, cookie);
    const ds = createDeviceSession({
      clientId: 'verify-test-key',
      hostname: null,
    });
    harness.drainLogs();
    const r = await postVerify(
      harness.app,
      { _csrf: csrf, user_code: ds.userCode },
      { cookie: c2 },
    );
    expect(r.statusCode).toBe(200);

    const allLogText = harness.capturedLogs.join('');
    expect(allLogText).toMatch(/"event":"device_flow_approved"/);
    expect(allLogText).toContain(`"userId":${harness.legacyUserId}`);
    // CRITICAL: user_code MUST NEVER appear in any log line (T-30-02-06).
    expect(allLogText).not.toContain(ds.userCode);
  });
});
