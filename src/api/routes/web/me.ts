/**
 * Phase 29 Plan 07 — GET /me profile page.
 *
 * Auth: implements an in-handler session check (the parent scope is
 * skipAuth-enabled so the Phase 28 chain never runs here — that chain
 * is /api/v1-scoped and validates PAT/legacy/session for the API only).
 *
 * Behavior:
 *   - No session.user → 302 to /auth/login?next=/me
 *   - Session user disabled mid-session (CR-02) → session cleared, 302 to
 *     /auth/login?next=/me. Re-validation runs on EVERY request via
 *     resolveActiveSessionUser so a disabled user cannot continue browsing
 *     the profile UI for the remainder of the 8-hour session lifetime.
 *   - Session present + user active → 200 + HTML with displayName + email +
 *     auth method + CSRF-protected logout form
 *
 * Cache-Control: no-store on every response (security pages must not
 * be cached — the personalized response would otherwise leak to a
 * shared cache).
 */
import type { FastifyPluginAsync } from 'fastify';
import { renderMe } from '../../../web/pages/me.js';
import { getOrCreateCsrfToken } from '../auth/csrf.js';
import { resolveActiveSessionUser } from '../../../web/session-user.js';

const meWeb: FastifyPluginAsync = async (fastify) => {
  fastify.get('/me', { config: { skipAuth: true } }, async (request, reply) => {
    // CR-02 fix: re-read the user row + check disabled_at on every
    // request. resolveActiveSessionUser clears the session if the user
    // was disabled mid-session, mirroring the /api/v1 chain's behavior
    // so the web UI cannot be used by a disabled user for up to 8h.
    const sessionUser = resolveActiveSessionUser(request, fastify.userRepository);
    if (!sessionUser) {
      return reply.header('Cache-Control', 'no-store').redirect('/auth/login?next=/me', 302);
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
  });
};

export default meWeb;
