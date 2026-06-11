import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ModelCatalogEntrySchema } from '../../../schemas/model-catalog.schema.js';

/**
 * Configurable Task Models (Task 13) — GET /api/v1/models
 *
 * Exposes the runtime-discovered Claude model catalog (task #917's
 * `model-catalog.service`) over REST so the remote MCP proxy / dashboard /
 * `set-models` interview can enumerate the available models. The 200 body is
 * `{ models, stale }` — identical to the service's `ModelCatalog` and the
 * stdio MCP `list_models` tool's structured output.
 *
 * `stale: true` signals the catalog was served from the static fallback (no
 * ANTHROPIC_API_KEY, non-OK Models API response, or a network error). The
 * service NEVER throws from `list()`, so this route always returns 200.
 *
 * Auth: inherits the standard `/api/v1` auth chain (the parent plugin is
 * mounted inside the `/api/v1` scope that wires `authPlugin`). No custom guard.
 */

/** The `{ models, stale }` envelope returned by GET /models. */
export const ModelCatalogResponseSchema = z.object({
  models: z.array(ModelCatalogEntrySchema),
  stale: z.boolean(),
});

const modelsRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    '/',
    {
      schema: {
        tags: ['models'],
        description:
          'List the available Claude model catalog (runtime-discovered via the ' +
          'Anthropic Models API, TTL-cached). Returns `{ models, stale }`; ' +
          '`stale: true` means the static fallback was served (no API key / ' +
          'unreachable Models API).',
        response: {
          200: ModelCatalogResponseSchema,
        },
      },
    },
    async (_request, reply) => {
      const catalog = await fastify.modelCatalogService.list();
      return reply.send(catalog);
    },
  );
};

export default modelsRoutes;
