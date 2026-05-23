/**
 * Phase 29 Plan 07 — GET /me/tokens + POST /me/tokens/:id/revoke.
 *
 * GET behavior:
 *   - No session.user → 302 to /auth/login?next=/me/tokens
 *   - Session present → 200 + HTML
 *   - Reads + clears `session.mintedToken` via getFlashAndClear so the
 *     full token is shown EXACTLY ONCE (refresh hides it).
 *
 * POST /me/tokens/:id/revoke behavior:
 *   - No session.user → 302 to /auth/login?next=/me/tokens
 *   - Invalid CSRF → 403 { error: 'csrf_invalid' }
 *   - Valid → apiTokenRepository.revoke(id, userId) (no existence leak
 *     on miss — repo returns false silently), 303 to /me/tokens
 *
 * Both routes are config.skipAuth so the Phase 28 chain (which is
 * /api/v1-scoped) does not gate them; the handlers implement their
 * own minimal session-presence check. Cache-Control: no-store always.
 *
 * Note on the revoke path: we expose POST /me/tokens/:id/revoke (NOT
 * DELETE) because HTML forms only support GET + POST natively, and
 * relying on a hidden `_method=DELETE` override would require an
 * additional plugin. A small route-level alias is cheaper and more
 * explicit. The underlying repository call is shared with the JSON
 * DELETE handler at /api/v1/me/tokens/:id.
 */
import type { FastifyPluginAsync } from 'fastify';
import { renderTokens } from '../../../web/pages/tokens.js';
import { getOrCreateCsrfToken, verifyCsrfToken } from '../auth/csrf.js';
import { getFlashAndClear } from '../../../web/session-flash.js';
import { resolveActiveSessionUser } from '../../../web/session-user.js';

const tokensWeb: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    '/me/tokens',
    { config: { skipAuth: true } },
    async (request, reply) => {
      // CR-02 fix: re-validate the session user against the database on
      // every request so a disabled user cannot continue browsing or
      // revoking PATs through the web UI for the remainder of the 8h
      // session lifetime.
      const sessionUser = resolveActiveSessionUser(
        request,
        fastify.userRepository,
      );
      if (!sessionUser) {
        return reply
          .header('Cache-Control', 'no-store')
          .redirect('/auth/login?next=/me/tokens', 302);
      }
      const csrf = getOrCreateCsrfToken(request);
      const rows = fastify.apiTokenRepository.listByUser(sessionUser.id);
      const tokenRows = rows.map((r) => ({
        id: r.id,
        name: r.name,
        prefix: r.prefix,
        suffix: r.suffix,
        createdAt: r.created_at,
        lastUsedAt: r.last_used_at,
        revokedAt: r.revoked_at,
        expiresAt: r.expires_at,
      }));
      const mintedToken = getFlashAndClear<'mintedToken'>(
        request,
        'mintedToken',
      );
      return reply
        .header('Content-Type', 'text/html; charset=utf-8')
        .header('Cache-Control', 'no-store')
        .code(200)
        .send(renderTokens({ tokens: tokenRows, mintedToken, csrf }));
    },
  );

  fastify.post(
    '/me/tokens/:id/revoke',
    { config: { skipAuth: true } },
    async (request, reply) => {
      // CR-02 fix: same defense as the GET handler. A disabled user must
      // not be able to mutate token state through the web UI.
      const sessionUser = resolveActiveSessionUser(
        request,
        fastify.userRepository,
      );
      if (!sessionUser) {
        return reply
          .header('Cache-Control', 'no-store')
          .redirect('/auth/login?next=/me/tokens', 302);
      }
      const body = (request.body ?? {}) as { _csrf?: unknown };
      if (!verifyCsrfToken(request, body._csrf)) {
        return reply
          .header('Cache-Control', 'no-store')
          .code(403)
          .send({ error: 'csrf_invalid' });
      }
      const id = Number((request.params as { id?: unknown }).id);
      if (Number.isInteger(id) && id > 0) {
        // No existence leak on miss — repo returns false silently and we
        // redirect anyway. The bottom-of-page "Revoked tokens" section
        // will simply not show a new row.
        fastify.apiTokenRepository.revoke(id, sessionUser.id);
      }
      return reply
        .header('Cache-Control', 'no-store')
        .redirect('/me/tokens', 303);
    },
  );
};

export default tokensWeb;
