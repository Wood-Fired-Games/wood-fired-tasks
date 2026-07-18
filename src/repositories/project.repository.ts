import type Database from '../db/driver.js';
import { ModelPolicySchema } from '../schemas/model-policy.schema.js';
import { ScmCharterSchema } from '../schemas/scm-charter.schema.js';
import type {
  Project,
  CreateProjectDTO,
  ValueCharter,
  ModelPolicy,
  ScmCharter,
} from '../types/task.js';
import { DEFAULT_PAGE_LIMIT, DEFAULT_PAGE_OFFSET, MAX_PAGE_LIMIT } from '../types/task.js';
import type { IProjectRepository, PaginationOptions } from './interfaces.js';
import { mapRow, mapRows } from './row-mapper.js';
import type { SqlParams } from './types.js';
import { parseJsonColumn } from '../utils/parse-json-column.js';

/**
 * In-place transform converting the raw TEXT columns `value_charter` and
 * `model_policy` (string-or-null) into the parsed `ValueCharter | null` /
 * `ModelPolicy | null` shapes upstream consumers expect (via the shared
 * `parseJsonColumn`). `value_charter` trusts the stored bytes
 * (`ValueCharterSchema` validates on write); `model_policy` ALSO validates on
 * read: `ModelPolicySchema` is `.strict()` and project RESPONSE schemas embed
 * it, so an unvalidated stored shape (corruption, hand-edit, forward-version
 * row written by a newer build) would reach fastify-type-provider-zod's
 * response serializer and turn `GET /projects` into a 500 for every project
 * over one bad row. Degrading to `null` reads as "no policy → inherit".
 * Returns a new object so the original row is not mutated.
 */
function inflateValueCharter<
  T extends {
    value_charter?: string | ValueCharter | null;
    model_policy?: string | ModelPolicy | null;
    scm?: string | ScmCharter | null;
  },
>(
  project: T,
): T & {
  value_charter: ValueCharter | null;
  model_policy: ModelPolicy | null;
  scm: ScmCharter | null;
} {
  const rawCharter = project.value_charter;
  const parsedCharter =
    typeof rawCharter === 'string'
      ? parseJsonColumn<ValueCharter>(rawCharter)
      : (rawCharter ?? null);
  const rawPolicy = project.model_policy;
  const parsedPolicy =
    typeof rawPolicy === 'string'
      ? parseJsonColumn(rawPolicy, ModelPolicySchema)
      : (rawPolicy ?? null);
  // Pluggable SCM: `scm` validates on read too — `ScmCharterSchema` is
  // `.strict()` and the project RESPONSE schema embeds it, so an unvalidated
  // stored shape (corruption, hand-edit, forward-version row) would 500 the
  // response serializer over one bad row. Degrading to `null` reads as "no scm
  // default → no precedence-2 fallback". Mirrors `model_policy` above.
  const rawScm = project.scm;
  const parsedScm =
    typeof rawScm === 'string' ? parseJsonColumn(rawScm, ScmCharterSchema) : (rawScm ?? null);
  return {
    ...project,
    value_charter: parsedCharter,
    model_policy: parsedPolicy,
    scm: parsedScm,
  };
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
      'INSERT INTO projects (name, description, value_charter, model_policy, scm) VALUES (@name, @description, @value_charter, @model_policy, @scm)',
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
      model_policy: dto.model_policy == null ? null : JSON.stringify(dto.model_policy),
      scm: dto.scm == null ? null : JSON.stringify(dto.scm),
    });
    const project = this.findById(info.lastInsertRowid as number);
    if (!project) {
      throw new Error('Failed to create project');
    }
    return project;
  }

  findById(id: number): Project | null {
    const row = mapRow<
      Omit<Project, 'value_charter' | 'model_policy' | 'scm'> & {
        value_charter: string | null;
        model_policy: string | null;
        scm: string | null;
      }
    >(this.findByIdStmt, id);
    return row ? inflateValueCharter(row) : null;
  }

  findAll(pagination?: PaginationOptions): Project[] {
    const { limit, offset } = resolvePagination(pagination);
    const rows = mapRows<
      Omit<Project, 'value_charter' | 'model_policy' | 'scm'> & {
        value_charter: string | null;
        model_policy: string | null;
        scm: string | null;
      }
    >(this.findAllStmt, limit, offset);
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
      Omit<Project, 'value_charter' | 'model_policy' | 'scm'> & {
        value_charter: string | null;
        model_policy: string | null;
        scm: string | null;
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
    // Configurable Task Models: patch model_policy. `undefined` (key absent)
    // leaves the column untouched; explicit `null` clears it; an object is
    // serialized to JSON. Mirrors the value_charter patch above.
    if (updates.model_policy !== undefined) {
      fields.push('model_policy = @model_policy');
      params['model_policy'] =
        updates.model_policy === null ? null : JSON.stringify(updates.model_policy);
    }
    // Pluggable SCM: patch scm. `undefined` (key absent) leaves the column
    // untouched; explicit `null` clears it; an object is serialized to JSON.
    // Mirrors the model_policy patch above.
    if (updates.scm !== undefined) {
      fields.push('scm = @scm');
      params['scm'] = updates.scm === null ? null : JSON.stringify(updates.scm);
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
