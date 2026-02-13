import type Database from 'better-sqlite3';
import type { Project, CreateProjectDTO } from '../types/task.js';
import type { IProjectRepository } from './interfaces.js';

export class ProjectRepository implements IProjectRepository {
  private insertStmt: Database.Statement;
  private findByIdStmt: Database.Statement;
  private findByNameStmt: Database.Statement;
  private findAllStmt: Database.Statement;
  private deleteStmt: Database.Statement;

  constructor(private db: Database.Database) {
    // Prepare all statements for reuse
    this.insertStmt = db.prepare(
      'INSERT INTO projects (name, description) VALUES (@name, @description)'
    );
    this.findByIdStmt = db.prepare('SELECT * FROM projects WHERE id = ?');
    this.findByNameStmt = db.prepare('SELECT * FROM projects WHERE name = ?');
    this.findAllStmt = db.prepare('SELECT * FROM projects ORDER BY name');
    this.deleteStmt = db.prepare('DELETE FROM projects WHERE id = ?');
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

  findAll(): Project[] {
    return this.findAllStmt.all() as Project[];
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
