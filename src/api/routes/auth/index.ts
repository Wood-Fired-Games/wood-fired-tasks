/**
 * Phase 29 Plan 06 — OIDC routes barrel module.
 *
 * Registered AT TOP LEVEL by Plan 8's server.ts wiring (with prefix
 * `/auth`), NOT under `/api/v1`. Final externally-visible paths:
 *   GET  /auth/login     — initiates the OIDC handshake (302 to IdP)
 *   GET  /auth/callback  — exchanges the auth code; sets session
 *   POST /auth/logout    — clears session; RP-initiated logout when avail
 *   GET  /auth/error     — generic error page
 *
 * All four routes carry `config: { skipAuth: true }` so even if the
 * Phase 28 auth chain were ever hoisted to a parent scope it would
 * short-circuit them. The chain is currently /api/v1-scoped, so this
 * is belt-and-braces.
 *
 * Plan 8 is responsible for the OIDC-disabled mode branching: when
 * `initOidc` returns null (no OIDC_ISSUER_URL), server.ts registers a
 * 501 stub plugin instead of this one.
 */
import type { FastifyPluginAsync } from 'fastify';
import type { OidcConfig } from '../../../services/oidc-client.js';
import loginRoute from './login.js';
import callbackRoute from './callback.js';
import logoutRoute from './logout.js';
import authErrorRoute from './auth-error.js';

export interface AuthRoutesOptions {
  oidcConfig: OidcConfig;
  /**
   * Registered IdP redirect URI; must match the value supplied to the
   * IdP at app-registration time. Surfaced as a plugin option (not read
   * from the global Config) so tests can mount the plugin with a probe
   * redirect URI without mutating process.env.
   */
  redirectUri: string;
  /** Space-separated scope string (e.g. "openid email profile"). */
  scopes: string;
  /**
   * Cookie name for the session cookie (mirrors `config.SESSION_COOKIE_NAME`).
   * Used by the WR-02 cookie-size warn line in callback.ts so the
   * lookup against `reply.getHeader('set-cookie')` matches the
   * concrete cookie name configured on the secure-session plugin.
   * Defaults to `wfb_session` at the server.ts wiring site.
   */
  sessionCookieName: string;
  /**
   * Post-logout redirect URI passed to the IdP's RP-initiated logout
   * (`post_logout_redirect_uri`). WR-03 fix: sourced from config so the
   * value does NOT come from caller-controlled headers
   * (`request.hostname` / `request.protocol`).
   */
  postLogoutRedirectUri: string;
}

const authRoutes: FastifyPluginAsync<AuthRoutesOptions> = async (
  fastify,
  opts,
) => {
  // Strip Fastify-reserved `prefix` from the options forwarded to child
  // plugins — the parent prefix (e.g. `/auth`) has already been applied
  // to *this* scope by Fastify, so re-passing it would mount each child
  // at `/auth/auth/...`.
  const childOpts: AuthRoutesOptions = {
    oidcConfig: opts.oidcConfig,
    redirectUri: opts.redirectUri,
    scopes: opts.scopes,
    sessionCookieName: opts.sessionCookieName,
    postLogoutRedirectUri: opts.postLogoutRedirectUri,
  };
  await fastify.register(loginRoute, childOpts);
  await fastify.register(callbackRoute, childOpts);
  await fastify.register(logoutRoute, childOpts);
  await fastify.register(authErrorRoute);
};

export default authRoutes;
