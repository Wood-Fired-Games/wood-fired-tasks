/**
 * Phase 29 Plan 06 — GET /auth/login (initiates the OIDC handshake).
 *
 * Behavior table (PLAN.md):
 *   - already-signed-in (`session.get('user')`)  → 302 /me
 *   - OIDC disabled                              → /auth/error?reason=oidc_not_configured
 *      [handled by Plan 8's wiring: when OIDC is off, server.ts registers a
 *      stub plugin instead of this one; this handler only ships when
 *      oidcConfig is non-null, so we don't branch here.]
 *   - fresh visit                                → 302 to IdP authorize URL
 *
 * Open-redirect prevention (T-29-06-02): `?next=<path>` must match
 * `/^\/[^/]/` — a single leading slash followed by ANYTHING other than
 * another slash. Rejects `//evil.com`, `///path`, etc. Fallback `/me`.
 *
 * Side effects:
 *   - Generates PKCE verifier + state + nonce per request (entropy from
 *     openid-client's randomPKCECodeVerifier / randomState / randomNonce).
 *   - Stashes the handshake triple in `session.oidc.handshake` so the
 *     callback can validate and complete the exchange.
 *   - Emits Cache-Control: no-store on the redirect (security headers
 *     hygiene).
 */
import type { FastifyPluginAsync } from 'fastify';
import {
  buildAuthorizationUrl,
  calculatePKCECodeChallenge,
  randomNonce,
  randomPKCECodeVerifier,
  randomState,
} from '../../../services/oidc-client.js';
import type { AuthRoutesOptions } from './index.js';

/**
 * Validates `?next=<path>` for open-redirect safety. Pattern: a SINGLE
 * leading slash followed by ANY character that is NOT another slash AND
 * NOT a backslash. Rejects:
 *   - missing leading slash    (`me`)
 *   - protocol-relative URLs   (`//evil.com`)
 *   - triple slash etc.        (`///foo`)
 *   - backslash bypass         (`/\evil.com` — WHATWG URL parsers in
 *                                browsers normalize `\` to `/` in path
 *                                components, so `Location: /\evil.com`
 *                                navigates to `//evil.com` cross-origin.
 *                                CR-01 in 29-REVIEW.md.)
 *   - empty string
 * Accepts: `/me`, `/me/tokens`, `/projects/42`, `/me?x=1` ...
 */
const NEXT_PATH_RE = /^\/[^/\\]/;

interface LoginQuery {
  next?: unknown;
}

const loginRoute: FastifyPluginAsync<AuthRoutesOptions> = async (
  fastify,
  opts,
) => {
  fastify.get(
    '/login',
    { config: { skipAuth: true } },
    async (request, reply) => {
      // Already signed in — short-circuit to /me (the documented home
      // page for authenticated users). Skip the IdP roundtrip entirely.
      if (request.session.get('user')) {
        return reply
          .header('Cache-Control', 'no-store')
          .redirect('/me', 302);
      }

      const nextRaw = (request.query as LoginQuery).next;
      const redirectAfterLogin =
        typeof nextRaw === 'string' && NEXT_PATH_RE.test(nextRaw)
          ? nextRaw
          : '/me';

      // PKCE + CSRF nonces. The verifier stays server-side (encrypted
      // cookie); only the SHA-256 challenge is sent to the IdP.
      const pkceVerifier = randomPKCECodeVerifier();
      const pkceCodeChallenge = await calculatePKCECodeChallenge(pkceVerifier);
      const state = randomState();
      const nonce = randomNonce();

      request.session.set('oidc.handshake', {
        pkceVerifier,
        state,
        nonce,
        redirectAfterLogin,
      });

      const url = buildAuthorizationUrl(opts.oidcConfig, {
        pkceCodeChallenge,
        state,
        nonce,
        redirectUri: opts.redirectUri,
        scopes: opts.scopes,
      });

      return reply
        .header('Cache-Control', 'no-store')
        .redirect(url.toString(), 302);
    },
  );
};

export default loginRoute;
