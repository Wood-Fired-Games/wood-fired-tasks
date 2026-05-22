import type Database from 'better-sqlite3';
import type {
  Task,
  CreateTaskDTO,
  UpdateTaskDTO,
  TaskFilters,
} from '../types/task.js';
import {
  DEFAULT_PAGE_LIMIT,
  DEFAULT_PAGE_OFFSET,
  MAX_PAGE_LIMIT,
} from '../types/task.js';
import type {
  ITaskRepository,
  CompletionRangeFilters,
  PaginationOptions,
} from './interfaces.js';
import { FtsSyntaxError, isSqliteFtsSyntaxError } from './errors.js';
import { mapRow, mapRows } from './row-mapper.js';
import type { SqlParams } from './types.js';

/**
 * Clamp pagination inputs into the supported repository range.
 *
 * The schema layer (Zod) already enforces these bounds for HTTP callers, but
 * the repository is also called directly from services and tests. Defending
 * here keeps every code path within the budget — a malicious or buggy caller
 * cannot ask SQLite to materialize an unbounded result set.
 */
function resolvePagination(pagination?: PaginationOptions): {
  limit: number;
  offset: number;
} {
  const rawLimit = pagination?.limit ?? DEFAULT_PAGE_LIMIT;
  const rawOffset = pagination?.offset ?? DEFAULT_PAGE_OFFSET;
  // Clamp to [1, MAX_PAGE_LIMIT]; non-finite or non-integer values collapse to default.
  const limit = Number.isFinite(rawLimit) && Number.isInteger(rawLimit) && rawLimit > 0
    ? Math.min(rawLimit, MAX_PAGE_LIMIT)
    : DEFAULT_PAGE_LIMIT;
  const offset = Number.isFinite(rawOffset) && Number.isInteger(rawOffset) && rawOffset >= 0
    ? rawOffset
    : DEFAULT_PAGE_OFFSET;
  return { limit, offset };
}

// SQLite's datetime('now') stores "YYYY-MM-DD HH:MM:SS" while JS
// new Date().toISOString() stores "YYYY-MM-DDTHH:MM:SS.sssZ". Normalize the
// former to the latter so API responses present a single canonical shape.
function normalizeIsoTimestamp(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/.exec(value);
  return match ? match[1] + 'T' + match[2] + '.000Z' : value;
}

function normalizeTaskTimestamps<T extends { updated_at: string }>(task: T): T {
  return { ...task, updated_at: normalizeIsoTimestamp(task.updated_at) };
}

export class TaskRepository implements ITaskRepository {
  private insertTaskStmt: Database.Statement;
  private findByIdStmt: Database.Statement;
  private deleteStmt: Database.Statement;
  private findTagsByTaskIdStmt: Database.Statement;
  private insertTagStmt: Database.Statement;
  private deleteTagsByTaskIdStmt: Database.Statement;

  constructor(private db: Database.Database) {
    // Prepare reusable statements
    this.insertTaskStmt = db.prepare(`
      INSERT INTO tasks (
        title, description, status, priority, project_id, parent_task_id,
        estimated_minutes, assignee, created_by, due_date, created_at, updated_at
      ) VALUES (
        @title, @description, @status, @priority, @project_id, @parent_task_id,
        @estimated_minutes, @assignee, @created_by, @due_date, @created_at, @updated_at
      )
    `);

    this.findByIdStmt = db.prepare('SELECT * FROM tasks WHERE id = ?');
    this.deleteStmt = db.prepare('DELETE FROM tasks WHERE id = ?');
    this.findTagsByTaskIdStmt = db.prepare(
      'SELECT tag FROM task_tags WHERE task_id = ? ORDER BY tag'
    );
    this.insertTagStmt = db.prepare(
      'INSERT INTO task_tags (task_id, tag) VALUES (?, ?)'
    );
    this.deleteTagsByTaskIdStmt = db.prepare(
      'DELETE FROM task_tags WHERE task_id = ?'
    );
  }

  create(dto: CreateTaskDTO, tags?: string[]): Task & { tags: string[] } {
    const now = new Date().toISOString();

    const result = this.db.transaction(() => {
      // Insert task
      const info = this.insertTaskStmt.run({
        title: dto.title,
        description: dto.description || null,
        status: dto.status,
        priority: dto.priority,
        project_id: dto.project_id,
        parent_task_id: dto.parent_task_id || null,
        estimated_minutes: dto.estimated_minutes ?? null,
        assignee: dto.assignee || null,
        created_by: dto.created_by,
        due_date: dto.due_date || null,
        created_at: now,
        updated_at: now,
      });

      const taskId = info.lastInsertRowid as number;

      // Insert tags if provided
      if (tags && tags.length > 0) {
        for (const tag of tags) {
          this.insertTagStmt.run(taskId, tag);
        }
      }

      return this.findById(taskId);
    })();

    if (!result) {
      throw new Error('Failed to create task');
    }

    return result;
  }

  findById(id: number): (Task & { tags: string[] }) | null {
    const task = mapRow<Task>(this.findByIdStmt, id);
    if (!task) {
      return null;
    }

    // Load tags
    const tagRows = mapRows<{ tag: string }>(this.findTagsByTaskIdStmt, id);
    const tags = tagRows.map((row) => row.tag);

    return normalizeTaskTimestamps({ ...task, tags });
  }

  findAll(pagination?: PaginationOptions): Array<Task & { tags: string[] }> {
    const { limit, offset } = resolvePagination(pagination);
    // Use LEFT JOIN with GROUP_CONCAT to get tasks (page) with their tags.
    // LIMIT/OFFSET bound the result set so a 100k-row table cannot DoS the
    // request via GROUP_CONCAT materialization.
    const rows = mapRows<Task & { tags_csv: string | null }>(
      this.db.prepare(
        `
      SELECT
        t.*,
        GROUP_CONCAT(tt.tag, ',') as tags_csv
      FROM tasks t
      LEFT JOIN task_tags tt ON tt.task_id = t.id
      GROUP BY t.id
      ORDER BY t.created_at DESC
      LIMIT ? OFFSET ?
    `,
      ),
      limit,
      offset,
    );

    return rows.map((row) => {
      const { tags_csv, ...task } = row;
      const tags = tags_csv ? tags_csv.split(',').sort() : [];
      return normalizeTaskTimestamps({ ...task, tags });
    });
  }

  update(
    id: number,
    updates: UpdateTaskDTO
  ): Task & { tags: string[] } {
    const result = this.db.transaction(() => {
      // Build dynamic UPDATE SET clause
      const fields: string[] = [];
      const params: SqlParams = { id };

      // Only update fields that are provided (excluding tags)
      if (updates.title !== undefined) {
        fields.push('title = @title');
        params.title = updates.title;
      }
      if (updates.description !== undefined) {
        fields.push('description = @description');
        params.description = updates.description;
      }
      if (updates.status !== undefined) {
        fields.push('status = @status');
        params.status = updates.status;

        // Maintain completed_at on transitions to/from 'done'.
        // Read current status inside the same transaction for consistency.
        const current = mapRow<{
          status: string;
          completed_at: string | null;
        }>(this.findByIdStmt, id);
        const movingIntoDone =
          updates.status === 'done' && current?.status !== 'done';
        const movingOutOfDone =
          current?.status === 'done' && updates.status !== 'done';

        if (movingIntoDone) {
          fields.push("completed_at = datetime('now')");
        } else if (movingOutOfDone) {
          fields.push('completed_at = NULL');
        }
      }
      if (updates.priority !== undefined) {
        fields.push('priority = @priority');
        params.priority = updates.priority;
      }
      if (updates.assignee !== undefined) {
        fields.push('assignee = @assignee');
        params.assignee = updates.assignee;
      }
      if (updates.due_date !== undefined) {
        fields.push('due_date = @due_date');
        params.due_date = updates.due_date;
      }
      if (updates.parent_task_id !== undefined) {
        fields.push('parent_task_id = @parent_task_id');
        params.parent_task_id = updates.parent_task_id;
      }
      if (updates.estimated_minutes !== undefined) {
        fields.push('estimated_minutes = @estimated_minutes');
        params.estimated_minutes = updates.estimated_minutes;
      }

      // Always update updated_at
      fields.push("updated_at = datetime('now')");

      // Run update if there are fields to update
      if (fields.length > 0) {
        const updateStmt = this.db.prepare(
          `UPDATE tasks SET ${fields.join(', ')} WHERE id = @id`
        );
        updateStmt.run(params);
      }

      // Handle tags update if provided
      if (updates.tags !== undefined) {
        // Delete all existing tags
        this.deleteTagsByTaskIdStmt.run(id);

        // Insert new tags if any
        if (updates.tags.length > 0) {
          for (const tag of updates.tags) {
            this.insertTagStmt.run(id, tag);
          }
        }
      }

      return this.findById(id);
    })();

    if (!result) {
      throw new Error(`Task with id ${id} not found`);
    }

    return result;
  }

  delete(id: number): void {
    this.deleteStmt.run(id);
  }

  findByFilters(filters: TaskFilters): Array<Task & { tags: string[] }> {
    const whereClauses: string[] = [];
    const params: SqlParams = {};

    // Build WHERE clause from filters
    if (filters.project_id !== undefined) {
      whereClauses.push('t.project_id = @project_id');
      params.project_id = filters.project_id;
    }

    if (filters.status !== undefined) {
      whereClauses.push('t.status = @status');
      params.status = filters.status;
    }

    if (filters.assignee !== undefined) {
      whereClauses.push('t.assignee = @assignee');
      params.assignee = filters.assignee;
    }

    if (filters.due_before !== undefined) {
      whereClauses.push('t.due_date <= @due_before');
      params.due_before = filters.due_before;
    }

    if (filters.due_after !== undefined) {
      whereClauses.push('t.due_date >= @due_after');
      params.due_after = filters.due_after;
    }

    // Wrap updated_at comparisons in datetime() to handle mixed storage
    // formats: "YYYY-MM-DDTHH:MM:SS.sssZ" (JS toISOString) and
    // "YYYY-MM-DD HH:MM:SS" (SQLite datetime('now')).
    if (filters.updated_before !== undefined) {
      whereClauses.push('datetime(t.updated_at) <= datetime(@updated_before)');
      params.updated_before = filters.updated_before;
    }

    if (filters.updated_after !== undefined) {
      whereClauses.push('datetime(t.updated_at) >= datetime(@updated_after)');
      params.updated_after = filters.updated_after;
    }

    if (filters.tags !== undefined && filters.tags.length > 0) {
      // Use EXISTS with parameterized IN clause
      const tagPlaceholders = filters.tags
        .map((_, i) => `@tag${i}`)
        .join(', ');
      whereClauses.push(
        `EXISTS (SELECT 1 FROM task_tags tt WHERE tt.task_id = t.id AND tt.tag IN (${tagPlaceholders}))`
      );
      filters.tags.forEach((tag, i) => {
        params[`tag${i}`] = tag;
      });
    }

    if (filters.search !== undefined) {
      // Use FTS5 MATCH for text search
      whereClauses.push(
        't.id IN (SELECT rowid FROM tasks_fts WHERE tasks_fts MATCH @search)'
      );
      params.search = filters.search;
    }

    // Build final query
    const whereClause =
      whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    // Apply pagination so the server never materializes an unbounded result
    // set. The schema layer caps `limit` at 500; this is a defence in depth
    // for direct service/repo callers.
    const { limit, offset } = resolvePagination({
      limit: filters.limit,
      offset: filters.offset,
    });
    params.__limit = limit;
    params.__offset = offset;

    const query = `
      SELECT
        t.*,
        GROUP_CONCAT(tt.tag, ',') as tags_csv
      FROM tasks t
      LEFT JOIN task_tags tt ON tt.task_id = t.id
      ${whereClause}
      GROUP BY t.id
      ORDER BY t.created_at DESC
      LIMIT @__limit OFFSET @__offset
    `;

    // FTS5 MATCH parses user-supplied search syntax at query time. Malformed
    // expressions (e.g. unterminated quote, `NEAR(`, bare `*`) throw
    // SQLITE_ERROR with raw parser text. Catch and re-throw as FtsSyntaxError
    // ONLY when the caller actually provided a search filter — otherwise
    // unrelated SQLITE_ERRORs would be misclassified.
    let rows: Array<Task & { tags_csv: string | null }>;
    try {
      rows = mapRows<Task & { tags_csv: string | null }>(
        this.db.prepare(query),
        params,
      );
    } catch (err) {
      if (filters.search !== undefined && isSqliteFtsSyntaxError(err)) {
        throw new FtsSyntaxError((err as Error).message);
      }
      throw err;
    }

    return rows.map((row) => {
      const { tags_csv, ...task } = row;
      const tags = tags_csv ? tags_csv.split(',').sort() : [];
      return normalizeTaskTimestamps({ ...task, tags });
    });
  }

  claimTask(id: number, assignee: string): (Task & { tags: string[] }) | null {
    // Use .immediate() to acquire write lock early (BEGIN IMMEDIATE)
    // This prevents SQLITE_BUSY when multiple agents try to claim simultaneously
    const claimTransaction = this.db.transaction(() => {
      // Read current task state
      const task = mapRow<import('../types/task.js').Task>(
        this.findByIdStmt,
        id,
      );
      if (!task) return null;

      // CAS: only claim if unassigned and status is 'open'
      const claimStmt = this.db.prepare(
        `UPDATE tasks
         SET assignee = ?, status = 'in_progress', version = version + 1,
             claimed_at = datetime('now'), updated_at = datetime('now')
         WHERE id = ? AND assignee IS NULL AND status = 'open' AND version = ?`
      );
      const info = claimStmt.run(assignee, id, task.version);

      if (info.changes === 0) {
        // CAS failed - task was already claimed or status changed
        return null;
      }

      return this.findById(id);
    });

    // Execute with BEGIN IMMEDIATE to acquire write lock early
    return claimTransaction.immediate();
  }

  findChildren(
    parentId: number,
    pagination?: PaginationOptions
  ): Array<Task & { tags: string[] }> {
    const { limit, offset } = resolvePagination(pagination);
    const query = `
      SELECT
        t.*,
        GROUP_CONCAT(tt.tag, ',') as tags_csv
      FROM tasks t
      LEFT JOIN task_tags tt ON tt.task_id = t.id
      WHERE t.parent_task_id = ?
      GROUP BY t.id
      ORDER BY t.created_at ASC
      LIMIT ? OFFSET ?
    `;

    const rows = mapRows<Task & { tags_csv: string | null }>(
      this.db.prepare(query),
      parentId,
      limit,
      offset,
    );

    return rows.map((row) => {
      const { tags_csv, ...task } = row;
      const tags = tags_csv ? tags_csv.split(',').sort() : [];
      return normalizeTaskTimestamps({ ...task, tags });
    });
  }

  /**
   * Total children count for a parent task. Mirrors `count(filters)` semantics
   * for the subtask list endpoint — ignores limit/offset so the envelope can
   * report the true match count.
   */
  countChildren(parentId: number): number {
    const result = mapRow<{ count: number }>(
      this.db.prepare(
        'SELECT COUNT(*) as count FROM tasks WHERE parent_task_id = ?',
      ),
      parentId,
    );
    // COUNT(*) always returns exactly one row — `result` is never undefined.
    return result?.count ?? 0;
  }

  count(filters?: TaskFilters): number {
    if (!filters) {
      const result = mapRow<{ count: number }>(
        this.db.prepare('SELECT COUNT(*) as count FROM tasks'),
      );
      return result?.count ?? 0;
    }

    const whereClauses: string[] = [];
    const params: SqlParams = {};

    // Build WHERE clause (same logic as findByFilters)
    if (filters.project_id !== undefined) {
      whereClauses.push('t.project_id = @project_id');
      params.project_id = filters.project_id;
    }

    if (filters.status !== undefined) {
      whereClauses.push('t.status = @status');
      params.status = filters.status;
    }

    if (filters.assignee !== undefined) {
      whereClauses.push('t.assignee = @assignee');
      params.assignee = filters.assignee;
    }

    if (filters.due_before !== undefined) {
      whereClauses.push('t.due_date <= @due_before');
      params.due_before = filters.due_before;
    }

    if (filters.due_after !== undefined) {
      whereClauses.push('t.due_date >= @due_after');
      params.due_after = filters.due_after;
    }

    if (filters.updated_before !== undefined) {
      whereClauses.push('datetime(t.updated_at) <= datetime(@updated_before)');
      params.updated_before = filters.updated_before;
    }

    if (filters.updated_after !== undefined) {
      whereClauses.push('datetime(t.updated_at) >= datetime(@updated_after)');
      params.updated_after = filters.updated_after;
    }

    if (filters.tags !== undefined && filters.tags.length > 0) {
      const tagPlaceholders = filters.tags
        .map((_, i) => `@tag${i}`)
        .join(', ');
      whereClauses.push(
        `EXISTS (SELECT 1 FROM task_tags tt WHERE tt.task_id = t.id AND tt.tag IN (${tagPlaceholders}))`
      );
      filters.tags.forEach((tag, i) => {
        params[`tag${i}`] = tag;
      });
    }

    if (filters.search !== undefined) {
      whereClauses.push(
        't.id IN (SELECT rowid FROM tasks_fts WHERE tasks_fts MATCH @search)'
      );
      params.search = filters.search;
    }

    const whereClause =
      whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const query = `
      SELECT COUNT(DISTINCT t.id) as count
      FROM tasks t
      ${whereClause}
    `;

    // Mirror the FTS-error handling from findByFilters so countByFilters
    // surfaces FtsSyntaxError instead of bare SQLITE_ERROR.
    let result: { count: number } | undefined;
    try {
      result = mapRow<{ count: number }>(this.db.prepare(query), params);
    } catch (err) {
      if (filters.search !== undefined && isSqliteFtsSyntaxError(err)) {
        throw new FtsSyntaxError((err as Error).message);
      }
      throw err;
    }
    // COUNT(*) always returns exactly one row — `result` is never undefined.
    return result?.count ?? 0;
  }

  findCompletedInRange(
    filters: CompletionRangeFilters
  ): Array<Task & { tags: string[] }> {
    // Use SQLite's datetime() to normalize comparison: completed_at may be
    // stored as ISO8601 ("2026-04-12T16:17:17Z") or SQLite format
    // ("2026-04-12 16:17:17") depending on whether the timestamp came from
    // datetime('now') or new Date().toISOString().
    const whereClauses: string[] = [
      "t.status = 'done'",
      't.completed_at IS NOT NULL',
      'datetime(t.completed_at) >= datetime(@start)',
      'datetime(t.completed_at) <= datetime(@end)',
    ];
    const params: SqlParams = {
      start: filters.start,
      end: filters.end,
    };

    if (filters.project_id !== undefined) {
      whereClauses.push('t.project_id = @project_id');
      params.project_id = filters.project_id;
    }

    if (filters.assignee !== undefined) {
      whereClauses.push('t.assignee = @assignee');
      params.assignee = filters.assignee;
    }

    const query = `
      SELECT
        t.*,
        GROUP_CONCAT(tt.tag, ',') as tags_csv
      FROM tasks t
      LEFT JOIN task_tags tt ON tt.task_id = t.id
      WHERE ${whereClauses.join(' AND ')}
      GROUP BY t.id
      ORDER BY t.completed_at ASC
    `;

    const rows = mapRows<Task & { tags_csv: string | null }>(
      this.db.prepare(query),
      params,
    );

    return rows.map((row) => {
      const { tags_csv, ...task } = row;
      const tags = tags_csv ? tags_csv.split(',').sort() : [];
      return normalizeTaskTimestamps({ ...task, tags });
    });
  }
}
