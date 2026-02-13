# Phase 2: REST API - Research

**Researched:** 2026-02-13
**Domain:** REST API layer using Fastify, OpenAPI documentation, API key authentication, structured error handling
**Confidence:** MEDIUM-HIGH

## Summary

Phase 2 builds a REST API layer on top of the Phase 1 foundation using Fastify 5.7, the fastest Node.js web framework (76,000+ requests/sec). Fastify provides built-in JSON schema validation via type providers, plugin-based extensibility, and native Pino logging for structured JSON output.

The standard approach integrates Zod schemas from Phase 1 with Fastify's type system using fastify-type-provider-zod, which bridges Zod validation with Fastify's performance optimizations. OpenAPI specification is auto-generated from route definitions using @fastify/swagger + @fastify/swagger-ui, ensuring documentation stays synchronized with implementation.

Authentication uses API key validation via preHandler hooks, applied selectively to protected routes while leaving health checks public. Error handling maps Phase 1 custom errors (ValidationError, BusinessError, NotFoundError) to structured JSON responses with machine-readable error codes via Fastify's setErrorHandler.

Route organization follows plugin-based architecture with @fastify/autoload for file-based routing. The plugin system provides encapsulation (isolated contexts for decorators/hooks) and prevents tight coupling through directed acyclic graph (DAG) dependency management.

**Primary recommendation:** Use Fastify 5.7 with fastify-type-provider-zod for validation, @fastify/swagger for OpenAPI generation, preHandler hooks for authentication, setErrorHandler for error mapping, and @fastify/autoload for route organization. Enable Pino logger with custom serializers for request/response logging.

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| fastify | 5.7.4 | Web framework | Fastest Node.js framework (76k req/sec), schema-based validation, plugin architecture, built-in async/await support |
| @fastify/swagger | 8+ | OpenAPI generation | Official Fastify plugin, generates OpenAPI 3.x specs from route definitions, v8+ separates spec generation from UI |
| @fastify/swagger-ui | 5.2.5 | OpenAPI UI | Official Fastify plugin, serves interactive Swagger UI for API exploration |
| fastify-type-provider-zod | latest | Zod integration | Bridges Zod schemas with Fastify validation, enables type-safe routes, integrates with @fastify/swagger |
| @fastify/cors | latest | CORS handling | Official plugin, configurable origin validation, supports LAN development with regex/function patterns |
| @fastify/env | latest | Environment config | Official plugin, validates env vars with schemas, integrates with dotenv, type-safe configuration |
| pino | bundled | Logging | Default Fastify logger, JSON structured logs, fastest Node.js logger, production-ready |
| pino-pretty | latest (dev) | Dev logging | Human-readable log formatting for development, colorized output |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| @fastify/autoload | latest | File-based routing | Automatic route loading from directory structure, optional for larger APIs |
| @fastify/bearer-auth | latest | Bearer token auth | Alternative to API key auth if using JWT/OAuth |
| fastify-healthcheck | latest | Health endpoints | Kubernetes-ready /health endpoints, optional if custom implementation preferred |
| @fastify/response-validation | latest | Response validation | Validates responses match schema, useful for catching bugs, add in development |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| fastify-type-provider-zod | fastify-zod, fastify-zod-openapi | fastify-type-provider-zod is simpler for basic use cases; fastify-zod-openapi adds more OpenAPI customization |
| @fastify/swagger | fastify-openapi-docs, fastify-openapi-glue | @fastify/swagger is official and most widely used; alternatives offer different generation strategies |
| preHandler hook auth | @fastify/auth plugin | preHandler is simpler for basic auth; @fastify/auth enables complex multi-strategy authentication |

**Installation:**
```bash
pnpm add fastify @fastify/swagger @fastify/swagger-ui fastify-type-provider-zod @fastify/cors @fastify/env
pnpm add -D pino-pretty @types/node
```

## Architecture Patterns

### Recommended Project Structure
```
src/
├── api/
│   ├── routes/
│   │   ├── tasks/
│   │   │   ├── index.ts          # Task routes (CRUD endpoints)
│   │   │   └── schemas.ts        # Route-specific response schemas
│   │   ├── projects/
│   │   │   ├── index.ts          # Project routes
│   │   │   └── schemas.ts
│   │   └── health.ts             # Health check endpoint (no auth)
│   ├── plugins/
│   │   ├── auth.ts               # API key authentication plugin
│   │   ├── swagger.ts            # OpenAPI configuration plugin
│   │   └── cors.ts               # CORS configuration plugin
│   ├── hooks/
│   │   └── error-handler.ts     # Custom error handler (maps Phase 1 errors)
│   └── server.ts                 # Fastify instance creation and configuration
├── db/                            # (from Phase 1)
├── repositories/                  # (from Phase 1)
├── services/                      # (from Phase 1)
├── schemas/                       # (from Phase 1 - Zod schemas)
└── index.ts                       # Entry point (calls createApp + starts server)
```

### Pattern 1: Fastify Server Initialization with Zod Type Provider
**What:** Create Fastify instance with Zod type provider, Pino logger, and validation/serialization compilers
**When to use:** At application startup before registering routes
**Example:**
```typescript
// Source: https://github.com/turkerdev/fastify-type-provider-zod + https://fastify.dev/docs/latest/Reference/TypeScript/
import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  ZodTypeProvider
} from 'fastify-type-provider-zod';

export async function createServer() {
  const server = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info',
      transport: process.env.NODE_ENV === 'development'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
    },
  }).withTypeProvider<ZodTypeProvider>();

  // Set Zod as validator and serializer
  server.setValidatorCompiler(validatorCompiler);
  server.setSerializerCompiler(serializerCompiler);

  return server;
}
```

### Pattern 2: Route Definition with Zod Schema Validation
**What:** Define routes with Zod schemas for body, querystring, params, and response validation
**When to use:** All API endpoints - provides runtime validation and TypeScript inference
**Example:**
```typescript
// Source: https://github.com/turkerdev/fastify-type-provider-zod + https://fastify.dev/docs/latest/Reference/Routes/
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { CreateTaskSchema } from '../../../schemas/task.schema.js';

const TaskResponseSchema = z.object({
  id: z.number(),
  title: z.string(),
  description: z.string().nullable(),
  status: z.enum(['open', 'in_progress', 'done', 'closed', 'blocked']),
  priority: z.enum(['low', 'medium', 'high', 'urgent']),
  project_id: z.number(),
  assignee: z.string().nullable(),
  due_date: z.string().nullable(),
  created_by: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

const routes: FastifyPluginAsyncZod = async (fastify) => {
  // POST /tasks - Create new task
  fastify.post('/', {
    schema: {
      description: 'Create a new task',
      tags: ['tasks'],
      body: CreateTaskSchema,
      response: {
        201: TaskResponseSchema,
      },
    },
  }, async (request, reply) => {
    // request.body is typed as CreateTaskInput (from Zod inference)
    const task = fastify.taskService.createTask(request.body);
    return reply.code(201).send(task);
  });

  // GET /tasks/:id - Get task by ID
  fastify.get('/:id', {
    schema: {
      description: 'Get task by ID',
      tags: ['tasks'],
      params: z.object({
        id: z.coerce.number().int().positive(),
      }),
      response: {
        200: TaskResponseSchema,
      },
    },
  }, async (request, reply) => {
    // request.params.id is typed as number
    const task = fastify.taskService.getTask(request.params.id);
    return reply.send(task);
  });
};

export default routes;
```

### Pattern 3: OpenAPI Generation with @fastify/swagger
**What:** Auto-generate OpenAPI spec from Zod route schemas with Swagger UI
**When to use:** All Fastify applications - provides living documentation
**Example:**
```typescript
// Source: https://github.com/fastify/fastify-swagger + https://github.com/turkerdev/fastify-type-provider-zod
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUI from '@fastify/swagger-ui';
import {
  jsonSchemaTransform
} from 'fastify-type-provider-zod';

export async function registerSwagger(fastify: FastifyInstance) {
  // Register @fastify/swagger for spec generation
  await fastify.register(fastifySwagger, {
    openapi: {
      info: {
        title: 'Wood Fired Bugs API',
        description: 'Task management REST API',
        version: '1.0.0',
      },
      servers: [
        { url: 'http://localhost:3000', description: 'Development' },
      ],
      components: {
        securitySchemes: {
          apiKey: {
            type: 'apiKey',
            name: 'X-API-Key',
            in: 'header',
          },
        },
      },
      security: [{ apiKey: [] }],
    },
    transform: jsonSchemaTransform, // Transform Zod schemas to JSON Schema
  });

  // Register @fastify/swagger-ui for interactive UI
  await fastify.register(fastifySwaggerUI, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
    },
  });
}
```

### Pattern 4: API Key Authentication with preHandler Hook
**What:** Validate API key in request headers before route handler executes
**When to use:** All protected routes (exclude health checks)
**Example:**
```typescript
// Source: https://fastify.dev/docs/latest/Reference/Hooks/ + https://kevincunningham.co.uk/posts/protect-fastify-routes-with-authorization/
import { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';

const VALID_API_KEYS = new Set(
  (process.env.API_KEYS || '').split(',').filter(Boolean)
);

async function authenticateApiKey(
  request: FastifyRequest,
  reply: FastifyReply
) {
  const apiKey = request.headers['x-api-key'];

  if (!apiKey || typeof apiKey !== 'string') {
    return reply.code(401).send({
      error: 'UNAUTHORIZED',
      message: 'Missing API key',
    });
  }

  if (!VALID_API_KEYS.has(apiKey)) {
    return reply.code(401).send({
      error: 'UNAUTHORIZED',
      message: 'Invalid API key',
    });
  }
}

const authPlugin: FastifyPluginAsync = async (fastify) => {
  // Add preHandler hook to all routes in this scope
  fastify.addHook('preHandler', authenticateApiKey);
};

// Export as plugin with fastify-plugin to break encapsulation
// or use without fp() to apply only to specific route scopes
export default fp(authPlugin);
```

### Pattern 5: Custom Error Handler for Structured Responses
**What:** Map Phase 1 custom errors to structured JSON with machine-readable codes
**When to use:** Global error handler - maps all errors to consistent format
**Example:**
```typescript
// Source: https://fastify.dev/docs/latest/Reference/Errors/
import { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ValidationError, BusinessError, NotFoundError } from '../../services/errors.js';
import { ZodError } from 'zod';

export function errorHandler(
  error: FastifyError | Error,
  request: FastifyRequest,
  reply: FastifyReply
) {
  request.log.error(error);

  // Handle Zod validation errors
  if (error instanceof ZodError) {
    return reply.code(400).send({
      error: 'VALIDATION_ERROR',
      message: 'Request validation failed',
      details: error.errors.map(err => ({
        field: err.path.join('.'),
        message: err.message,
      })),
    });
  }

  // Handle Phase 1 ValidationError
  if (error instanceof ValidationError) {
    return reply.code(400).send({
      error: 'VALIDATION_ERROR',
      message: 'Validation failed',
      details: error.fieldErrors,
    });
  }

  // Handle Phase 1 NotFoundError
  if (error instanceof NotFoundError) {
    return reply.code(404).send({
      error: 'NOT_FOUND',
      message: error.message,
      details: {
        entity: error.entity,
        id: error.id,
      },
    });
  }

  // Handle Phase 1 BusinessError
  if (error instanceof BusinessError) {
    return reply.code(422).send({
      error: 'BUSINESS_RULE_VIOLATION',
      message: error.message,
    });
  }

  // Handle Fastify errors (e.g., FST_ERR_VALIDATION)
  if ('statusCode' in error) {
    return reply.code(error.statusCode || 500).send({
      error: error.code || 'INTERNAL_ERROR',
      message: error.message,
    });
  }

  // Unknown errors
  return reply.code(500).send({
    error: 'INTERNAL_ERROR',
    message: 'An unexpected error occurred',
  });
}
```

### Pattern 6: Health Check Endpoint (No Authentication)
**What:** Public endpoint reporting service status without authentication requirement
**When to use:** Required for Kubernetes liveness/readiness probes and monitoring
**Example:**
```typescript
// Source: https://docs.platformatic.dev/docs/guides/deployment/k8s-readiness-liveness + https://github.com/ducktors/arecibo
import { FastifyPluginAsync } from 'fastify';

const healthRoutes: FastifyPluginAsync = async (fastify) => {
  // Liveness probe - is the service running?
  fastify.get('/health/live', {
    schema: {
      description: 'Liveness probe',
      tags: ['health'],
      response: {
        200: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            timestamp: { type: 'string' },
          },
        },
      },
    },
  }, async (request, reply) => {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  });

  // Readiness probe - is the service ready to accept traffic?
  fastify.get('/health/ready', {
    schema: {
      description: 'Readiness probe',
      tags: ['health'],
      response: {
        200: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            timestamp: { type: 'string' },
            checks: { type: 'object' },
          },
        },
      },
    },
  }, async (request, reply) => {
    // Check database connectivity
    try {
      fastify.db.prepare('SELECT 1').get();
      return {
        status: 'ready',
        timestamp: new Date().toISOString(),
        checks: {
          database: 'ok',
        },
      };
    } catch (error) {
      return reply.code(503).send({
        status: 'not_ready',
        timestamp: new Date().toISOString(),
        checks: {
          database: 'failed',
        },
      });
    }
  });
};

export default healthRoutes;
```

### Pattern 7: CORS Configuration for LAN Development
**What:** Configure CORS to allow requests from LAN IP addresses during development
**When to use:** Development environment where clients may be on different machines
**Example:**
```typescript
// Source: https://github.com/fastify/fastify-cors + https://www.npmjs.com/package/@fastify/cors
import cors from '@fastify/cors';

export async function registerCors(fastify: FastifyInstance) {
  await fastify.register(cors, {
    origin: (origin, callback) => {
      // Allow requests with no origin (e.g., mobile apps, curl)
      if (!origin) {
        callback(null, true);
        return;
      }

      const hostname = new URL(origin).hostname;

      // Allow localhost and LAN addresses
      if (
        hostname === 'localhost' ||
        hostname === '127.0.0.1' ||
        /^192\.168\.\d{1,3}\.\d{1,3}$/.test(hostname) || // LAN
        /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname) // LAN
      ) {
        callback(null, true);
        return;
      }

      // Production: whitelist specific origins
      const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',');
      if (allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error('Not allowed by CORS'), false);
    },
    credentials: true,
  });
}
```

### Pattern 8: Plugin-Based Route Organization
**What:** Organize routes as plugins with encapsulation for isolated contexts
**When to use:** All route definitions - enables modular architecture
**Example:**
```typescript
// Source: https://fastify.dev/docs/latest/Reference/Plugins/ + https://nearform.com/digital-community/the-complete-guide-to-fastify-plugin-system/
import { FastifyPluginAsync } from 'fastify';

// api/routes/tasks/index.ts
const taskRoutes: FastifyPluginAsync = async (fastify, opts) => {
  // Routes registered here are scoped to /tasks prefix
  // if plugin is registered with prefix option

  fastify.post('/', async (request, reply) => {
    // POST /tasks
  });

  fastify.get('/:id', async (request, reply) => {
    // GET /tasks/:id
  });

  fastify.put('/:id', async (request, reply) => {
    // PUT /tasks/:id
  });

  fastify.delete('/:id', async (request, reply) => {
    // DELETE /tasks/:id
  });
};

export default taskRoutes;

// In server.ts
import taskRoutes from './routes/tasks/index.js';

await fastify.register(taskRoutes, { prefix: '/tasks' });
```

### Anti-Patterns to Avoid

- **Async functions in db.transaction() from Phase 1:** Fastify routes are async, but never use await inside db.transaction() - do DB work synchronously within transaction, await outside of it.
- **Deeply nested plugin registrations:** Creates hard-to-understand code and makes dependency injection difficult. Keep plugin hierarchy shallow (2-3 levels max).
- **Using origin: true in CORS for production:** Reflects any origin, bypasses CORS protection. Always use explicit allow-list in production.
- **Not breaking encapsulation for shared plugins:** Plugins like auth need fastify-plugin wrapper to be available across all routes, otherwise they're scoped only to child contexts.
- **Ignoring Fastify error codes:** Fastify errors have specific codes (FST_ERR_VALIDATION, etc.) - check error.code before generic fallback.
- **Mixing schema validation approaches:** Don't mix Fastify JSON Schema and Zod - choose one (Zod via type provider) for consistency.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| OpenAPI spec generation | Manually written OpenAPI YAML/JSON | @fastify/swagger with Zod transform | Specs drift from implementation. Auto-generation keeps docs synchronized, reduces errors, supports multiple OpenAPI versions. |
| Request/response logging | Custom middleware with console.log | Pino (built-in) with custom serializers | Production needs structured logs (JSON), request IDs, performance tracking, log levels. Pino is fastest, integrates with log aggregation tools. |
| Input validation | Manual type checks in route handlers | Zod schemas via fastify-type-provider-zod | Validation logic duplicated across routes, error messages inconsistent, no TypeScript inference. Type provider gives both runtime validation and compile-time types. |
| API key management | Custom header checking in each route | preHandler hooks or @fastify/auth plugin | Easy to forget auth on routes, inconsistent error responses, no centralized key management. Hooks apply automatically to all routes in scope. |
| CORS handling | Manual res.setHeader() calls | @fastify/cors plugin | CORS has complex preflight requirements, credential handling, wildcard origins. Plugin handles all edge cases correctly. |
| File-based routing | Custom route loader scripts | @fastify/autoload | Manual loaders miss edge cases (circular dependencies, load order). @fastify/autoload handles directory scanning, plugin registration, prefixes. |

**Key insight:** Fastify's plugin ecosystem provides battle-tested solutions optimized for performance. Custom implementations miss edge cases (preflight requests, log correlation, schema versioning) and sacrifice Fastify's performance optimizations (schema compilation, route matching).

## Common Pitfalls

### Pitfall 1: Plugin Encapsulation Breaking Shared State
**What goes wrong:** Authentication plugin registered but routes don't have access, decorators undefined in handlers
**Why it happens:** Fastify plugins create isolated contexts by default - decorators/hooks registered in plugin only available to children, not siblings or parents
**How to avoid:** Use fastify-plugin wrapper (fp()) for plugins that need to break encapsulation (auth, database connections, shared utilities). Don't use fp() for route plugins that should be isolated.
**Warning signs:** TypeError: fastify.someDecorator is not a function, hooks not firing on expected routes

**Source:** https://fastify.dev/docs/latest/Reference/Encapsulation/ + https://nearform.com/digital-community/the-complete-guide-to-fastify-plugin-system/

### Pitfall 2: Incorrect Error Status Codes
**What goes wrong:** Validation errors return 500, business errors return 400, NotFound returns 422
**Why it happens:** Developer doesn't map custom errors to correct HTTP status codes in error handler
**How to avoid:** Follow HTTP semantics: 400 for validation/malformed requests, 404 for not found, 422 for business rule violations, 500 only for unexpected errors. Use setErrorHandler to map error types to status codes.
**Warning signs:** APIs return 500 for validation failures, clients can't distinguish error types

**Source:** https://fastify.dev/docs/latest/Reference/Errors/

### Pitfall 3: Forgetting to Enable Pino Logging in Production
**What goes wrong:** No request/response logs in production, debugging impossible, no audit trail
**Why it happens:** Developer sets logger: false or doesn't configure logger, defaults to minimal logging
**How to avoid:** Always set logger: true minimum, configure log level via environment variable (info for production, debug for development). Use pino-pretty only in development (breaks structured JSON).
**Warning signs:** Empty logs in production, can't trace request flow, no error context

**Source:** https://fastify.dev/docs/latest/Reference/Logging/ + https://betterstack.com/community/guides/logging/how-to-install-setup-and-use-pino-to-log-node-js-applications/

### Pitfall 4: API Key Validation Applied to Health Checks
**What goes wrong:** Kubernetes health probes fail, monitoring tools can't check service status, 401 errors on /health
**Why it happens:** Auth plugin registered globally before health routes, or health routes inside auth scope
**How to avoid:** Register health routes at root level without auth plugin, or exclude health paths in auth hook. Health checks must be public for infrastructure monitoring.
**Warning signs:** Kubernetes shows pod as unhealthy, monitoring alerts for 401 on health endpoint

**Source:** https://docs.platformatic.dev/docs/guides/deployment/k8s-readiness-liveness

### Pitfall 5: Not Validating Response Schemas in Development
**What goes wrong:** API returns data that doesn't match OpenAPI spec, clients receive unexpected fields or types
**Why it happens:** Route handler returns data that doesn't match response schema, no validation enabled
**How to avoid:** Use @fastify/response-validation in development/testing to validate responses match schemas. Catches schema drift early before clients encounter issues.
**Warning signs:** OpenAPI spec shows field as required but API returns null, TypeScript types don't match runtime data

**Source:** https://www.npmjs.com/package/@fastify/response-validation

### Pitfall 6: Mixing Fastify Lifecycle with Phase 1 Synchronous Operations
**What goes wrong:** Route handlers block event loop, requests time out, poor performance under load
**Why it happens:** Phase 1 better-sqlite3 operations are synchronous, long queries block Fastify's async handlers
**How to avoid:** Accept that SQLite operations are synchronous - this is a design choice for simplicity. For long queries, consider: (1) optimize with indexes, (2) use query timeout, (3) if needed, wrap in worker threads (future phase). Most CRUD operations are <1ms, acceptable for single-user/small-team use.
**Warning signs:** Request timeouts under load, high event loop lag, blocking other requests

**Source:** https://github.com/WiseLibs/better-sqlite3 (synchronous API design)

## Code Examples

Verified patterns from official sources:

### Complete Server Setup with All Plugins
```typescript
// Source: https://github.com/turkerdev/fastify-type-provider-zod + https://fastify.dev/docs/latest/Reference/TypeScript/
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { createApp } from '../index.js'; // Phase 1 createApp
import { errorHandler } from './hooks/error-handler.js';
import { registerSwagger } from './plugins/swagger.js';
import { registerCors } from './plugins/cors.js';
import taskRoutes from './routes/tasks/index.js';
import projectRoutes from './routes/projects/index.js';
import healthRoutes from './routes/health.js';

export async function createServer() {
  // Initialize Phase 1 app (db + services)
  const app = await createApp();

  // Create Fastify server
  const server = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info',
      transport: process.env.NODE_ENV === 'development'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
    },
  }).withTypeProvider<ZodTypeProvider>();

  // Set Zod as validator and serializer
  server.setValidatorCompiler(validatorCompiler);
  server.setSerializerCompiler(serializerCompiler);

  // Register global error handler
  server.setErrorHandler(errorHandler);

  // Decorate server with Phase 1 services
  server.decorate('db', app.db);
  server.decorate('taskService', app.taskService);
  server.decorate('projectService', app.projectService);

  // Register plugins
  await registerCors(server);
  await registerSwagger(server);

  // Register health routes (no auth)
  await server.register(healthRoutes, { prefix: '/health' });

  // Register API routes (with auth plugin in scope)
  await server.register(async (fastify) => {
    // Auth plugin applies to all routes in this scope
    await fastify.register((await import('./plugins/auth.js')).default);

    // Register resource routes
    await fastify.register(taskRoutes, { prefix: '/tasks' });
    await fastify.register(projectRoutes, { prefix: '/projects' });
  }, { prefix: '/api/v1' });

  return { server, app };
}

// Start server
if (import.meta.url === `file://${process.argv[1]}`) {
  const { server } = await createServer();
  try {
    const address = await server.listen({
      port: parseInt(process.env.PORT || '3000'),
      host: process.env.HOST || '0.0.0.0',
    });
    server.log.info(`Server listening on ${address}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}
```

### Task CRUD Routes with Zod Integration
```typescript
// Source: https://github.com/turkerdev/fastify-type-provider-zod + Fastify docs
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  CreateTaskSchema,
  UpdateTaskSchema,
  TaskFiltersSchema
} from '../../../schemas/task.schema.js';

// Define response schemas (extend from Phase 1 types)
const TaskSchema = z.object({
  id: z.number(),
  title: z.string(),
  description: z.string().nullable(),
  status: z.enum(['open', 'in_progress', 'done', 'closed', 'blocked']),
  priority: z.enum(['low', 'medium', 'high', 'urgent']),
  project_id: z.number(),
  assignee: z.string().nullable(),
  due_date: z.string().nullable(),
  created_by: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

const ErrorSchema = z.object({
  error: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
});

const routes: FastifyPluginAsyncZod = async (fastify) => {
  // POST /tasks - Create task
  fastify.post('/', {
    schema: {
      description: 'Create a new task',
      tags: ['tasks'],
      body: CreateTaskSchema,
      response: {
        201: TaskSchema,
        400: ErrorSchema,
        422: ErrorSchema,
      },
    },
  }, async (request, reply) => {
    const task = fastify.taskService.createTask(request.body);
    return reply.code(201).send(task);
  });

  // GET /tasks - List tasks with filters
  fastify.get('/', {
    schema: {
      description: 'List tasks with optional filters',
      tags: ['tasks'],
      querystring: TaskFiltersSchema,
      response: {
        200: z.array(TaskSchema),
      },
    },
  }, async (request, reply) => {
    const tasks = fastify.taskService.listTasks(request.query);
    return reply.send(tasks);
  });

  // GET /tasks/:id - Get task
  fastify.get('/:id', {
    schema: {
      description: 'Get task by ID',
      tags: ['tasks'],
      params: z.object({
        id: z.coerce.number().int().positive(),
      }),
      response: {
        200: TaskSchema,
        404: ErrorSchema,
      },
    },
  }, async (request, reply) => {
    const task = fastify.taskService.getTask(request.params.id);
    return reply.send(task);
  });

  // PUT /tasks/:id - Update task
  fastify.put('/:id', {
    schema: {
      description: 'Update task',
      tags: ['tasks'],
      params: z.object({
        id: z.coerce.number().int().positive(),
      }),
      body: UpdateTaskSchema,
      response: {
        200: TaskSchema,
        400: ErrorSchema,
        404: ErrorSchema,
        422: ErrorSchema,
      },
    },
  }, async (request, reply) => {
    const task = fastify.taskService.updateTask(request.params.id, request.body);
    return reply.send(task);
  });

  // DELETE /tasks/:id - Delete task
  fastify.delete('/:id', {
    schema: {
      description: 'Delete task',
      tags: ['tasks'],
      params: z.object({
        id: z.coerce.number().int().positive(),
      }),
      response: {
        204: z.void(),
        404: ErrorSchema,
      },
    },
  }, async (request, reply) => {
    fastify.taskService.deleteTask(request.params.id);
    return reply.code(204).send();
  });
};

export default routes;
```

### Testing Fastify Routes with Vitest
```typescript
// Source: https://github.com/vitest-dev/vitest/blob/main/examples/fastify/test/app.test.ts + https://www.james-gardner.dev/posts/testing-fastify-apps/
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from '../../api/server.js';

describe('Task API', () => {
  let server: Awaited<ReturnType<typeof createServer>>['server'];
  let app: Awaited<ReturnType<typeof createServer>>['app'];

  beforeAll(async () => {
    // Create server with in-memory database
    process.env.DB_PATH = ':memory:';
    const result = await createServer();
    server = result.server;
    app = result.app;
  });

  afterAll(async () => {
    await server.close();
    app.db.close();
  });

  it('should create task', async () => {
    // Create project first
    const project = app.projectService.createProject({
      name: 'Test Project',
    });

    // Test task creation via HTTP
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      headers: {
        'x-api-key': 'test-key',
      },
      payload: {
        title: 'Test Task',
        project_id: project.id,
        created_by: 'test-user',
      },
    });

    expect(response.statusCode).toBe(201);
    const task = JSON.parse(response.payload);
    expect(task.title).toBe('Test Task');
    expect(task.status).toBe('open');
  });

  it('should return 401 without API key', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/tasks',
    });

    expect(response.statusCode).toBe(401);
    const error = JSON.parse(response.payload);
    expect(error.error).toBe('UNAUTHORIZED');
  });

  it('should return 400 for invalid input', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      headers: {
        'x-api-key': 'test-key',
      },
      payload: {
        title: '', // Invalid - empty string
      },
    });

    expect(response.statusCode).toBe(400);
    const error = JSON.parse(response.payload);
    expect(error.error).toBe('VALIDATION_ERROR');
  });
});
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Express.js | Fastify | 2016-2018 | 2-3x faster, native async/await, schema-based validation, plugin architecture instead of middleware |
| Manual JSON Schema | Zod with type providers | 2021-2023 | Type safety + runtime validation from single source, no schema/type drift |
| @fastify/swagger v7 | @fastify/swagger v8 + @fastify/swagger-ui | 2023 | Separation of concerns - spec generation vs UI serving, better OpenAPI 3.1 support |
| Manual route loading | @fastify/autoload | 2019 | File-based routing, automatic plugin registration, reduced boilerplate |
| Winston/Bunyan logging | Pino (built-in) | 2016 | Fastest Node.js logger (5-10x faster), structured JSON, request ID correlation |

**Deprecated/outdated:**
- **fastify-swagger@7.x:** Use @fastify/swagger@8+ with separate @fastify/swagger-ui
- **fastify-cors:** Use @fastify/cors (renamed with @ scope)
- **fastify-env:** Use @fastify/env (renamed with @ scope)
- **Manual JSON Schema in routes:** Use Zod with fastify-type-provider-zod for type safety
- **express-validator patterns:** Use Fastify's built-in validation with Zod schemas

## Open Questions

1. **API Key Storage and Management**
   - What we know: API keys validated from environment variable comma-separated list
   - What's unclear: Production-grade key storage (database, rotation, per-user keys)
   - Recommendation: Start with environment variable for v1 (simple, meets requirements). Add database-backed keys with rotation in Phase 3 if multi-user auth needed.

2. **Rate Limiting and Throttling**
   - What we know: Fastify has @fastify/rate-limit plugin
   - What's unclear: Whether rate limiting is required for LAN-only deployment
   - Recommendation: Not required for v1 (LAN deployment, trusted users). Add @fastify/rate-limit if exposed to internet or aggressive polling clients cause issues.

3. **Request Body Size Limits**
   - What we know: Fastify has bodyLimit option (default 1MB)
   - What's unclear: Whether task descriptions could exceed 1MB
   - Recommendation: Task descriptions limited to 5000 chars by schema (~5KB), default 1MB limit is sufficient. Monitor and adjust if needed.

4. **OpenAPI Spec Versioning**
   - What we know: @fastify/swagger supports OpenAPI 3.0 and 3.1
   - What's unclear: Which version to target
   - Recommendation: Use OpenAPI 3.1.0 (latest, better JSON Schema support, aligns with Zod transform). Most tools support 3.1 now.

## Sources

### Primary (HIGH confidence)
- Fastify official documentation: https://fastify.dev/docs/latest/
- fastify-type-provider-zod GitHub: https://github.com/turkerdev/fastify-type-provider-zod
- @fastify/swagger GitHub: https://github.com/fastify/fastify-swagger
- @fastify/swagger-ui GitHub: https://github.com/fastify/fastify-swagger-ui
- @fastify/cors GitHub: https://github.com/fastify/fastify-cors
- Fastify Hooks documentation: https://fastify.dev/docs/latest/Reference/Hooks/
- Fastify Errors documentation: https://fastify.dev/docs/latest/Reference/Errors/
- Fastify Plugins documentation: https://fastify.dev/docs/latest/Reference/Plugins/
- Fastify TypeScript documentation: https://fastify.dev/docs/latest/Reference/TypeScript/

### Secondary (MEDIUM confidence)
- [How To Generate an OpenAPI Spec With Fastify](https://www.speakeasy.com/openapi/frameworks/fastify) - OpenAPI generation patterns
- [The Complete Guide to the Fastify Plugin System](https://nearform.com/digital-community/the-complete-guide-to-fastify-plugin-system/) - Plugin architecture
- [Protect Fastify Routes with Authorization](https://kevincunningham.co.uk/posts/protect-fastify-routes-with-authorization/) - Authentication patterns
- [A Complete Guide to Pino Logging in Node.js](https://betterstack.com/community/guides/logging/how-to-install-setup-and-use-pino-to-log-node-js-applications/) - Pino configuration
- [Kubernetes Health Checks with Fastify](https://docs.platformatic.dev/docs/guides/deployment/k8s-readiness-liveness) - Health check patterns
- [Testing Fastify Apps Like a Boss](https://www.james-gardner.dev/posts/testing-fastify-apps/) - Testing strategies
- [Vitest Fastify Example](https://github.com/vitest-dev/vitest/blob/main/examples/fastify/test/app.test.ts) - Testing patterns
- [Fastify Adoption Guide](https://blog.logrocket.com/fastify-adoption-guide/) - Overview and patterns

### Tertiary (LOW confidence - marked for validation)
- Various Medium articles on Fastify patterns - general guidance, verify against official docs
- Community blog posts on API design - patterns only, verify implementation details

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - Fastify 5.7, @fastify/swagger, @fastify/cors are official and verified via npm/GitHub
- Zod integration: MEDIUM-HIGH - fastify-type-provider-zod verified via GitHub, patterns confirmed in examples
- Architecture patterns: MEDIUM-HIGH - Plugin system, hooks, error handling verified in official docs
- OpenAPI generation: HIGH - @fastify/swagger v8+ official plugin, documented transformation process
- Authentication: MEDIUM - preHandler hook pattern verified, but API key management is basic (env var only)
- Testing: MEDIUM - Vitest integration verified via examples, but project-specific patterns untested

**Research date:** 2026-02-13
**Valid until:** ~2026-03-13 (30 days - Fastify stable, plugin ecosystem mature, unlikely to change rapidly)
