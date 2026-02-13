# Phase 1: Foundation - Research

**Researched:** 2026-02-13
**Domain:** SQLite data layer with better-sqlite3, repository pattern, service layer architecture
**Confidence:** MEDIUM-HIGH

## Summary

Phase 1 builds a robust SQLite-backed data layer for task management using better-sqlite3 12.6.2 with TypeScript 5.7+. The architecture follows a three-layer pattern (Interface → Service → Repository → Database) with Zod validation at system boundaries and a single-writer queue pattern for write concurrency.

better-sqlite3 provides a synchronous API that simplifies transaction handling compared to async SQLite libraries. WAL mode enables concurrent readers without blocking writers, and proper pragma configuration (busy_timeout, foreign_keys) prevents SQLITE_BUSY errors. Migrations via Umzug provide type-safe schema evolution.

The repository pattern abstracts database access behind interfaces, enabling testability with in-memory SQLite databases (:memory:). The service layer implements business logic including status lifecycle validation, filtering, and full-text search via SQLite FTS5.

**Primary recommendation:** Use better-sqlite3 with WAL mode, BEGIN IMMEDIATE transactions wrapped in db.transaction(), composite indexes for common filter combinations, and Zod schemas at service boundaries. Test with in-memory databases for fast, isolated unit tests.

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| better-sqlite3 | 12.6.2 | SQLite driver | Fastest synchronous SQLite driver for Node.js, simplifies transactions, widely adopted |
| @types/better-sqlite3 | latest | TypeScript types | DefinitelyTyped types for better-sqlite3, maintained by community |
| Zod | 3.x | Runtime validation | TypeScript-first schema validation with type inference, industry standard for API boundaries |
| Umzug | 3.x | Database migrations | Framework-agnostic, TypeScript support via ts-node, programmatic API |
| Vitest | latest | Testing framework | Better Node.js compatibility than Jest, fast, native ESM support |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| @databases/sqlite | optional | Alternative driver with async API | If async/await preferred over sync (NOT recommended for this phase) |
| better-sqlite3-helper | optional | Helper with auto-WAL | If you want auto-configuration (adds abstraction, not needed) |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| better-sqlite3 | node-sqlite3 | Async API requires complex pooling, slower, harder transaction management |
| Umzug | db-migrate, node-pg-migrate | db-migrate supports multiple DBs but less TypeScript-friendly; node-pg-migrate is Postgres-specific |
| Zod | Yup, Joi, ArkType | Zod has superior TypeScript integration and type inference |

**Installation:**
```bash
pnpm add better-sqlite3 zod umzug
pnpm add -D @types/better-sqlite3 vitest
```

## Architecture Patterns

### Recommended Project Structure
```
src/
├── db/
│   ├── migrations/           # Umzug migration files (TypeScript)
│   ├── database.ts           # Database initialization, WAL config, pragmas
│   └── migrate.ts            # Migration runner
├── repositories/
│   ├── interfaces/           # Repository interface definitions
│   ├── task.repository.ts    # Task CRUD operations
│   ├── project.repository.ts # Project CRUD operations
│   └── tag.repository.ts     # Tag CRUD operations
├── services/
│   ├── task.service.ts       # Business logic, validation, filtering
│   └── types.ts              # Shared service types
└── schemas/
    └── task.schema.ts        # Zod validation schemas
```

### Pattern 1: Database Initialization with WAL Mode
**What:** Configure SQLite with WAL mode, pragmas, and busy timeout on connection
**When to use:** At application startup, before any queries
**Example:**
```typescript
// Source: https://github.com/WiseLibs/better-sqlite3 + https://www.npmjs.com/package/better-sqlite3
import Database from 'better-sqlite3';

export function initDatabase(filepath: string = './data.db'): Database.Database {
  const db = new Database(filepath);

  // Enable WAL mode for concurrent reads during writes
  db.pragma('journal_mode = WAL');

  // Enforce foreign key constraints
  db.pragma('foreign_keys = ON');

  // Wait up to 5 seconds if database is busy (prevents SQLITE_BUSY)
  db.timeout(5000);

  // Optional: Set synchronous to NORMAL in WAL mode for performance
  // WAL mode defaults to NORMAL with SQLITE_DEFAULT_WAL_SYNCHRONOUS=1
  db.pragma('synchronous = NORMAL');

  return db;
}
```

### Pattern 2: Transaction-Wrapped Write Operations
**What:** Use db.transaction() to create atomic write functions with automatic rollback
**When to use:** Any multi-statement write operation, bulk inserts, updates with side effects
**Example:**
```typescript
// Source: https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md
const insertTaskWithTags = db.transaction((task: Task, tags: string[]) => {
  // Insert task
  const insertTask = db.prepare(`
    INSERT INTO tasks (title, description, status, project_id)
    VALUES (@title, @description, @status, @project_id)
  `);
  const taskResult = insertTask.run(task);
  const taskId = taskResult.lastInsertRowid;

  // Insert tags
  const insertTag = db.prepare(`
    INSERT INTO task_tags (task_id, tag) VALUES (?, ?)
  `);
  for (const tag of tags) {
    insertTag.run(taskId, tag);
  }

  return taskId;
});

// Execute transaction - automatically commits or rolls back
const newTaskId = insertTaskWithTags(
  { title: 'Test', description: 'Desc', status: 'open', project_id: 1 },
  ['bug', 'urgent']
);
```

### Pattern 3: Repository Pattern with Interfaces
**What:** Abstract database access behind interfaces for testability and dependency injection
**When to use:** All data access - enables mocking, multiple implementations, clean architecture
**Example:**
```typescript
// Source: https://www.abdou.dev/blog/the-repository-pattern-with-typescript
// repositories/interfaces/task.repository.interface.ts
export interface ITaskRepository {
  create(task: CreateTaskDTO): Task;
  findById(id: number): Task | null;
  update(id: number, updates: Partial<Task>): Task;
  delete(id: number): void;
  findByFilters(filters: TaskFilters): Task[];
}

// repositories/task.repository.ts
export class TaskRepository implements ITaskRepository {
  constructor(private db: Database.Database) {}

  create(task: CreateTaskDTO): Task {
    const stmt = this.db.prepare(`
      INSERT INTO tasks (title, description, status, priority, project_id, assignee, due_date, created_by)
      VALUES (@title, @description, @status, @priority, @project_id, @assignee, @due_date, @created_by)
    `);
    const result = stmt.run(task);
    return this.findById(result.lastInsertRowid as number)!;
  }

  // ... other methods
}
```

### Pattern 4: Service Layer with Zod Validation
**What:** Business logic layer that validates inputs, enforces rules, calls repositories
**When to use:** All business operations - validates at system boundaries before touching database
**Example:**
```typescript
// Source: https://zod.dev/ + https://oneuptime.com/blog/post/2026-01-25-zod-validation-typescript/view
import { z } from 'zod';

// Define schema with validation rules
const CreateTaskSchema = z.object({
  title: z.string().min(1).max(255),
  description: z.string().optional(),
  status: z.enum(['open', 'in_progress', 'done', 'closed', 'blocked']),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).default('medium'),
  project_id: z.number().int().positive(),
  assignee: z.string().optional(),
  due_date: z.string().datetime().optional(), // ISO8601 string
  created_by: z.string(),
});

export class TaskService {
  constructor(private taskRepo: ITaskRepository) {}

  createTask(input: unknown): Task {
    // safeParse returns { success, data } or { success, error }
    const result = CreateTaskSchema.safeParse(input);

    if (!result.success) {
      throw new ValidationError(result.error.format());
    }

    // Business logic: validate status lifecycle
    if (result.data.status !== 'open') {
      throw new BusinessError('New tasks must start with status=open');
    }

    return this.taskRepo.create(result.data);
  }
}
```

### Pattern 5: Composite Indexes for Filter Queries
**What:** Multi-column indexes matching common WHERE clause combinations
**When to use:** Queries with multiple AND-connected filters (status + project + assignee)
**Example:**
```sql
-- Source: https://blog.sqlite.ai/choosing-the-right-index-in-sqlite
-- Common query: Filter by project, status, assignee
CREATE INDEX idx_tasks_project_status_assignee
ON tasks(project_id, status, assignee);

-- Column order matters: equality filters first, then range filters
-- Good: WHERE project_id = 1 AND status = 'open' AND assignee = 'alice'
-- Good: WHERE project_id = 1 AND status = 'open'
-- Good: WHERE project_id = 1
-- Bad (can't use index): WHERE status = 'open' (doesn't start with project_id)

-- For date range queries, put exact matches first
CREATE INDEX idx_tasks_status_due_date
ON tasks(status, due_date);
-- Good: WHERE status = 'open' AND due_date < '2026-03-01'
```

### Pattern 6: Full-Text Search with FTS5
**What:** Virtual FTS5 table for efficient text search on title and description
**When to use:** TASK-04 requires search by title/description text
**Example:**
```sql
-- Source: https://sqlite.org/fts5.html + https://thelinuxcode.com/sqlite-full-text-search-fts5-in-practice-fast-search-ranking-and-real-world-patterns/
-- Create FTS5 virtual table
CREATE VIRTUAL TABLE tasks_fts USING fts5(
  task_id UNINDEXED,  -- Don't index ID, just store it
  title,
  description,
  content='tasks',    -- Sync with tasks table
  content_rowid='id'
);

-- Keep FTS5 in sync with tasks table via triggers
CREATE TRIGGER tasks_ai AFTER INSERT ON tasks BEGIN
  INSERT INTO tasks_fts(task_id, title, description)
  VALUES (new.id, new.title, new.description);
END;

CREATE TRIGGER tasks_au AFTER UPDATE ON tasks BEGIN
  UPDATE tasks_fts
  SET title = new.title, description = new.description
  WHERE task_id = new.id;
END;

CREATE TRIGGER tasks_ad AFTER DELETE ON tasks BEGIN
  DELETE FROM tasks_fts WHERE task_id = old.id;
END;

-- Search query with BM25 ranking
SELECT tasks.*, rank
FROM tasks_fts
JOIN tasks ON tasks.id = tasks_fts.task_id
WHERE tasks_fts MATCH 'bug AND urgent'
ORDER BY rank;
```

### Pattern 7: In-Memory Database for Testing
**What:** Use :memory: database for isolated, fast unit tests
**When to use:** All unit and integration tests for repositories and services
**Example:**
```typescript
// Source: https://www.sqlite.org/inmemorydb.html + https://coobird.net/blog/2023/08/05/using-sqlite-inmemory-for-testing.html
import { describe, it, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

describe('TaskRepository', () => {
  let db: Database.Database;
  let repo: TaskRepository;

  beforeEach(() => {
    // Create fresh in-memory database for each test
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');

    // Run migrations to set up schema
    runMigrationsSync(db);

    repo = new TaskRepository(db);
  });

  it('should create task', () => {
    const task = repo.create({
      title: 'Test task',
      status: 'open',
      project_id: 1,
      created_by: 'test'
    });

    expect(task.id).toBeDefined();
    expect(task.title).toBe('Test task');
  });
});
```

### Anti-Patterns to Avoid

- **Async/await with better-sqlite3 transactions:** Transactions don't work with async functions - they commit after first await. Use synchronous code inside db.transaction().
- **String concatenation for queries:** Always use prepared statements with parameter binding (@named, ?positional, or $dollar) to prevent SQL injection.
- **Upgrading transactions from read to write:** Never BEGIN then upgrade to write later - use BEGIN IMMEDIATE for writes to avoid SQLITE_BUSY errors.
- **Mixing manual transactions with db.transaction():** Choose one approach. db.transaction() is recommended for atomicity guarantees.
- **Forgetting to enable WAL mode:** Without WAL, readers block writers and vice versa, causing severe concurrency bottlenecks.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Schema migrations | Custom migration scripts with version tracking | Umzug with TypeScript migrations | Handles execution order, rollbacks, migration state, and prevents re-runs. Edge cases: parallel deployments, partial failures. |
| Input validation | Manual type checking and error messages | Zod schemas with safeParse() | Handles nested objects, arrays, refinements, transforms, type inference, and detailed error paths automatically. |
| Transaction management | Manual BEGIN/COMMIT/ROLLBACK | db.transaction() wrapper | Automatically rolls back on throw, prevents partial commits, handles nested transactions. |
| SQL injection prevention | Manual escaping/sanitization | Prepared statements with parameter binding | Database engine handles escaping, prevents all injection vectors including Unicode attacks. |
| Full-text search | LIKE '%term%' queries or custom tokenization | SQLite FTS5 extension | Tokenization, stemming, BM25 ranking, phrase search, boolean operators - LIKE can't do any of this efficiently. |
| Date/time handling | Custom date parsing and formatting | SQLite datetime functions + ISO8601 strings | Handles timezones, date math, formatting edge cases (leap years, DST). |

**Key insight:** SQLite and better-sqlite3 provide battle-tested solutions for these problems. Custom solutions miss edge cases (concurrent access, Unicode, timezones, injection vectors) that took years to discover and fix in production systems.

## Common Pitfalls

### Pitfall 1: SQLITE_BUSY Errors Despite Busy Timeout
**What goes wrong:** Database returns SQLITE_BUSY immediately even with db.timeout() set, blocking operations fail
**Why it happens:** Upgrading a read transaction to write after it started causes immediate SQLITE_BUSY to prevent deadlock. Timeout is bypassed because SQLite detects potential deadlock.
**How to avoid:** Use BEGIN IMMEDIATE for all write transactions. Never BEGIN a transaction then decide to write later. better-sqlite3's db.transaction() handles this correctly.
**Warning signs:** SQLITE_BUSY errors under low load, errors occur immediately without retry delay

**Source:** https://berthub.eu/articles/posts/a-brief-post-on-sqlite3-database-locked-despite-timeout/

### Pitfall 2: Incorrect Composite Index Column Order
**What goes wrong:** Multi-column index created but queries still do table scans, slow performance
**Why it happens:** SQLite can only use index if WHERE clause matches columns from left-to-right. Query on 2nd column of (col1, col2) index can't use the index.
**How to avoid:** Put most selective filters first, equality filters before range filters. Use EXPLAIN QUERY PLAN to verify index usage.
**Warning signs:** EXPLAIN shows SCAN TABLE instead of SEARCH TABLE USING INDEX

**Source:** https://blog.sqlite.ai/choosing-the-right-index-in-sqlite

### Pitfall 3: Storing Dates as Integers or Locale Strings
**What goes wrong:** Date filtering and sorting broken, timezone bugs, date math requires application code
**Why it happens:** Developer stores Unix timestamps (integers) or locale-formatted strings instead of ISO8601
**How to avoid:** Always store dates as ISO8601 UTC strings (YYYY-MM-DDTHH:MM:SSZ). Use SQLite datetime functions for queries. Convert to local time only for display.
**Warning signs:** Date range queries return wrong results, sorting by date doesn't work, timezone conversion bugs

**Source:** https://www.slingacademy.com/article/date-and-time-handling-with-sqlite-functions-best-practices/

### Pitfall 4: Not Enabling Foreign Key Constraints
**What goes wrong:** Orphaned records, referential integrity violations, cascading deletes don't work
**Why it happens:** SQLite has foreign keys disabled by default for backwards compatibility
**How to avoid:** Run db.pragma('foreign_keys = ON') immediately after opening connection, before any queries
**Warning signs:** Tasks with project_id referencing deleted projects, tags for non-existent tasks

**Source:** https://www.npmjs.com/package/better-sqlite3

### Pitfall 5: Using Async Functions in Transactions
**What goes wrong:** Transaction commits before async operations complete, partial data written, no atomicity
**Why it happens:** better-sqlite3 db.transaction() returns after function completes. Async functions return immediately (Promise), so transaction commits before awaited operations run.
**How to avoid:** Never use async/await inside db.transaction(). Keep transaction functions synchronous. Do async work before or after transaction, not during.
**Warning signs:** Data inconsistencies, partial writes, "transaction already committed" errors

**Source:** https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md

### Pitfall 6: Missing Indexes on Foreign Keys
**What goes wrong:** JOINs and foreign key lookups are slow, full table scans on joins
**Why it happens:** SQLite doesn't auto-index foreign key columns. Developer creates foreign key but forgets index.
**How to avoid:** Create index on every foreign key column: CREATE INDEX idx_tasks_project_id ON tasks(project_id)
**Warning signs:** JOIN queries slow even with few rows, EXPLAIN shows SCAN on joined table

**Source:** https://www.sqlitetutorial.net/sqlite-index/

## Code Examples

Verified patterns from official sources:

### Database Setup with Migrations
```typescript
// Source: https://github.com/sequelize/umzug + https://www.npmjs.com/package/better-sqlite3
import Database from 'better-sqlite3';
import { Umzug, SequelizeStorage } from 'umzug';
import { Sequelize } from 'sequelize';

export function setupDatabase(filepath: string = './data/tasks.db') {
  // Initialize database with proper configuration
  const db = new Database(filepath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  db.timeout(5000);

  // Set up migrations
  const sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: filepath,
    logging: false
  });

  const umzug = new Umzug({
    migrations: {
      glob: 'src/db/migrations/*.ts',
    },
    context: sequelize.getQueryInterface(),
    storage: new SequelizeStorage({ sequelize }),
    logger: console,
  });

  return { db, umzug };
}

// Run migrations
export async function runMigrations(umzug: Umzug) {
  await umzug.up();
}
```

### Repository with Prepared Statements
```typescript
// Source: https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md
import Database from 'better-sqlite3';

export class TaskRepository implements ITaskRepository {
  private db: Database.Database;
  private stmts: {
    insert: Database.Statement;
    findById: Database.Statement;
    update: Database.Statement;
    delete: Database.Statement;
  };

  constructor(db: Database.Database) {
    this.db = db;

    // Prepare statements once for reuse (performance optimization)
    this.stmts = {
      insert: db.prepare(`
        INSERT INTO tasks (title, description, status, priority, project_id, assignee, due_date, created_by, created_at)
        VALUES (@title, @description, @status, @priority, @project_id, @assignee, @due_date, @created_by, @created_at)
      `),
      findById: db.prepare(`
        SELECT * FROM tasks WHERE id = ?
      `),
      update: db.prepare(`
        UPDATE tasks
        SET title = @title, description = @description, status = @status,
            priority = @priority, assignee = @assignee, due_date = @due_date,
            updated_at = @updated_at
        WHERE id = @id
      `),
      delete: db.prepare(`DELETE FROM tasks WHERE id = ?`)
    };
  }

  create(task: CreateTaskDTO): Task {
    const now = new Date().toISOString();
    const result = this.stmts.insert.run({
      ...task,
      created_at: now,
    });

    return this.stmts.findById.get(result.lastInsertRowid) as Task;
  }

  findById(id: number): Task | null {
    return this.stmts.findById.get(id) as Task | null;
  }

  update(id: number, updates: Partial<Task>): Task {
    const now = new Date().toISOString();
    this.stmts.update.run({
      id,
      ...updates,
      updated_at: now,
    });

    return this.stmts.findById.get(id) as Task;
  }

  delete(id: number): void {
    this.stmts.delete.run(id);
  }
}
```

### Complex Filter Query with Composite Index
```typescript
// Source: https://www.slingacademy.com/article/using-composite-indexes-in-sqlite-for-complex-queries/
export interface TaskFilters {
  project_id?: number;
  status?: TaskStatus;
  assignee?: string;
  tags?: string[];
  due_before?: string; // ISO8601
  due_after?: string;  // ISO8601
  search?: string;      // Full-text search
}

export class TaskRepository {
  findByFilters(filters: TaskFilters): Task[] {
    // Build dynamic query based on provided filters
    const conditions: string[] = [];
    const params: Record<string, any> = {};

    if (filters.project_id !== undefined) {
      conditions.push('t.project_id = @project_id');
      params.project_id = filters.project_id;
    }

    if (filters.status !== undefined) {
      conditions.push('t.status = @status');
      params.status = filters.status;
    }

    if (filters.assignee !== undefined) {
      conditions.push('t.assignee = @assignee');
      params.assignee = filters.assignee;
    }

    if (filters.due_before !== undefined) {
      conditions.push('t.due_date < @due_before');
      params.due_before = filters.due_before;
    }

    if (filters.due_after !== undefined) {
      conditions.push('t.due_date > @due_after');
      params.due_after = filters.due_after;
    }

    if (filters.tags && filters.tags.length > 0) {
      conditions.push(`
        EXISTS (
          SELECT 1 FROM task_tags tt
          WHERE tt.task_id = t.id
          AND tt.tag IN (${filters.tags.map((_, i) => `@tag${i}`).join(',')})
        )
      `);
      filters.tags.forEach((tag, i) => {
        params[`tag${i}`] = tag;
      });
    }

    if (filters.search) {
      conditions.push(`
        t.id IN (
          SELECT task_id FROM tasks_fts
          WHERE tasks_fts MATCH @search
        )
      `);
      params.search = filters.search;
    }

    const whereClause = conditions.length > 0
      ? `WHERE ${conditions.join(' AND ')}`
      : '';

    const query = `
      SELECT DISTINCT t.*
      FROM tasks t
      ${whereClause}
      ORDER BY t.created_at DESC
    `;

    return this.db.prepare(query).all(params) as Task[];
  }
}
```

### Service with Status Lifecycle Validation
```typescript
// Source: https://zod.dev/ + business logic patterns
const VALID_STATUS_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  open: ['in_progress', 'blocked', 'closed'],
  in_progress: ['done', 'blocked', 'open'],
  blocked: ['open', 'in_progress'],
  done: ['closed', 'open'],  // Can reopen if needed
  closed: ['open'],  // Can reopen closed tasks
};

export class TaskService {
  constructor(private taskRepo: ITaskRepository) {}

  updateStatus(taskId: number, newStatus: TaskStatus): Task {
    const task = this.taskRepo.findById(taskId);
    if (!task) {
      throw new NotFoundError(`Task ${taskId} not found`);
    }

    // Validate status transition
    const validTransitions = VALID_STATUS_TRANSITIONS[task.status];
    if (!validTransitions.includes(newStatus)) {
      throw new BusinessError(
        `Invalid status transition: ${task.status} -> ${newStatus}. ` +
        `Valid transitions: ${validTransitions.join(', ')}`
      );
    }

    return this.taskRepo.update(taskId, { status: newStatus });
  }
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| node-sqlite3 async API | better-sqlite3 sync API | 2017 | Simpler transaction handling, 2-3x faster, eliminated callback/promise complexity |
| Manual WAL mode setup | Compile-time SQLITE_DEFAULT_WAL_SYNCHRONOUS=1 | 2020 | WAL defaults to NORMAL synchronous, no manual pragma needed (but explicit is better) |
| FTS3/FTS4 | FTS5 | 2015 (SQLite 3.9.0) | Better ranking (BM25), faster, more features. Always use FTS5, not FTS3/4. |
| Joi validation | Zod validation | 2020-2021 | Better TypeScript inference, smaller bundle, schema-first design |
| db-migrate | Umzug 3.x | 2021 | Native TypeScript support, programmatic API, framework-agnostic |
| WITHOUT ROWID optimization | Regular rowid tables | Context-dependent | Only use WITHOUT ROWID for tables with INTEGER PRIMARY KEY lookups. Most tables should use default rowid. |

**Deprecated/outdated:**
- **FTS3/FTS4:** Use FTS5 for all new projects (https://sqlite.org/fts5.html)
- **node-sqlite3:** Use better-sqlite3 for Node.js projects (better-sqlite3 is maintained, faster, simpler)
- **Joi validation:** Zod has better TypeScript integration
- **Manual transaction management:** Use db.transaction() wrapper instead of manual BEGIN/COMMIT

## Open Questions

1. **Migration tool for SQLite-specific features**
   - What we know: Umzug works but uses Sequelize query interface which may not expose all SQLite features (FTS5, triggers)
   - What's unclear: Can Umzug migrations create FTS5 virtual tables and triggers, or do we need raw SQL?
   - Recommendation: Use Umzug with raw SQL via sequelize.query() for SQLite-specific features. Test FTS5 creation in first migration.

2. **Single-writer queue implementation**
   - What we know: SQLite is single-writer, WAL mode helps readers not block writers
   - What's unclear: Should we implement application-level write queue, or rely on busy_timeout + BEGIN IMMEDIATE?
   - Recommendation: Start with busy_timeout(5000) + BEGIN IMMEDIATE. Add application queue only if SQLITE_BUSY errors persist under load testing.

3. **Concurrency limits for this use case**
   - What we know: better-sqlite3 is synchronous, one connection per process
   - What's unclear: Will single connection handle concurrent reads + occasional writes for multi-user task management?
   - Recommendation: Test with realistic load (10-50 concurrent operations). SQLite handles thousands of reads/sec, writes are sequential but fast (<1ms typically).

## Sources

### Primary (HIGH confidence)
- better-sqlite3 official docs: https://github.com/WiseLibs/better-sqlite3 and https://www.npmjs.com/package/better-sqlite3
- SQLite official documentation: https://sqlite.org/fts5.html, https://www.sqlite.org/lang_transaction.html, https://www.sqlite.org/inmemorydb.html
- Zod official documentation: https://zod.dev/
- Umzug GitHub repository: https://github.com/sequelize/umzug

### Secondary (MEDIUM confidence)
- [How to Use SQLite in Node.js Applications](https://oneuptime.com/blog/post/2026-02-02-sqlite-nodejs/view) - WAL mode configuration
- [Choosing the Right Index in SQLite](https://blog.sqlite.ai/choosing-the-right-index-in-sqlite) - Index optimization patterns
- [SQLite Full-Text Search (FTS5) in Practice](https://thelinuxcode.com/sqlite-full-text-search-fts5-in-practice-fast-search-ranking-and-real-world-patterns/) - FTS5 implementation
- [Date and Time Handling with SQLite Functions: Best Practices](https://www.slingacademy.com/article/date-and-time-handling-with-sqlite-functions-best-practices/) - ISO8601 date handling
- [How to Validate Data with Zod in TypeScript](https://oneuptime.com/blog/post/2026-01-25-zod-validation-typescript/view) - Zod patterns
- [The Repository pattern with TypeScript](https://www.abdou.dev/blog/the-repository-pattern-with-typescript) - Repository architecture
- [What to do about SQLITE_BUSY errors despite setting a timeout](https://berthub.eu/articles/posts/a-brief-post-on-sqlite3-database-locked-despite-timeout/) - Transaction pitfalls
- [Using Composite Indexes in SQLite for Complex Queries](https://www.slingacademy.com/article/using-composite-indexes-in-sqlite-for-complex-queries/) - Multi-column indexes
- [Using in-memory SQLite for testing](https://coobird.net/blog/2023/08/05/using-sqlite-inmemory-for-testing.html) - Testing patterns

### Tertiary (LOW confidence - marked for validation)
- Various StackOverflow and Medium articles on Node.js patterns - general guidance only, verify against official docs

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - better-sqlite3, Zod, Umzug are industry standards with official documentation verified
- Architecture: MEDIUM-HIGH - Patterns verified via official docs and multiple sources, but specific integration untested
- Pitfalls: MEDIUM-HIGH - Common pitfalls documented in official SQLite docs and community blog posts from SQLite experts
- FTS5 implementation: MEDIUM - Official SQLite docs, but Node.js-specific patterns from secondary sources
- Migration tooling: MEDIUM - Umzug verified but SQLite-specific feature support needs validation

**Research date:** 2026-02-13
**Valid until:** ~2026-03-13 (30 days - stable technology stack, unlikely to change rapidly)
