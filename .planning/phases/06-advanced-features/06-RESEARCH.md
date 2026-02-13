# Phase 6: Advanced Features - Research

**Researched:** 2026-02-13
**Domain:** Hierarchical task relationships, dependency graphs with cycle detection, collaboration features (comments, time estimates)
**Confidence:** HIGH

## Summary

Phase 6 extends the core task model with hierarchical relationships (parent/child subtasks), dependency graphs (blocks/requires), circular dependency detection via DFS graph traversal, task comments with author/timestamp, and time estimates. The architecture builds on Phase 1's SQLite foundation using self-referencing foreign keys for hierarchies, separate junction tables for many-to-many dependencies, and application-level cycle detection.

SQLite supports hierarchical queries via recursive CTEs but does not provide built-in cycle detection—cycles must be prevented at write-time using DFS traversal with a recursion stack to detect back edges (O(V+E) time complexity). The standard pattern uses adjacency lists for storage with application-level validation before writes, avoiding the storage overhead of closure tables while maintaining query simplicity for common operations.

Comments are stored in a separate table with foreign keys to tasks, indexed on task_id and created_at for chronological retrieval. Time estimates follow best practice of storing as INTEGER minutes (not strings) for efficient calculations, with optional ISO 8601 duration formatting at the presentation layer.

**Primary recommendation:** Use adjacency list pattern for parent/child relationships, separate task_dependencies junction table for blocks/requires, TypeScript DFS cycle detection with Map-based adjacency graph built from database queries, INTEGER storage for time estimates in minutes, and separate task_comments table with composite index on (task_id, created_at).

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| better-sqlite3 | 12.6.2 | SQLite driver (from Phase 1) | Synchronous API simplifies transaction handling for write validation |
| Zod | 3.x | Runtime validation (from Phase 1) | Validates dependency inputs, detects invalid relationships before DB writes |
| TypeScript | 5.7+ | Type safety | Native Map/Set support for efficient graph data structures |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| None required | - | - | Cycle detection implemented in-app with native TypeScript data structures |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Adjacency list + app validation | Closure table pattern | Closure table: faster reads for deep trees, but 10x storage overhead and complex write logic |
| INTEGER minutes | ISO 8601 duration strings (PT1H30M) | Strings: human-readable, but slower aggregations and complex parsing |
| Application-level DFS | SQLite recursive CTE with UNION deduplication | CTE: detects cycles at query time, but cannot prevent writes (cycles discovered after-the-fact) |

**Installation:**
No new dependencies required. Uses existing Phase 1 stack.

## Architecture Patterns

### Recommended Project Structure
```
src/
├── db/
│   ├── migrations/
│   │   ├── 006_add_task_hierarchy.ts         # Parent/child columns
│   │   ├── 007_add_task_dependencies.ts      # Junction table
│   │   ├── 008_add_task_comments.ts          # Comments table
│   │   └── 009_add_time_estimates.ts         # Estimate column
│   └── database.ts
├── repositories/
│   ├── task.repository.ts                     # Extended with hierarchy queries
│   ├── dependency.repository.ts               # NEW: dependency CRUD
│   └── comment.repository.ts                  # NEW: comment CRUD
├── services/
│   ├── task.service.ts
│   ├── dependency.service.ts                  # NEW: cycle detection logic
│   └── comment.service.ts                     # NEW: comment business logic
├── utils/
│   └── cycle-detector.ts                      # NEW: DFS algorithm
└── schemas/
    ├── dependency.schema.ts                   # NEW: Zod schemas
    └── comment.schema.ts                      # NEW: Zod schemas
```

### Pattern 1: Self-Referencing Foreign Key for Parent/Child
**What:** Task table with optional parent_task_id column referencing tasks.id
**When to use:** Hierarchical relationships where a task can have multiple children but one parent
**Example:**
```sql
-- Source: https://www.sqlitetutorial.net/sqlite-foreign-key/ + https://learnsql.com/blog/query-parent-child-tree/
ALTER TABLE tasks ADD COLUMN parent_task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE;

-- Index for finding children of a parent
CREATE INDEX idx_tasks_parent_id ON tasks(parent_task_id);

-- Query to get all direct children
SELECT * FROM tasks WHERE parent_task_id = ?;

-- Recursive CTE to get entire subtree
WITH RECURSIVE subtree AS (
  SELECT * FROM tasks WHERE id = ?
  UNION ALL
  SELECT t.* FROM tasks t
  JOIN subtree ON t.parent_task_id = subtree.id
)
SELECT * FROM subtree;
```

### Pattern 2: Junction Table for Dependency Graph
**What:** Many-to-many relationship table linking tasks via blocks/requires
**When to use:** Dependency relationships where Task A blocks Task B (Task B requires Task A)
**Example:**
```sql
-- Source: https://sqlite.org/foreignkeys.html + https://www.geeksforgeeks.org/sqlite/how-to-create-a-sqlite-hierarchical-recursive-query/
CREATE TABLE task_dependencies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  blocks_task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(task_id, blocks_task_id),
  CHECK(task_id != blocks_task_id) -- Prevent self-dependencies
);

-- Composite index for "what does this task block?"
CREATE INDEX idx_dependencies_task ON task_dependencies(task_id);

-- Composite index for "what blocks this task?"
CREATE INDEX idx_dependencies_blocked ON task_dependencies(blocks_task_id);

-- Query: What tasks does Task A block?
SELECT t.* FROM tasks t
JOIN task_dependencies d ON t.id = d.blocks_task_id
WHERE d.task_id = ?;

-- Query: What tasks are blocked by (require) Task A?
SELECT t.* FROM tasks t
JOIN task_dependencies d ON t.id = d.task_id
WHERE d.blocks_task_id = ?;
```

### Pattern 3: Application-Level Cycle Detection with DFS
**What:** Build adjacency list in memory, perform DFS with recursion stack to detect back edges
**When to use:** Before inserting new dependency relationship (validation step)
**Example:**
```typescript
// Source: https://www.geeksforgeeks.org/dsa/detect-cycle-in-a-graph/ + https://ricardoborges.dev/blog/data-structures-in-typescript-graph
export class CycleDetector {
  private adjacencyList: Map<number, Set<number>>;

  constructor(dependencies: Array<{ task_id: number; blocks_task_id: number }>) {
    // Build adjacency list from dependencies
    this.adjacencyList = new Map();

    for (const dep of dependencies) {
      if (!this.adjacencyList.has(dep.task_id)) {
        this.adjacencyList.set(dep.task_id, new Set());
      }
      this.adjacencyList.get(dep.task_id)!.add(dep.blocks_task_id);
    }
  }

  /**
   * Detect if adding a new edge would create a cycle
   * @param from Task that blocks
   * @param to Task that is blocked
   * @returns true if adding edge creates cycle
   */
  wouldCreateCycle(from: number, to: number): boolean {
    // Temporarily add the edge
    if (!this.adjacencyList.has(from)) {
      this.adjacencyList.set(from, new Set());
    }
    this.adjacencyList.get(from)!.add(to);

    const hasCycle = this.detectCycle();

    // Remove temporary edge
    this.adjacencyList.get(from)!.delete(to);

    return hasCycle;
  }

  private detectCycle(): boolean {
    const visited = new Set<number>();
    const recStack = new Set<number>(); // Recursion stack to track current path

    // Check all nodes (graph may be disconnected)
    for (const node of this.adjacencyList.keys()) {
      if (!visited.has(node)) {
        if (this.dfs(node, visited, recStack)) {
          return true;
        }
      }
    }
    return false;
  }

  private dfs(node: number, visited: Set<number>, recStack: Set<number>): boolean {
    visited.add(node);
    recStack.add(node); // Mark as part of current DFS path

    const neighbors = this.adjacencyList.get(node) || new Set();
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        // Recurse on unvisited neighbor
        if (this.dfs(neighbor, visited, recStack)) {
          return true; // Cycle found in deeper recursion
        }
      } else if (recStack.has(neighbor)) {
        // Back edge detected: neighbor is in current path
        return true;
      }
    }

    recStack.delete(node); // Remove from path when backtracking
    return false;
  }
}

// Usage in DependencyService
export class DependencyService {
  async addDependency(taskId: number, blocksTaskId: number): Promise<void> {
    // 1. Validate inputs
    // 2. Load all existing dependencies
    const allDeps = await this.dependencyRepo.findAll();

    // 3. Check for cycles
    const detector = new CycleDetector(allDeps);
    if (detector.wouldCreateCycle(taskId, blocksTaskId)) {
      throw new BusinessError('Cannot add dependency: would create circular dependency');
    }

    // 4. Insert dependency
    await this.dependencyRepo.create({ task_id: taskId, blocks_task_id: blocksTaskId });
  }
}
```

### Pattern 4: Comments Table with Chronological Indexing
**What:** Separate table for task comments with author, timestamp, and task foreign key
**When to use:** COLLAB-01 requirement for task collaboration
**Example:**
```sql
-- Source: https://www.sqliteforum.com/p/effective-schema-design-for-sqlite + https://moldstud.com/articles/p-best-practices-for-database-schema-design-in-sqlite
CREATE TABLE task_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);

-- Composite index for retrieving comments by task in chronological order
CREATE INDEX idx_comments_task_created ON task_comments(task_id, created_at);

-- Query: Get all comments for a task (chronological order)
SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at ASC;
```

### Pattern 5: Time Estimates as INTEGER Minutes
**What:** Store time estimates as INTEGER minutes for efficient calculations
**When to use:** COLLAB-02 requirement for time tracking
**Example:**
```sql
-- Source: https://www.quora.com/What-is-the-best-way-to-store-a-duration-in-MySQL + https://www.sqlservercentral.com/forums/topic/best-practice-to-store-how-many-days-minute-and-second
ALTER TABLE tasks ADD COLUMN estimated_minutes INTEGER;

-- Query: Sum estimates for a project
SELECT SUM(estimated_minutes) as total_minutes FROM tasks WHERE project_id = ?;

-- Query: Convert to hours for display (handled by service layer)
SELECT id, title, estimated_minutes,
       CAST(estimated_minutes / 60 AS INTEGER) as hours,
       estimated_minutes % 60 as remaining_minutes
FROM tasks WHERE estimated_minutes IS NOT NULL;
```

```typescript
// Service layer: Format as ISO 8601 duration for API responses
function formatEstimate(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `PT${hours}H${mins}M`; // Example: PT2H30M for 150 minutes
}

// Parse ISO 8601 duration to minutes
function parseEstimate(duration: string): number {
  const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
  if (!match) throw new Error('Invalid duration format');
  const hours = parseInt(match[1] || '0', 10);
  const minutes = parseInt(match[2] || '0', 10);
  return hours * 60 + minutes;
}
```

### Anti-Patterns to Avoid
- **Closure table without justification:** Don't use closure tables unless deep tree queries are frequent (adds storage/complexity)
- **String-based time storage:** Don't store durations as "1h 30m" strings—use INTEGER minutes
- **Detecting cycles at query time:** Don't rely on SQLite UNION to prevent cycles—validate before writes
- **Missing indexes on foreign keys:** Always index parent_task_id, task_id, blocks_task_id for join performance

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Cycle detection in database | Custom SQL recursive queries with LIMIT hacks | Application-level DFS with recursion stack | SQLite has no built-in cycle detection; UNION only prevents infinite loops, doesn't prevent cycle creation |
| Graph visualization | DOT format generator, rendering engine | Defer to v2 (ADV-06) or use existing libraries | Complex problem, low value for Phase 6 core requirements |
| Duration parsing | Regex-based parsers for multiple formats | ISO 8601 parser library or store as INTEGER | Edge cases: negative durations, fractional minutes, timezone confusion |
| Comment threading | Nested comment structure with parent_comment_id | Simple flat comments with chronological order | Requirements specify basic comments, not Reddit-style threading |

**Key insight:** Graph cycle detection is algorithmically straightforward (DFS with recursion stack) but error-prone to implement—spend time on correct implementation rather than prematurely optimizing for exotic cases.

## Common Pitfalls

### Pitfall 1: Forgetting to Index Self-Referencing Foreign Keys
**What goes wrong:** Queries for "find children of parent X" become slow table scans
**Why it happens:** SQLite doesn't auto-index foreign key columns (only primary keys)
**How to avoid:** Explicitly create index on parent_task_id: `CREATE INDEX idx_tasks_parent_id ON tasks(parent_task_id);`
**Warning signs:** EXPLAIN QUERY PLAN shows "SCAN TABLE tasks" instead of "SEARCH TABLE tasks USING INDEX"

### Pitfall 2: Data Type Mismatch in Foreign Keys
**What goes wrong:** SQLite allows FK creation with mismatched types, causing silent failures later
**Why it happens:** SQLite's dynamic typing doesn't enforce strict FK type matching
**How to avoid:** Verify parent and child columns use same type (INTEGER for IDs), test with `PRAGMA foreign_key_check;`
**Warning signs:** Cascade deletes don't work, orphaned records appear

### Pitfall 3: Inefficient Cycle Detection—Loading All Tasks
**What goes wrong:** Building full task graph when only checking dependencies for cycle detection
**Why it happens:** Confusion between task hierarchy (parent/child) and dependency graph (blocks/requires)
**How to avoid:** CycleDetector only needs task_dependencies table, not full tasks table
**Warning signs:** Memory usage spikes, slow dependency creation for large task counts

### Pitfall 4: Missing CHECK Constraint for Self-Dependencies
**What goes wrong:** Task A can be marked as blocking itself (task_id = blocks_task_id)
**Why it happens:** Application validation missed, no DB-level constraint
**How to avoid:** Add CHECK constraint: `CHECK(task_id != blocks_task_id)` in task_dependencies table
**Warning signs:** Cycle detector flags self-loops, degenerate dependency chains

### Pitfall 5: Deleting Dependencies Without CASCADE
**What goes wrong:** Deleting a task leaves orphaned dependency records
**Why it happens:** Forgetting `ON DELETE CASCADE` in foreign key definitions
**How to avoid:** Both task_id and blocks_task_id should use `ON DELETE CASCADE`
**Warning signs:** Dangling foreign keys, `PRAGMA foreign_key_check` reports violations

### Pitfall 6: Using UNION Instead of UNION ALL in Non-Cyclic Hierarchies
**What goes wrong:** Performance penalty from unnecessary duplicate elimination
**Why it happens:** Cargo-culting cycle prevention pattern (UNION) to parent/child hierarchies (tree, no cycles)
**How to avoid:** Parent/child is a tree (acyclic)—use UNION ALL. Dependencies are a graph (can have cycles)—use UNION for safety or application validation.
**Warning signs:** Slow recursive queries in strictly hierarchical structures

### Pitfall 7: Allowing Circular Dependencies Through Batch Updates
**What goes wrong:** Adding multiple dependencies simultaneously bypasses cycle detection
**Why it happens:** Cycle detection runs before batch, doesn't account for dependencies within the batch
**How to avoid:** Validate entire batch as a single graph update (build CycleDetector with existing + all new edges)
**Warning signs:** Cycles appear after bulk imports, cycle detector doesn't catch batch-created loops

### Pitfall 8: Storing ISO 8601 Durations as TEXT Without Validation
**What goes wrong:** Invalid duration strings like "1h30m" or "90 minutes" stored without parsing
**Why it happens:** Accepting user input directly without Zod schema validation
**How to avoid:** Store as INTEGER minutes, format as ISO 8601 only for API responses
**Warning signs:** Query aggregations fail, frontend can't parse duration values

## Code Examples

Verified patterns from research:

### Example 1: Zod Schema for Dependency Creation
```typescript
// Source: https://zod.dev/
import { z } from 'zod';

export const CreateDependencySchema = z.object({
  task_id: z.number().int().positive(),
  blocks_task_id: z.number().int().positive(),
}).refine(
  (data) => data.task_id !== data.blocks_task_id,
  { message: 'A task cannot depend on itself' }
);

export const CreateCommentSchema = z.object({
  task_id: z.number().int().positive(),
  author: z.string().min(1).max(100),
  content: z.string().min(1).max(5000),
});

export const UpdateTaskEstimateSchema = z.object({
  estimated_minutes: z.number().int().min(0).max(10080).nullable(), // Max 1 week
});
```

### Example 2: Repository Pattern for Dependencies
```typescript
// Source: Phase 1 research repository pattern
export interface IDependencyRepository {
  create(dep: { task_id: number; blocks_task_id: number }): Dependency;
  findAll(): Dependency[];
  findByTaskId(taskId: number): Dependency[];
  delete(id: number): boolean;
}

export class DependencyRepository implements IDependencyRepository {
  constructor(private db: Database.Database) {}

  create(dep: { task_id: number; blocks_task_id: number }): Dependency {
    const stmt = this.db.prepare(`
      INSERT INTO task_dependencies (task_id, blocks_task_id)
      VALUES (@task_id, @blocks_task_id)
    `);
    const result = stmt.run(dep);
    return this.findById(result.lastInsertRowid as number)!;
  }

  findAll(): Dependency[] {
    const stmt = this.db.prepare(`SELECT * FROM task_dependencies`);
    return stmt.all() as Dependency[];
  }

  findByTaskId(taskId: number): Dependency[] {
    const stmt = this.db.prepare(`
      SELECT * FROM task_dependencies WHERE task_id = ?
    `);
    return stmt.all(taskId) as Dependency[];
  }

  private findById(id: number): Dependency | undefined {
    const stmt = this.db.prepare(`SELECT * FROM task_dependencies WHERE id = ?`);
    return stmt.get(id) as Dependency | undefined;
  }

  delete(id: number): boolean {
    const stmt = this.db.prepare(`DELETE FROM task_dependencies WHERE id = ?`);
    const result = stmt.run(id);
    return result.changes > 0;
  }
}
```

### Example 3: Service Layer with Cycle Detection
```typescript
// Source: DFS algorithm + Phase 1 service pattern
import { CycleDetector } from '../utils/cycle-detector';
import { IDependencyRepository } from '../repositories/dependency.repository';
import { CreateDependencySchema } from '../schemas/dependency.schema';

export class DependencyService {
  constructor(private dependencyRepo: IDependencyRepository) {}

  async createDependency(input: unknown): Promise<Dependency> {
    // 1. Validate input
    const result = CreateDependencySchema.safeParse(input);
    if (!result.success) {
      throw new ValidationError(result.error.format());
    }

    const { task_id, blocks_task_id } = result.data;

    // 2. Load existing dependencies
    const allDeps = this.dependencyRepo.findAll();

    // 3. Check for cycles
    const detector = new CycleDetector(allDeps);
    if (detector.wouldCreateCycle(task_id, blocks_task_id)) {
      throw new BusinessError(
        `Cannot add dependency: Task ${task_id} -> ${blocks_task_id} would create a circular dependency`
      );
    }

    // 4. Create dependency
    return this.dependencyRepo.create({ task_id, blocks_task_id });
  }

  getBlockedTasks(taskId: number): Task[] {
    // Tasks that are blocked by this task (this task must complete first)
    const deps = this.dependencyRepo.findByTaskId(taskId);
    return deps.map(d => this.taskRepo.findById(d.blocks_task_id)).filter(Boolean);
  }

  getBlockingTasks(taskId: number): Task[] {
    // Tasks that block this task (must complete before this task can start)
    const allDeps = this.dependencyRepo.findAll();
    const blockingDeps = allDeps.filter(d => d.blocks_task_id === taskId);
    return blockingDeps.map(d => this.taskRepo.findById(d.task_id)).filter(Boolean);
  }
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Closure tables for all hierarchies | Adjacency list + selective closure tables | 2020+ | Adjacency lists with recursive CTEs now standard for most use cases; closure tables reserved for read-heavy deep trees |
| String duration storage ("1h 30m") | INTEGER minutes or ISO 8601 | 2015+ | INTEGER for storage, ISO 8601 for API; avoids parsing complexity and enables efficient aggregations |
| Database-enforced acyclic graphs | Application-level validation | Ongoing | Most RDBMS lack native cycle detection; application validation is standard practice |
| Nested sets for hierarchies | Recursive CTEs | 2011+ (SQLite 3.8.3) | Nested sets were clever hack before recursive CTEs; now obsolete for most SQL engines |

**Deprecated/outdated:**
- **Nested sets:** Pre-CTE pattern for tree traversal; complex updates, abandoned in favor of adjacency lists + recursive queries
- **EAV tables for comments:** Anti-pattern; normalized comments table is always superior
- **Storing durations as TIME type:** TIME is for clock times (12:30:00), not durations; use INTEGER or INTERVAL types

## Open Questions

1. **Deep hierarchy performance**
   - What we know: Recursive CTEs have O(N) performance for tree depth N
   - What's unclear: At what depth/width does adjacency list + CTE become slower than closure table?
   - Recommendation: Start with adjacency list, measure query performance, migrate to closure table only if evidence shows bottleneck (unlikely for task hierarchies <1000 items)

2. **Concurrent dependency creation**
   - What we know: better-sqlite3 is synchronous; cycle detector loads all deps
   - What's unclear: Race condition if two requests create dependencies simultaneously?
   - Recommendation: Wrap dependency creation in `db.transaction()` with BEGIN IMMEDIATE to serialize writes

3. **Topological sort for dependency ordering**
   - What we know: DFS can be extended to produce topological sort (task execution order)
   - What's unclear: Is this needed for Phase 6 requirements?
   - Recommendation: Defer to future phase unless REL-02 explicitly requires execution ordering (appears to be declarative relationship only)

## Sources

### Primary (HIGH confidence)
- [SQLite Recursive CTEs Official Documentation](https://sqlite.org/lang_with.html) - Recursive query syntax, limitations, cycle prevention patterns
- [SQLite Foreign Key Support](https://sqlite.org/foreignkeys.html) - FK constraints, ON DELETE CASCADE, data type requirements
- [Zod Official Documentation](https://zod.dev/) - Schema validation patterns for TypeScript

### Secondary (MEDIUM confidence)
- [GeeksforGeeks: Detect Cycle in a Directed Graph](https://www.geeksforgeeks.org/dsa/detect-cycle-in-a-graph/) - DFS algorithm with visited and recursion stack
- [LearnSQL: How to Query a Parent-Child Tree in SQL](https://learnsql.com/blog/query-parent-child-tree/) - Adjacency list patterns
- [SQLite Forum: Effective Schema Design](https://www.sqliteforum.com/p/effective-schema-design-for-sqlite) - Best practices for table design
- [Medium: Data Structures in TypeScript - Graph](https://ricardoborges.dev/blog/data-structures-in-typescript-graph) - TypeScript Map/Set graph implementation
- [Quora: What is the best way to store a duration in MySQL?](https://www.quora.com/What-is-the-best-way-to-store-a-duration-in-MySQL) - INTEGER minutes vs. other formats
- [ISO 8601 Duration Format (Wikipedia)](https://en.wikipedia.org/wiki/ISO_8601) - Duration format specification

### Tertiary (LOW confidence - WebSearch only)
- [W3Schools: DSA Graphs Cycle Detection](https://www.w3schools.com/dsa/dsa_algo_graphs_cycledetection.php) - Educational algorithm overview
- [MoldStud: Strategies for Managing Hierarchical Data in SQLite](https://moldstud.com/articles/p-strategies-for-managing-hierarchical-data-structures-in-sqlite) - Comparison of hierarchical patterns
- [Madge Circular Dependency Detection](https://deepwiki.com/pahen/madge/4.4-circular-dependency-detection) - Module dependency cycle detection (analogous problem)

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - Reuses Phase 1 foundation (better-sqlite3, Zod, TypeScript)
- Architecture: HIGH - DFS cycle detection is well-documented algorithm; adjacency list + recursive CTEs are standard SQLite patterns
- Pitfalls: MEDIUM-HIGH - Foreign key pitfalls verified via SQLite docs; cycle detection edge cases identified through research

**Research date:** 2026-02-13
**Valid until:** 2026-04-13 (60 days—stable domain, SQLite patterns don't change frequently)
