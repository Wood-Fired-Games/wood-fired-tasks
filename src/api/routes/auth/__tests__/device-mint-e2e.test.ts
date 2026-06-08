/**
 * Phase 30 Plan 04 Task 3 — end-to-end server-side device-flow test.
 *
 * Drives the full RFC 8628 server pipeline with `fastify.inject`:
 *
 *   1. POST /auth/device/code   → 200 with device_code + user_code envelope
 *   2. POST /auth/device/token  → 400 authorization_pending (no approval yet)
 *   3. GET  /auth/device         → 200 HTML with CSRF token in form
 *   4. POST /auth/device/verify  → 200 Approved page + api_tokens row inserted
 *   5. POST /auth/device/token   → 200 success envelope with the minted PAT
 *   6. POST /auth/device/token   → 400 expired_token (replay rejected)
 *   7. The PAT hashes to the row we just inserted (usability seam)
 *
 * Also covers hostname-sanitization end-to-end: the CLI sends a raw human
 * hostname, the device-flow store sanitizes at create time, and the verify
 * handler reads the sanitized form when composing the auto-PAT name.
 *
 * The cleanup interval is INTENTIONALLY not started — the store's setInterval
 * is opt-in (production wires it via Plan 30-08; isolated tests never start
 * it, so vitest stays timer-clean).
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
import { hashToken } from '../../../../services/pat-hash.js';

const ORIGIN = 'http://localhost:3000';
// #834: verification_uri is now derived from the request Host; inject this host
// so the http-scheme + host reconstruct exactly ORIGIN.
const ORIGIN_HOST = 'localhost:3000';
const CLIENT_ID = 'cli-e2e-client.example.com';
const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

interface Harness {
  app: FastifyInstance;
  db: Database.Database;
  apiTokenRepo: ApiTokenRepository;
  legacyUserId: number;
}

async function buildHarness(): Promise<Harness> {
  const db = initDatabase(':memory:');
  await runMigrations(db);
  // v2.0: #801 removed legacy is_legacy seeding from API_KEYS, so seed a plain
  // user directly to act as the device-flow approver. The device-flow logic is
  // independent of the auth strategy — it only needs a valid users.id.
  seedIdentities(db, [], { info: () => {}, warn: () => {} });
  const userRepo = new UserRepository(db);
  const apiTokenRepo = new ApiTokenRepository(db);
  const approver = db
    .prepare(`INSERT INTO users (display_name) VALUES (?) RETURNING id`)
    .get('e2e-user') as { id: number };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const app: any = Fastify({ logger: false });
  app.decorate('userRepository', userRepo);
  app.decorate('apiTokenRepository', apiTokenRepo);

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

  // Probe — seeds session.user the way the OIDC callback does.
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

  await app.register(deviceCodeRoute, {
    origin: ORIGIN,
    expectedClientId: CLIENT_ID,
  });
  await app.register(deviceTokenRoute, { expectedClientId: CLIENT_ID });
  await app.register(deviceHtmlRoute, { origin: ORIGIN });
  await app.ready();

  return { app, db, apiTokenRepo, legacyUserId: approver.id };
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

async function fetchCsrf(
  app: FastifyInstance,
  cookie: string,
  userCode: string,
): Promise<{ csrf: string; cookie: string }> {
  const r = await app.inject({
    method: 'GET',
    url: `/auth/device?user_code=${userCode}`,
    headers: { cookie },
  });
  expect(r.statusCode).toBe(200);
  const $ = cheerio.load(r.body);
  const csrf = $('input[name="_csrf"]').attr('value') ?? '';
  expect(csrf).toMatch(/^[0-9a-f]{64}$/);
  const rotated = extractSessionCookie(r);
  return { csrf, cookie: rotated ?? cookie };
}

function todayUtc(): string {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

describe('device-flow end-to-end (server side)', () => {
  let h: Harness;

  beforeEach(async () => {
    resetDeviceFlowStore();
    h = await buildHarness();
  });
  afterEach(async () => {
    await h.app.close();
    h.db.close();
  });

  it('full pipeline: code → poll → verify → poll → bearer-use → replay-rejection', async () => {
    // 1. POST /auth/device/code
    const codeRes = await h.app.inject({
      method: 'POST',
      url: '/auth/device/code',
      // #834: verification_uri is derived from the request Host — pin it.
      headers: { 'content-type': 'application/json', host: ORIGIN_HOST },
      payload: { client_id: CLIENT_ID, hostname: 'ci-runner' },
    });
    expect(codeRes.statusCode).toBe(200);
    const codeBody = codeRes.json() as {
      device_code: string;
      user_code: string;
      verification_uri: string;
      verification_uri_complete: string;
      expires_in: number;
      interval: number;
    };
    expect(codeBody.device_code).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    expect(codeBody.user_code).toMatch(/^[A-HJ-KM-NP-Z2-9]{8}$/);
    expect(codeBody.verification_uri).toBe(`${ORIGIN}/auth/device`);
    expect(codeBody.verification_uri_complete).toBe(
      `${ORIGIN}/auth/device?user_code=${codeBody.user_code}`,
    );
    expect(codeBody.expires_in).toBe(600);
    expect(codeBody.interval).toBe(5);

    // 2. POST /auth/device/token (no approval yet)
    const pollPending = await h.app.inject({
      method: 'POST',
      url: '/auth/device/token',
      headers: { 'content-type': 'application/json' },
      payload: {
        grant_type: GRANT_TYPE,
        device_code: codeBody.device_code,
        client_id: CLIENT_ID,
      },
    });
    expect(pollPending.statusCode).toBe(400);
    expect(pollPending.json()).toMatchObject({ error: 'authorization_pending' });

    // 3. Sign in + GET /auth/device → extract CSRF
    const sessionCookie = await signIn(h.app, h.legacyUserId);
    const { csrf, cookie: c2 } = await fetchCsrf(h.app, sessionCookie, codeBody.user_code);

    // 4. POST /auth/device/verify
    const verifyParams = new URLSearchParams({
      _csrf: csrf,
      user_code: codeBody.user_code,
    }).toString();
    const verifyRes = await h.app.inject({
      method: 'POST',
      url: '/auth/device/verify',
      payload: verifyParams,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: c2,
      },
    });
    expect(verifyRes.statusCode).toBe(200);
    expect(verifyRes.body.toLowerCase()).toContain('approved');

    // DB has the row — find it via the most recent insert for this user.
    const dbRow = h.db
      .prepare(
        'SELECT id, name, hash, user_id FROM api_tokens WHERE user_id = ? ORDER BY id DESC LIMIT 1',
      )
      .get(h.legacyUserId) as
      | { id: number; name: string; hash: string; user_id: number }
      | undefined;
    expect(dbRow).toBeDefined();
    expect(dbRow?.name).toBe(`cli-ci-runner-${todayUtc()}`);

    // Pull lastPollAt back so the next poll lands outside the (interval-1)s
    // rate-gate cooldown. The CLI's real poll loop sleeps for `interval`
    // seconds between polls; mirroring that with timer-mutation keeps the
    // test deterministic without sleeping for 5+ real seconds.
    const refForPoll = findByDeviceCode(codeBody.device_code);
    if (refForPoll) refForPoll.lastPollAt = Date.now() - 10_000;

    // 5. POST /auth/device/token — should now return the PAT.
    const pollSuccess = await h.app.inject({
      method: 'POST',
      url: '/auth/device/token',
      headers: { 'content-type': 'application/json' },
      payload: {
        grant_type: GRANT_TYPE,
        device_code: codeBody.device_code,
        client_id: CLIENT_ID,
      },
    });
    expect(pollSuccess.statusCode).toBe(200);
    const successBody = pollSuccess.json() as {
      token: string;
      token_type: string;
      token_id: number;
      user: {
        id: number;
        displayName: string;
        email: string | null;
        isLegacy: boolean;
        isServiceAccount: boolean;
      };
    };
    expect(successBody.token).toMatch(/^wft_pat_[A-Z2-7]{32}$/);
    expect(successBody.token_type).toBe('PAT');
    expect(successBody.token_id).toBe(dbRow?.id);
    expect(successBody.user.id).toBe(h.legacyUserId);
    expect(successBody.user.displayName).toBe('e2e-user');
    // v2.0 (#801): the approver is a plain seeded user, no longer is_legacy.
    expect(successBody.user.isLegacy).toBe(false);

    // Token's hash matches the row's stored hash → DB lookup would succeed.
    expect(hashToken(successBody.token)).toBe(dbRow?.hash);

    // 6. Replay → expired_token (session was removed after the 200).
    const pollReplay = await h.app.inject({
      method: 'POST',
      url: '/auth/device/token',
      headers: { 'content-type': 'application/json' },
      payload: {
        grant_type: GRANT_TYPE,
        device_code: codeBody.device_code,
        client_id: CLIENT_ID,
      },
    });
    expect(pollReplay.statusCode).toBe(400);
    expect(pollReplay.json()).toMatchObject({ error: 'expired_token' });

    // 7. The minted PAT is usable: its hash resolves to the inserted row
    //    via the api_tokens hash index. (Full Bearer auth-chain coverage
    //    lives in pat.test.ts / auth-chain.test.ts; this seam is the
    //    contract Plan 06's CLI poll loop relies on.)
    const lookup = h.apiTokenRepo.findByHash(hashToken(successBody.token));
    expect(lookup).not.toBeNull();
    expect(lookup?.id).toBe(dbRow?.id);
    expect(lookup?.user_id).toBe(h.legacyUserId);
    expect(lookup?.revoked_at).toBeNull();
  });

  it("hostname sanitization end-to-end: Stuart's Laptop → cli-stuart-s-laptop-<today>", async () => {
    // 1. CLI sends raw hostname with punctuation + caps + spaces.
    const codeRes = await h.app.inject({
      method: 'POST',
      url: '/auth/device/code',
      headers: { 'content-type': 'application/json' },
      payload: { client_id: CLIENT_ID, hostname: "Stuart's Laptop" },
    });
    expect(codeRes.statusCode).toBe(200);
    const { user_code } = codeRes.json() as {
      device_code: string;
      user_code: string;
    };

    // 2. Approve via browser leg.
    const sessionCookie = await signIn(h.app, h.legacyUserId);
    const { csrf, cookie: c2 } = await fetchCsrf(h.app, sessionCookie, user_code);
    const verifyRes = await h.app.inject({
      method: 'POST',
      url: '/auth/device/verify',
      payload: new URLSearchParams({ _csrf: csrf, user_code }).toString(),
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: c2,
      },
    });
    expect(verifyRes.statusCode).toBe(200);

    // 3. The minted row's name reflects the sanitization rule.
    const row = h.db
      .prepare('SELECT name FROM api_tokens WHERE user_id = ? ORDER BY id DESC LIMIT 1')
      .get(h.legacyUserId) as { name: string } | undefined;
    expect(row?.name).toBe(`cli-stuart-s-laptop-${todayUtc()}`);
  });
});
