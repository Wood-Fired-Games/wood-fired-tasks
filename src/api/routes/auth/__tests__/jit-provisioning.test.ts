/**
 * Phase 29 Plan 06 — JIT provisioning (AUTH-02) tests.
 *
 * Exercises the lifecycle the /auth/callback handler drives through
 * upsertFromOidc:
 *   1. First-time Google login with sub X INSERTs a row.
 *   2. Second login with the same sub returns the same row (idempotent).
 *   3. email_verified=false does NOT create a row.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { extractSessionCookie } from '../../../../../tests/helpers/session-cookie.js';
import {
  mountAuthRoutes,
  setupOidcHappyPath,
  type AuthTestHarness,
} from './oidc-test-setup.js';

async function loginAndCallback(
  harness: AuthTestHarness,
  sub: string,
  overrides: { email?: string; name?: string; email_verified?: boolean } = {},
): Promise<{ statusCode: number; cookie: string | null }> {
  const loginResp = await harness.server.inject({
    method: 'GET',
    url: '/auth/login',
  });
  expect(loginResp.statusCode).toBe(302);
  const cookie = extractSessionCookie(loginResp);
  expect(cookie).not.toBeNull();

  const authorize = new URL(loginResp.headers.location as string);
  const state = authorize.searchParams.get('state') ?? '';
  const nonce = authorize.searchParams.get('nonce') ?? '';

  await setupOidcHappyPath({ sub, state, nonce, ...overrides });

  const cbResp = await harness.server.inject({
    method: 'GET',
    url: `/auth/callback?code=ac-${sub}&state=${state}`,
    headers: { cookie: cookie as string },
  });
  return {
    statusCode: cbResp.statusCode,
    cookie: extractSessionCookie(cbResp) ?? null,
  };
}

describe('JIT provisioning (AUTH-02)', () => {
  let harness: AuthTestHarness;

  beforeEach(async () => {
    harness = await mountAuthRoutes();
  });
  afterEach(async () => {
    await harness.close();
  });

  it('first-time login with sub X INSERTs a users row', async () => {
    const before = harness.userRepository.findByOidcSub('google', 'jit-001');
    expect(before).toBeNull();

    const r = await loginAndCallback(harness, 'jit-001', {
      email: 'jit-001@example.com',
      name: 'JIT One',
    });
    expect(r.statusCode).toBe(302);

    const row = harness.userRepository.findByOidcSub('google', 'jit-001');
    expect(row).not.toBeNull();
    expect(row?.email).toBe('jit-001@example.com');
    expect(row?.display_name).toBe('JIT One');
    expect(row?.oidc_provider).toBe('google');
    expect(row?.oidc_sub).toBe('jit-001');
  });

  it('second login with same sub returns the same row (idempotent)', async () => {
    await loginAndCallback(harness, 'jit-002', {
      email: 'jit-002@example.com',
      name: 'JIT Two',
    });
    const first = harness.userRepository.findByOidcSub('google', 'jit-002');
    expect(first).not.toBeNull();
    const firstId = first?.id;

    // Second roundtrip — same sub.
    await loginAndCallback(harness, 'jit-002', {
      email: 'jit-002@example.com',
      name: 'JIT Two',
    });
    const second = harness.userRepository.findByOidcSub('google', 'jit-002');
    expect(second).not.toBeNull();
    expect(second?.id).toBe(firstId);
  });

  it('callback with email_verified=false does NOT create a row', async () => {
    const r = await loginAndCallback(harness, 'jit-unverified', {
      email: 'unverified@example.com',
      email_verified: false,
    });
    expect(r.statusCode).toBe(302);

    const row = harness.userRepository.findByOidcSub('google', 'jit-unverified');
    expect(row).toBeNull();
  });

  it('WR-05: upsertFromOidc throw clears handshake AND redirects to /auth/error?reason=provisioning_failed', async () => {
    // Drive the login leg first so handshake state is in the session
    // cookie, then patch the repository so the upsert throws on this
    // request. The handler must catch, clear handshake, and bounce to
    // /auth/error?reason=provisioning_failed (NOT Fastify's default 500
    // with stale handshake still in the cookie).
    const loginResp = await harness.server.inject({
      method: 'GET',
      url: '/auth/login',
    });
    expect(loginResp.statusCode).toBe(302);
    const cookie = extractSessionCookie(loginResp);
    expect(cookie).not.toBeNull();

    const authorize = new URL(loginResp.headers.location as string);
    const state = authorize.searchParams.get('state') ?? '';
    const nonce = authorize.searchParams.get('nonce') ?? '';
    await setupOidcHappyPath({ sub: 'jit-throw', state, nonce });

    // Force upsertFromOidc -> userRepository.findByOidcSub to throw on
    // this single request. Restored in the finally so subsequent tests
    // see a clean repository.
    const orig = harness.userRepository.findByOidcSub.bind(
      harness.userRepository,
    );
    harness.userRepository.findByOidcSub = () => {
      throw new Error('simulated DB outage');
    };

    try {
      const cbResp = await harness.server.inject({
        method: 'GET',
        url: `/auth/callback?code=ac-jit-throw&state=${state}`,
        headers: { cookie: cookie as string },
      });
      expect(cbResp.statusCode).toBe(302);
      expect(cbResp.headers.location).toBe(
        '/auth/error?reason=provisioning_failed',
      );

      // Handshake state must be cleared so a retry from /auth/login
      // starts from a clean slate.
      const post = extractSessionCookie(cbResp) ?? cookie;
      const probe = await harness.server.inject({
        method: 'GET',
        url: '/_test/handshake',
        headers: { cookie: post as string },
      });
      expect(probe.statusCode).toBe(200);
      expect(JSON.parse(probe.body)).toEqual({ handshake: null });
    } finally {
      harness.userRepository.findByOidcSub = orig;
    }
  });
});
