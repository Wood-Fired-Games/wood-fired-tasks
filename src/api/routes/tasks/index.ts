import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { CreateTaskSchema, UpdateTaskSchema } from '../../../schemas/task.schema.js';
import {
  TaskResponseSchema,
  TaskListResponseSchema,
  ErrorResponseSchema,
  ClaimRequestSchema,
  ClaimResponseSchema,
  ConflictResponseSchema,
} from './schemas.js';
import { TASK_STATUSES } from '../../../types/task.js';
import { BusinessError } from '../../../services/errors.js';

// Query parameter schema for task filters (uses coercion for URL params)
const QueryTaskFiltersSchema = z.object({
  project_id: z.coerce.number().int().positive(),
  status: z.enum(TASK_STATUSES),
  assignee: z.string(),
  tags: z.string().transform((s) => s.split(',')),
  due_before: z.string().datetime(),
  due_after: z.string().datetime(),
  updated_before: z.string().datetime(),
  updated_after: z.string().datetime(),
  search: z
    .string()
    .min(1)
    .max(200)
    .refine(
      (s) => s.trim().split(/\s+/).filter(Boolean).length <= 32,
      { message: 'Search query must contain at most 32 terms.' }
    ),
}).partial();

const taskRoutes: FastifyPluginAsyncZod = async (fastify) => {
  // POST / - Create task
  fastify.post(
    '/',
    {
      schema: {
        tags: ['tasks'],
        description: 'Create a new task',
        body: CreateTaskSchema,
        response: {
          201: TaskResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const task = fastify.taskService.createTask(request.body);
      return reply.code(201).send(task);
    }
  );

  // GET / - List/filter tasks
  fastify.get(
    '/',
    {
      schema: {
        tags: ['tasks'],
        description: 'List tasks with optional filters',
        querystring: QueryTaskFiltersSchema,
        response: {
          200: TaskListResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const tasks = fastify.taskService.listTasks(request.query);
      return reply.send(tasks);
    }
  );

  // GET /:id - Get task by ID
  fastify.get(
    '/:id',
    {
      schema: {
        tags: ['tasks'],
        description: 'Get task by ID',
        params: z.object({ id: z.coerce.number().int().positive() }),
        response: {
          200: TaskResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const task = fastify.taskService.getTask(request.params.id);
      return reply.send(task);
    }
  );

  // PUT /:id - Update task
  fastify.put(
    '/:id',
    {
      schema: {
        tags: ['tasks'],
        description: 'Update task by ID',
        params: z.object({ id: z.coerce.number().int().positive() }),
        body: UpdateTaskSchema,
        response: {
          200: TaskResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const task = fastify.taskService.updateTask(request.params.id, request.body);
      return reply.send(task);
    }
  );

  // DELETE /:id - Delete task
  fastify.delete(
    '/:id',
    {
      schema: {
        tags: ['tasks'],
        description: 'Delete task by ID',
        params: z.object({ id: z.coerce.number().int().positive() }),
        response: {
          204: z.null().describe('No content'),
        },
      },
    },
    async (request, reply) => {
      fastify.taskService.deleteTask(request.params.id);
      return reply.code(204).send(null);
    }
  );

  // POST /:id/claim - Claim task atomically
  fastify.post(
    '/:id/claim',
    {
      schema: {
        tags: ['tasks'],
        description: 'Atomically claim an unassigned task',
        params: z.object({ id: z.coerce.number().int().positive() }),
        body: ClaimRequestSchema,
        response: {
          200: ClaimResponseSchema,
          409: ConflictResponseSchema,
        },
      },
    },
    async (request, reply) => {
      // Check idempotency key
      const idempotencyKey = request.headers['x-idempotency-key'] as string | undefined;
      if (idempotencyKey) {
        const cached = fastify.idempotencyService.get(idempotencyKey);
        if (cached) {
          return reply.code(200).send(cached as z.infer<typeof ClaimResponseSchema>);
        }
      }

      try {
        // Determine source from request header or default to 'user'
        const source = (request.headers['x-claim-source'] as 'user' | 'workflow') || 'user';
        const task = fastify.taskService.claimTask(request.params.id, request.body.assignee, source);

        // Cache response if idempotency key provided
        if (idempotencyKey) {
          fastify.idempotencyService.set(idempotencyKey, task);
        }

        return reply.code(200).send(task);
      } catch (error) {
        if (error instanceof BusinessError) {
          return reply.code(409).send({
            error: 'CONFLICT' as const,
            message: error.message,
          });
        }
        throw error; // Let error handler deal with NotFoundError, etc.
      }
    }
  );

  // GET /:id/subtasks - Get subtasks of a task
  fastify.get(
    '/:id/subtasks',
    {
      schema: {
        tags: ['tasks'],
        description: 'Get all subtasks (children) of a task',
        params: z.object({ id: z.coerce.number().int().positive() }),
        response: {
          200: TaskListResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const subtasks = fastify.taskService.getSubtasks(request.params.id);
      return reply.send(subtasks);
    }
  );
};

export default taskRoutes;
