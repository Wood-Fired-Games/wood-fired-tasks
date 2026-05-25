/**
 * Phase 29 Plan 06 — GET /auth/callback (exchanges code for tokens).
 *
 * Decision tree (matches PLAN.md "Hard constraints"):
 *
 *   1. session.get('oidc.handshake') missing
 *        → request.log.error({ requestId, peerIp }, 'oidc.handshake_missing')
 *        → 302 /auth/error?reason=handshake_missing
 *
 *   2. query.state !== handshake.state
 *        → request.log.error({ received, requestId, peerIp }, 'oidc.state_mismatch')
 *          [W2 fix: log ERROR level, NOT warn; log `received` but NOT `expected`
 *           — `expected` is session-bound and leaking it is a minor secret leak
 *           with no diagnostic value.]
 *        → 302 /auth/error?reason=state_mismatch
 *
 *   3. handleCallback(...) rejects
 *        → request.log.error({ err, requestId, peerIp }, 'oidc.callback_failed')
 *        → 302 /auth/error?reason=exchange_failed
 *
 *   4. !claims  (defensive — handleCallback should have thrown)
 *        → request.log.error({ requestId }, 'oidc.id_token_missing')
 *        → 302 /auth/error?reason=exchange_failed
 *
 *   5. claims.email_verified !== true
 *        → request.log.error({ sub, requestId }, 'oidc.email_unverified')
 *        → 302 /auth/error?reason=email_unverified
 *
 *   6. happy path:
 *      a. upsertFromOidc({ userRepository }, claims) — INSERT or reuse row
 *      b. EXPLICITLY clear handshake (W4 fix): session.set('oidc.handshake', undefined)
 *         BEFORE setting the user payload; survives even if regenerate is a no-op.
 *      c. session.regenerate() — rotate the cookie (AUTH-05 fixation defense)
 *      d. session.set('user', toAuthenticatedUser(row))
 *         session.set('authenticatedAt', Date.now())
 *         session.set('idToken', tokens.id_token)  [used by /auth/logout]
 *      e. 302 → handshake.redirectAfterLogin (or /me fallback)
 *
 * Every redirect carries Cache-Control: no-store.
 */
import type { FastifyPluginAsync } from 'fastify';
import { handleCallback } from '../../../services/oidc-client.js';
import { upsertFromOidc } from '../../../services/user-upsert.js';
import { toAuthenticatedUser } from '../../plugins/auth/strategies/pat.js';
import type { AuthRoutesOptions } from './index.js';

interface CallbackQuery {
  code?: unknown;
  state?: unknown;
}

const callbackRoute: FastifyPluginAsync<AuthRoutesOptions> = async (
  fastify,
  opts,
) => {
  fastify.get(
    '/callback',
    { config: { skipAuth: true } },
    async (request, reply) => {
      const handshake = request.session.get('oidc.handshake');
      if (!handshake) {
        request.log.error(
          { requestId: request.id, peerIp: request.ip },
          'oidc.handshake_missing',
        );
        return reply
          .header('Cache-Control', 'no-store')
          .redirect('/auth/error?reason=handshake_missing', 302);
      }

      const queryState = (request.query as CallbackQuery).state;
      if (typeof queryState !== 'string' || queryState !== handshake.state) {
        // W2 — error level, NOT warn. Log `received` for diagnostics.
        // Do NOT log `expected: handshake.state` — the expected value is
        // session-bound; logging it is a minor secret leak with no
        // operational value.
        request.log.error(
          {
            received: typeof queryState === 'string' ? queryState : null,
            requestId: request.id,
            peerIp: request.ip,
          },
          'oidc.state_mismatch',
        );
        // Clear handshake — any retry must start over.
        request.session.set('oidc.handshake', undefined);
        return reply
          .header('Cache-Control', 'no-store')
          .redirect('/auth/error?reason=state_mismatch', 302);
      }

      // Build the URL the OIDC library expects. The library extracts
      // `code` + `state` from this URL's query string AND derives the
      // `redirect_uri` token-endpoint parameter by stripping the query
      // string from this URL. It must therefore equal the
      // registered IdP redirect URI EXACTLY (host/path/scheme) —
      // request.protocol/hostname reflect the *internal* listener
      // (e.g. http://localhost), which is NOT what the IdP saw at
      // /authorize time. Using opts.redirectUri as the base preserves
      // the registered URL while letting us mount the query params
      // from the incoming request.
      const currentUrl = new URL(opts.redirectUri);
      // Copy the query params openid-client v6 reads:
      //   - code, state: RFC 6749 authorization-code grant.
      //   - iss: RFC 9207 Authorization Server Issuer Identification.
      //     openid-client v6 + oauth4webapi validateAuthResponse REQUIRES
      //     this when the AS metadata advertises
      //     `authorization_response_iss_parameter_supported: true`
      //     (Google does), and fails with `OPE: response parameter "iss"
      //     (issuer) missing` otherwise — even though the iss is right
      //     there in `request.query`. Pre-v6 openid-client did not check
      //     iss, hence the older comment that read "code+state are the
      //     only params openid-client reads" — that statement is no
      //     longer true.
      const incomingQuery = (request.query as Record<string, unknown>) ?? {};
      for (const key of ['code', 'state', 'iss']) {
        const v = incomingQuery[key];
        if (typeof v === 'string') currentUrl.searchParams.set(key, v);
      }

      let tokens;
      try {
        tokens = await handleCallback(opts.oidcConfig, currentUrl, {
          pkceVerifier: handshake.pkceVerifier,
          expectedState: handshake.state,
          ...(handshake.nonce ? { expectedNonce: handshake.nonce } : {}),
        });
      } catch (err) {
        request.log.error(
          { err, requestId: request.id, peerIp: request.ip },
          'oidc.callback_failed',
        );
        request.session.set('oidc.handshake', undefined);
        return reply
          .header('Cache-Control', 'no-store')
          .redirect('/auth/error?reason=exchange_failed', 302);
      }

      const claims = tokens.claims();
      if (!claims) {
        // handleCallback should have thrown if the ID token was absent /
        // malformed, but defend defensively.
        request.log.error(
          { requestId: request.id, peerIp: request.ip },
          'oidc.id_token_missing',
        );
        request.session.set('oidc.handshake', undefined);
        return reply
          .header('Cache-Control', 'no-store')
          .redirect('/auth/error?reason=exchange_failed', 302);
      }

      if (claims.email_verified !== true) {
        request.log.error(
          {
            sub: claims.sub,
            requestId: request.id,
            peerIp: request.ip,
          },
          'oidc.email_unverified',
        );
        request.session.set('oidc.handshake', undefined);
        return reply
          .header('Cache-Control', 'no-store')
          .redirect('/auth/error?reason=email_unverified', 302);
      }

      const emailClaim =
        typeof claims.email === 'string' ? claims.email : null;
      const displayName =
        typeof claims.name === 'string' && claims.name.length > 0
          ? claims.name
          : (emailClaim ?? claims.sub);

      // WR-05 fix — wrap upsert in try/catch. If the DB call throws
      // (FK violation, constraint conflict, transient I/O error), we
      // must clear the handshake before bouncing to the error page so
      // a retry from /auth/login starts from a clean slate AND the user
      // gets a documented retry UX (the /auth/error page) instead of
      // Fastify's default 500 with stale handshake state still in the
      // session cookie.
      let row;
      try {
        row = upsertFromOidc(
          { userRepository: fastify.userRepository },
          {
            provider: 'google',
            sub: claims.sub,
            email: emailClaim,
            displayName,
          },
        );
      } catch (err) {
        request.log.error(
          {
            err,
            requestId: request.id,
            sub: claims.sub,
            peerIp: request.ip,
          },
          'oidc.upsert_failed',
        );
        request.session.set('oidc.handshake', undefined);
        return reply
          .header('Cache-Control', 'no-store')
          .redirect('/auth/error?reason=provisioning_failed', 302);
      }

      // W4 — EXPLICITLY clear the handshake BEFORE writing the user.
      // Belt-and-braces: even if regenerate() is a no-op on this version
      // of secure-session, the handshake key is unambiguously cleared.
      request.session.set('oidc.handshake', undefined);

      // AUTH-05 — rotate the encrypted cookie before setting the user
      // payload. regenerate() wipes the session payload AND rolls a new
      // encryption nonce, defeating fixation.
      request.session.regenerate();

      request.session.set('user', toAuthenticatedUser(row));
      request.session.set('authenticatedAt', Date.now());
      if (typeof tokens.id_token === 'string') {
        request.session.set('idToken', tokens.id_token);
      }

      const redirectTo = handshake.redirectAfterLogin || '/me';
      const replyWithRedirect = reply
        .header('Cache-Control', 'no-store')
        .redirect(redirectTo, 302);

      // WR-02 — surface "cookie close to 4 KB" as a warn line BEFORE
      // the browser silently rejects it. Most browsers cap individual
      // cookies at 4 KB; some intermediaries (proxies, WAFs) drop
      // headers above 4 KB without notice. The Google id_token plus
      // sealed-box overhead plus base64 inflation can put `wft_session`
      // in the 2.5–4 KB range; a custom-claim-laden id_token (group
      // memberships, etc.) can push past the limit. The warn fires
      // EARLY so operators see the problem in logs before users start
      // reporting "sign-in silently fails after a Google admin change."
      //
      // 3500 bytes ≈ 90% of the 4 KB ceiling, matching the
      // "fail loud before silent breakage" principle from 29-CONTEXT.md.
      // Bound the lookup to the session cookie specifically so other
      // Set-Cookie headers (rate-limit, CSRF, etc.) do not skew the check.
      const setCookieRaw = reply.getHeader('set-cookie');
      const setCookieList: string[] = Array.isArray(setCookieRaw)
        ? setCookieRaw.map((c) => String(c))
        : setCookieRaw !== undefined && setCookieRaw !== null
          ? [String(setCookieRaw)]
          : [];
      const sessionCookieLine = setCookieList.find((c) =>
        c.startsWith(`${opts.sessionCookieName}=`),
      );
      if (sessionCookieLine && sessionCookieLine.length > 3500) {
        request.log.warn(
          {
            cookieLen: sessionCookieLine.length,
            requestId: request.id,
          },
          'session.cookie_size_approaching_limit',
        );
      }

      return replyWithRedirect;
    },
  );
};

export default callbackRoute;
