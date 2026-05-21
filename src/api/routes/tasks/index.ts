import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { CreateTaskSchema, UpdateTaskSchema } from '../../../schemas/task.schema.js';
import { idempotencyKeyHeaderSchema } from '../../../schemas/idempotency.schema.js';
import {
  TaskResponseSchema,
  TaskListPaginatedResponseSchema,
  ErrorResponseSchema,
  ClaimRequestSchema,
  ClaimResponseSchema,
  ConflictResponseSchema,
  CompletionReportQuerySchema,
  CompletionReportResponseSchema,
} from './schemas.js';
import { TASK_STATUSES } from '../../../types/task.js';
import { BusinessError } from '../../../services/errors.js';

// Query parameter schema for task filters (uses coercion for URL params).
// `limit`/`offset` bound the result set so a 100k-row table cannot DoS the
// server via GROUP_CONCAT materialization on every list call. Defaults are
// applied if omitted; `limit` is capped at 500 to keep payload + query cost
// predictable across all callers.
const QueryTaskFiltersSchema = z.object({
  project_id: z.coerce.number().int().positive().optional(),
  status: z.enum(TASK_STATUSES).optional(),
  assignee: z.string().optional(),
  tags: z.string().transform((s) => s.split(',')).optional(),
  due_before: z.string().datetime().optional(),
  due_after: z.string().datetime().optional(),
  updated_before: z.string().datetime().optional(),
  updated_after: z.string().datetime().optional(),
  search: z
    .string()
    .min(1)
    .max(200)
    .refine(
      (s) => s.trim().split(/\s+/).filter(Boolean).length <= 32,
      { message: 'Search query must contain at most 32 terms.' }
    )
    .optional(),
  limit: z.coerce.number().int().positive().max(500).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
});

// Subtask list query - only pagination (no filters; parent_id is in the path).
const QuerySubtasksSchema = z.object({
  limit: z.coerce.number().int().positive().max(500).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
});

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

  // GET / - List/filter tasks (paginated)
  // Response shape: `{ data, total, limit, offset }` — see
  // TaskListPaginatedResponseSchema. BREAKING vs. pre-pagination clients
  // that consumed the bare array — coordinated with CLI/MCP shims.
  fastify.get(
    '/',
    {
      schema: {
        tags: ['tasks'],
        description:
          'List tasks with optional filters (paginated). Returns ' +
          '`{ data, total, limit, offset }` — `limit` defaults to 50, max 500.',
        querystring: QueryTaskFiltersSchema,
        response: {
          200: TaskListPaginatedResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const result = fastify.taskService.listTasksPaginated(request.query);
      return reply.send(result);
    }
  );

  // GET /completion-report - Completion report (must be declared before
  // GET /:id so the static path beats the dynamic id matcher).
  // task #245: parity with local MCP `completion_report` tool — exposes
  // the same TaskService.getCompletionReport output over REST so the
  // remote MCP server can wrap it.
  fastify.get(
    '/completion-report',
    {
      schema: {
        tags: ['tasks'],
        description:
          'Dashboard report of tasks completed (status=done) in a time interval. ' +
          'Provide either `days` (trailing window, 1-365) or both `start` and `end` ' +
          'ISO8601 timestamps. Optional `project_id` and `assignee` filters narrow ' +
          'the result set. Returns per-task rows plus aggregates by project, ' +
          'assignee, priority, and daily throughput.',
        querystring: CompletionReportQuerySchema,
        response: {
          200: CompletionReportResponseSchema,
          400: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const report = fastify.taskService.getCompletionReport(request.query);
      return reply.send(report);
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
          400: ErrorResponseSchema,
          409: ConflictResponseSchema,
        },
      },
    },
    async (request, reply) => {
      // Validate idempotency key header BEFORE touching the DB.
      // Bounds row size and charset to prevent unbounded `idempotency_keys` growth.
      const rawIdempotencyKey = request.headers['x-idempotency-key'];
      let idempotencyKey: string | undefined;
      if (rawIdempotencyKey !== undefined) {
        // Fastify may pass duplicate headers as an array; reject ambiguity.
        if (typeof rawIdempotencyKey !== 'string') {
          return reply.code(400).send({
            error: 'VALIDATION_ERROR',
            message: 'X-Idempotency-Key header must be a single value',
          });
        }
        const parsed = idempotencyKeyHeaderSchema.safeParse(rawIdempotencyKey);
        if (!parsed.success) {
          return reply.code(400).send({
            error: 'VALIDATION_ERROR',
            message: 'Invalid X-Idempotency-Key header',
            details: parsed.error.flatten().formErrors,
          });
        }
        idempotencyKey = parsed.data;
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

  // GET /:id/subtasks - Get subtasks of a task (paginated)
  fastify.get(
    '/:id/subtasks',
    {
      schema: {
        tags: ['tasks'],
        description:
          'Get subtasks (children) of a task (paginated). Returns ' +
          '`{ data, total, limit, offset }`.',
        params: z.object({ id: z.coerce.number().int().positive() }),
        querystring: QuerySubtasksSchema,
        response: {
          200: TaskListPaginatedResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const result = fastify.taskService.getSubtasksPaginated(
        request.params.id,
        request.query
      );
      return reply.send(result);
    }
  );
};

export default taskRoutes;
