import type { FastifyInstance } from 'fastify';
import fastifySwagger from '@fastify/swagger';
import { jsonSchemaTransform } from 'fastify-type-provider-zod';
import { VERSION } from '../../utils/version.js';

/**
 * Register the OpenAPI spec collector (`@fastify/swagger`).
 *
 * The spec collector hooks into route registration to build the OpenAPI
 * document — it does NOT expose any HTTP endpoint by itself. Always
 * registering it keeps the in-process spec available to tests and to the
 * optional Swagger UI plugin, regardless of whether `/docs` is exposed.
 *
 * Must be called BEFORE registering routes to capture their schemas.
 */
export async function registerSwaggerSpec(fastify: FastifyInstance): Promise<void> {
  await fastify.register(fastifySwagger, {
    openapi: {
      info: {
        title: 'Wood Fired Tasks API',
        description:
          'Task management REST API for Wood Fired Games. Designed for LLM agent consumption.',
        version: VERSION,
      },
      servers: [{ url: 'http://localhost:3000', description: 'Development' }],
      components: {
        securitySchemes: {
          // Personal Access Token is the sole documented auth surface. The
          // chain auth plugin (src/api/plugins/auth/index.ts) tries
          // Authorization: Bearer wft_pat_* then session. The legacy
          // X-API-Key securityScheme was removed in the v2.0 auth cutover.
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'wft_pat_<base32>',
            description:
              'Personal Access Token. Format: `wft_pat_<32 base32 chars>`. ' +
              'Mint via POST /api/v1/me/tokens (session-only).',
          },
        },
      },
      security: [{ bearerAuth: [] }],
    },
    transform: jsonSchemaTransform,
  });
}

/**
 * True when `err` (or anything in its `cause` chain) is a module-resolution
 * failure — i.e. "the package is not installed".
 *
 * The `cause` walk is deliberate, not defensive padding: a dynamic `import()`
 * rarely reaches application code unwrapped. Node's ESM loader, bundlers, and
 * test runners all re-throw resolution failures wrapped in their own Error
 * with the original attached as `cause`. Matching only the top-level `.code`
 * would make the guard silently ineffective under any of them — the module
 * would appear "broken" rather than "absent" and take the server down.
 *
 * The check stays narrow on purpose: only the two resolution codes are
 * tolerated. A module that resolves but throws while evaluating (a corrupted
 * install) has no such code anywhere in its chain and must propagate.
 */
function isModuleNotFound(err: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current !== null && current !== undefined && !seen.has(current)) {
    seen.add(current);
    const code = (current as NodeJS.ErrnoException).code;
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Register the interactive Swagger UI plugin at `/docs`.
 *
 * Splitting this from spec registration lets `createServer` gate UI exposure
 * (mandatory opt-in in every environment, + auth in production posture)
 * without affecting the in-process OpenAPI document that tests rely on for
 * schema introspection.
 *
 * Task #185 / task #1612: `createServer` only calls this when
 * `ENABLE_SWAGGER_IN_PRODUCTION=true` is explicitly set (mandatory in EVERY
 * environment, not only production — see task #1611's `isProductionPosture`),
 * and wraps it in an auth-protected scope whenever posture is production
 * (explicit `NODE_ENV=production`, or `NODE_ENV` absent/unset).
 *
 * Task #1617 (H3 audit finding): `@fastify/swagger-ui` is a **devDependency**,
 * not a production dependency. It is the sole path by which `@fastify/static`
 * — which carries two unfixed HIGH advisories (GHSA-8pvw-jcv7-9cmj,
 * GHSA-83w8-p2f5-377r, both `<=10.1.1`, no upstream fix on the `^9.x` line
 * swagger-ui pins) — enters the dependency tree. Keeping it out of
 * `dependencies` removes the vulnerable package from every production install
 * and from `npm audit --omit=dev`, rather than suppressing the finding.
 *
 * The consequence is that the module may legitimately be ABSENT at runtime
 * (`npm install --omit=dev`, `npm ci --production`, the published tarball).
 * The import below is therefore dynamic and guarded, and lives inside this
 * function so the not-exposed path — the default in every environment — never
 * touches it at all. When the operator explicitly opted in but the optional
 * module is not installed, we log and return `false` instead of throwing: a
 * missing developer-facing docs UI must not brick an API server boot. The
 * caller (`createServer`) surfaces that as a warning so it is never silent.
 *
 * @returns `true` if the UI plugin was registered, `false` if
 *   `@fastify/swagger-ui` is not installed.
 */
export async function registerSwaggerUI(fastify: FastifyInstance): Promise<boolean> {
  let fastifySwaggerUI: typeof import('@fastify/swagger-ui').default;
  try {
    ({ default: fastifySwaggerUI } = await import('@fastify/swagger-ui'));
  } catch (err) {
    // Only an actual "module is not installed" resolution failure is
    // tolerated. Anything else (a broken install, a module that throws at
    // evaluation time) is a real fault and must propagate.
    if (!isModuleNotFound(err)) throw err;
    fastify.log.warn(
      { err },
      'ENABLE_SWAGGER_IN_PRODUCTION is set but the optional @fastify/swagger-ui ' +
        'devDependency is not installed — /docs will not be mounted. Install it ' +
        'explicitly (npm i -D @fastify/swagger-ui) to use the docs UI; it is not a ' +
        'production dependency because it transitively pulls in the vulnerable ' +
        '@fastify/static.',
    );
    return false;
  }

  await fastify.register(fastifySwaggerUI, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
    },
  });
  return true;
}

/**
 * Legacy combined helper: register spec + UI together (no auth, no env gating).
 *
 * Retained for callers that want the pre-task-#185 behaviour. New code should
 * call `registerSwaggerSpec` and `registerSwaggerUI` independently so the UI
 * can be gated.
 */
export async function registerSwagger(fastify: FastifyInstance): Promise<void> {
  await registerSwaggerSpec(fastify);
  await registerSwaggerUI(fastify);
}
