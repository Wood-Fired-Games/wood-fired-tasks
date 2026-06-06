/**
 * Phase 29 Plan 06 — session fixation prevention (AUTH-05) test.
 *
 * Threat T-29-06-03: a pre-existing session cookie (set by an attacker
 * via cookie injection on a shared network) must NOT survive across the
 * login boundary. After a successful /auth/callback the session cookie
 * value emitted by Set-Cookie MUST differ from the pre-callback cookie
 * value — i.e. session.regenerate() (or equivalent rewrite of the
 * encrypted payload) was called.
 *
 * @fastify/secure-session is stateless sealed-cookie: regenerate()
 * clears the in-memory data and the next Set-Cookie carries a freshly
 * encrypted payload. The encryption nonce is random per request, so
 * even an empty-vs-populated session produces a different ciphertext.
 * We assert the ciphertext changed AND that the post-login session has
 * the user payload (sanity).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { extractSessionCookie } from '../../../../../tests/helpers/session-cookie.js';
import { mountAuthRoutes, setupOidcHappyPath, type AuthTestHarness } from './oidc-test-setup.js';

describe('session fixation prevention (AUTH-05)', () => {
  let harness: AuthTestHarness;

  beforeEach(async () => {
    harness = await mountAuthRoutes();
  });
  afterEach(async () => {
    await harness.close();
  });

  it('post-callback Set-Cookie value differs from pre-callback cookie value', async () => {
    // 1. Drive /auth/login to populate session.oidc.handshake. Capture
    //    the cookie issued by the login response.
    const loginResp = await harness.server.inject({
      method: 'GET',
      url: '/auth/login',
    });
    expect(loginResp.statusCode).toBe(302);
    const preLoginCookie = extractSessionCookie(loginResp);
    expect(preLoginCookie).not.toBeNull();

    const authorize = new URL(loginResp.headers.location as string);
    const state = authorize.searchParams.get('state') ?? '';
    const nonce = authorize.searchParams.get('nonce') ?? '';

    // 2. Drive /auth/callback. The handler must regenerate the session
    //    BEFORE writing the user payload.
    await setupOidcHappyPath({ sub: 'fix-001', state, nonce });
    const cbResp = await harness.server.inject({
      method: 'GET',
      url: `/auth/callback?code=ac-fix&state=${state}`,
      headers: { cookie: preLoginCookie as string },
    });
    expect(cbResp.statusCode).toBe(302);
    const postLoginCookie = extractSessionCookie(cbResp);
    expect(postLoginCookie).not.toBeNull();

    // 3. Critical assertion: the cookie VALUE (everything after `=`) must
    //    differ. The encrypted payload changed because the contents
    //    changed AND/OR regenerate() rotated the inner state.
    expect(postLoginCookie).not.toBe(preLoginCookie);

    // 4. Sanity check via the harness's pre-mounted /_test/who probe.
    const probe = await harness.server.inject({
      method: 'GET',
      url: '/_test/who',
      headers: { cookie: postLoginCookie as string },
    });
    expect(probe.statusCode).toBe(200);
    const body = JSON.parse(probe.body) as {
      user: { id: number } | null;
    };
    expect(body.user).not.toBeNull();
    expect(typeof body.user?.id).toBe('number');
  });
});
