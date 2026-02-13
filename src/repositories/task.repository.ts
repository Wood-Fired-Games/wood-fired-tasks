import type Database from 'better-sqlite3';
import type {
  Task,
  CreateTaskDTO,
  UpdateTaskDTO,
  TaskFilters,
} from '../types/task.js';
import type { ITaskRepository } from './interfaces.js';

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
        title, description, status, priority, project_id,
        assignee, created_by, due_date, created_at, updated_at
      ) VALUES (
        @title, @description, @status, @priority, @project_id,
        @assignee, @created_by, @due_date, @created_at, @updated_at
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
    const task = this.findByIdStmt.get(id) as Task | undefined;
    if (!task) {
      return null;
    }

    // Load tags
    const tagRows = this.findTagsByTaskIdStmt.all(id) as Array<{ tag: string }>;
    const tags = tagRows.map((row) => row.tag);

    return { ...task, tags };
  }

  findAll(): Array<Task & { tags: string[] }> {
    // Use LEFT JOIN with GROUP_CONCAT to get all tasks with their tags
    const rows = this.db
      .prepare(
        `
      SELECT
        t.*,
        GROUP_CONCAT(tt.tag, ',') as tags_csv
      FROM tasks t
      LEFT JOIN task_tags tt ON tt.task_id = t.id
      GROUP BY t.id
      ORDER BY t.created_at DESC
    `
      )
      .all() as Array<Task & { tags_csv: string | null }>;

    return rows.map((row) => {
      const { tags_csv, ...task } = row;
      const tags = tags_csv ? tags_csv.split(',').sort() : [];
      return { ...task, tags };
    });
  }

  update(
    id: number,
    updates: UpdateTaskDTO
  ): Task & { tags: string[] } {
    const result = this.db.transaction(() => {
      // Build dynamic UPDATE SET clause
      const fields: string[] = [];
      const params: Record<string, any> = { id };

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
    const params: Record<string, any> = {};

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

    const query = `
      SELECT
        t.*,
        GROUP_CONCAT(tt.tag, ',') as tags_csv
      FROM tasks t
      LEFT JOIN task_tags tt ON tt.task_id = t.id
      ${whereClause}
      GROUP BY t.id
      ORDER BY t.created_at DESC
    `;

    const rows = this.db.prepare(query).all(params) as Array<
      Task & { tags_csv: string | null }
    >;

    return rows.map((row) => {
      const { tags_csv, ...task } = row;
      const tags = tags_csv ? tags_csv.split(',').sort() : [];
      return { ...task, tags };
    });
  }

  count(filters?: TaskFilters): number {
    if (!filters) {
      const result = this.db
        .prepare('SELECT COUNT(*) as count FROM tasks')
        .get() as { count: number };
      return result.count;
    }

    const whereClauses: string[] = [];
    const params: Record<string, any> = {};

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

    const result = this.db.prepare(query).get(params) as { count: number };
    return result.count;
  }
}
