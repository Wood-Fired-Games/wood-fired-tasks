# Phase 17: Core Reliability Fundamentals - Research

**Researched:** 2026-02-17
**Domain:** Node.js Service Reliability (Fastify, Pino, better-sqlite3)
**Confidence:** HIGH

## Summary

This research covers the implementation of core reliability features for the Wood Fired Bugs service, including structured logging with Pino redaction, health checks with database verification, graceful shutdown with connection cleanup, timeout configuration, startup validation with Zod, SQLite WAL checkpointing, and standard exit codes.

The service already uses Fastify v5.7.4 with built-in Pino logging, better-sqlite3 for database access, and has a basic health endpoint. This research identifies the specific patterns needed to enhance these existing foundations to meet production reliability standards.

**Primary recommendation:** Use Fastify's built-in Pino configuration for structured JSON logging with redaction, implement `forceCloseConnections: 'idle'` for graceful shutdown, use Zod schemas for fail-fast configuration validation at startup, and follow sysexits.h conventions for CLI exit codes.

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| RELI-01 | Service emits structured JSON logs with NODE_ENV handling and Pino redaction | Fastify built-in Pino supports redaction via `redact.paths` and `redact.censor` |
| RELI-02 | Health check endpoint verifies DB connectivity with SELECT 1 | Already implemented; enhance to report component status |
| RELI-03 | Graceful shutdown closes idle connections with forceCloseConnections: 'idle' | Fastify supports `forceCloseConnections` option; requires Node.js >= 18.2.0 for 'idle' mode |
| RELI-04 | Connection timeouts configured (connectionTimeout, requestTimeout, keepAliveTimeout) | Fastify supports all three timeout options at server creation |
| RELI-06 | Configuration validation at startup fails fast on missing/bad environment variables | Zod schemas with `.safeParse()` or `.parse()` provide clear error messages |
| RELI-07 | Periodic WAL checkpoint prevents WAL file bloat | better-sqlite3 supports `db.pragma('wal_checkpoint(TRUNCATE)')` |
| RELI-08 | Exit codes follow sysexits.h standard (0=success, 1=general error, 2=misuse) | Use constants: EX_OK=0, EX_USAGE=64, EX_CONFIG=78, EX_SOFTWARE=70 |

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Fastify | ^5.7.4 | Web framework with built-in logging | Industry standard for Node.js APIs; Pino built-in |
| Pino | (bundled with Fastify) | Structured JSON logging | Fastest Node.js logger; redaction built-in |
| better-sqlite3 | ^12.6.2 | SQLite driver | Synchronous, fast; supports PRAGMA wal_checkpoint |
| Zod | ^4.3.6 | Schema validation | TypeScript-first; transform support for env vars |

### Configuration

| Option | Default | Recommended | Purpose |
|--------|---------|-------------|---------|
| forceCloseConnections | false | 'idle' | Close idle connections on shutdown |
| connectionTimeout | 0 (no timeout) | 120000 (2 min) | Socket inactivity timeout |
| requestTimeout | 0 (no limit) | 60000 (1 min) | Max time for entire request |
| keepAliveTimeout | 72000 (72s) | 10000 (10s) | Idle keep-alive timeout |

## Architecture Patterns

### Pattern 1: Structured Logging with Redaction

**What:** Configure Pino redaction to automatically censor sensitive fields in production logs
**When to use:** All production deployments with NODE_ENV=production

**Example:**
```typescript
// Source: Fastify docs + Pino redaction patterns
const server = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || 'info',
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-api-key"]',
        '*.apiKey',
        '*.password',
        '*.secret'
      ],
      censor: '[REDACTED]'
    },
    // Pretty print only in development
    transport: process.env.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined
  }
});
```

### Pattern 2: Configuration Validation with Zod

**What:** Define a Zod schema for environment variables and validate at startup
**When to use:** All server startup scenarios to fail fast on misconfiguration

**Example:**
```typescript
// Source: Zod best practices 2025
import { z } from 'zod';

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().transform((v) => parseInt(v, 10)).default('3000'),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  API_KEYS: z.string().min(1, 'API_KEYS is required for authentication'),
  DATABASE_PATH: z.string().default('./data/tasks.db'),
  // Connection timeouts
  CONNECTION_TIMEOUT: z.string().transform((v) => parseInt(v, 10)).default('120000'),
  REQUEST_TIMEOUT: z.string().transform((v) => parseInt(v, 10)).default('60000'),
  KEEP_ALIVE_TIMEOUT: z.string().transform((v) => parseInt(v, 10)).default('10000'),
});

// Validate and export
const result = configSchema.safeParse(process.env);
if (!result.success) {
  console.error('Configuration error:');
  result.error.errors.forEach((err) => {
    console.error(`  - ${err.path.join('.')}: ${err.message}`);
  });
  process.exit(78); // EX_CONFIG
}
export const config = result.data;
```

### Pattern 3: Graceful Shutdown with WAL Checkpoint

**What:** On SIGTERM/SIGINT, close idle connections, checkpoint WAL, then exit
**When to use:** All production server processes

**Example:**
```typescript
// Source: Fastify graceful shutdown patterns + better-sqlite3 WAL
const shutdown = async (signal: string) => {
  server.log.info({ signal }, 'Received shutdown signal, starting graceful shutdown');

  try {
    // Stop accepting new connections, close idle ones
    await server.close();

    // Checkpoint WAL to prevent file bloat
    app.db.pragma('wal_checkpoint(TRUNCATE)');
    server.log.info('WAL checkpoint completed');

    // Close database connection
    app.db.close();

    server.log.info('Shutdown complete');
    process.exit(0); // EX_OK
  } catch (error) {
    server.log.fatal({ error }, 'Error during shutdown');
    process.exit(70); // EX_SOFTWARE
  }
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
```

### Pattern 4: Periodic WAL Checkpoint

**What:** Schedule periodic WAL checkpoints to prevent unbounded WAL file growth
**When to use:** Long-running services with frequent writes

**Example:**
```typescript
// Run checkpoint every 15 minutes
const CHECKPOINT_INTERVAL = 15 * 60 * 1000;

const checkpointInterval = setInterval(() => {
  try {
    const result = db.pragma('wal_checkpoint(TRUNCATE)', { simple: true });
    server.log.debug({ checkpointResult: result }, 'Periodic WAL checkpoint completed');
  } catch (error) {
    server.log.error({ error }, 'WAL checkpoint failed');
  }
}, CHECKPOINT_INTERVAL);

// Cleanup on server close
server.addHook('onClose', async () => {
  clearInterval(checkpointInterval);
});
```

### Pattern 5: Health Check with Component Status

**What:** Enhance existing health endpoint to report detailed component status
**When to use:** Container orchestration health probes, monitoring

**Example:**
```typescript
// Source: Fastify health check patterns
fastify.get('/health', async (request, reply) => {
  const timestamp = new Date().toISOString();
  const checks = {
    database: 'unknown',
    eventBus: 'unknown',
    sseManager: 'unknown'
  };
  let isHealthy = true;

  // Database check
  try {
    fastify.db.prepare('SELECT 1').get();
    checks.database = 'ok';
  } catch (err) {
    checks.database = 'failed';
    isHealthy = false;
  }

  // Component checks
  checks.eventBus = eventBus.isActive() ? 'ok' : 'degraded';
  checks.sseManager = sseManager.isHealthy() ? 'ok' : 'degraded';

  const response = {
    status: isHealthy ? 'healthy' : 'unhealthy',
    timestamp,
    version: '1.0.0',
    checks
  };

  return reply.code(isHealthy ? 200 : 503).send(response);
});
```

### Anti-Patterns to Avoid

- **Don't use `process.exit()` directly in async contexts:** Set `process.exitCode` instead to allow async cleanup to complete
- **Don't configure Pino redaction in code that runs before Fastify:** Configure it in the Fastify logger option
- **Don't ignore Zod validation errors:** Always provide clear error messages and exit with appropriate codes
- **Don't use PASSIVE checkpoint mode for space reclamation:** Use TRUNCATE to actually reclaim disk space

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| JSON logging | Custom logger wrapper | Fastify's built-in Pino | Pino is fastest; redaction built-in; ecosystem compatible |
| Config validation | Manual if/else checks | Zod schema validation | Type inference; clear errors; transforms built-in |
| Health check framework | Custom HTTP endpoint | Fastify route with schema | Native Fastify validation; auto-generated OpenAPI |
| Connection timeout handling | Custom middleware | Fastify server options | Native Node.js HTTP server timeout support |
| CLI exit codes | Magic numbers | sysexits.h constants | Self-documenting; shell scripting compatible |

**Key insight:** Fastify + Pino already provide most reliability primitives. Focus on configuration and orchestration, not custom implementations.

## Common Pitfalls

### Pitfall 1: Redaction Path Syntax Errors

**What goes wrong:** Pino redaction paths are case-sensitive and use dot notation. Using wrong case or bracket syntax causes sensitive data to leak.
**Why it happens:** HTTP headers are lowercase in Node.js, but documentation often shows Title-Case.
**How to avoid:** Always use lowercase for headers: `req.headers.authorization`, `req.headers["x-api-key"]`
**Warning signs:** Logs showing API keys or tokens in production

### Pitfall 2: `forceCloseConnections: 'idle'` Requires Node.js >= 18.2.0

**What goes wrong:** Using `'idle'` on older Node.js throws `FST_ERR_FORCE_CLOSE_CONNECTIONS_IDLE_NOT_AVAILABLE`
**Why it happens:** The `closeIdleConnections()` method was added in Node.js 18.2.0
**How to avoid:** Check Node.js version or use `forceCloseConnections: true` as fallback
**Warning signs:** Shutdown errors mentioning idle connections

### Pitfall 3: Zod Transform Failures on Empty Strings

**What goes wrong:** Environment variables are always strings. Empty strings pass `z.string()` but fail transforms.
**Why it happens:** `PORT=` in .env creates empty string, not undefined.
**How to avoid:** Use `.optional()` or `.default()` before transforms, or validate non-empty: `z.string().min(1).transform(...)`
**Warning signs:** `NaN` values after transform, or parse errors on startup

### Pitfall 4: WAL Checkpoint Blocks Writers

**What goes wrong:** `wal_checkpoint(TRUNCATE)` blocks database writers during the operation.
**Why it happens:** TRUNCATE mode requires exclusive access to checkpoint and truncate.
**How to avoid:** Schedule checkpoints during low-traffic periods, or use PASSIVE mode if blocking is unacceptable.
**Warning signs:** Request timeouts during checkpoint, slow responses

### Pitfall 5: Setting exitCode Doesn't Immediately Exit

**What goes wrong:** Setting `process.exitCode = 1` then continuing execution doesn't exit immediately.
**Why it happens:** Node.js exits naturally at end of event loop, not when exitCode is set.
**How to avoid:** Return from function after setting exitCode; don't execute further code.
**Warning signs:** Exit code appears correct but logs show continued execution

## Code Examples

### Complete Server Configuration with Reliability Features

```typescript
// Source: Fastify docs + best practices
import Fastify from 'fastify';
import { z } from 'zod';

// Configuration schema
const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().transform(Number).default('3000'),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  CONNECTION_TIMEOUT: z.string().transform(Number).default('120000'),
  REQUEST_TIMEOUT: z.string().transform(Number).default('60000'),
  KEEP_ALIVE_TIMEOUT: z.string().transform(Number).default('10000'),
});

const config = configSchema.parse(process.env);

// Create server with reliability configurations
const server = Fastify({
  // Timeouts
  connectionTimeout: config.CONNECTION_TIMEOUT,
  requestTimeout: config.REQUEST_TIMEOUT,
  keepAliveTimeout: config.KEEP_ALIVE_TIMEOUT,

  // Graceful shutdown
  forceCloseConnections: 'idle',

  // Logging with redaction
  logger: {
    level: config.LOG_LEVEL,
    redact: config.NODE_ENV === 'production' ? {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-api-key"]',
        '*.password',
        '*.secret',
        '*.apiKey'
      ],
      censor: '[REDACTED]'
    } : undefined,
    transport: config.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined
  }
});

// Graceful shutdown handler
const shutdown = async (signal: string) => {
  server.log.info({ signal }, 'Shutting down gracefully');
  await server.close();
  // WAL checkpoint performed in onClose hook
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
```

### Exit Codes Module

```typescript
// Source: sysexits.h standard
export const ExitCodes = {
  EX_OK: 0,           // Success
  EX_USAGE: 64,       // Command line usage error
  EX_DATAERR: 65,     // Data format error
  EX_NOINPUT: 66,     // Cannot open input
  EX_UNAVAILABLE: 69, // Service unavailable
  EX_SOFTWARE: 70,    // Internal software error
  EX_OSERR: 71,       // System error
  EX_CANTCREAT: 73,   // Cannot create output file
  EX_IOERR: 74,       // I/O error
  EX_TEMPFAIL: 75,    // Temporary failure
  EX_PROTOCOL: 76,    // Remote error in protocol
  EX_NOPERM: 77,      // Permission denied
  EX_CONFIG: 78,      // Configuration error
} as const;

// Simplified for CLI
export const CliExitCodes = {
  SUCCESS: 0,
  GENERAL_ERROR: 1,
  USAGE_ERROR: 2,     // Most common for CLI arg errors
  CONFIG_ERROR: 78,
} as const;
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Custom logger (Winston) | Pino (via Fastify) | 2020+ | 5x faster; structured JSON by default |
| Manual env var parsing | Zod schema validation | 2022+ | Type safety; clear errors; transforms |
| `forceCloseConnections: true` | `forceCloseConnections: 'idle'` | Fastify 4.x | Closes only inactive connections; graceful |
| `process.exit(1)` | `process.exitCode = 1` | 2020+ | Allows async cleanup; prevents truncation |
| SQLite journal_mode = DELETE | journal_mode = WAL | 2010+ | Better concurrency; requires checkpointing |

## Open Questions

1. **Checkpoint Frequency**
   - What we know: Should checkpoint periodically to prevent WAL bloat
   - What's unclear: Optimal frequency depends on write volume
   - Recommendation: Start with 15 minutes, make configurable

2. **Timeout Values**
   - What we know: Need timeouts to prevent hung requests
   - What's unclear: Service-specific appropriate values
   - Recommendation: Use defaults; override via env vars

3. **Health Check Component Granularity**
   - What we know: Should report component status
   - What's unclear: How many components to track
   - Recommendation: Database, EventBus, SSEManager for now

## Sources

### Primary (HIGH confidence)
- [Fastify Server Configuration](https://fastify.dev/docs/latest/Reference/Server/) - timeout options, forceCloseConnections
- [Pino Redaction Documentation](https://github.com/pinojs/pino/blob/main/docs/redaction.md) - redact configuration
- [better-sqlite3 WAL Checkpoint](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md#pragmastring-options---return) - pragma method
- [SQLite VACUUM INTO](https://sqlite.org/lang_vacuum.html) - backup syntax

### Secondary (MEDIUM confidence)
- [Fastify HTTP Timeout Handling Guide](https://nearform.com/digital-community/handling-http-timeouts-in-fastify/) - timeout configuration patterns
- [Node.js Best Practices: Pino Redaction](https://blog.lepape.me/nodejs-best-practices-redacting-secrets-from-pino-logs/) - redaction patterns
- [SQLite WAL Checkpoint Modes](https://www.jvt.me/posts/2025/07/29/sqlite-wal-sync/) - checkpoint behavior
- [Zod Best Practices 2025](https://javascript.plainenglish.io/9-best-practices-for-using-zod-in-2025-31ee7418062e) - configuration validation

### Tertiary (LOW confidence)
- [sysexits.h Documentation](https://man7.org/linux/man-pages/man3/sysexits.h.3head.html) - exit code definitions
- [Fastify Graceful Shutdown Issue](https://github.com/fastify/fastify/issues/3852) - forceCloseConnections behavior

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - Fastify, Pino, Zod are well-documented and stable
- Architecture patterns: HIGH - Based on official documentation and verified examples
- Pitfalls: MEDIUM-HIGH - Some from community experience, verified against docs

**Research date:** 2026-02-17
**Valid until:** 2026-05-17 (90 days for stable stack)

---

## RESEARCH COMPLETE

**Phase:** 17 - Core Reliability Fundamentals
**Confidence:** HIGH

### Key Findings
1. Fastify's built-in Pino supports structured JSON logging with redaction via `redact.paths` and `redact.censor`
2. `forceCloseConnections: 'idle'` requires Node.js >= 18.2.0 and closes only inactive connections during shutdown
3. Zod schemas with `.transform()` are ideal for environment variable validation with type conversion
4. better-sqlite3's `db.pragma('wal_checkpoint(TRUNCATE)')` is the recommended approach for WAL management
5. sysexits.h defines standard codes: 0=success, 64=usage error, 70=software error, 78=config error
6. Current codebase already has basic health endpoint and graceful shutdown; needs enhancement for full compliance

### File Created
`.planning/phases/17-core-reliability-fundamentals/17-RESEARCH.md`

### Confidence Assessment
| Area | Level | Reason |
|------|-------|--------|
| Standard Stack | HIGH | Fastify v5, Pino, Zod are mature with stable APIs |
| Architecture Patterns | HIGH | Official docs verified with code examples |
| Pitfalls | MEDIUM-HIGH | Community patterns verified against official sources |

### Open Questions
- Optimal WAL checkpoint frequency (recommend making configurable)
- Timeout values for specific service characteristics (recommend defaults with env override)

### Ready for Planning
Research complete. Planner can now create PLAN.md files for Phase 17 requirements RELI-01 through RELI-08.
