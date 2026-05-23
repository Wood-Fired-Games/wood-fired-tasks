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

const webRoutes: FastifyPluginAsync = async (fastify) => {
  await fastify.register(loginWeb);
  await fastify.register(meWeb);
  await fastify.register(tokensWeb);
};

export default webRoutes;
