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
   * Defaults to `wft_session` at the server.ts wiring site.
   */
  sessionCookieName: string;
  /**
   * Post-logout redirect URI passed to the IdP's RP-initiated logout
   * (`post_logout_redirect_uri`). WR-03 fix: sourced from config so the
   * value does NOT come from caller-controlled headers
   * (`request.hostname` / `request.protocol`).
   */
  postLogoutRedirectUri: string;
  /**
   * Phase 30 Plan 08 — OAuth client_id expected by the device-flow code
   * endpoint. Sourced from `env.OIDC_CLIENT_ID` at the server.ts wiring
   * site; threaded as a plugin option so tests can mount the barrel with
   * a probe client_id without mutating process.env. Optional in the
   * interface so Phase 29-era callers (oidc-test-setup.ts etc.) that
   * never exercise the device-flow surface can omit it.
   */
  clientId?: string;
  /**
   * Phase 30 Plan 08 — server origin used to compose the absolute
   * verification URIs the CLI prints. Sourced from `effectiveOrigin(env)`
   * at the server.ts wiring site. Optional — see `clientId` above.
   */
  origin?: string;
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
    ...(opts.clientId !== undefined ? { clientId: opts.clientId } : {}),
    ...(opts.origin !== undefined ? { origin: opts.origin } : {}),
  };
  await fastify.register(loginRoute, childOpts);
  await fastify.register(callbackRoute, childOpts);
  await fastify.register(logoutRoute, childOpts);
  await fastify.register(authErrorRoute);

  // NOTE — Phase 30 Plan 08 device-flow routes (POST /auth/device/code,
  // POST /auth/device/token, GET /auth/device, POST /auth/device/verify)
  // are NOT registered inside this barrel. The three plugin files
  // (device-code.ts, device-token.ts, device-html.ts) register their
  // handlers at ABSOLUTE paths (`/auth/device/code`, etc.) because Plan
  // 30-01/02/04 tests mount them directly on a Fastify root WITHOUT a
  // prefix. Fastify concatenates prefixes (no override), so mounting
  // those plugins inside THIS barrel (which itself sits behind `prefix:
  // '/auth'` at server.ts) would double-prefix them to
  // `/auth/auth/device/code`.
  //
  // Plan 30-08 sidesteps the path collision by registering the device-flow
  // routes DIRECTLY on the server at server.ts (top-level, no prefix) when
  // `app.oidcConfig` is non-null. The OIDC-disabled branch registers
  // `device-disabled-stub` under `prefix: '/auth'` (it uses RELATIVE paths
  // `/device/code` etc., so the prefix wiring works there).
  //
  // The asymmetry (enabled = top-level absolute paths; disabled = prefixed
  // relative paths) is documented in server.ts and is the only safe option
  // without rewriting Plans 30-01/02/04. A future cleanup could normalize
  // the device-* files to RELATIVE paths and mount both branches under
  // prefix `/auth`; out of scope for this plan.
};

export default authRoutes;
