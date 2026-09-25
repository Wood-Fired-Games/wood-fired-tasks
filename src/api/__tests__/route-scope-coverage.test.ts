import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createServer } from '../server.js';
import { resetConfig } from '../../config/env.js';
import type { App } from '../../index.js';
import { PAT_SCOPES } from '../../schemas/pat-scope.schema.js';
import { authHeaders } from './helpers/auth.js';

/**
 * Security Audit finding M1 (task #1622) — route-scope coverage drift guard.
 *
 * Every route registered inside an authenticated scope (`/api/v1/**` and
 * `/health/detailed`) MUST declare a `config.requiredScope` tier, EXCEPT
 * routes explicitly flagged `skipAuth` or `sessionOnly` (those bypass the
 * scope gate entirely — see `enforceRequiredScope` in
 * `src/api/plugins/auth/index.ts`).
 *
 * This test enumerates the server's ACTUAL built route table — collected via
 * the `onRoute` audit hooks wired into `src/api/server.ts`'s `/health/detailed`
 * and `/api/v1` scope registrations (`authenticatedRouteAudit`) — rather than
 * a hand-maintained file list. A new route added inside either scope without
 * a `requiredScope` (and without `skipAuth`/`sessionOnly`) fails this test
 * immediately, naming the offending method + url in the failure message.
 */

interface RouteAuditEntry {
  method: string;
  url: string;
  config: Record<string, unknown>;
}

describe('Security Audit finding M1 — route-scope coverage drift guard', () => {
  let server: FastifyInstance;
  let app: App;
  let audit: RouteAuditEntry[];

  beforeAll(async () => {
    const result = await createServer({ dbPath: ':memory:' });
    server = result.server;
    app = result.app;
    await server.ready();

    audit = (server as unknown as { authenticatedRouteAudit: RouteAuditEntry[] })
      .authenticatedRouteAudit;
  });

  afterAll(async () => {
    await server.close();
    app.db.close();
  });

  it('the audit hook actually collected the built route table (sanity guard)', () => {
    // Regression guard: if the onRoute hooks in server.ts ever stop firing
    // (e.g. a refactor moves the collector below the route registrations),
    // `audit` would be empty and the coverage assertion below would pass
    // VACUOUSLY (an empty offenders list from an empty input). Assert a
    // floor well below the current route count (~30) so this test fails
    // loudly instead of the real check silently doing nothing.
    expect(audit.length).toBeGreaterThan(20);
  });

  it('every authenticated route lacking a requiredScope declaration is empty (except skipAuth/sessionOnly routes)', () => {
    const offenders = audit
      .filter((route) => route.config.skipAuth !== true && route.config.sessionOnly !== true)
      .filter((route) => route.config.requiredScope === undefined)
      .map((route) => `${route.method} ${route.url}`);

    expect(
      offenders,
      `Routes missing a requiredScope declaration: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('every declared requiredScope is a member of the canonical PAT_SCOPES taxonomy', () => {
    const invalid = audit
      .filter((route) => route.config.requiredScope !== undefined)
      .filter(
        (route) =>
          !(PAT_SCOPES as readonly string[]).includes(route.config.requiredScope as string),
      )
      .map(
        (route) =>
          `${route.method} ${route.url} (requiredScope=${String(route.config.requiredScope)})`,
      );

    expect(invalid, `Routes with a non-taxonomy requiredScope: ${invalid.join(', ')}`).toEqual([]);
  });
});

/**
 * Security Audit finding M1 (task #1622) — the Swagger UI blind spot.
 *
 * The default boot above can NOT see the `/docs*` routes at all: they only
 * exist when `ENABLE_SWAGGER_IN_PRODUCTION=true` AND the posture is production
 * (`config.isProductionPosture`), which is exactly the configuration that
 * mounts them INSIDE an authenticated scope (`src/api/server.ts`). Under the
 * default test env the opt-in is unset, so the swagger-ui plugin is never
 * registered and the drift guard is structurally blind to it — the guard would
 * report "no offenders" while a real, authenticated, UNDECLARED route surface
 * existed in the supported opt-in deployment.
 *
 * That is not hypothetical: an undeclared route fails OPEN in
 * `enforceRequiredScope` (`if (required === undefined) return false` —
 * src/api/plugins/auth/index.ts), so any authenticated principal, whatever its
 * PAT scope grant, would reach them.
 *
 * This suite therefore boots the server in EXACTLY that configuration and
 * asserts the `/docs*` routes are (a) present in the audit table at all and
 * (b) carry a `requiredScope`. Without it a regression that drops the
 * declaration is undetectable.
 */
describe('Security Audit finding M1 — Swagger UI routes under production posture + opt-in', () => {
  const STRONG_KEY = 'k1a2b3c4d5e6f7g8h9i0j1k2l3m4n5o6';
  const originalNodeEnv = process.env.NODE_ENV;
  const originalApiKeys = process.env.API_KEYS;
  const originalEnable = process.env.ENABLE_SWAGGER_IN_PRODUCTION;

  let server: FastifyInstance;
  let app: App;
  let audit: RouteAuditEntry[];
  let docsRoutes: RouteAuditEntry[];

  beforeAll(async () => {
    // `NODE_ENV=production` + the explicit opt-in is the ONE supported
    // configuration in which the swagger-ui plugin is mounted behind auth.
    // API_KEYS must be a strong key or the production key validation in the
    // auth plugin refuses to boot.
    process.env.NODE_ENV = 'production';
    process.env.API_KEYS = STRONG_KEY;
    process.env.ENABLE_SWAGGER_IN_PRODUCTION = 'true';
    resetConfig();

    const result = await createServer({ dbPath: ':memory:' });
    server = result.server;
    app = result.app;
    await server.ready();

    audit = (server as unknown as { authenticatedRouteAudit: RouteAuditEntry[] })
      .authenticatedRouteAudit;
    docsRoutes = audit.filter((route) => route.url === '/docs' || route.url.startsWith('/docs/'));
  });

  afterAll(async () => {
    await server.close();
    app.db.close();
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalApiKeys === undefined) delete process.env.API_KEYS;
    else process.env.API_KEYS = originalApiKeys;
    if (originalEnable === undefined) delete process.env.ENABLE_SWAGGER_IN_PRODUCTION;
    else process.env.ENABLE_SWAGGER_IN_PRODUCTION = originalEnable;
    resetConfig();
  });

  it('the swagger-ui routes are actually registered and visible to the audit hook', () => {
    // Sanity floor: if the swagger scope's onRoute hook regresses (or the
    // opt-in stops mounting the plugin), `docsRoutes` goes empty and the
    // declaration assertion below would pass VACUOUSLY.
    expect(
      docsRoutes.map((route) => `${route.method} ${route.url}`),
      'expected the /docs* routes to appear in the authenticated route audit',
    ).not.toEqual([]);
    expect(docsRoutes.some((route) => route.url === '/docs/json')).toBe(true);
  });

  it('every swagger-ui route declares a requiredScope tier', () => {
    const offenders = docsRoutes
      .filter((route) => route.config.skipAuth !== true && route.config.sessionOnly !== true)
      .filter((route) => route.config.requiredScope === undefined)
      .map((route) => `${route.method} ${route.url}`);

    expect(
      offenders,
      `Swagger UI routes missing a requiredScope declaration: ${offenders.join(', ')}`,
    ).toEqual([]);

    // Viewing API docs is a read operation — pin the tier, not just its
    // presence, so a future edit cannot quietly widen it.
    for (const route of docsRoutes) {
      expect(route.config.requiredScope, `${route.method} ${route.url}`).toBe('read');
    }
  });

  it('the whole-server drift guard still reports no offenders in this configuration', () => {
    const offenders = audit
      .filter((route) => route.config.skipAuth !== true && route.config.sessionOnly !== true)
      .filter((route) => route.config.requiredScope === undefined)
      .map((route) => `${route.method} ${route.url}`);

    expect(
      offenders,
      `Routes missing a requiredScope declaration: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('/docs/json is still auth-gated and still serves the spec to a valid principal', async () => {
    // Regression guard for the stamping hook itself: mutating
    // `routeOptions.config` must not disturb the routes it stamps. Note there
    // is deliberately no 403 case here — `read` is the LOWEST tier in the
    // taxonomy, so `grantSatisfiesScope` (src/schemas/pat-scope.schema.ts)
    // returns true for every non-empty grant as well as for the `null`
    // (session) and `[]` (legacy PAT) special cases. The declaration is a
    // fail-closed *declaration*, not a new restriction: its job is to remove
    // these routes from the `required === undefined` fail-open branch of
    // `enforceRequiredScope`, so a later tightening of the tier is a one-line
    // change on a route the drift guard already tracks.
    const unauthed = await server.inject({ method: 'GET', url: '/docs/json' });
    expect(unauthed.statusCode).toBe(401);

    const authed = await server.inject({
      method: 'GET',
      url: '/docs/json',
      headers: authHeaders(app.db, { displayName: 'docs-reader' }),
    });
    expect(authed.statusCode).toBe(200);
    expect(JSON.parse(authed.payload).openapi).toBeDefined();
  });
});
