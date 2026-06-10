import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ErrorResponseSchema } from '../tasks/schemas.js';
import { PipelineRoleSchema } from '../../../schemas/model-policy.schema.js';

/**
 * Configurable Task Models (Task #926) — GET /api/v1/projects/:id/resolve-model
 *
 * Exposes `ModelPolicyService.resolveModel(projectId, role, taskId?)` over REST
 * so the remote MCP proxy (`src/mcp/remote/register-tools.ts`) can offer a
 * `resolve_model` tool with byte-for-byte the same input/output contract as the
 * stdio MCP server's `resolve_model` (`src/mcp/tools/model-tools.ts`). Before
 * this route there was a `GET /models` and `GET|PUT /settings/model-policy`
 * (task #922) but NO REST surface for the resolver itself, so the remote proxy
 * had nothing to call.
 *
 * The 200 body IS the resolver output VERBATIM — exactly the shape the stdio
 * `resolve_model` tool emits as `structuredContent`:
 *   - `{ model: string }`  — a concrete model id (or `{ model: 'auto' }`).
 *   - `null`               — "inherit the session model" (no policy resolves).
 *
 * Resolution is NOT reimplemented here; the route delegates to the injected
 * `fastify.modelPolicyService.resolveModel`, the SAME service the stdio server
 * wires in-process (project policy ?? global default, per-slot merge, jobSize→
 * category routing when `task_id` is supplied).
 *
 * Project-existence is enforced by the resolver itself (task #928): a missing
 * project throws NotFoundError → 404 ProblemDetails (mirrors the sibling
 * `/:id/topology` and `/:id/dependency-graph` routes), so an unknown project
 * never resolves to the global default (or null) silently. The route carries
 * no separate pre-fetch guard (task #931): the resolver's single project
 * fetch doubles as the 404 check. The resolver also validates `task_id`: a
 * nonexistent one throws NotFoundError (→ 404) and one belonging to a
 * different project throws ValidationError (→ 400), so size-routing can never
 * silently use a foreign task's jobSize.
 *
 * Auth: inherits the standard projects-route auth chain (the parent
 * `projectRoutes` plugin is mounted inside the `/api/v1` scope that wires
 * `authPlugin`). No custom guard here.
 */

/** The resolver output envelope — `{ model }` or a bare `null` (inherit). */
const ResolveModelResponseSchema = z.object({ model: z.string() }).nullable();

const resolveModelRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    '/:id/resolve-model',
    {
      schema: {
        tags: ['projects'],
        description:
          'Resolve the model for a pipeline role (execution|validation|planning) ' +
          'for a project, optionally task-scoped (`task_id`) for jobSize→category ' +
          'routing. Returns `{ model }` (a concrete id or "auto") or `null` ' +
          '(inherit the session model) — identical to the stdio `resolve_model` ' +
          'MCP tool output. Read-only.',
        params: z.object({ id: z.coerce.number().int().positive() }),
        querystring: z.object({
          role: PipelineRoleSchema,
          task_id: z.coerce.number().int().positive().optional(),
        }),
        response: {
          200: ResolveModelResponseSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      // Existence guard → 404 on a missing project: since task #928 the
      // resolver itself throws NotFoundError (mapped to the 404
      // ProblemDetails by the error handler), so the former
      // `projectService.getProject` pre-fetch here was a redundant second
      // fetch + full inflation of the same row (task #931 — one shared fetch).
      const resolved = fastify.modelPolicyService.resolveModel(
        request.params.id,
        request.query.role,
        request.query.task_id,
      );
      // `resolved` is `{ model } | { model: 'auto' } | null` — sent verbatim so
      // the remote MCP tool is transport-indistinguishable from the stdio one.
      return reply.send(resolved);
    },
  );
};

export default resolveModelRoutes;
