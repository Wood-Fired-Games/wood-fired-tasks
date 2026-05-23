/**
 * Phase 29 Plan 06 — POST /auth/logout.
 *
 * Why POST (not GET): RP-initiated logout via a GET link is itself a
 * CSRF vector — any cross-origin <img src="/auth/logout"> would tear
 * down a user's session. POST + a per-session CSRF token blocks both
 * trivial CSRF and cross-origin form submissions.
 *
 * Flow:
 *   1. Validate request.body._csrf against session.csrf (constant-time).
 *      Mismatch → 403 { error: 'csrf_invalid' }; session NOT cleared so
 *      a legitimate user can still recover via a refresh.
 *   2. Capture session.idToken BEFORE clearing the session — needed for
 *      the RP-initiated logout's id_token_hint.
 *   3. session.delete() — clears the local session cookie unconditionally.
 *      If the IdP roundtrip fails for any reason, the user is still
 *      logged out locally (the cookie is invalidated).
 *   4. If discovery advertised end_session_endpoint AND we have an
 *      idToken, build the RP-initiated logout URL via buildEndSessionUrl
 *      (which gracefully returns null when end_session_endpoint is
 *      absent — see oidc-client.ts) and 302 to it.
 *   5. Otherwise 302 /auth/login.
 *
 * Cache-Control: no-store on every response.
 */
import type { FastifyPluginAsync } from 'fastify';
import { buildEndSessionUrl } from '../../../services/oidc-client.js';
import { verifyCsrfToken } from './csrf.js';
import type { AuthRoutesOptions } from './index.js';

const logoutRoute: FastifyPluginAsync<AuthRoutesOptions> = async (
  fastify,
  opts,
) => {
  fastify.post(
    '/logout',
    { config: { skipAuth: true } },
    async (request, reply) => {
      const body = (request.body ?? {}) as { _csrf?: unknown };
      if (!verifyCsrfToken(request, body._csrf)) {
        return reply
          .header('Cache-Control', 'no-store')
          .code(403)
          .send({ error: 'csrf_invalid' });
      }

      // Snapshot idToken BEFORE delete() — RP-initiated logout needs it.
      const idToken = request.session.get('idToken');

      // Clear the local session unconditionally; the IdP roundtrip is
      // best-effort. If buildEndSessionUrl returns null OR the IdP is
      // unreachable, the user is still logged out locally.
      request.session.delete();

      if (typeof idToken === 'string' && idToken.length > 0) {
        const origin = `${request.protocol}://${request.hostname}`;
        const url = buildEndSessionUrl(opts.oidcConfig, {
          idTokenHint: idToken,
          postLogoutRedirectUri: `${origin}/auth/login`,
        });
        if (url) {
          return reply
            .header('Cache-Control', 'no-store')
            .redirect(url.toString(), 302);
        }
      }

      return reply
        .header('Cache-Control', 'no-store')
        .redirect('/auth/login', 302);
    },
  );
};

export default logoutRoute;
