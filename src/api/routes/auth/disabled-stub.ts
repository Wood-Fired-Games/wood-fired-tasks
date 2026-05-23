/**
 * Phase 29 Plan 08 — 501 stub for /auth/* when OIDC is disabled.
 *
 * Plan 8's `createServer` registers EITHER this plugin OR the real
 * `authRoutes` (Plan 6) at prefix `/auth`, gated by `App.oidcConfig`:
 *   - `oidcConfig` non-null → real authRoutes (Plan 6).
 *   - `oidcConfig` null     → this stub.
 *
 * Surface:
 *   GET  /auth/login    → 501 { error: 'oidc_disabled', ... } JSON
 *   GET  /auth/callback → 501 { error: 'oidc_disabled', ... } JSON
 *   POST /auth/logout   → 501 { error: 'oidc_disabled', ... } JSON
 *   GET  /auth/error    → 200 text/html (Plan 6's auth-error handler)
 *
 * Why /auth/error stays functional in disabled mode: PAT-only sessions
 * (Phase 28) may still expire or 403; the error page is the operator-
 * friendly destination for those flows. The page is purely static so
 * registering it costs nothing when OIDC is off.
 *
 * Why JSON for the 501s: programmatic callers (CLI, future MCP) get a
 * clear machine-readable signal that OIDC is not configured. The HTML
 * web UI at /login (Plan 7) checks for OIDC presence itself and renders
 * a different message when needed.
 *
 * All three stub routes carry `config: { skipAuth: true }` so even if a
 * future change hoists the Phase 28 auth chain above /auth, it would
 * short-circuit them. Belt-and-braces only — the chain is /api/v1-scoped.
 */
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import authErrorRoute from './auth-error.js';

const STUB_BODY = {
  error: 'oidc_disabled',
  message: 'OIDC sign-in is not configured on this server.',
} as const;

const disabledStub: FastifyPluginAsync = async (fastify) => {
  const handler = async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply
      .header('Content-Type', 'application/json; charset=utf-8')
      .code(501)
      .send(STUB_BODY);
  };

  fastify.get('/login', { config: { skipAuth: true } }, handler);
  fastify.get('/callback', { config: { skipAuth: true } }, handler);
  fastify.post('/logout', { config: { skipAuth: true } }, handler);

  // /auth/error stays functional in disabled mode — Plan 7's web pages
  // may still redirect here on session-expiry / 403 even when OIDC is off.
  await fastify.register(authErrorRoute);
};

export default disabledStub;
