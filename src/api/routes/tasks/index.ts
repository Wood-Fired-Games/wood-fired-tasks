import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { CreateTaskSchema, UpdateTaskSchema } from '../../../schemas/task.schema.js';
import { TaskResponseSchema, TaskListResponseSchema, ErrorResponseSchema } from './schemas.js';
import { TASK_STATUSES } from '../../../types/task.js';

// Query parameter schema for task filters (uses coercion for URL params)
const QueryTaskFiltersSchema = z.object({
  project_id: z.coerce.number().int().positive(),
  status: z.enum(TASK_STATUSES),
  assignee: z.string(),
  tags: z.string().transform((s) => s.split(',')),
  due_before: z.string().datetime(),
  due_after: z.string().datetime(),
  search: z.string().min(1).max(200),
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
};

export default taskRoutes;
