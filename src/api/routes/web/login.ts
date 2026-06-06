/**
 * Phase 29 Plan 07 — GET /login web route.
 *
 * Anonymous (config.skipAuth: true). If a session.user already exists,
 * 302 to /me — the canonical home for signed-in callers. Otherwise
 * renders the Sign-in page with a single "Sign in with Google" link
 * to /auth/login.
 *
 * Cache-Control: no-store on every response (security pages must not
 * be cached — even the anonymous one, since the response body shape
 * varies with session presence on the redirect-to-/me branch).
 *
 * The route forwards `?next=<path>` to /auth/login so the post-login
 * redirect targets the user's original destination. The validation of
 * `next` lives in /auth/login (Plan 29-06); here we just pass it
 * through verbatim (escapeHtml in the template handles XSS).
 */
import type { FastifyPluginAsync } from 'fastify';
import { renderLogin } from '../../../web/pages/login.js';

const loginWeb: FastifyPluginAsync = async (fastify) => {
  fastify.get('/login', { config: { skipAuth: true } }, async (request, reply) => {
    if (request.session?.get('user')) {
      return reply.header('Cache-Control', 'no-store').redirect('/me', 302);
    }
    const next = (request.query as { next?: unknown }).next;
    return reply
      .header('Content-Type', 'text/html; charset=utf-8')
      .header('Cache-Control', 'no-store')
      .code(200)
      .send(
        renderLogin({
          next: typeof next === 'string' ? next : undefined,
        }),
      );
  });
};

export default loginWeb;
