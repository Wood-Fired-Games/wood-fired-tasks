import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  DependencyResponseSchema,
  DependencyListResponseSchema,
  CreateDependencyBodySchema,
} from './schemas.js';

const dependencyRoutes: FastifyPluginAsyncZod = async (fastify) => {
  // POST /tasks/:id/dependencies - Add dependency
  fastify.post(
    '/:id/dependencies',
    {
      schema: {
        params: z.object({ id: z.coerce.number().int().positive() }),
        body: CreateDependencyBodySchema,
        response: {
          201: DependencyResponseSchema,
        },
        tags: ['dependencies'],
        description: 'Add a dependency relationship (this task blocks another task)',
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { blocks_task_id } = request.body;

      const dependency = fastify.dependencyService.addDependency({
        task_id: id,
        blocks_task_id,
      });

      return reply.code(201).send(dependency);
    },
  );

  // GET /tasks/:id/dependencies - Get dependencies for a task
  fastify.get(
    '/:id/dependencies',
    {
      schema: {
        params: z.object({ id: z.coerce.number().int().positive() }),
        response: {
          200: DependencyListResponseSchema,
        },
        tags: ['dependencies'],
        description: 'Get all dependencies for a task (tasks it blocks and tasks that block it)',
      },
    },
    async (request, reply) => {
      const { id } = request.params;

      const blocks = fastify.dependencyService.getBlockedBy(id);
      const blocked_by = fastify.dependencyService.getBlockers(id);

      return reply.send({ blocks, blocked_by });
    },
  );

  // DELETE /tasks/:id/dependencies/:blocksTaskId - Remove dependency
  fastify.delete(
    '/:id/dependencies/:blocksTaskId',
    {
      schema: {
        params: z.object({
          id: z.coerce.number().int().positive(),
          blocksTaskId: z.coerce.number().int().positive(),
        }),
        response: {
          204: z.void(),
        },
        tags: ['dependencies'],
        description: 'Remove a dependency relationship',
      },
    },
    async (request, reply) => {
      const { id, blocksTaskId } = request.params;

      fastify.dependencyService.removeDependency(id, blocksTaskId);

      return reply.code(204).send();
    },
  );
};

export default dependencyRoutes;
