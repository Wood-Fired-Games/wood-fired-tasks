import type Database from 'better-sqlite3';
import type { Project, CreateProjectDTO } from '../types/task.js';
import {
  DEFAULT_PAGE_LIMIT,
  DEFAULT_PAGE_OFFSET,
  MAX_PAGE_LIMIT,
} from '../types/task.js';
import type { IProjectRepository, PaginationOptions } from './interfaces.js';

/**
 * Same defensive clamp used in TaskRepository — see notes there.
 */
function resolvePagination(pagination?: PaginationOptions): {
  limit: number;
  offset: number;
} {
  const rawLimit = pagination?.limit ?? DEFAULT_PAGE_LIMIT;
  const rawOffset = pagination?.offset ?? DEFAULT_PAGE_OFFSET;
  const limit = Number.isFinite(rawLimit) && Number.isInteger(rawLimit) && rawLimit > 0
    ? Math.min(rawLimit, MAX_PAGE_LIMIT)
    : DEFAULT_PAGE_LIMIT;
  const offset = Number.isFinite(rawOffset) && Number.isInteger(rawOffset) && rawOffset >= 0
    ? rawOffset
    : DEFAULT_PAGE_OFFSET;
  return { limit, offset };
}

export class ProjectRepository implements IProjectRepository {
  private insertStmt: Database.Statement;
  private findByIdStmt: Database.Statement;
  private findByNameStmt: Database.Statement;
  private findAllStmt: Database.Statement;
  private deleteStmt: Database.Statement;
  private countStmt: Database.Statement;

  constructor(private db: Database.Database) {
    // Prepare all statements for reuse
    this.insertStmt = db.prepare(
      'INSERT INTO projects (name, description) VALUES (@name, @description)'
    );
    this.findByIdStmt = db.prepare('SELECT * FROM projects WHERE id = ?');
    this.findByNameStmt = db.prepare('SELECT * FROM projects WHERE name = ?');
    this.findAllStmt = db.prepare(
      'SELECT * FROM projects ORDER BY name LIMIT ? OFFSET ?'
    );
    this.deleteStmt = db.prepare('DELETE FROM projects WHERE id = ?');
    this.countStmt = db.prepare('SELECT COUNT(*) as count FROM projects');
  }

  create(dto: CreateProjectDTO): Project {
    const info = this.insertStmt.run({
      name: dto.name,
      description: dto.description ?? null,
    });
    const project = this.findById(info.lastInsertRowid as number);
    if (!project) {
      throw new Error('Failed to create project');
    }
    return project;
  }

  findById(id: number): Project | null {
    const row = this.findByIdStmt.get(id) as Project | undefined;
    return row || null;
  }

  findAll(pagination?: PaginationOptions): Project[] {
    const { limit, offset } = resolvePagination(pagination);
    return this.findAllStmt.all(limit, offset) as Project[];
  }

  /** Total project count, ignoring pagination. */
  count(): number {
    const result = this.countStmt.get() as { count: number };
    return result.count;
  }

  findByName(name: string): Project | null {
    const row = this.findByNameStmt.get(name) as Project | undefined;
    return row || null;
  }

  update(id: number, updates: Partial<CreateProjectDTO>): Project {
    // Build dynamic SET clause from provided fields
    const fields: string[] = [];
    const params: Record<string, any> = { id };

    if (updates.name !== undefined) {
      fields.push('name = @name');
      params.name = updates.name;
    }
    if (updates.description !== undefined) {
      fields.push('description = @description');
      params.description = updates.description;
    }

    // Always update the updated_at timestamp
    fields.push("updated_at = datetime('now')");

    if (fields.length === 1) {
      // Only updated_at changed, but we still need to run the update
      const stmt = this.db.prepare(
        `UPDATE projects SET ${fields.join(', ')} WHERE id = @id`
      );
      stmt.run(params);
    } else {
      const stmt = this.db.prepare(
        `UPDATE projects SET ${fields.join(', ')} WHERE id = @id`
      );
      stmt.run(params);
    }

    const project = this.findById(id);
    if (!project) {
      throw new Error(`Project with id ${id} not found`);
    }
    return project;
  }

  delete(id: number): void {
    this.deleteStmt.run(id);
  }
}
