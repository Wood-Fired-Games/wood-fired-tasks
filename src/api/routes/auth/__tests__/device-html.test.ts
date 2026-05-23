/**
 * Phase 30 Plan 02 Task 2 — GET /auth/device integration tests.
 *
 * Coverage (mirrors plan §Task 2 done-criteria):
 *   1. Unauthenticated, no ?user_code → 302 to /auth/login?next=%2Fauth%2Fdevice.
 *   2. Authenticated, no ?user_code → 200, form rendered, csrf hidden input
 *      present, no prefilled-code paragraph.
 *   3. Authenticated, valid ?user_code=ABCDEFGH → 200, value="ABCDEFGH",
 *      prefilled-code paragraph rendered.
 *   4. Authenticated, malformed ?user_code=<script>... → 200, no literal
 *      <script> in output, no prefilled-code paragraph.
 *   5. Authenticated, lowercase ?user_code=abcdefgh → 200, NOT prefilled.
 *   6. Response headers include Cache-Control: no-store + text/html.
 *   7. Unauthenticated + valid ?user_code → redirect's next preserves it.
 *   8. Unauthenticated + malformed ?user_code → redirect's next is bare /auth/device.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifySecureSession from '@fastify/secure-session';
import fastifyFormbody from '@fastify/formbody';
import { randomBytes } from 'node:crypto';
import * as cheerio from 'cheerio';
import deviceHtmlRoute from '../device-html.js';
import { extractSessionCookie } from '../../../../../tests/helpers/session-cookie.js';
import { SESSION_LIFETIME_SECONDS } from '../../../../web/session-constants.js';

const ORIGIN = 'http://localhost:3000';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
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

  // Probe route — seeds session.user the way the OIDC callback would.
  app.post(
    '/__test/sign-in',
    { config: { skipAuth: true } },
    async (request, reply) => {
      const { userId } = request.body as { userId: number };
      request.session.set('user', { id: userId });
      request.session.set('authenticatedAt', Date.now());
      return reply.code(204).send();
    },
  );

  await app.register(deviceHtmlRoute, { origin: ORIGIN });
  await app.ready();
  return app;
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

describe('GET /auth/device', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp();
  });
  afterEach(async () => {
    await app.close();
  });

  it('1. unauthenticated, no ?user_code → 302 /auth/login?next=%2Fauth%2Fdevice', async () => {
    const r = await app.inject({ method: 'GET', url: '/auth/device' });
    expect(r.statusCode).toBe(302);
    const loc = r.headers.location as string;
    expect(loc).toBe(`${ORIGIN}/auth/login?next=%2Fauth%2Fdevice`);
  });

  it('2. authenticated, no ?user_code → 200, form rendered, csrf hidden input present', async () => {
    const cookie = await signIn(app, 1);
    const r = await app.inject({
      method: 'GET',
      url: '/auth/device',
      headers: { cookie },
    });
    expect(r.statusCode).toBe(200);
    const $ = cheerio.load(r.body);
    expect($('form').attr('action')).toBe('/auth/device/verify');
    const csrf = $('input[name="_csrf"]').attr('value');
    expect(csrf).toMatch(/^[0-9a-f]{64}$/);
    expect($('input[name="user_code"]').attr('value')).toBe('');
    expect($('p.prefilled-code').length).toBe(0);
  });

  it('3. authenticated, valid ?user_code=ABCDEFGH → 200, value="ABCDEFGH", prefilled-code paragraph', async () => {
    const cookie = await signIn(app, 1);
    const r = await app.inject({
      method: 'GET',
      url: '/auth/device?user_code=ABCDEFGH',
      headers: { cookie },
    });
    expect(r.statusCode).toBe(200);
    const $ = cheerio.load(r.body);
    expect($('input[name="user_code"]').attr('value')).toBe('ABCDEFGH');
    const pCode = $('p.prefilled-code');
    expect(pCode.length).toBe(1);
    expect(pCode.text()).toBe('ABCDEFGH');
  });

  it('4. authenticated, malformed ?user_code=<script> → 200, no <script> literal, no prefilled-code paragraph', async () => {
    const cookie = await signIn(app, 1);
    const r = await app.inject({
      method: 'GET',
      url: `/auth/device?user_code=${encodeURIComponent('<script>alert(1)</script>')}`,
      headers: { cookie },
    });
    expect(r.statusCode).toBe(200);
    // No literal <script> tag should appear (alphabet pre-validation drops it).
    expect(r.body).not.toContain('<script>alert(1)</script>');
    const $ = cheerio.load(r.body);
    expect($('p.prefilled-code').length).toBe(0);
    expect($('input[name="user_code"]').attr('value')).toBe('');
  });

  it('5. authenticated, lowercase ?user_code=abcdefgh → 200, NOT prefilled (alphabet is uppercase only)', async () => {
    const cookie = await signIn(app, 1);
    const r = await app.inject({
      method: 'GET',
      url: '/auth/device?user_code=abcdefgh',
      headers: { cookie },
    });
    expect(r.statusCode).toBe(200);
    const $ = cheerio.load(r.body);
    expect($('p.prefilled-code').length).toBe(0);
    expect($('input[name="user_code"]').attr('value')).toBe('');
  });

  it('6. response headers include Cache-Control: no-store + text/html', async () => {
    const cookie = await signIn(app, 1);
    const r = await app.inject({
      method: 'GET',
      url: '/auth/device',
      headers: { cookie },
    });
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(String(r.headers['content-type'])).toMatch(/text\/html/);
  });

  it('7. unauthenticated + valid ?user_code=ABCDEFGH → next preserves encoded user_code', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/auth/device?user_code=ABCDEFGH',
    });
    expect(r.statusCode).toBe(302);
    const loc = r.headers.location as string;
    // next= is the URL-encoded form of /auth/device?user_code=ABCDEFGH
    expect(loc).toBe(
      `${ORIGIN}/auth/login?next=${encodeURIComponent('/auth/device?user_code=ABCDEFGH')}`,
    );
  });

  it('8. unauthenticated + malformed ?user_code=BAD → next is bare /auth/device', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/auth/device?user_code=BAD',
    });
    expect(r.statusCode).toBe(302);
    const loc = r.headers.location as string;
    expect(loc).toBe(`${ORIGIN}/auth/login?next=%2Fauth%2Fdevice`);
    // Must NOT contain the malformed code reflected anywhere.
    expect(loc).not.toContain('BAD');
  });
});
