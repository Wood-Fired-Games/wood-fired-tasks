import type Database from '../db/driver.js';
import type { Project, CreateProjectDTO, ValueCharter } from '../types/task.js';
import { DEFAULT_PAGE_LIMIT, DEFAULT_PAGE_OFFSET, MAX_PAGE_LIMIT } from '../types/task.js';
import type { IProjectRepository, PaginationOptions } from './interfaces.js';
import { mapRow, mapRows } from './row-mapper.js';
import type { SqlParams } from './types.js';

/**
 * WSJF (Phase 3.1): parse the JSON-string `value_charter` column into a
 * typed object so callers see a structured value (matching the Project type)
 * instead of having to JSON.parse themselves. Mirrors
 * `parseVerificationEvidence` in task.repository.ts.
 *
 * Defensive: a non-JSON string (corruption / hand-edit) surfaces as `null`
 * rather than crashing the query. Shape validation is enforced by
 * `ValueCharterSchema` on write — read-side parsing trusts the stored bytes.
 */
function parseValueCharter(raw: string | null | undefined): ValueCharter | null {
  if (raw === null || raw === undefined) return null;
  try {
    return JSON.parse(raw) as ValueCharter;
  } catch {
    return null;
  }
}

/**
 * In-place transform converting the raw TEXT column `value_charter`
 * (string-or-null) into the parsed `ValueCharter | null` shape upstream
 * consumers expect. Returns a new object so the original row is not mutated.
 */
function inflateValueCharter<T extends { value_charter?: string | ValueCharter | null }>(
  project: T,
): T & { value_charter: ValueCharter | null } {
  const raw = project.value_charter;
  const parsed = typeof raw === 'string' ? parseValueCharter(raw) : (raw ?? null);
  return { ...project, value_charter: parsed };
}

/**
 * Same defensive clamp used in TaskRepository — see notes there.
 */
function resolvePagination(pagination?: PaginationOptions): {
  limit: number;
  offset: number;
} {
  const rawLimit = pagination?.limit ?? DEFAULT_PAGE_LIMIT;
  const rawOffset = pagination?.offset ?? DEFAULT_PAGE_OFFSET;
  const limit =
    Number.isFinite(rawLimit) && Number.isInteger(rawLimit) && rawLimit > 0
      ? Math.min(rawLimit, MAX_PAGE_LIMIT)
      : DEFAULT_PAGE_LIMIT;
  const offset =
    Number.isFinite(rawOffset) && Number.isInteger(rawOffset) && rawOffset >= 0
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
      'INSERT INTO projects (name, description, value_charter) VALUES (@name, @description, @value_charter)',
    );
    this.findByIdStmt = db.prepare('SELECT * FROM projects WHERE id = ?');
    this.findByNameStmt = db.prepare('SELECT * FROM projects WHERE name = ?');
    this.findAllStmt = db.prepare('SELECT * FROM projects ORDER BY name LIMIT ? OFFSET ?');
    this.deleteStmt = db.prepare('DELETE FROM projects WHERE id = ?');
    this.countStmt = db.prepare('SELECT COUNT(*) as count FROM projects');
  }

  create(dto: CreateProjectDTO): Project {
    const info = this.insertStmt.run({
      name: dto.name,
      description: dto.description ?? null,
      value_charter: dto.value_charter == null ? null : JSON.stringify(dto.value_charter),
    });
    const project = this.findById(info.lastInsertRowid as number);
    if (!project) {
      throw new Error('Failed to create project');
    }
    return project;
  }

  findById(id: number): Project | null {
    const row = mapRow<
      Omit<Project, 'value_charter'> & {
        value_charter: string | null;
      }
    >(this.findByIdStmt, id);
    return row ? inflateValueCharter(row) : null;
  }

  findAll(pagination?: PaginationOptions): Project[] {
    const { limit, offset } = resolvePagination(pagination);
    const rows = mapRows<Omit<Project, 'value_charter'> & { value_charter: string | null }>(
      this.findAllStmt,
      limit,
      offset,
    );
    return rows.map(inflateValueCharter);
  }

  /** Total project count, ignoring pagination. */
  count(): number {
    const result = mapRow<{ count: number }>(this.countStmt);
    // COUNT(*) always returns exactly one row — `result` is never undefined.
    return result?.count ?? 0;
  }

  findByName(name: string): Project | null {
    const row = mapRow<
      Omit<Project, 'value_charter'> & {
        value_charter: string | null;
      }
    >(this.findByNameStmt, name);
    return row ? inflateValueCharter(row) : null;
  }

  update(id: number, updates: Partial<CreateProjectDTO>): Project {
    // Build dynamic SET clause from provided fields
    const fields: string[] = [];
    const params: SqlParams = { id };

    if (updates.name !== undefined) {
      fields.push('name = @name');
      params['name'] = updates.name;
    }
    if (updates.description !== undefined) {
      fields.push('description = @description');
      params['description'] = updates.description;
    }
    // WSJF (Phase 3.1): patch value_charter. `undefined` (key absent) leaves
    // the column untouched; explicit `null` clears it; an object is
    // serialized to JSON.
    if (updates.value_charter !== undefined) {
      fields.push('value_charter = @value_charter');
      params['value_charter'] =
        updates.value_charter === null ? null : JSON.stringify(updates.value_charter);
    }

    // Always update the updated_at timestamp
    fields.push("updated_at = datetime('now')");

    if (fields.length === 1) {
      // Only updated_at changed, but we still need to run the update
      const stmt = this.db.prepare(`UPDATE projects SET ${fields.join(', ')} WHERE id = @id`);
      stmt.run(params);
    } else {
      const stmt = this.db.prepare(`UPDATE projects SET ${fields.join(', ')} WHERE id = @id`);
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
