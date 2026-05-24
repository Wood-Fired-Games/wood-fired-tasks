import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  DependencyGraphFormatSchema,
  DependencyGraphResponseSchema,
} from './schemas.js';
import { ErrorResponseSchema } from '../tasks/schemas.js';

/**
 * Task #342 — GET /api/v1/projects/:id/dependency-graph
 *
 * Returns a project's full task dependency structure in one of three shapes
 * so the Agent Overview dashboard can render a file-tree-style view of Open
 * Tasks without falling into an N+1 trap on the per-task
 * `GET /tasks/:id/dependencies` endpoint.
 *
 * The service layer performs a SINGLE bulk pass over `tasks` and a SINGLE
 * bulk pass over `task_dependencies`, then composes the requested shape in
 * memory — see `DependencyGraphService.buildDependencyGraph` for the
 * exact contract.
 *
 * Auth: inherits the standard projects-route auth chain (the parent
 * `projectRoutes` plugin is registered inside the `/api/v1` scope which
 * mounts `authPlugin`). No custom guard is bolted on here.
 *
 * Schema registration is automatic — the `schema:` block below is picked
 * up by `@fastify/swagger`'s `jsonSchemaTransform` and rendered in the
 * Scalar UI at `/docs`. The 200 response is a discriminated union keyed
 * on the `format` literal so the OpenAPI document advertises all three
 * shapes with a clear discriminator.
 */
const dependencyGraphRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    '/:id/dependency-graph',
    {
      schema: {
        tags: ['projects'],
        description:
          "Return a project's task dependency structure in tree (default), " +
          "graph, or text form. Performs a single bulk SQL pass over tasks " +
          "and task_dependencies — safe for dashboard panels that would " +
          "otherwise N+1 against /tasks/:id/dependencies.",
        params: z.object({ id: z.coerce.number().int().positive() }),
        querystring: z.object({
          format: DependencyGraphFormatSchema,
        }),
        response: {
          // The shared response schema is a `z.discriminatedUnion('format',
          // [...])` exported by the schema module — each variant carries a
          // `format` literal as its first field, so callers can narrow the
          // union without inspecting any other property. We use the union
          // directly here (no `.extend({ format })` wrapper) so the runtime
          // shape and the OpenAPI document stay in lockstep.
          200: DependencyGraphResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const result = fastify.dependencyGraphService.buildDependencyGraph(
        request.params.id,
        request.query.format,
      );
      return reply.send(result);
    },
  );
};

export default dependencyGraphRoutes;
