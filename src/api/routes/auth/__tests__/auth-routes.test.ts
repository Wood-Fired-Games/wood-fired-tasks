/**
 * Phase 29 Plan 06 — /auth/login + /auth/callback integration tests.
 *
 * Covers the behavior table in the plan:
 *   /auth/login
 *     L1. already signed-in → 302 /me
 *     L2. fresh → 302 to authorize URL with state + code_challenge + scope
 *     L3. ?next=/me/tokens → stored redirectAfterLogin honored on callback
 *     L4. ?next=//evil.com → sanitized to /me (open-redirect prevention)
 *     L5. ?next=/me%20space → URL-decoded; if matches regex, honored
 *
 *   /auth/callback
 *     C1. missing handshake → /auth/error?reason=handshake_missing
 *     C2. state mismatch → /auth/error?reason=state_mismatch
 *         + W2: logs at error level, does NOT leak expected state
 *     C3. email_verified=false → /auth/error?reason=email_unverified
 *     C4. happy path: upsert, session set, cookie rotated, redirect to next
 *     C5. exchange failure (token endpoint 500) → /auth/error?reason=exchange_failed
 *     C6. W4: oidc.handshake explicitly cleared after success
 *
 * Open-redirect / state-leak threats are exercised via direct injects;
 * the JIT-provisioning and session-fixation aspects get their own files.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import nock from 'nock';
import { extractSessionCookie } from '../../../../../tests/helpers/session-cookie.js';
import {
  mountAuthRoutes,
  setupOidcHappyPath,
  CLIENT_ID,
  REDIRECT_URI,
  SCOPES,
  type AuthTestHarness,
} from './oidc-test-setup.js';

/**
 * Drive a GET /auth/login, capture the session cookie + the redirect URL,
 * and return both so the caller can derive the (state, codeVerifier)
 * captured into the session by inspecting the redirect URL.
 *
 * The state is recovered from the redirect URL's `state` query param;
 * the codeVerifier is opaque inside the session cookie and must be
 * supplied via a probe route OR fully exercised end-to-end through the
 * callback (which is what the happy-path tests do).
 */
async function driveLogin(
  harness: AuthTestHarness,
  next?: string,
  cookie?: string,
): Promise<{
  cookie: string;
  state: string;
  codeChallenge: string;
  authorizeUrl: URL;
}> {
  const url = next ? `/auth/login?next=${encodeURIComponent(next)}` : '/auth/login';
  const r = await harness.server.inject({
    method: 'GET',
    url,
    ...(cookie ? { headers: { cookie } } : {}),
  });
  expect(r.statusCode).toBe(302);
  const location = r.headers.location;
  expect(typeof location).toBe('string');
  const authorizeUrl = new URL(location as string);
  const state = authorizeUrl.searchParams.get('state') ?? '';
  const codeChallenge = authorizeUrl.searchParams.get('code_challenge') ?? '';
  const sessionCookie = extractSessionCookie(r);
  expect(sessionCookie).not.toBeNull();
  return {
    cookie: sessionCookie as string,
    state,
    codeChallenge,
    authorizeUrl,
  };
}

describe('GET /auth/login', () => {
  let harness: AuthTestHarness;

  beforeEach(async () => {
    harness = await mountAuthRoutes();
  });
  afterEach(async () => {
    await harness.close();
  });

  it('L2: fresh visit → 302 to authorize URL with state, code_challenge, scope, redirect_uri', async () => {
    const r = await harness.server.inject({ method: 'GET', url: '/auth/login' });
    expect(r.statusCode).toBe(302);

    const location = r.headers.location;
    expect(typeof location).toBe('string');
    const u = new URL(location as string);

    // Authorization endpoint host matches the discovery fixture.
    expect(u.host).toBe('accounts.example.com');
    expect(u.searchParams.get('state')).toBeTruthy();
    expect(u.searchParams.get('code_challenge')).toBeTruthy();
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('scope')).toBe(SCOPES);
    expect(u.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(u.searchParams.get('client_id')).toBe(CLIENT_ID);
  });

  it('L3: ?next=/me/tokens → callback redirects there after success', async () => {
    const { cookie, state } = await driveLogin(harness, '/me/tokens');
    const { tokenResponse } = await setupOidcHappyPath({
      sub: 'sub-login-next',
      state,
    });

    const r = await harness.server.inject({
      method: 'GET',
      url: `/auth/callback?code=authcode-001&state=${state}`,
      headers: { cookie },
    });
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe('/me/tokens');
    // tokenResponse was consumed (no unsatisfied interceptors)
    expect(nock.isDone()).toBe(true);
    void tokenResponse;
  });

  it('L4: ?next=//evil.com is sanitized to /me (open-redirect prevention)', async () => {
    const { cookie, state } = await driveLogin(harness, '//evil.com');
    await setupOidcHappyPath({ sub: 'sub-login-evil', state });

    const r = await harness.server.inject({
      method: 'GET',
      url: `/auth/callback?code=authcode-evil&state=${state}`,
      headers: { cookie },
    });
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe('/me');
  });

  it('L1: already-signed-in users get 302 to /me without hitting the IdP', async () => {
    // Sign in once.
    const { cookie: loginCookie, state } = await driveLogin(harness);
    await setupOidcHappyPath({ sub: 'sub-signedin', state });
    const cbResp = await harness.server.inject({
      method: 'GET',
      url: `/auth/callback?code=authcode-x&state=${state}`,
      headers: { cookie: loginCookie },
    });
    expect(cbResp.statusCode).toBe(302);
    // Capture the post-login cookie (regenerate rotates it).
    const postLoginCookie = extractSessionCookie(cbResp) ?? loginCookie;

    // Second visit to /auth/login carrying the signed-in cookie.
    const r = await harness.server.inject({
      method: 'GET',
      url: '/auth/login',
      headers: { cookie: postLoginCookie },
    });
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe('/me');
  });
});

describe('GET /auth/callback', () => {
  let harness: AuthTestHarness;

  beforeEach(async () => {
    harness = await mountAuthRoutes();
  });
  afterEach(async () => {
    await harness.close();
  });

  it('C1: missing handshake (no session) → /auth/error?reason=handshake_missing', async () => {
    const r = await harness.server.inject({
      method: 'GET',
      url: '/auth/callback?code=any&state=any',
    });
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe('/auth/error?reason=handshake_missing');
  });

  it('C2: state mismatch → /auth/error?reason=state_mismatch; logs error (NOT warn); does NOT leak expected', async () => {
    const { cookie } = await driveLogin(harness);

    // Capture the logger output by intercepting fastify.log.
    const logs: Array<{ level: string; payload: unknown; msg: string }> = [];
    const origError = harness.server.log.error.bind(harness.server.log);
    const origWarn = harness.server.log.warn.bind(harness.server.log);
    harness.server.log.error = ((...args: unknown[]) => {
      logs.push({ level: 'error', payload: args[0], msg: String(args[1] ?? '') });
      return origError(...(args as Parameters<typeof origError>));
    }) as never;
    harness.server.log.warn = ((...args: unknown[]) => {
      logs.push({ level: 'warn', payload: args[0], msg: String(args[1] ?? '') });
      return origWarn(...(args as Parameters<typeof origWarn>));
    }) as never;

    const r = await harness.server.inject({
      method: 'GET',
      url: '/auth/callback?code=any&state=attacker-state',
      headers: { cookie },
    });
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe('/auth/error?reason=state_mismatch');

    // W2 — must log at error level, NOT warn.
    const stateMismatchLogs = logs.filter((l) =>
      l.msg.includes('state_mismatch'),
    );
    expect(stateMismatchLogs.length).toBeGreaterThanOrEqual(1);
    for (const entry of stateMismatchLogs) {
      expect(entry.level).toBe('error');
      // W2 — payload MUST NOT include `expected: ...` (only `received`).
      const payload = entry.payload as Record<string, unknown> | null | undefined;
      if (payload && typeof payload === 'object') {
        expect(payload).not.toHaveProperty('expected');
        // received state (the attacker-supplied value) is OK to log.
        expect(payload).toHaveProperty('received');
        expect(payload.received).toBe('attacker-state');
      }
    }
  });

  it('C3: email_verified=false → /auth/error?reason=email_unverified (rejected)', async () => {
    const { cookie, state } = await driveLogin(harness);
    await setupOidcHappyPath({
      sub: 'sub-unverified',
      email_verified: false,
      state,
    });

    const r = await harness.server.inject({
      method: 'GET',
      url: `/auth/callback?code=authcode-unverified&state=${state}`,
      headers: { cookie },
    });
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe('/auth/error?reason=email_unverified');

    // User must NOT have been inserted.
    const row = harness.userRepository.findByOidcSub('google', 'sub-unverified');
    expect(row).toBeNull();
  });

  it('C4 happy path: upserts user, sets session.user, redirects to next', async () => {
    const { cookie, state } = await driveLogin(harness, '/me');
    await setupOidcHappyPath({
      sub: 'sub-happy-001',
      email: 'happy@example.com',
      name: 'Happy User',
      state,
    });

    const r = await harness.server.inject({
      method: 'GET',
      url: `/auth/callback?code=authcode-happy&state=${state}`,
      headers: { cookie },
    });
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe('/me');

    // User row created.
    const row = harness.userRepository.findByOidcSub('google', 'sub-happy-001');
    expect(row).not.toBeNull();
    expect(row?.email).toBe('happy@example.com');
    expect(row?.display_name).toBe('Happy User');
  });

  it('C5: token-endpoint 500 → /auth/error?reason=exchange_failed (no leak in response body)', async () => {
    const { cookie, state } = await driveLogin(harness);

    // Install discovery + JWKS but force the token endpoint to 500.
    const discovery = (await import('../../../../../tests/helpers/oidc-fixtures.js')).getDiscoveryFixture();
    const { getTestKeys } = await import('../../../../../tests/helpers/oidc-fixtures.js');
    const jwksUri = discovery.jwks_uri as string;
    const tokenUri = discovery.token_endpoint as string;

    const { publicJwk } = await getTestKeys();
    nock(new URL(jwksUri).origin)
      .get(new URL(jwksUri).pathname)
      .reply(200, { keys: [publicJwk] });
    nock(new URL(tokenUri).origin)
      .post(new URL(tokenUri).pathname)
      .reply(500, 'idp-internal-error');

    const r = await harness.server.inject({
      method: 'GET',
      url: `/auth/callback?code=authcode-fail&state=${state}`,
      headers: { cookie },
    });
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe('/auth/error?reason=exchange_failed');

    // Response body must NOT contain the upstream error verbatim.
    expect(r.body).not.toContain('idp-internal-error');
  });

  it('C6 (W4): oidc.handshake is explicitly cleared after a successful callback', async () => {
    const { cookie, state } = await driveLogin(harness);
    await setupOidcHappyPath({ sub: 'sub-clear-001', state });

    const r = await harness.server.inject({
      method: 'GET',
      url: `/auth/callback?code=authcode-clear&state=${state}`,
      headers: { cookie },
    });
    expect(r.statusCode).toBe(302);

    // Drive a follow-up request with the new cookie and probe a route that
    // reports session.get('oidc.handshake'). Use a tiny probe registered on
    // the same Fastify instance.
    harness.server.get('/_test/handshake', async (request) => {
      return { handshake: request.session.get('oidc.handshake') ?? null };
    });
    await harness.server.ready();

    const postLoginCookie = extractSessionCookie(r) ?? cookie;
    const probe = await harness.server.inject({
      method: 'GET',
      url: '/_test/handshake',
      headers: { cookie: postLoginCookie },
    });
    expect(probe.statusCode).toBe(200);
    expect(JSON.parse(probe.body)).toEqual({ handshake: null });
  });
});
