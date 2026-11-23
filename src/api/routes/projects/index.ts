import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  ArchivedFilterSchema,
  ArchiveProjectSchema,
  CreateProjectSchema,
  UpdateProjectSchema,
} from '../../../schemas/task.schema.js';
import { requireUser } from '../../plugins/auth/index.js';
import {
  ErrorResponseSchema,
  ProjectResponseSchema,
  ProjectListPaginatedResponseSchema,
  UnarchiveProjectResponseSchema,
} from './schemas.js';
import dependencyGraphRoutes from './dependency-graph.js';
import topologyRoutes from './topology.js';
import resolveModelRoutes from './resolve-model.js';
import projectWsjfRoutes from './wsjf.js';

// Pagination query schema for GET /projects. Mirrors task list bounds.
const QueryProjectListSchema = z.object({
  limit: z.coerce.number().int().positive().max(500).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
  // Archived project state (design §2.5): archived projects are omitted
  // unless asked for. `total` counts the filtered set.
  archived: ArchivedFilterSchema,
});

const projectRoutes: FastifyPluginAsyncZod = async (fastify) => {
  // POST / - Create project
  fastify.post(
    '/',
    {
      // Security Audit finding M1 (task #1622): mutation → `write` tier.
      config: { requiredScope: 'write' },
      schema: {
        tags: ['projects'],
        description: 'Create a new project',
        body: CreateProjectSchema,
        response: {
          201: ProjectResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const project = fastify.projectService.createProject(request.body);
      return reply.code(201).send(project);
    },
  );

  // GET / - List projects (paginated)
  // BREAKING vs. pre-pagination clients that consumed the bare array — CLI
  // and MCP layers handle the envelope; bare-array shim retained in CLI for
  // older servers.
  fastify.get(
    '/',
    {
      // Security Audit finding M1 (task #1622): GET-shaped read → `read` tier.
      config: { requiredScope: 'read' },
      schema: {
        tags: ['projects'],
        description: 'List projects (paginated). Returns `{ data, total, limit, offset }`.',
        querystring: QueryProjectListSchema,
        response: {
          200: ProjectListPaginatedResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const result = fastify.projectService.listProjectsPaginated(request.query);
      return reply.send(result);
    },
  );

  // POST /:id/archive - Archive a project (Archived project state, §2.2/§2.6)
  fastify.post(
    '/:id/archive',
    {
      // `write`, like update: archiving destroys nothing and is reversible.
      config: { requiredScope: 'write' },
      schema: {
        tags: ['projects'],
        description:
          'Archive a project: it leaves default listings and becomes read-only. ' +
          'Refused with 422 `project_has_unfinished_tasks` while any task is open, ' +
          'in_progress, blocked or backlogged, unless `force: true` with a `reason`. ' +
          'Archiving an already archived project returns it unchanged.',
        params: z.object({ id: z.coerce.number().int().positive() }),
        body: ArchiveProjectSchema.nullish(),
        response: {
          200: ProjectResponseSchema,
          400: ErrorResponseSchema.describe(
            'Invalid id or body; `force: true` without a `reason` opens its message with ' +
              '`archive_reason_required`.',
          ),
          404: ErrorResponseSchema.describe('No project with this id.'),
          422: ErrorResponseSchema.describe(
            'The project has unfinished tasks (`project_has_unfinished_tasks`); `details` ' +
              'carries `code`, `total` and `counts` per status.',
          ),
        },
      },
    },
    async (request, reply) => {
      // archived_by is the authenticated caller, never a body field.
      const project = fastify.projectService.archiveProject(
        request.params.id,
        request.body ?? {},
        requireUser(request).displayName,
      );
      return reply.send(project);
    },
  );

  // POST /:id/unarchive - Return an archived project to normal use
  fastify.post(
    '/:id/unarchive',
    {
      config: { requiredScope: 'write' },
      schema: {
        tags: ['projects'],
        description:
          'Unarchive a project; the project is then re-evaluated once. Unarchiving a project ' +
          'that is not archived returns it unchanged and does not run the re-evaluation again: ' +
          'it only retries tasks whose re-evaluation failed earlier in this server process, or ' +
          'finishes a pass that an earlier error left unfinished. Nothing is remembered across a ' +
          'restart. `reevaluation_failed_task_ids` names the tasks whose re-evaluation rolled ' +
          'back (empty on a clean pass).',
        params: z.object({ id: z.coerce.number().int().positive() }),
        response: {
          200: UnarchiveProjectResponseSchema,
          400: ErrorResponseSchema.describe('Invalid id.'),
          404: ErrorResponseSchema.describe('No project with this id.'),
        },
      },
    },
    async (request, reply) => {
      const { project, reevaluationFailedTaskIds } = fastify.projectService.unarchiveProject(
        request.params.id,
        requireUser(request).displayName,
      );
      return reply.send({ ...project, reevaluation_failed_task_ids: reevaluationFailedTaskIds });
    },
  );

  // GET /:id - Get project by ID
  fastify.get(
    '/:id',
    {
      // Security Audit finding M1 (task #1622): GET-shaped read → `read` tier.
      config: { requiredScope: 'read' },
      schema: {
        tags: ['projects'],
        description: 'Get project by ID',
        params: z.object({ id: z.coerce.number().int().positive() }),
        response: {
          200: ProjectResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const project = fastify.projectService.getProject(request.params.id);
      return reply.send(project);
    },
  );

  // PUT /:id - Update project
  fastify.put(
    '/:id',
    {
      // Security Audit finding M1 (task #1622): mutation → `write` tier.
      config: { requiredScope: 'write' },
      schema: {
        tags: ['projects'],
        description: 'Update project by ID',
        params: z.object({ id: z.coerce.number().int().positive() }),
        body: UpdateProjectSchema,
        response: {
          200: ProjectResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const project = fastify.projectService.updateProject(request.params.id, request.body);
      return reply.send(project);
    },
  );

  // GET /:id/dependency-graph — task #342, dashboard tree-view backend.
  // Registered as a child plugin so the colocated `schema:` block stays in
  // its own file (the projects barrel was getting busy).
  await fastify.register(dependencyGraphRoutes);

  // GET /:id/topology — topology classifier over REST, backing the remote
  // MCP `topology_check` proxy tool. Registered as a child plugin alongside
  // dependency-graph so its colocated `schema:` block lives in its own file.
  await fastify.register(topologyRoutes);

  // GET /:id/resolve-model — model-policy resolver over REST (task #926),
  // backing the remote MCP `resolve_model` proxy tool. Registered as a child
  // plugin alongside topology so its colocated `schema:` block lives in its
  // own file.
  await fastify.register(resolveModelRoutes);

  // WSJF 4.5 (#645): GET /:id/charter-history + GET /:id/rescore-runs.
  // Registered as a child plugin alongside topology so its colocated `schema:`
  // blocks live in their own file.
  await fastify.register(projectWsjfRoutes);

  // DELETE /:id - Delete project
  fastify.delete(
    '/:id',
    {
      // Security Audit finding M1 (task #1622): mutation → `write` tier.
      config: { requiredScope: 'write' },
      schema: {
        tags: ['projects'],
        description: 'Delete project by ID',
        params: z.object({ id: z.coerce.number().int().positive() }),
        response: {
          204: z.null().describe('No content'),
        },
      },
    },
    async (request, reply) => {
      fastify.projectService.deleteProject(request.params.id);
      return reply.code(204).send(null);
    },
  );
};

export default projectRoutes;
