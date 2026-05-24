import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  DependencyGraphFormatSchema,
  DependencyGraphTreeResponseSchema,
  DependencyGraphGraphResponseSchema,
  DependencyGraphTextResponseSchema,
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
 * Scalar UI at `/docs`. The three discriminated response shapes are
 * declared together so the OpenAPI document advertises ALL of them under
 * the 200 status.
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
          // We expose a discriminated union under 200 — the active shape is
          // dictated by `?format=`. Zod's `z.discriminatedUnion` requires a
          // discriminator that is a literal/enum in every variant; we add a
          // `format` literal on each branch so consumers can narrow without
          // peeking at the other fields.
          200: z.union([
            DependencyGraphTreeResponseSchema.extend({
              format: z.literal('tree'),
            }),
            DependencyGraphGraphResponseSchema.extend({
              format: z.literal('graph'),
            }),
            DependencyGraphTextResponseSchema.extend({
              format: z.literal('text'),
            }),
          ]),
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
