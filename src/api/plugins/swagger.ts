import type { FastifyInstance } from 'fastify';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUI from '@fastify/swagger-ui';
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
 * Register the interactive Swagger UI plugin at `/docs`.
 *
 * Splitting this from spec registration lets `createServer` gate UI exposure
 * (production-only opt-in + auth) without affecting the in-process OpenAPI
 * document that tests rely on for schema introspection.
 *
 * Task #185: in production, this is only called inside an auth-protected
 * scope (or skipped entirely when ENABLE_SWAGGER_IN_PRODUCTION!=true).
 */
export async function registerSwaggerUI(fastify: FastifyInstance): Promise<void> {
  await fastify.register(fastifySwaggerUI, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
    },
  });
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
