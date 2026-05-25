import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { TopologyReportSchema } from '../../../schemas/topology.schema.js';
import { ErrorResponseSchema } from '../tasks/schemas.js';

/**
 * Wave 4.1 follow-up — GET /api/v1/projects/:id/topology
 *
 * Exposes `TopologyService.classify(projectId)` over REST so the remote
 * MCP proxy (`src/mcp/remote/register-tools.ts`) can offer a `topology_check`
 * tool with byte-for-byte the same input/output contract as the stdio MCP
 * server's `topology_check` (`src/mcp/tools/topology-tools.ts`). Before this
 * route, remote-MCP users had no topology tool — the stdio server constructs
 * a TopologyService but the REST-backed proxy never did.
 *
 * The 200 body IS the `TopologyReport` (topology, edges, roots, leaves,
 * advisory) — identical to the stdio tool's `structuredContent` and the
 * `tasks topology` CLI JSON output. Classification is NOT reimplemented here;
 * the route delegates to `fastify.topologyService.classify`.
 *
 * Project-existence is enforced explicitly so a missing project yields a
 * 404 ProblemDetails (the classifier itself treats an unknown project as a
 * vacuously-FLAT empty graph). This mirrors the 404 contract of the sibling
 * `/:id/dependency-graph` route.
 *
 * Auth: inherits the standard projects-route auth chain (the parent
 * `projectRoutes` plugin is mounted inside the `/api/v1` scope that wires
 * `authPlugin`). No custom guard here.
 */
const topologyRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    '/:id/topology',
    {
      schema: {
        tags: ['projects'],
        description:
          'Classify a project as FLAT (parallelizable, /tasks:loop), DAG ' +
          '(wave-by-wave parallel dispatch, /tasks:loop-dag), or DAG_CYCLIC ' +
          '(BLOCKED) based on its task_dependencies graph. Returns topology, ' +
          'edges, roots, leaves, and an execution advisory.',
        params: z.object({ id: z.coerce.number().int().positive() }),
        response: {
          200: TopologyReportSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      // Existence guard → 404 on a missing project. getProject throws
      // NotFoundError, mapped to the 404 ProblemDetails by the error handler.
      fastify.projectService.getProject(request.params.id);
      const report = fastify.topologyService.classify(request.params.id);
      return reply.send(report);
    },
  );
};

export default topologyRoutes;
