/**
 * Phase 29 Plan 07 — web routes barrel module.
 *
 * Registers three top-level GET/POST endpoints for the server-rendered
 * HTML web UI:
 *   GET  /login                    — public sign-in page
 *   GET  /me                       — profile (session-gated)
 *   GET  /me/tokens                — token management (session-gated)
 *   POST /me/tokens/:id/revoke     — revoke (session-gated, CSRF)
 *
 * All routes carry `config: { skipAuth: true }` so the Phase 28 auth
 * chain (mounted under /api/v1) does NOT gate them — the chain is
 * scope-local. The handlers implement their own session-presence
 * checks (redirect to /auth/login when absent).
 *
 * Plan 8 is responsible for the OIDC-disabled mode branching at
 * server.ts (when SESSION_COOKIE_SECRET is unset, the cookie + session
 * plugins are skipped and request.session is undefined; the handlers
 * cope via optional-chained `request.session?.get(...)`).
 */
import type { FastifyPluginAsync } from 'fastify';
import loginWeb from './login.js';
import meWeb from './me.js';
import tokensWeb from './tokens.js';
import { HTML_SECURITY_HEADERS } from '../../../web/html.js';

const webRoutes: FastifyPluginAsync = async (fastify) => {
  // WR-04 fix — stamp X-Frame-Options + CSP + Referrer-Policy on every
  // text/html response in this scope. Scoped to the web routes plugin
  // (not the global server) so JSON API responses under /api/v1 are
  // unaffected. The check inspects the outgoing Content-Type: applying
  // the headers ONLY to HTML keeps JSON 4xx/5xx error envelopes free of
  // CSP — JSON responses cannot be framed and the CSP would be noise.
  fastify.addHook('onSend', async (_request, reply, payload) => {
    const contentType = reply.getHeader('content-type');
    const isHtml =
      typeof contentType === 'string' && contentType.includes('text/html');
    if (isHtml) {
      for (const [name, value] of Object.entries(HTML_SECURITY_HEADERS)) {
        // `header()` does not overwrite an existing header by default in
        // Fastify; use the lower-level reply.header which we know is
        // idempotent for our values (we always stamp the same constants).
        reply.header(name, value);
      }
    }
    return payload;
  });

  await fastify.register(loginWeb);
  await fastify.register(meWeb);
  await fastify.register(tokensWeb);
};

export default webRoutes;
