# Phase 19: Observability - Research

**Researched:** 2026-02-17
**Domain:** Diagnostics, request tracing, event replay, statistics (Node.js, Fastify, better-sqlite3, Commander.js)
**Confidence:** HIGH

## Summary

Phase 19 adds five observability features: two diagnostic CLI commands (`tasks doctor`, `tasks db-check`), one statistics command (`tasks stats`), request ID propagation across REST/MCP/CLI layers, and reducing the SSE replay buffer from 1000 to 100 events. All features use the existing stack — no new production dependencies are required.

The three CLI commands (`doctor`, `stats`, `db-check`) follow the same direct-DB pattern established in Phase 18's `tasks backup` command: they open the SQLite file directly using better-sqlite3 without going through the REST API. This is appropriate because they are diagnostic read-only operations that need to work even when the API server is down. The `doctor` command additionally uses Node.js built-in `fs.statfs` (available since Node 18.4.0, confirmed on Node 22.22.0 in this environment) for disk space checking — no external package needed.

Request ID propagation requires two changes: (1) configure Fastify's `genReqId` to emit UUID v4 (via `crypto.randomUUID()` — already used in `events.ts`) and add an `onSend` hook that stamps `X-Request-ID` on every REST response; (2) thread the request ID through the MCP and CLI layers by passing it as a log field. The MCP server runs in stdio transport with no HTTP context, so MCP tracing is limited to adding a per-tool `requestId` field in structured log output, not a header. The SSE event buffer change is a single-line parameter tweak in `SSEManager` — confirmed: 100 events at typical payload size is ~44 KB, well within acceptable memory.

**Primary recommendation:** All five requirements are purely additive; zero new npm packages needed. Implement all three CLI commands as direct-DB commands (matching `backup.ts` pattern), configure Fastify request ID with UUID + `onSend` hook, and reduce SSE buffer size to 100 in `SSEManager` constructor default.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| OBSV-01 | `tasks doctor` command performs self-service diagnostics (DB connectivity, disk space, config validity) | Direct-DB CLI pattern confirmed (Phase 18 backup). `fs.statfs` available in Node 22. Config validity = read `.env` + validate via Zod schema already in `src/config/env.ts` |
| OBSV-02 | Request ID propagated across REST API, MCP, and CLI layers | Fastify `genReqId` + `onSend` hook confirmed working. MCP uses stdio (no HTTP headers); tracing via structured log fields. CLI is a fetch-based client that can read `X-Request-ID` from REST responses |
| OBSV-03 | Event replay buffer (last 100 events in-memory) enables SSE resilience for disconnected clients | SSEManager already implements Last-Event-ID replay. Buffer currently 1000; change to 100. 100 events ~44 KB confirmed. `replayEvents()` already in place |
| OBSV-04 | `tasks stats` command displays task statistics (counts by status, recent activity, agent productivity) | Direct-DB SQL queries verified: `GROUP BY status`, `updated_at >= datetime('now', '-7 days')` with assignee grouping. All data in existing schema |
| OBSV-05 | `tasks db-check` command runs `PRAGMA integrity_check` for proactive corruption detection | `db.pragma('integrity_check')` confirmed returns `[{"integrity_check":"ok"}]` on healthy DB. better-sqlite3 `pragma()` method handles it natively |
</phase_requirements>

## Standard Stack

### Core (all already installed)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| better-sqlite3 | ^12.6.2 | Direct DB access for diagnostic commands | Already the project's SQLite driver; `pragma()` method covers PRAGMA integrity_check |
| Commander.js | ^14.0.3 | CLI command framework | Already used for all CLI commands; `backupCommand` is the template to follow |
| Fastify | ^5.7.4 | Web framework; `genReqId` + `onSend` hook for request ID | Built-in support; `request.id` exposed on all request objects |
| Node.js crypto | built-in | UUID v4 generation | `randomUUID()` already used in `src/api/routes/events.ts` |
| Node.js fs | built-in | `fs.statfs` for disk space checking | Available since Node 18.4.0; confirmed working on Node 22.22.0 |
| Zod | ^4.3.6 | Config validation for `doctor` command | `configSchema` already in `src/config/env.ts`; reuse it for `.env` validation check |
| chalk | ^4.1.2 | Terminal output formatting | Already used in `backup.ts` and other commands |

### No New Production Dependencies

This phase requires **zero new npm packages**. All required capabilities are covered by installed libraries and Node.js built-ins.

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `fs.statfs` (built-in) | `check-disk-space` npm | `check-disk-space` has 1.8M weekly downloads but last published 3 years ago; `fs.statfs` is native and requires no dependency |
| `crypto.randomUUID()` (built-in) | `hyperid` or `uuid` npm | `hyperid` is faster but an extra dependency; `randomUUID()` is standard since Node 15 and already in use in this codebase |
| Direct-DB CLI commands | REST API calls | Doctor/stats/db-check must work when the API server is down — direct-DB is the correct architecture |

## Architecture Patterns

### Recommended New File Structure

```
src/
├── cli/
│   └── commands/
│       ├── doctor.ts        # NEW: OBSV-01 — DB connectivity, disk space, config validity
│       ├── stats.ts         # NEW: OBSV-04 — task counts, recent activity, agent productivity
│       └── db-check.ts      # NEW: OBSV-05 — PRAGMA integrity_check
└── api/
    └── server.ts            # MODIFY: add genReqId + onSend hook for X-Request-ID
```

The SSE buffer change is a one-line edit in `src/events/sse-manager.ts`.

### Pattern 1: Direct-DB CLI Diagnostic Command

**What:** CLI commands that open the SQLite file directly with better-sqlite3, without going through the REST API.

**When to use:** Diagnostic operations that must work even when the API server is unavailable.

**Template (from Phase 18 backup.ts):**
```typescript
// src/cli/commands/doctor.ts (and stats.ts, db-check.ts)
import { Command } from 'commander';
import Database from 'better-sqlite3';
import { existsSync } from 'fs';
import chalk from 'chalk';
import { jsonOutput } from '../output/json-output.js';
import '../config/env.js';  // load .env

export const doctorCommand = new Command('doctor')
  .description('Run self-service diagnostics')
  .action(async () => {
    const dbPath = process.env.DATABASE_PATH || './data/tasks.db';
    const program = doctorCommand.parent;
    const isJsonMode = program?.optsWithGlobals()?.json || false;

    if (!existsSync(dbPath)) {
      console.error(chalk.red(`Database not found at ${dbPath}`));
      process.exitCode = 1;
      return;
    }

    const db = new Database(dbPath, { readonly: true });
    try {
      // ... diagnostics ...
    } finally {
      db.close();
    }
  });
```

### Pattern 2: Fastify Request ID with UUID

**What:** Generate UUID v4 request IDs, attach to Pino logs automatically (Fastify does this), and expose in `X-Request-ID` response header.

**When to use:** All REST API requests.

**Key configuration for `src/api/server.ts`:**
```typescript
import { randomUUID } from 'crypto';

const server = Fastify({
  genReqId: () => randomUUID(),  // Replace default integer ID with UUID
  requestIdHeader: false,        // Don't trust caller-supplied IDs (security)
  logger: {
    name: 'wood-fired-bugs',
    // Pino automatically logs request.id as 'reqId' field
    ...
  },
}).withTypeProvider<ZodTypeProvider>();

// Stamp X-Request-ID on every response
server.addHook('onSend', async (request, reply) => {
  reply.header('X-Request-ID', request.id);
});
```

**Confirmed working:** Verified via Fastify inject test — `request.id` matches `X-Request-ID` response header exactly.

**Security note:** `requestIdHeader: false` (keep disabled) prevents callers from injecting arbitrary request IDs, which could corrupt log correlation.

### Pattern 3: MCP Request Tracing

**What:** MCP tools run in stdio transport — no HTTP headers available. Tracing is via structured log output.

**When to use:** All MCP tool invocations.

**Pattern:**
```typescript
// In each MCP tool handler (task-tools.ts, project-tools.ts, etc.)
// Generate a per-invocation trace ID at the start of each tool call
import { randomUUID } from 'crypto';

server.registerTool('create_task', { ... }, async (args) => {
  const traceId = randomUUID();
  console.error(JSON.stringify({ level: 'info', traceId, tool: 'create_task', event: 'start' }));
  try {
    // ... operation ...
    console.error(JSON.stringify({ level: 'info', traceId, tool: 'create_task', event: 'success' }));
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', traceId, tool: 'create_task', event: 'error', err }));
    throw err;
  }
});
```

**Alternative (simpler):** Only add tracing to the health tool and key operations, not all 26 tools. This avoids a large blast radius refactor.

**Recommendation for OBSV-02:** The requirement says request IDs are "visible in logs/responses." For MCP, acceptable delivery is: (1) REST layer: `X-Request-ID` response header + Pino log field; (2) CLI layer: CLI can log the `X-Request-ID` from the REST response when `--json` or verbose mode is used; (3) MCP layer: generate per-tool traceId logged to stderr. Full AsyncLocalStorage context propagation across all three layers is out of scope for this phase.

### Pattern 4: SSE Buffer Size Reduction

**What:** Change `SSEManager` constructor default from 1000 to 100 events.

**Memory analysis:**
- Typical event payload: ~455 bytes (measured against real task data)
- 100 events: ~44 KB — negligible
- 1000 events: ~444 KB — also fine, but requirement specifies 100

**Change:** One line in `src/events/sse-manager.ts`:
```typescript
// Before:
constructor(
  private readonly maxBufferSize = 1000,

// After:
constructor(
  private readonly maxBufferSize = 100,
```

**No API change needed:** `SSEManager.addConnection()` already calls `replayEvents()` when `lastEventId` is provided. The `replayEvents()` method already works correctly. The only change is the buffer ceiling.

### Pattern 5: Disk Space Check via `fs.statfs`

**What:** Use Node.js built-in `fs.statfs()` (available since Node 18.4.0) to check available disk space for the database directory.

**When to use:** `tasks doctor` command.

```typescript
import { promisify } from 'util';
import { statfs, existsSync } from 'fs';
import { dirname } from 'path';

const statfsAsync = promisify(statfs);

async function checkDiskSpace(dbPath: string): Promise<{ free: number; total: number }> {
  const dir = dirname(dbPath);
  const stats = await statfsAsync(dir);
  return {
    free: stats.bavail * stats.bsize,   // Available to non-root
    total: stats.blocks * stats.bsize,
  };
}
```

**Confirmed working on Node 22.22.0** — returns `{ bavail, bsize, blocks, ... }`.

### Pattern 6: Stats Queries

**What:** Direct SQLite queries for task counts, recent activity, and agent productivity.

**Verified queries:**
```sql
-- Task counts by status
SELECT status, COUNT(*) as count
FROM tasks
GROUP BY status
ORDER BY status;

-- Recent activity (created in last 24h)
SELECT COUNT(*) as count
FROM tasks
WHERE created_at >= datetime('now', '-24 hours');

-- Agent productivity (last 7 days)
SELECT assignee,
       COUNT(*) as task_count,
       SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as completed,
       SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress
FROM tasks
WHERE assignee IS NOT NULL
  AND updated_at >= datetime('now', '-7 days')
GROUP BY assignee
ORDER BY task_count DESC;
```

**All verified working** against the live `tasks.db`.

### Pattern 7: `doctor` Command Config Validity Check

**What:** The `doctor` command should validate that the required environment variables are present without starting the full server.

**Pattern:**
```typescript
import { configSchema } from '../../config/env.js';  // Reuse existing Zod schema

function checkConfigValidity(): { valid: boolean; errors: string[] } {
  const result = configSchema.safeParse(process.env);
  if (result.success) return { valid: true, errors: [] };
  return {
    valid: false,
    errors: result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`),
  };
}
```

**Note:** The `doctor` CLI command does NOT need `API_KEY` (the server's `API_KEYS`) — it is a direct-DB diagnostic command like `backup`. But it should validate the server's required config (from `src/config/env.ts`) as a separate check, reading the `.env` file and reporting which vars are missing/invalid.

### Pattern 8: PRAGMA integrity_check

**What:** Run SQLite's built-in integrity checker via better-sqlite3.

```typescript
const db = new Database(dbPath, { readonly: true });
try {
  const results = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
  const passed = results.length === 1 && results[0].integrity_check === 'ok';
  // ...
} finally {
  db.close();
}
```

**Confirmed working:** Returns `[{"integrity_check":"ok"}]` on healthy database.

**Note on `quick_check`:** `PRAGMA quick_check` is faster (skips some cross-reference checks) and also available via `db.pragma('quick_check')`. The requirement specifies `integrity_check`; implement it exactly as specified.

**Timing concern:** On very large databases, `integrity_check` can be slow. For this project's scale, it is not a concern. If the DB grows large, add a `--quick` flag in a future phase.

### Anti-Patterns to Avoid

- **Making `doctor`/`stats`/`db-check` call the REST API:** These are diagnostic commands. They must work when the server is down. Use direct-DB.
- **Trusting `requestIdHeader`:** Disabled by default. Do not enable it — allows caller ID injection.
- **Adding AsyncLocalStorage for MCP tracing:** Overcomplicated for this requirement. Generate per-tool traceId locally.
- **Importing `src/config/env.ts` config object in CLI commands:** The CLI config (`src/cli/config/env.ts`) validates `API_KEY` and `API_BASE_URL`. The server config (`src/config/env.ts`) validates `API_KEYS`, `DATABASE_PATH`, etc. Doctor needs to check the server config, not the CLI config.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Disk space checking | Custom C++ binding or exec(df) | `fs.statfs` (Node built-in) | Available since Node 18.4.0, zero dependency, cross-platform |
| UUID generation | Custom ID generator | `crypto.randomUUID()` (Node built-in) | Already used in this codebase; standards-compliant UUIDv4 |
| SQLite corruption check | Custom file-scanning logic | `db.pragma('integrity_check')` | SQLite's own checker; handles WAL, btree validation, all edge cases |
| Request ID storage/propagation | AsyncLocalStorage context threading | Fastify `request.id` + `onSend` hook | Fastify already tracks request ID through the full lifecycle; hook stamps it on response |

**Key insight:** All four problems in this phase have solved, built-in solutions. The implementation work is about wiring them together, not building the primitives.

## Common Pitfalls

### Pitfall 1: Opening DB in Write Mode for Diagnostic Commands
**What goes wrong:** Opening the database in the default (read-write) mode for `doctor`, `stats`, and `db-check` commands may conflict with a running API server's WAL lock.
**Why it happens:** WAL mode allows concurrent reads but still has write conflicts. `integrity_check` does not need write access.
**How to avoid:** Always open the database with `{ readonly: true }` for diagnostic CLI commands, exactly as `backup.ts` does.
**Warning signs:** `SQLITE_BUSY` or `SQLITE_LOCKED` errors when the server is running.

### Pitfall 2: Blocking on `integrity_check` for Large Databases
**What goes wrong:** `PRAGMA integrity_check` reads every page in the database and can take several seconds on large databases.
**Why it happens:** Full integrity check is O(n) with database size.
**How to avoid:** For now, accept this limitation — the database is small (144 KB measured). Add a progress indicator or timeout consideration in a future phase if needed.
**Warning signs:** `db-check` appears to hang.

### Pitfall 3: Config Validity Check Triggering `process.exit()`
**What goes wrong:** Importing `src/config/env.ts` directly in the CLI `doctor` command will call `process.exit(78)` on validation failure, preventing the doctor command from reporting the issue gracefully.
**Why it happens:** `loadConfig()` in `src/config/env.ts` calls `process.exit()` when not in test mode.
**How to avoid:** Use `configSchema.safeParse(process.env)` directly — do NOT call `loadConfig()` or import the `config` proxy. Import only `configSchema` from `src/config/env.ts`.
**Warning signs:** `tasks doctor` exits with code 78 instead of reporting config errors.

### Pitfall 4: SSE Buffer Change Breaking Existing Tests
**What goes wrong:** If tests create `SSEManager` with default constructor and rely on the old 1000-event capacity, changing the default to 100 might break tests that send more than 100 events.
**Why it happens:** Tests may not explicitly set `maxBufferSize`.
**How to avoid:** Check `src/events/__tests__/` for tests that send > 100 events before making the change. The existing test suite has 598 tests — run them after the change.
**Warning signs:** SSE-related tests fail after the buffer change.

### Pitfall 5: `X-Request-ID` on SSE Responses
**What goes wrong:** The `onSend` hook fires for SSE streams too. SSE connections are long-lived; the hook sets the header on the initial upgrade response, which is correct.
**Why it happens:** SSE connections go through Fastify's normal request lifecycle.
**How to avoid:** No special handling needed. The header will be set correctly on the SSE connection establishment response.

## Code Examples

Verified patterns from official sources and codebase testing:

### PRAGMA integrity_check (verified against live DB)
```typescript
// Source: better-sqlite3 docs + verified in Node.js REPL
import Database from 'better-sqlite3';

const db = new Database(dbPath, { readonly: true });
try {
  const results = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
  const passed = results.length === 1 && results[0].integrity_check === 'ok';
  const message = passed ? 'ok' : results.map(r => r.integrity_check).join('\n');
  return { passed, message };
} finally {
  db.close();
}
```

### Fastify genReqId + onSend hook (verified via inject test)
```typescript
// Source: Fastify docs + local verification
import { randomUUID } from 'crypto';

const server = Fastify({
  genReqId: () => randomUUID(),  // UUID v4 for all requests
  requestIdHeader: false,        // Security: don't trust caller IDs
  logger: { ... },
}).withTypeProvider<ZodTypeProvider>();

// Stamp X-Request-ID on every response (including SSE initial response)
server.addHook('onSend', async (request, reply) => {
  reply.header('X-Request-ID', request.id);
});
```

### Disk space check via fs.statfs (verified on Node 22.22.0)
```typescript
// Source: Node.js docs + verified in local environment
import { promisify } from 'util';
import { statfs } from 'fs';
import { dirname } from 'path';

const statfsAsync = promisify(statfs);

async function getDiskSpace(path: string) {
  const stats = await statfsAsync(dirname(path));
  const free = stats.bavail * stats.bsize;
  const total = stats.blocks * stats.bsize;
  const freePercent = ((free / total) * 100).toFixed(1);
  return { free, total, freePercent };
}
```

### Stats query (verified against live tasks.db)
```typescript
// Status counts — verified working
const statusCounts = db.prepare(`
  SELECT status, COUNT(*) as count
  FROM tasks
  GROUP BY status
  ORDER BY status
`).all() as Array<{ status: string; count: number }>;

// Agent productivity — verified working
const agentStats = db.prepare(`
  SELECT assignee,
         COUNT(*) as task_count,
         SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as completed,
         SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress
  FROM tasks
  WHERE assignee IS NOT NULL
    AND updated_at >= datetime('now', '-7 days')
  GROUP BY assignee
  ORDER BY task_count DESC
`).all() as Array<{ assignee: string; task_count: number; completed: number; in_progress: number }>;
```

### CLI command registration in tasks.ts
```typescript
// src/cli/bin/tasks.ts — add new imports and registrations
import { doctorCommand } from '../commands/doctor.js';
import { statsCommand } from '../commands/stats.js';
import { dbCheckCommand } from '../commands/db-check.js';

program.addCommand(doctorCommand);
program.addCommand(statsCommand);
program.addCommand(dbCheckCommand);
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Auto-incrementing integer request IDs | UUID v4 via `crypto.randomUUID()` | Fastify v1+ supported both; UUID is current best practice | Globally unique IDs survive server restarts and multi-instance deployments |
| `child_process.exec('df')` for disk space | `fs.statfs()` built-in | Node 18.4.0 | Zero dependency, no subprocess, cross-platform |
| Manual event replay implementation | `@fastify/sse` with SSEManager (already in codebase) | Phase 14 | Already implemented; only buffer size needs tuning |

**Deprecated/outdated:**
- `diskusage` npm package: Has native bindings (compilation required); `fs.statfs` is simpler and dependency-free
- `hyperid` npm package: Marginally faster than `randomUUID()` but adds a dependency; not worth it

## Open Questions

1. **MCP traceId scope — all tools or key tools only?**
   - What we know: There are 26 MCP tools. Adding traceId logging to all requires touching every tool handler.
   - What's unclear: The requirement says "visible in logs" — does this mean per-request or per-tool?
   - Recommendation: Add traceId to just the 5 most commonly called tools (create_task, update_task, claim_task, check_health, list_tasks) in this phase. Flag full coverage for a future hardening pass.

2. **CLI request ID visibility — where to surface it?**
   - What we know: The CLI is an HTTP client (`src/cli/api/client.ts`). The REST API will now return `X-Request-ID` in response headers. The CLI currently discards response headers.
   - What's unclear: Does "visible in logs/responses" mean the CLI should print the request ID?
   - Recommendation: In `--json` mode, include `_requestId` in the JSON envelope. In normal mode, print it only on errors (to aid debugging). This is the most useful behavior without being noisy.

3. **`doctor` config check scope — server config or CLI config?**
   - What we know: The CLI has `src/cli/config/env.ts` (validates `API_KEY`, `API_BASE_URL`). The server has `src/config/env.ts` (validates `API_KEYS`, `DATABASE_PATH`, etc.).
   - What's unclear: Which config should `tasks doctor` validate?
   - Recommendation: Validate the server config (`src/config/env.ts`'s `configSchema`) — this is what "config validity" means for a service diagnostic. The CLI's own config (API_KEY) is implicitly checked because the CLI is running.

4. **SSE buffer TTL interaction with 100-event limit**
   - What we know: `SSEManager` has both a count limit (1000→100) AND a TTL (5 minutes). The pruning runs on every broadcast.
   - What's unclear: With 100 events, the TTL may rarely trigger. Is 5 minutes still the right TTL?
   - Recommendation: Keep the 5-minute TTL as-is. With 100 events, the count limit is the dominant constraint. No change needed.

## Sources

### Primary (HIGH confidence)
- Codebase — `src/events/sse-manager.ts` — verified SSEManager replay implementation
- Codebase — `src/cli/commands/backup.ts` — verified direct-DB CLI pattern
- Codebase — `src/api/server.ts` — verified current Fastify server configuration
- Codebase — `src/api/routes/events.ts` — verified `randomUUID()` usage
- Codebase — `src/config/env.ts` — verified `configSchema` Zod schema for reuse
- Live REPL — `db.pragma('integrity_check')` — confirmed `[{"integrity_check":"ok"}]` return format
- Live REPL — `fs.statfs()` — confirmed available on Node 22.22.0
- Live REPL — `db.pragma('page_count')` and `db.pragma('page_size')` — confirmed PRAGMA API
- Live REPL — Fastify inject test — confirmed `genReqId` + `onSend` propagation
- Live REPL — Memory estimation: 100 events × ~455 bytes = ~44 KB
- [Fastify Server Reference](https://fastify.dev/docs/latest/Reference/Server/) — genReqId, requestIdHeader
- [better-sqlite3 API docs](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md) — pragma() method

### Secondary (MEDIUM confidence)
- [Fastify Hooks Reference](https://fastify.dev/docs/latest/Reference/Hooks/) — onSend hook pattern
- [SQLite PRAGMA documentation](https://sqlite.org/pragma.html) — integrity_check semantics
- [check-disk-space README](https://github.com/Alex-D/check-disk-space/blob/main/README.md) — considered and rejected in favor of `fs.statfs`
- [MDN: Using server-sent events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events) — Last-Event-ID semantics

### Tertiary (LOW confidence)
- None. All findings verified via codebase or local REPL execution.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all verified in codebase or via Node.js REPL
- Architecture: HIGH — direct-DB pattern confirmed from Phase 18; Fastify request ID confirmed via inject test
- SQL queries: HIGH — executed against live tasks.db
- Pitfalls: HIGH — derived from actual code paths in existing codebase
- MCP tracing: MEDIUM — scope ambiguity in requirement (see Open Questions)

**Research date:** 2026-02-17
**Valid until:** 2026-03-17 (stable stack; 30-day validity)
