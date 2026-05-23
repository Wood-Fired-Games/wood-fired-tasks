/**
 * Phase 29 Plan 07 — GET /me profile page.
 *
 * Auth: implements an in-handler session check (the parent scope is
 * skipAuth-enabled so the Phase 28 chain never runs here — that chain
 * is /api/v1-scoped and validates PAT/legacy/session for the API only).
 *
 * Behavior:
 *   - No session.user → 302 to /auth/login?next=/me
 *   - Session present → 200 + HTML with displayName + email + auth method
 *     + CSRF-protected logout form
 *
 * Cache-Control: no-store on every response (security pages must not
 * be cached — the personalized response would otherwise leak to a
 * shared cache).
 */
import type { FastifyPluginAsync } from 'fastify';
import { renderMe } from '../../../web/pages/me.js';
import { getOrCreateCsrfToken } from '../auth/csrf.js';

const meWeb: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    '/me',
    { config: { skipAuth: true } },
    async (request, reply) => {
      const sessionUser = request.session?.get('user');
      if (!sessionUser) {
        return reply
          .header('Cache-Control', 'no-store')
          .redirect('/auth/login?next=/me', 302);
      }
      const csrf = getOrCreateCsrfToken(request);
      const authenticatedAt = request.session.get('authenticatedAt') ?? null;
      return reply
        .header('Content-Type', 'text/html; charset=utf-8')
        .header('Cache-Control', 'no-store')
        .code(200)
        .send(
          renderMe({
            user: sessionUser,
            authMethod: 'session',
            csrf,
            authenticatedAt,
          }),
        );
    },
  );
};

export default meWeb;
