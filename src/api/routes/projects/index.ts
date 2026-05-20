import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { CreateProjectSchema } from '../../../schemas/task.schema.js';
import {
  ProjectResponseSchema,
  ProjectListPaginatedResponseSchema,
} from './schemas.js';

// Pagination query schema for GET /projects. Mirrors task list bounds.
const QueryProjectListSchema = z.object({
  limit: z.coerce.number().int().positive().max(500).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
});

const projectRoutes: FastifyPluginAsyncZod = async (fastify) => {
  // POST / - Create project
  fastify.post(
    '/',
    {
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
    }
  );

  // GET / - List projects (paginated)
  // BREAKING vs. pre-pagination clients that consumed the bare array — CLI
  // and MCP layers handle the envelope; bare-array shim retained in CLI for
  // older servers.
  fastify.get(
    '/',
    {
      schema: {
        tags: ['projects'],
        description:
          'List projects (paginated). Returns `{ data, total, limit, offset }`.',
        querystring: QueryProjectListSchema,
        response: {
          200: ProjectListPaginatedResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const result = fastify.projectService.listProjectsPaginated(request.query);
      return reply.send(result);
    }
  );

  // GET /:id - Get project by ID
  fastify.get(
    '/:id',
    {
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
    }
  );

  // PUT /:id - Update project
  fastify.put(
    '/:id',
    {
      schema: {
        tags: ['projects'],
        description: 'Update project by ID',
        params: z.object({ id: z.coerce.number().int().positive() }),
        body: CreateProjectSchema.partial(),
        response: {
          200: ProjectResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const project = fastify.projectService.updateProject(request.params.id, request.body);
      return reply.send(project);
    }
  );

  // DELETE /:id - Delete project
  fastify.delete(
    '/:id',
    {
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
    }
  );
};

export default projectRoutes;
