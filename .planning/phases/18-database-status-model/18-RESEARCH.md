# Phase 18: Database & Status Model - Research

**Researched:** 2026-02-17
**Domain:** SQLite backup, status lifecycle extension (better-sqlite3, Commander.js)
**Confidence:** HIGH

## Summary

This phase adds two distinct features: (1) a `tasks backup` CLI command that creates an offline SQLite backup, and (2) the "backlogged" status added to the task lifecycle so users can triage and defer tasks without deleting them.

The backup command operates differently from all other CLI commands. Every other command is an HTTP client that calls the REST API. `tasks backup` must access the database **file directly** because backup is a file-system operation — the server holds the live database handle, and there is no REST API backup endpoint. The CLI must read `DATABASE_PATH` from the environment (or `.env`) and operate on the SQLite file directly using either `db.backup(destPath)` (better-sqlite3 async API) or `db.exec("VACUUM INTO 'destPath'")` (synchronous SQL). Both approaches are confirmed working in this codebase (SQLite 3.51.2).

Adding "backlogged" as a status requires changes in six places: (1) the TypeScript `TASK_STATUSES` const, (2) `VALID_STATUS_TRANSITIONS` map, (3) Zod schemas (UpdateTaskSchema, TaskFiltersSchema), (4) a new database migration (005) to rebuild the tasks table with an updated CHECK constraint, (5) the `TaskService.claimTask()` guard, and (6) the `ClaimReleaseService` stale-claim query. The MCP `claim_task` tool and REST `POST /tasks/:id/claim` route both delegate to `taskService.claimTask()`, so the service-layer guard is the single enforcement point. The status must NOT be listed as a valid starting status for `createTask` — new tasks continue to always start as `open`.

**Primary recommendation:** Implement `tasks backup` as a direct-to-SQLite CLI command (not via API) using `db.backup(destPath)` for its async safety. Add "backlogged" by rebuilding the tasks table in migration 005 following the standard SQLite table-rebuild pattern already used by this codebase.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| RELI-05 | CLI `tasks backup` command creates SQLite backup using `VACUUM INTO` or `.backup()` API | Both confirmed working; `db.backup()` is preferred (async, WAL-safe) |
| DATA-01 | New task status "backlogged" added to status lifecycle | Requires SQLite table rebuild via migration 005; TypeScript types and Zod schemas updated |
| DATA-02 | Backlogged tasks are excluded from agent claim operations | `taskService.claimTask()` already checks `status === 'open'`; adding `backlogged` as a non-open status automatically excludes it |
| DATA-03 | Backlogged tasks can be transitioned to open by authorized users | `VALID_STATUS_TRANSITIONS` entry for `backlogged: ['open']`; all existing auth (X-API-Key) applies |
</phase_requirements>

## Standard Stack

### Core (already in the project)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| better-sqlite3 | ^12.6.2 | SQLite driver; provides `db.backup()` and `db.exec("VACUUM INTO ...")` | Already the project's SQLite driver |
| Commander.js | ^14.0.3 | CLI command framework | Already used for all other CLI commands |
| Umzug | ^3.8.2 | Migration runner | Already used; migration 005 follows existing patterns |
| Zod | ^4.3.6 | Schema validation | Already used for status enum validation |

### No New Dependencies

This phase requires **zero new npm packages**. All required capabilities exist in the installed stack.

## Architecture Patterns

### Pattern 1: CLI Command That Bypasses the REST API

**What:** `tasks backup` reads `DATABASE_PATH` from environment, opens the database directly, and calls `db.backup(destPath)`. This is the ONLY CLI command that does not use the HTTP API client.

**Why:** Database backup is a file-system-level operation. The live server holds the WAL-mode database file open. `db.backup()` is the safe way to snapshot a live SQLite database because it uses SQLite's official Online Backup API, which handles WAL files correctly.

**Pattern:**
```typescript
// src/cli/commands/backup.ts
import { Command } from 'commander';
import Database from 'better-sqlite3';
import { resolve } from 'path';
import chalk from 'chalk';
import { jsonOutput } from '../output/json-output.js';

export const backupCommand = new Command('backup')
  .description('Create a SQLite backup of the task database')
  .option('-o, --output <path>', 'Backup destination path', `./tasks-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.db`)
  .action(async (options) => {
    const program = backupCommand.parent;
    const globalOpts = program?.optsWithGlobals() || {};
    const isJsonMode = globalOpts.json || false;

    const dbPath = process.env.DATABASE_PATH || './data/tasks.db';
    const destPath = resolve(options.output);

    const db = new Database(dbPath, { readonly: true });
    try {
      await db.backup(destPath);
      // report success
    } finally {
      db.close();
    }
  });
```

**Key constraint:** Open the source database **readonly** (`{ readonly: true }`) to avoid competing with the running server's write lock. better-sqlite3's `backup()` works correctly on a readonly connection.

**Verified:** `db.backup('/path/to/dest.db')` returns `{ totalPages: N, remainingPages: 0 }` when complete. The directory must exist before calling backup.

### Pattern 2: SQLite Table Rebuild for CHECK Constraint Extension

**What:** SQLite does not support `ALTER TABLE ... MODIFY COLUMN` or modifying CHECK constraints. Adding `'backlogged'` to the existing `CHECK(status IN (...))` requires a table rebuild.

**Standard SQLite table rebuild procedure:**
```sql
-- Step 1: Disable FK enforcement temporarily
PRAGMA foreign_keys = OFF;

-- Step 2: Create new table with updated CHECK
CREATE TABLE tasks_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK(status IN ('open', 'in_progress', 'done', 'closed', 'blocked', 'backlogged')),
  priority TEXT NOT NULL DEFAULT 'medium'
    CHECK(priority IN ('low', 'medium', 'high', 'urgent')),
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  assignee TEXT,
  created_by TEXT NOT NULL,
  due_date TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  estimated_minutes INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  claimed_at TEXT
);

-- Step 3: Copy all data
INSERT INTO tasks_new SELECT * FROM tasks;

-- Step 4: Drop old table (cascades to FTS triggers)
DROP TABLE tasks;

-- Step 5: Rename new table
ALTER TABLE tasks_new RENAME TO tasks;

-- Step 6: Recreate indexes
CREATE INDEX idx_tasks_project_id ON tasks(project_id);
-- ... all other indexes

-- Step 7: Recreate FTS triggers
CREATE TRIGGER tasks_fts_insert ...;
-- ... etc
```

**Verified working:** Tested in SQLite 3.51.2 (bundled with better-sqlite3 12.6.2). All data preserved, new value insertable, old CHECK rejects invalid values.

**IMPORTANT:** The FTS5 virtual table (`tasks_fts`) and its triggers must be recreated. The triggers reference the `tasks` table by name, so the rename approach works without modifying the FTS table itself.

### Pattern 3: Status Lifecycle Extension

**What:** Add "backlogged" to the TypeScript type system, transition map, and Zod schemas.

**Current state** (`src/types/task.ts`):
```typescript
export const TASK_STATUSES = ['open', 'in_progress', 'done', 'closed', 'blocked'] as const;

export const VALID_STATUS_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  open: ['in_progress', 'blocked', 'closed'],
  in_progress: ['done', 'blocked', 'open'],
  blocked: ['open', 'in_progress'],
  done: ['closed', 'open'],
  closed: ['open'],
};
```

**Updated state:**
```typescript
export const TASK_STATUSES = ['open', 'in_progress', 'done', 'closed', 'blocked', 'backlogged'] as const;

export const VALID_STATUS_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  open: ['in_progress', 'blocked', 'closed', 'backlogged'],
  in_progress: ['done', 'blocked', 'open'],
  blocked: ['open', 'in_progress'],
  done: ['closed', 'open'],
  closed: ['open'],
  backlogged: ['open'],
};
```

**Design decision:** Any user can transition `open -> backlogged`. Only `backlogged -> open` is allowed (not `backlogged -> in_progress` directly). This enforces the triage workflow: backlogged tasks must be explicitly promoted to open before agents can claim them.

### Pattern 4: Claim Exclusion (DATA-02)

**What:** The existing `claimTask()` method already enforces `status === 'open'`. Adding "backlogged" as a new status automatically excludes it from claim operations.

**Current guard in `src/services/task.service.ts`:**
```typescript
if (existing.status !== 'open') {
  throw new BusinessError(`Task ${taskId} cannot be claimed: status is '${existing.status}', must be 'open'`);
}
```

No changes needed to this guard — it already rejects any non-open task. The error message correctly describes the rejection.

**Also verify:** `ClaimReleaseService.findStaleClaims()` queries `WHERE status = 'in_progress'`, so backlogged tasks are already excluded from stale-claim sweeps. No changes needed.

### Pattern 5: createTask Always Starts as 'open'

**Current behavior** (`src/services/task.service.ts`):
```typescript
// Create task with status forced to 'open'
const task = this.taskRepo.create(
  { ...result.data, status: 'open' },
  result.data.tags
);
```

This override is already in place. Adding "backlogged" to `TASK_STATUSES` does NOT allow creating tasks as backlogged — the service override ignores input status. This is intentional and must NOT change.

**However:** The `CreateTaskSchema` in `src/schemas/task.schema.ts` doesn't include status (it's not a field), so there's no schema change needed for create. But `UpdateTaskSchema` uses `z.enum(TASK_STATUSES)` which will automatically include `backlogged` after the types change. This is correct behavior.

### Pattern 6: `tasks backup` Command Architecture

**Integration into existing CLI:**

The backup command does NOT use `src/cli/api/client.ts`. It opens the database directly. The `DATABASE_PATH` env var is already defined in `src/config/env.ts` with a default of `'./data/tasks.db'`. The CLI config module (`src/cli/config/env.ts`) currently only exposes `API_BASE_URL` and `API_KEY`.

**Two options for getting DATABASE_PATH in CLI:**
1. Read from `process.env.DATABASE_PATH` directly (after `dotenv.config()`), falling back to the default `./data/tasks.db`
2. Add `DATABASE_PATH` to the CLI config module

Option 1 is simpler and avoids expanding the CLI config surface. The backup command can call `dotenv.config()` directly (or reuse the existing CLI env module which already loads `.env`) and read `process.env.DATABASE_PATH`.

**Registration in `tasks.ts`:**
```typescript
import { backupCommand } from '../commands/backup.js';
// ...
program.addCommand(backupCommand);
```

### Anti-Patterns to Avoid

- **Don't add a REST API `/backup` endpoint:** Backup is a file-system operation. An API endpoint would need to return the file contents over HTTP, which is complex and unnecessary. The CLI direct DB access pattern is simpler and correct.
- **Don't use `VACUUM INTO` as the primary approach:** While `VACUUM INTO` works and creates a clean backup, `db.backup()` is better for WAL-mode databases because it uses the SQLite Online Backup API — it's the canonical safe approach for hot backups.
- **Don't open the source database read-write:** Opening with `{ readonly: true }` avoids competing for the write lock with the running server.
- **Don't try `ALTER TABLE` for the CHECK constraint:** SQLite doesn't support modifying CHECK constraints. The table rebuild is the correct approach.
- **Don't forget to recreate FTS triggers:** After DROP TABLE + RENAME, all triggers attached to the old `tasks` table are gone. They must be recreated in the migration.
- **Don't allow `createTask` to accept backlogged:** The service override (`status: 'open'`) must remain. Backlogged is only reachable via `updateTask`.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Hot backup of WAL-mode SQLite | Custom file copy | `db.backup(destPath)` | Handles WAL file correctly; uses SQLite's Online Backup API |
| Migration tracking | Custom migration table | Umzug with SQLiteStorage | Already in use; migration 005 follows same pattern as 001-004 |
| Status validation | Manual string checks | Zod `z.enum(TASK_STATUSES)` | Already in use; auto-updates when TASK_STATUSES changes |

## Common Pitfalls

### Pitfall 1: Forgetting to Recreate FTS Triggers in Migration

**What goes wrong:** After `DROP TABLE tasks` + `ALTER TABLE tasks_new RENAME TO tasks`, the FTS triggers (`tasks_fts_insert`, `tasks_fts_update`, `tasks_fts_delete`) no longer exist. Task creation works but FTS search returns no results.

**Why it happens:** Triggers are attached to table names. Dropping the table removes all its triggers. The `tasks_fts` virtual table still exists but has no mechanism to stay in sync.

**How to avoid:** Migration 005 must explicitly DROP and recreate all three FTS triggers after renaming.

**Warning signs:** Tasks create successfully but `search` filter returns empty results.

### Pitfall 2: Backup Directory Must Exist

**What goes wrong:** `db.backup('/path/that/doesnt/exist/backup.db')` throws `TypeError: Cannot save backup because the directory does not exist`.

**Why it happens:** better-sqlite3's backup implementation calls `fsAccess(path.dirname(filename))` and throws if the directory doesn't exist.

**How to avoid:** The backup command must verify the output directory exists (create it with `mkdir -p` behavior, or output to current directory by default).

### Pitfall 3: Readonly Connection Required for Backup Source

**What goes wrong:** Opening the source database with the default (read-write) mode on a live WAL-mode database may conflict with the running server's write operations.

**Why it happens:** better-sqlite3 defaults to read-write mode. Two writers on the same WAL-mode file can cause SQLITE_BUSY.

**How to avoid:** Open with `new Database(dbPath, { readonly: true })`.

### Pitfall 4: Backlogged Status in CreateTaskSchema

**What goes wrong:** Someone adds `'backlogged'` to `TASK_STATUSES` and then adds status to `CreateTaskSchema`, allowing agents to create tasks as backlogged.

**Why it happens:** Natural assumption that if status is valid, it's valid on create.

**How to avoid:** `CreateTaskSchema` does NOT include a `status` field. The service always overrides to `'open'`. This design must be preserved.

### Pitfall 5: Missing `backlogged` in Formatters

**What goes wrong:** The CLI status formatter (`formatStatus()` in `src/cli/output/formatters.ts`) has a `switch` statement with explicit cases. If "backlogged" is not added, it falls through to the default (white) case with no color.

**Why it happens:** The formatter has hard-coded cases for each status. Adding a new status to the type system doesn't auto-update the formatter.

**How to avoid:** Add `case 'backlogged':` to the formatter's switch statement, using an appropriate color (e.g., `chalk.magenta` or `chalk.dim`).

## Code Examples

### backup() API - Complete Usage Pattern

```typescript
// Source: better-sqlite3 lib/methods/backup.js (verified 12.6.2)
import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';

async function backupDatabase(srcPath: string, destPath: string): Promise<{ totalPages: number; remainingPages: number }> {
  const dir = dirname(destPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const db = new Database(srcPath, { readonly: true });
  try {
    return await db.backup(destPath);
  } finally {
    db.close();
  }
}
```

### Migration 005 - Table Rebuild Pattern

```typescript
// src/db/migrations/005-backlogged-status.ts
import type Database from 'better-sqlite3';

export async function up(db: Database.Database): Promise<void> {
  db.transaction(() => {
    db.pragma('foreign_keys = OFF');

    // Create replacement table with updated CHECK constraint
    db.exec(`
      CREATE TABLE tasks_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'open'
          CHECK(status IN ('open', 'in_progress', 'done', 'closed', 'blocked', 'backlogged')),
        priority TEXT NOT NULL DEFAULT 'medium'
          CHECK(priority IN ('low', 'medium', 'high', 'urgent')),
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        parent_task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
        assignee TEXT,
        created_by TEXT NOT NULL,
        due_date TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        estimated_minutes INTEGER,
        version INTEGER NOT NULL DEFAULT 1,
        claimed_at TEXT
      )
    `);

    db.exec(`INSERT INTO tasks_new SELECT * FROM tasks`);

    // Drop old triggers (they reference the old table)
    db.exec(`DROP TRIGGER IF EXISTS tasks_fts_insert`);
    db.exec(`DROP TRIGGER IF EXISTS tasks_fts_update`);
    db.exec(`DROP TRIGGER IF EXISTS tasks_fts_delete`);

    db.exec(`DROP TABLE tasks`);
    db.exec(`ALTER TABLE tasks_new RENAME TO tasks`);

    // Recreate indexes
    db.exec(`CREATE INDEX idx_tasks_project_id ON tasks(project_id)`);
    db.exec(`CREATE INDEX idx_tasks_project_status_assignee ON tasks(project_id, status, assignee)`);
    db.exec(`CREATE INDEX idx_tasks_status_due_date ON tasks(status, due_date)`);
    db.exec(`CREATE INDEX idx_tasks_assignee ON tasks(assignee)`);
    db.exec(`CREATE INDEX idx_tasks_parent_id ON tasks(parent_task_id)`);

    // Recreate FTS triggers
    db.exec(`
      CREATE TRIGGER tasks_fts_insert AFTER INSERT ON tasks
      BEGIN
        INSERT INTO tasks_fts(rowid, title, description) VALUES (new.id, new.title, new.description);
      END
    `);
    db.exec(`
      CREATE TRIGGER tasks_fts_update AFTER UPDATE ON tasks
      BEGIN
        INSERT INTO tasks_fts(tasks_fts, rowid, title, description) VALUES('delete', old.id, old.title, old.description);
        INSERT INTO tasks_fts(rowid, title, description) VALUES (new.id, new.title, new.description);
      END
    `);
    db.exec(`
      CREATE TRIGGER tasks_fts_delete AFTER DELETE ON tasks
      BEGIN
        INSERT INTO tasks_fts(tasks_fts, rowid, title, description) VALUES('delete', old.id, old.title, old.description);
      END
    `);

    db.pragma('foreign_keys = ON');
  })();
}

export async function down(db: Database.Database): Promise<void> {
  // Reverse: rebuild without 'backlogged' in CHECK
  // Similar table rebuild, omitting 'backlogged' from CHECK constraint
  // ... (full reverse migration omitted for brevity, same pattern)
}
```

### Status Transitions (Complete Updated Map)

```typescript
// src/types/task.ts
export const TASK_STATUSES = ['open', 'in_progress', 'done', 'closed', 'blocked', 'backlogged'] as const;

export const VALID_STATUS_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  open: ['in_progress', 'blocked', 'closed', 'backlogged'],
  in_progress: ['done', 'blocked', 'open'],
  blocked: ['open', 'in_progress'],
  done: ['closed', 'open'],
  closed: ['open'],
  backlogged: ['open'],   // backlogged tasks must be explicitly promoted to open
};
```

## State of the Art

| Old Approach | Current Approach | Impact |
|--------------|------------------|--------|
| `fs.copyFile` for SQLite backup | `db.backup()` SQLite Online Backup API | Handles WAL files correctly; safe for live databases |
| `VACUUM` (in-place) | `VACUUM INTO 'path'` (SQLite 3.27.0+) | Creates compressed copy without modifying source |

**SQLite versions relevant to this work:**
- `VACUUM INTO` requires SQLite 3.27.0+ — bundled SQLite is 3.51.2, so supported
- Table `DROP COLUMN` requires SQLite 3.35.0+ — bundled, so supported for down migrations
- `db.backup()` uses the SQLite Online Backup API, available since SQLite 3.6.11 — fully supported

## Open Questions

1. **Where should the default backup output path go?**
   - What we know: The requirement says "creates a valid SQLite backup file" but doesn't specify where
   - What's unclear: Should it default to the current directory, or to a `./backups/` subdirectory?
   - Recommendation: Default to `./tasks-backup-{timestamp}.db` in the current directory — simple, no directory creation needed

2. **Should `tasks backup` require the API server to be running?**
   - What we know: Backup accesses the DB file directly; the server doesn't need to be running for the backup to work
   - What's unclear: Is this the intended UX — backup works even when server is down?
   - Recommendation: Yes, backup should work standalone (no API dependency). This is a feature, not a bug.

3. **Authorization distinction for DATA-03 ("authorized users")**
   - What we know: The system uses API key auth; all API key holders have equal access; there's no role-based access control
   - What's unclear: "Authorized users" in DATA-03 may simply mean "users with a valid API key" (not a special admin role)
   - Recommendation: Treat "authorized users" as any caller with a valid API key. No RBAC needed unless requirements specify otherwise.

## Sources

### Primary (HIGH confidence)

- **Codebase direct inspection** — Read all relevant source files: `src/types/task.ts`, `src/services/task.service.ts`, `src/services/claim-release.service.ts`, `src/db/migrations/001-004`, `src/cli/commands/*.ts`, `src/db/database.ts`, `src/repositories/task.repository.ts`
- **better-sqlite3 `lib/methods/backup.js`** — Read the actual backup implementation; confirmed options and behavior
- **Live SQLite testing** — Verified `VACUUM INTO` and `db.backup()` in SQLite 3.51.2 (bundled with better-sqlite3 12.6.2) via `node` + `tsx` from project directory
- **SQLite table rebuild** — Verified that the standard rebuild pattern correctly updates CHECK constraints, preserves data, and works with FTS triggers

### Secondary (MEDIUM confidence)

- **SQLite official documentation** — `VACUUM INTO` available since 3.27.0; Online Backup API available since 3.6.11; both confirmed supported by bundled 3.51.2

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all libraries are already in the project; no new dependencies
- Architecture: HIGH — backup pattern and table rebuild verified by direct testing
- Pitfalls: HIGH — FTS trigger pitfall verified by inspecting migration 001; backup directory pitfall verified by reading better-sqlite3 source

**Research date:** 2026-02-17
**Valid until:** 2026-03-17 (stable libraries; no fast-moving dependencies)
