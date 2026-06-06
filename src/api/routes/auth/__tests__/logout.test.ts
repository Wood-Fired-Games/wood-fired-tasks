/**
 * Phase 29 Plan 06 — POST /auth/logout tests.
 *
 * Behavior (PLAN.md Task 3):
 *   1. No CSRF token in body → 403
 *   2. Bad CSRF token         → 403
 *   3. Valid CSRF + idToken + end_session_endpoint
 *        → 302 to IdP RP-initiated logout URL with id_token_hint +
 *          post_logout_redirect_uri; session cleared BEFORE redirect
 *   4. Valid CSRF + no idToken (PAT user) → 302 /auth/login
 *   5. Valid CSRF + discovery omits end_session_endpoint → 302 /auth/login
 *
 * The session-fixture pattern: drive an /auth/login + /auth/callback
 * roundtrip to populate a real session (user + idToken + csrf via the
 * pre-mounted /_test/seed-csrf probe), then POST /auth/logout.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { extractSessionCookie } from '../../../../../tests/helpers/session-cookie.js';
import { mountAuthRoutes, setupOidcHappyPath, type AuthTestHarness } from './oidc-test-setup.js';

interface SignedInState {
  cookie: string;
  csrf: string;
}

/**
 * Drive a full login → callback roundtrip and return the post-callback
 * cookie. Also seeds a CSRF token into the session via the
 * /_test/seed-csrf probe and returns the cookie that carries it.
 */
async function signInAndSeedCsrf(harness: AuthTestHarness, sub: string): Promise<SignedInState> {
  const loginResp = await harness.server.inject({
    method: 'GET',
    url: '/auth/login',
  });
  expect(loginResp.statusCode).toBe(302);
  const loginCookie = extractSessionCookie(loginResp);
  expect(loginCookie).not.toBeNull();

  const authorize = new URL(loginResp.headers.location as string);
  const state = authorize.searchParams.get('state') ?? '';
  const nonce = authorize.searchParams.get('nonce') ?? '';

  await setupOidcHappyPath({ sub, state, nonce });

  const cbResp = await harness.server.inject({
    method: 'GET',
    url: `/auth/callback?code=ac-${sub}&state=${state}`,
    headers: { cookie: loginCookie as string },
  });
  expect(cbResp.statusCode).toBe(302);
  const sessionCookie = extractSessionCookie(cbResp);
  expect(sessionCookie).not.toBeNull();

  // Seed a CSRF token via the probe route.
  const seedResp = await harness.server.inject({
    method: 'GET',
    url: '/_test/seed-csrf',
    headers: { cookie: sessionCookie as string },
  });
  expect(seedResp.statusCode).toBe(200);
  const csrf = JSON.parse(seedResp.body).csrf as string;
  const seededCookie = extractSessionCookie(seedResp) ?? sessionCookie;

  return { cookie: seededCookie as string, csrf };
}

describe('POST /auth/logout', () => {
  let harness: AuthTestHarness;

  beforeEach(async () => {
    harness = await mountAuthRoutes();
  });
  afterEach(async () => {
    await harness.close();
  });

  it('rejects with 403 when the body has no _csrf field', async () => {
    const { cookie } = await signInAndSeedCsrf(harness, 'lo-001');

    const r = await harness.server.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: {
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: '', // no _csrf
    });
    expect(r.statusCode).toBe(403);
  });

  it('rejects with 403 when the supplied _csrf does not match session.csrf', async () => {
    const { cookie } = await signInAndSeedCsrf(harness, 'lo-002');

    const r = await harness.server.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: {
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: '_csrf=' + 'a'.repeat(64),
    });
    expect(r.statusCode).toBe(403);

    // Session must not be cleared on failed logout (probe still shows user).
    const probe = await harness.server.inject({
      method: 'GET',
      url: '/_test/who',
      headers: { cookie },
    });
    expect(probe.statusCode).toBe(200);
    const body = JSON.parse(probe.body) as { user: { id: number } | null };
    expect(body.user).not.toBeNull();
  });

  it('redirects 302 to RP-initiated logout when end_session_endpoint exists + idToken present', async () => {
    const { cookie, csrf } = await signInAndSeedCsrf(harness, 'lo-003');

    const r = await harness.server.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: {
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: '_csrf=' + encodeURIComponent(csrf),
    });
    expect(r.statusCode).toBe(302);

    const location = r.headers.location;
    expect(typeof location).toBe('string');
    const u = new URL(location as string);
    // Discovery fixture has end_session_endpoint at accounts.example.com.
    expect(u.host).toBe('accounts.example.com');
    expect(u.searchParams.get('id_token_hint')).toBeTruthy();
    expect(u.searchParams.get('post_logout_redirect_uri')).toBeTruthy();

    // WR-03 fix: the post_logout_redirect_uri must come from
    // configuration (the harness derives it from REDIRECT_URI's origin),
    // NOT from request.protocol/hostname. The harness's REDIRECT_URI is
    // `https://wft.example.com/auth/callback`, so the post-logout URI
    // is `https://wft.example.com/auth/login` regardless of what Host
    // header the caller smuggled in.
    expect(u.searchParams.get('post_logout_redirect_uri')).toBe(
      'https://wft.example.com/auth/login',
    );
  });

  it('WR-03: post_logout_redirect_uri ignores spoofed Host header', async () => {
    const { cookie, csrf } = await signInAndSeedCsrf(harness, 'lo-host-spoof');

    const r = await harness.server.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: {
        cookie,
        host: 'evil.example.org',
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: '_csrf=' + encodeURIComponent(csrf),
    });
    expect(r.statusCode).toBe(302);

    const location = r.headers.location;
    expect(typeof location).toBe('string');
    const u = new URL(location as string);
    // Even with a spoofed Host header, the post-logout URI MUST come
    // from configuration (wft.example.com), not from request.hostname.
    const postLogout = u.searchParams.get('post_logout_redirect_uri');
    expect(postLogout).toBe('https://wft.example.com/auth/login');
    expect(postLogout).not.toContain('evil.example.org');

    // Session-delete contract: the response must emit a clearing
    // Set-Cookie header so the browser drops the session cookie.
    // Probing with the OLD cookie still decrypts (sealed cookies are
    // stateless) — that's the inherent limitation of stateless sessions
    // and is why the clearing Set-Cookie is the documented mechanism.
    const setCookieRaw = r.headers['set-cookie'];
    expect(setCookieRaw).toBeDefined();
    const setCookieList = Array.isArray(setCookieRaw) ? setCookieRaw : [setCookieRaw as string];
    const clearing = setCookieList.find((c) => c.startsWith('wft_session='));
    expect(clearing).toBeDefined();
    // The clearing Set-Cookie either has an empty value OR an Expires
    // attribute in the past (epoch). Both are valid expiry signals.
    const hasEmptyValue = /^wft_session=;/.test(clearing as string);
    const hasPastExpiry =
      /Expires=Thu, 01 Jan 1970/i.test(clearing as string) || /Max-Age=0/i.test(clearing as string);
    expect(hasEmptyValue || hasPastExpiry).toBe(true);
  });

  it('redirects 302 to /auth/login when discovery has no end_session_endpoint', async () => {
    // Different harness — discovery missing end_session_endpoint.
    await harness.close();
    const { getDiscoveryFixture } = await import('../../../../../tests/helpers/oidc-fixtures.js');
    const trimmed: Record<string, unknown> = { ...getDiscoveryFixture() };
    delete trimmed.end_session_endpoint;

    harness = await mountAuthRoutes({ discoveryOverride: trimmed });
    const { cookie, csrf } = await signInAndSeedCsrf(harness, 'lo-004');

    const r = await harness.server.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: {
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: '_csrf=' + encodeURIComponent(csrf),
    });
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe('/auth/login');
  });

  it('redirects 302 to /auth/login when the session has no idToken (PAT-only user)', async () => {
    // Build a session that has csrf + user but NO idToken. The simplest way
    // is to seed the session through a probe that writes csrf but skips the
    // OIDC roundtrip. Use the harness's /_test/no-id-token-seed probe.
    const seed = await harness.server.inject({
      method: 'GET',
      url: '/_test/no-id-token-seed',
    });
    expect(seed.statusCode).toBe(200);
    const cookie = extractSessionCookie(seed);
    expect(cookie).not.toBeNull();
    const csrf = JSON.parse(seed.body).csrf as string;

    const r = await harness.server.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: {
        cookie: cookie as string,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: '_csrf=' + encodeURIComponent(csrf),
    });
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe('/auth/login');
  });
});
