import type Database from '../db/driver.js';
import type {
  Task,
  CreateTaskDTO,
  UpdateTaskDTO,
  TaskFilters,
  VerificationEvidence,
} from '../types/task.js';
import { DEFAULT_PAGE_LIMIT, DEFAULT_PAGE_OFFSET, MAX_PAGE_LIMIT } from '../types/task.js';
import type { Fib, WsjfSource } from '../types/wsjf.js';
import type { ITaskRepository, CompletionRangeFilters, PaginationOptions } from './interfaces.js';
import { FtsSyntaxError, isSqliteFtsSyntaxError } from './errors.js';
import { mapRow, mapRows } from './row-mapper.js';
import type { SqlParams } from './types.js';
import { omitUndefined } from '../utils/omit-undefined.js';
import { parseJsonColumn } from '../utils/parse-json-column.js';

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

/**
 * Wave 1.4 (#312): parse the JSON-string verification_evidence column into
 * a typed object so service / route / MCP / CLI callers see a structured
 * value (matching the Task type) instead of having to JSON.parse themselves.
 *
 * Defensive: if a row contains a non-JSON string (e.g. corruption from a
 * pre-1.4 hand-edit, or a future migration that touches the column), we
 * surface `null` rather than crashing the whole query. Validation against
 * the Zod schema is enforced at the boundary on write — read-side parsing
 * trusts the bytes were validated on the way in.
 */
function parseVerificationEvidence(raw: string | null | undefined): VerificationEvidence | null {
  if (raw === null || raw === undefined) return null;
  try {
    return JSON.parse(raw) as VerificationEvidence;
  } catch {
    return null;
  }
}

/**
 * Wave 1.4 (#312): in-place transform that converts the raw TEXT column
 * `verification_evidence` (string-or-null) into the parsed
 * `VerificationEvidence | null` shape that all upstream consumers expect.
 *
 * Returns a new object so the original row (a better-sqlite3 cell map) is
 * not mutated underneath any other reader.
 */
function inflateVerificationEvidence<
  T extends { verification_evidence?: string | VerificationEvidence | null },
>(task: T): T & { verification_evidence: VerificationEvidence | null } {
  const raw = task.verification_evidence;
  const parsed = typeof raw === 'string' ? parseVerificationEvidence(raw) : (raw ?? null);
  return { ...task, verification_evidence: parsed };
}

/**
 * WSJF (#627): serialize a wsjf_* JSON metadata member for storage. `undefined`
 * (caller omitted it) and explicit `null` both persist as a NULL column;
 * anything else is JSON.stringify'd. Validation already happened at the schema
 * boundary, so this is a pure write-side transform.
 */
function serializeWsjfMember(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

/** The five wsjf_* TEXT JSON columns inflated by {@link inflateWsjf}. */
const WSJF_JSON_COLUMNS = [
  'wsjf_evidence',
  'wsjf_locked',
  'wsjf_source',
  'wsjf_classifications',
  'wsjf_features',
] as const;

/**
 * WSJF (#627): in-place transform converting the raw wsjf_* TEXT columns
 * (string-or-null) into the parsed objects the Task contract expects. Follows
 * the `inflateVerificationEvidence` pattern — returns a new object so the
 * better-sqlite3 cell map is not mutated underneath another reader. The four
 * INTEGER component columns (wsjf_value etc.) pass through untouched.
 */
function inflateWsjf<T extends Record<string, unknown>>(task: T): T {
  const out: Record<string, unknown> = { ...task };
  for (const col of WSJF_JSON_COLUMNS) {
    const raw = task[col];
    out[col] = typeof raw === 'string' ? parseJsonColumn(raw) : (raw ?? null);
  }
  return out as T;
}

export class TaskRepository implements ITaskRepository {
  private insertTaskStmt: Database.Statement;
  private findByIdStmt: Database.Statement;
  private findResolverFactsStmt: Database.Statement;
  private deleteStmt: Database.Statement;
  private findTagsByTaskIdStmt: Database.Statement;
  private insertTagStmt: Database.Statement;
  private deleteTagsByTaskIdStmt: Database.Statement;

  constructor(private db: Database.Database) {
    // Prepare reusable statements
    // Phase 31 (Plan 31-01): the parallel FK columns
    // `created_by_user_id` / `assignee_user_id` ride alongside the existing
    // TEXT identity columns. Both are nullable and stay NULL when the caller
    // does not pre-resolve the displayName -> users.id mapping (back-compat
    // for every pre-Phase-31 call site).
    this.insertTaskStmt = db.prepare(`
      INSERT INTO tasks (
        title, description, status, priority, project_id, parent_task_id,
        estimated_minutes, assignee, created_by, due_date, created_at, updated_at,
        created_by_user_id, assignee_user_id, acceptance_criteria,
        verification_evidence,
        wsjf_value, wsjf_time_criticality, wsjf_risk_opportunity, wsjf_job_size,
        wsjf_evidence, wsjf_locked, wsjf_source, wsjf_classifications, wsjf_features
      ) VALUES (
        @title, @description, @status, @priority, @project_id, @parent_task_id,
        @estimated_minutes, @assignee, @created_by, @due_date, @created_at, @updated_at,
        @created_by_user_id, @assignee_user_id, @acceptance_criteria,
        @verification_evidence,
        @wsjf_value, @wsjf_time_criticality, @wsjf_risk_opportunity, @wsjf_job_size,
        @wsjf_evidence, @wsjf_locked, @wsjf_source, @wsjf_classifications, @wsjf_features
      )
    `);

    // Join projects so every Task row carries the project_name display
    // field. INNER JOIN is safe because `tasks.project_id` is NOT NULL with
    // a FK to projects(id) (orphan rows are impossible under
    // `PRAGMA foreign_keys = ON`). The `tasks` columns are explicitly
    // expanded by `t.*` and the join adds `p.name as project_name`.
    this.findByIdStmt = db.prepare(
      `SELECT t.*, p.name as project_name
       FROM tasks t INNER JOIN projects p ON p.id = t.project_id
       WHERE t.id = ?`,
    );
    // Task #931 — model-resolver fast path: `resolveModel` only needs the
    // task's project membership + WSJF jobSize tier, so reading them through
    // `findById` (projects JOIN + a second tags query + full WSJF/evidence
    // JSON inflation) was pure hot-path waste. Two INTEGER columns by PK.
    this.findResolverFactsStmt = db.prepare(
      'SELECT project_id, wsjf_job_size FROM tasks WHERE id = ?',
    );
    this.deleteStmt = db.prepare('DELETE FROM tasks WHERE id = ?');
    this.findTagsByTaskIdStmt = db.prepare(
      'SELECT tag FROM task_tags WHERE task_id = ? ORDER BY tag',
    );
    this.insertTagStmt = db.prepare('INSERT INTO task_tags (task_id, tag) VALUES (?, ?)');
    this.deleteTagsByTaskIdStmt = db.prepare('DELETE FROM task_tags WHERE task_id = ?');
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
        // Phase 31 (Plan 31-01): both SQL columns and bindings change in
        // the same edit (Pitfall 2 — SQL/binding skew). When the caller
        // omits the FK fields, the column stays NULL.
        created_by_user_id: dto.created_by_user_id ?? null,
        assignee_user_id: dto.assignee_user_id ?? null,
        // Wave 1.3 (#311): same SQL+binding skew rule — bind explicit NULL
        // when the caller omits the field so pre-1.3 callers keep working.
        acceptance_criteria: dto.acceptance_criteria ?? null,
        // Wave 1.4 (#312): verification_evidence is never set on CREATE — a
        // brand-new task has no evidence yet. Bind NULL unconditionally so
        // the SQL/binding count stays in sync.
        verification_evidence: null,
        // WSJF (#627): persist the score on create when supplied. The schema
        // boundary enforces all-four-or-none, so `dto.wsjf` is either a fully
        // populated object or absent — when absent, every wsjf_* column binds
        // NULL (unscored task). JSON members are serialized at this boundary.
        wsjf_value: dto.wsjf?.value ?? null,
        wsjf_time_criticality: dto.wsjf?.timeCriticality ?? null,
        wsjf_risk_opportunity: dto.wsjf?.riskOpportunity ?? null,
        wsjf_job_size: dto.wsjf?.jobSize ?? null,
        wsjf_evidence: serializeWsjfMember(dto.wsjf?.evidence),
        wsjf_locked: serializeWsjfMember(dto.wsjf?.locked),
        wsjf_source: serializeWsjfMember(dto.wsjf?.source),
        wsjf_classifications: serializeWsjfMember(dto.wsjf?.classifications),
        wsjf_features: serializeWsjfMember(dto.wsjf?.features),
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
    // Row arrives with verification_evidence as a raw JSON string (or NULL).
    // Inflate it to the typed object the Task contract expects before
    // returning. The cast is narrow: better-sqlite3 surfaces the column as
    // `string | null`, which the inflateVerificationEvidence helper accepts.
    const task = mapRow<
      Omit<Task, 'verification_evidence'> & {
        verification_evidence: string | null;
      }
    >(this.findByIdStmt, id);
    if (!task) {
      return null;
    }

    // Load tags
    const tagRows = mapRows<{ tag: string }>(this.findTagsByTaskIdStmt, id);
    const tags = tagRows.map((row) => row.tag);

    return normalizeTaskTimestamps(inflateWsjf(inflateVerificationEvidence({ ...task, tags })));
  }

  /**
   * Task #931 — the model-resolver's task facts (project membership + WSJF
   * jobSize tier) via a dedicated prepared two-column PK lookup. Returns the
   * exact `ResolverTask` shape `ModelPolicyDeps.getTask` needs, or `null`
   * when no such task exists (the task-#928 existence guard). Value-identical
   * to reading the same two fields off `findById`, minus the JOIN, the tags
   * query, and the full row inflation.
   */
  findResolverFacts(id: number): { project_id: number; wsjf_job_size: number | null } | null {
    const row = mapRow<{ project_id: number; wsjf_job_size: number | null }>(
      this.findResolverFactsStmt,
      id,
    );
    return row == null ? null : { project_id: row.project_id, wsjf_job_size: row.wsjf_job_size };
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
        p.name as project_name,
        GROUP_CONCAT(tt.tag, ',') as tags_csv
      FROM tasks t
      INNER JOIN projects p ON p.id = t.project_id
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
      return normalizeTaskTimestamps(inflateWsjf(inflateVerificationEvidence({ ...task, tags })));
    });
  }

  update(id: number, updates: UpdateTaskDTO): Task & { tags: string[] } {
    const result = this.db.transaction(() => {
      // Build dynamic UPDATE SET clause
      const fields: string[] = [];
      const params: SqlParams = { id };

      // Only update fields that are provided (excluding tags)
      if (updates.title !== undefined) {
        fields.push('title = @title');
        params['title'] = updates.title;
      }
      if (updates.description !== undefined) {
        fields.push('description = @description');
        params['description'] = updates.description;
      }
      if (updates.status !== undefined) {
        fields.push('status = @status');
        params['status'] = updates.status;

        // Maintain completed_at on transitions to/from 'done'.
        // Read current status inside the same transaction for consistency.
        const current = mapRow<{
          status: string;
          completed_at: string | null;
        }>(this.findByIdStmt, id);
        const movingIntoDone = updates.status === 'done' && current?.status !== 'done';
        const movingOutOfDone = current?.status === 'done' && updates.status !== 'done';

        if (movingIntoDone) {
          fields.push("completed_at = datetime('now')");
        } else if (movingOutOfDone) {
          fields.push('completed_at = NULL');
        }
      }
      if (updates.priority !== undefined) {
        fields.push('priority = @priority');
        params['priority'] = updates.priority;
      }
      if (updates.assignee !== undefined) {
        fields.push('assignee = @assignee');
        params['assignee'] = updates.assignee;
      }
      // Phase 31 (Plan 31-01): assignee_user_id is independently optional —
      // a TEXT-only update (legacy callers) does NOT clear the FK column,
      // and an explicit `null` value DOES clear the FK column (so callers
      // can deliberately unbind a user without removing the TEXT label).
      if (updates.assignee_user_id !== undefined) {
        fields.push('assignee_user_id = @assignee_user_id');
        params['assignee_user_id'] = updates.assignee_user_id;
      }
      if (updates.due_date !== undefined) {
        fields.push('due_date = @due_date');
        params['due_date'] = updates.due_date;
      }
      if (updates.parent_task_id !== undefined) {
        fields.push('parent_task_id = @parent_task_id');
        params['parent_task_id'] = updates.parent_task_id;
      }
      if (updates.estimated_minutes !== undefined) {
        fields.push('estimated_minutes = @estimated_minutes');
        params['estimated_minutes'] = updates.estimated_minutes;
      }
      // Wave 1.3 (#311): patch acceptance_criteria. `undefined` (key absent)
      // leaves the column untouched; explicit `null` clears it; a string sets
      // it. Same opt-in semantics as the other partial-update fields above.
      if (updates.acceptance_criteria !== undefined) {
        fields.push('acceptance_criteria = @acceptance_criteria');
        params['acceptance_criteria'] = updates.acceptance_criteria;
      }
      // Wave 1.4 (#312): patch verification_evidence. Same opt-in semantics
      // as acceptance_criteria above. The TEXT column stores the JSON
      // serialization — explicit null clears it.
      if (updates.verification_evidence !== undefined) {
        fields.push('verification_evidence = @verification_evidence');
        params['verification_evidence'] =
          updates.verification_evidence === null
            ? null
            : JSON.stringify(updates.verification_evidence);
      }

      // WSJF (#627): patch the WSJF score. `undefined` (key absent) leaves
      // every wsjf_* column untouched; explicit `null` clears all nine (back
      // to unscored); an object sets the four components and serializes the
      // JSON metadata. All-four-or-none is enforced at the schema boundary, so
      // an object here always carries all four components.
      if (updates.wsjf !== undefined) {
        const w = updates.wsjf;
        fields.push('wsjf_value = @wsjf_value');
        fields.push('wsjf_time_criticality = @wsjf_time_criticality');
        fields.push('wsjf_risk_opportunity = @wsjf_risk_opportunity');
        fields.push('wsjf_job_size = @wsjf_job_size');
        fields.push('wsjf_evidence = @wsjf_evidence');
        fields.push('wsjf_locked = @wsjf_locked');
        fields.push('wsjf_source = @wsjf_source');
        fields.push('wsjf_classifications = @wsjf_classifications');
        fields.push('wsjf_features = @wsjf_features');
        params['wsjf_value'] = w === null ? null : w.value;
        params['wsjf_time_criticality'] = w === null ? null : w.timeCriticality;
        params['wsjf_risk_opportunity'] = w === null ? null : w.riskOpportunity;
        params['wsjf_job_size'] = w === null ? null : w.jobSize;
        params['wsjf_evidence'] = w === null ? null : serializeWsjfMember(w.evidence);
        params['wsjf_locked'] = w === null ? null : serializeWsjfMember(w.locked);
        params['wsjf_source'] = w === null ? null : serializeWsjfMember(w.source);
        params['wsjf_classifications'] = w === null ? null : serializeWsjfMember(w.classifications);
        params['wsjf_features'] = w === null ? null : serializeWsjfMember(w.features);
      }

      // Always update updated_at
      fields.push("updated_at = datetime('now')");

      // Run update if there are fields to update
      if (fields.length > 0) {
        const updateStmt = this.db.prepare(`UPDATE tasks SET ${fields.join(', ')} WHERE id = @id`);
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

  /**
   * Guaranteed-task-sizing (#987, design spec §2/§3): the SIZE-ONLY column
   * write. Sets ONLY `wsjf_job_size` + `wsjf_source` (with `jobSize='auto'`),
   * deliberately NOT touching `wsjf_value` / `wsjf_time_criticality` /
   * `wsjf_risk_opportunity` (or their JSON metadata) — they stay NULL on a
   * fresh task, so the task remains UNSCORED for ranking (`componentsOf`'s
   * any-null exclusion) while `wsjf_job_size` makes `resolve_model` routing
   * engage.
   *
   * Issues no `BEGIN`/`COMMIT` of its own: the service layer (#628 no-bypass
   * invariant) calls this from inside ONE `db.transaction(...)` alongside the
   * `auto_size` history append so the column write and its audit row commit
   * atomically. Throws if the task id does not exist (parity with `update`).
   */
  writeAutoJobSize(id: number, jobSize: Fib, source: WsjfSource): Task & { tags: string[] } {
    const stmt = this.db.prepare(
      `UPDATE tasks
       SET wsjf_job_size = @wsjf_job_size,
           wsjf_source = @wsjf_source,
           updated_at = datetime('now')
       WHERE id = @id`,
    );
    const info = stmt.run({
      id,
      wsjf_job_size: jobSize,
      wsjf_source: serializeWsjfMember(source),
    });
    if (info.changes === 0) {
      throw new Error(`Task with id ${id} not found`);
    }
    const result = this.findById(id);
    if (!result) {
      throw new Error(`Task with id ${id} not found`);
    }
    return result;
  }

  /**
   * Guaranteed-task-sizing (#992, design spec §5): the boot-sweep candidate
   * scan. Returns `{ id, estimated_minutes }` for every task with a NULL
   * `wsjf_job_size` whose status is NOT terminal ({done,closed} excluded —
   * AC 3 skips them). Selects only the two columns the sweep consumes (id to
   * address the autoSizeTask write, estimated_minutes for `minutesToTier`) so
   * a large backlog scan stays cheap and never inflates full rows / tags.
   * A run after a successful sweep returns `[]` (every row now has a size),
   * which is the idempotence backbone (AC 2).
   */
  findIdsWithNullJobSize(): Array<{ id: number; estimated_minutes: number | null }> {
    const rows = this.db
      .prepare(
        `SELECT id, estimated_minutes
         FROM tasks
         WHERE wsjf_job_size IS NULL
           AND status NOT IN ('done', 'closed')
         ORDER BY id`,
      )
      .all() as Array<{ id: number; estimated_minutes: number | null }>;
    return rows;
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
      params['project_id'] = filters.project_id;
    }

    if (filters.status !== undefined) {
      whereClauses.push('t.status = @status');
      params['status'] = filters.status;
    }

    if (filters.assignee !== undefined) {
      whereClauses.push('t.assignee = @assignee');
      params['assignee'] = filters.assignee;
    }

    if (filters.due_before !== undefined) {
      whereClauses.push('t.due_date <= @due_before');
      params['due_before'] = filters.due_before;
    }

    if (filters.due_after !== undefined) {
      whereClauses.push('t.due_date >= @due_after');
      params['due_after'] = filters.due_after;
    }

    // Wrap updated_at comparisons in datetime() to handle mixed storage
    // formats: "YYYY-MM-DDTHH:MM:SS.sssZ" (JS toISOString) and
    // "YYYY-MM-DD HH:MM:SS" (SQLite datetime('now')).
    if (filters.updated_before !== undefined) {
      whereClauses.push('datetime(t.updated_at) <= datetime(@updated_before)');
      params['updated_before'] = filters.updated_before;
    }

    if (filters.updated_after !== undefined) {
      whereClauses.push('datetime(t.updated_at) >= datetime(@updated_after)');
      params['updated_after'] = filters.updated_after;
    }

    if (filters.tags !== undefined && filters.tags.length > 0) {
      // Use EXISTS with parameterized IN clause
      const tagPlaceholders = filters.tags.map((_, i) => `@tag${i}`).join(', ');
      whereClauses.push(
        `EXISTS (SELECT 1 FROM task_tags tt WHERE tt.task_id = t.id AND tt.tag IN (${tagPlaceholders}))`,
      );
      filters.tags.forEach((tag, i) => {
        params[`tag${i}`] = tag;
      });
    }

    if (filters.search !== undefined) {
      // Use FTS5 MATCH for text search
      whereClauses.push('t.id IN (SELECT rowid FROM tasks_fts WHERE tasks_fts MATCH @search)');
      params['search'] = filters.search;
    }

    // Wave 1.4 (#312): verified-state filter using json_extract on the
    // verdict slot of the JSON column. NULL-evidence rows (rows that never
    // crossed a closing transition with auto-NOT_VERIFIED, or pre-1.4 rows)
    // collapse into the "not verified" bucket alongside explicit NOT_VERIFIED
    // and FAIL.
    if (filters.verified === true) {
      whereClauses.push(
        "json_extract(t.verification_evidence, '$.verdict') IN ('PASS', 'PARTIAL')",
      );
    } else if (filters.verified === false) {
      whereClauses.push(
        "(t.verification_evidence IS NULL OR json_extract(t.verification_evidence, '$.verdict') IN ('NOT_VERIFIED', 'FAIL'))",
      );
    }

    // Build final query
    const whereClause = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    // Apply pagination so the server never materializes an unbounded result
    // set. The schema layer caps `limit` at 500; this is a defence in depth
    // for direct service/repo callers.
    const { limit, offset } = resolvePagination(
      omitUndefined({
        limit: filters.limit,
        offset: filters.offset,
      }),
    );
    params['__limit'] = limit;
    params['__offset'] = offset;

    // N7 (task #342 follow-up): when the caller explicitly opts out of tag
    // hydration (`include_tags: false`), drop the `task_tags` LEFT JOIN and
    // the GROUP BY. Graph builders (DependencyGraphService) never read the
    // `tags` field; skipping the join shaves work proportional to the tag
    // fanout. Default behaviour (`include_tags` undefined → true) is
    // unchanged so existing list endpoints stay byte-identical.
    const includeTags = filters.include_tags !== false;
    const query = includeTags
      ? `
      SELECT
        t.*,
        p.name as project_name,
        GROUP_CONCAT(tt.tag, ',') as tags_csv
      FROM tasks t
      INNER JOIN projects p ON p.id = t.project_id
      LEFT JOIN task_tags tt ON tt.task_id = t.id
      ${whereClause}
      GROUP BY t.id
      ORDER BY t.created_at DESC
      LIMIT @__limit OFFSET @__offset
    `
      : `
      SELECT
        t.*,
        p.name as project_name
      FROM tasks t
      INNER JOIN projects p ON p.id = t.project_id
      ${whereClause}
      ORDER BY t.created_at DESC
      LIMIT @__limit OFFSET @__offset
    `;

    // FTS5 MATCH parses user-supplied search syntax at query time. Malformed
    // expressions (e.g. unterminated quote, `NEAR(`, bare `*`) throw
    // SQLITE_ERROR with raw parser text. Catch and re-throw as FtsSyntaxError
    // ONLY when the caller actually provided a search filter — otherwise
    // unrelated SQLITE_ERRORs would be misclassified.
    if (includeTags) {
      let rows: Array<Task & { tags_csv: string | null }>;
      try {
        rows = mapRows<Task & { tags_csv: string | null }>(this.db.prepare(query), params);
      } catch (err) {
        if (filters.search !== undefined && isSqliteFtsSyntaxError(err)) {
          throw new FtsSyntaxError((err as Error).message);
        }
        throw err;
      }

      return rows.map((row) => {
        const { tags_csv, ...task } = row;
        const tags = tags_csv ? tags_csv.split(',').sort() : [];
        return normalizeTaskTimestamps(inflateWsjf(inflateVerificationEvidence({ ...task, tags })));
      });
    }

    let rowsNoTags: Task[];
    try {
      rowsNoTags = mapRows<Task>(this.db.prepare(query), params);
    } catch (err) {
      if (filters.search !== undefined && isSqliteFtsSyntaxError(err)) {
        throw new FtsSyntaxError((err as Error).message);
      }
      throw err;
    }
    return rowsNoTags.map((row) =>
      normalizeTaskTimestamps(inflateWsjf(inflateVerificationEvidence({ ...row, tags: [] }))),
    );
  }

  claimTask(
    id: number,
    assignee: string,
    assigneeUserId?: number | null,
  ): (Task & { tags: string[] }) | null {
    // Use .immediate() to acquire write lock early (BEGIN IMMEDIATE)
    // This prevents SQLITE_BUSY when multiple agents try to claim simultaneously
    //
    // Phase 31 (Plan 31-01): the trailing `assigneeUserId` is the FK
    // companion to `assignee`. When provided (including explicit null) it
    // is bound to the new `assignee_user_id` column in the SAME CAS UPDATE;
    // when omitted (legacy 2-arg callers) the column stays NULL.
    const claimTransaction = this.db.transaction(() => {
      // Read current task state
      const task = mapRow<import('../types/task.js').Task>(this.findByIdStmt, id);
      if (!task) return null;

      // CAS: only claim if unassigned and status is 'open'
      const claimStmt = this.db.prepare(
        `UPDATE tasks
         SET assignee = ?, assignee_user_id = ?, status = 'in_progress',
             version = version + 1,
             claimed_at = datetime('now'), updated_at = datetime('now')
         WHERE id = ? AND assignee IS NULL AND status = 'open' AND version = ?`,
      );
      const info = claimStmt.run(assignee, assigneeUserId ?? null, id, task.version);

      if (info.changes === 0) {
        // CAS failed - task was already claimed or status changed
        return null;
      }

      return this.findById(id);
    });

    // Execute with BEGIN IMMEDIATE to acquire write lock early
    return claimTransaction.immediate();
  }

  renewClaim(id: number, assignee: string): (Task & { tags: string[] }) | null {
    // Task #1003: claim renewal (heartbeat). The WHERE predicate is the
    // renewal contract — only the CURRENT holder of an in_progress claim can
    // refresh it. Refreshing claimed_at (and updated_at) restarts the
    // ClaimReleaseService TTL window; version bumps like every other write.
    const info = this.db
      .prepare(
        `UPDATE tasks
         SET claimed_at = datetime('now'), updated_at = datetime('now'),
             version = version + 1
         WHERE id = ? AND assignee = ? AND status = 'in_progress'`,
      )
      .run(id, assignee);

    if (info.changes === 0) {
      return null;
    }

    return this.findById(id);
  }

  findChildren(parentId: number, pagination?: PaginationOptions): Array<Task & { tags: string[] }> {
    const { limit, offset } = resolvePagination(pagination);
    const query = `
      SELECT
        t.*,
        p.name as project_name,
        GROUP_CONCAT(tt.tag, ',') as tags_csv
      FROM tasks t
      INNER JOIN projects p ON p.id = t.project_id
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
      return normalizeTaskTimestamps(inflateWsjf(inflateVerificationEvidence({ ...task, tags })));
    });
  }

  /**
   * Total children count for a parent task. Mirrors `count(filters)` semantics
   * for the subtask list endpoint — ignores limit/offset so the envelope can
   * report the true match count.
   */
  countChildren(parentId: number): number {
    const result = mapRow<{ count: number }>(
      this.db.prepare('SELECT COUNT(*) as count FROM tasks WHERE parent_task_id = ?'),
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
      params['project_id'] = filters.project_id;
    }

    if (filters.status !== undefined) {
      whereClauses.push('t.status = @status');
      params['status'] = filters.status;
    }

    if (filters.assignee !== undefined) {
      whereClauses.push('t.assignee = @assignee');
      params['assignee'] = filters.assignee;
    }

    if (filters.due_before !== undefined) {
      whereClauses.push('t.due_date <= @due_before');
      params['due_before'] = filters.due_before;
    }

    if (filters.due_after !== undefined) {
      whereClauses.push('t.due_date >= @due_after');
      params['due_after'] = filters.due_after;
    }

    if (filters.updated_before !== undefined) {
      whereClauses.push('datetime(t.updated_at) <= datetime(@updated_before)');
      params['updated_before'] = filters.updated_before;
    }

    if (filters.updated_after !== undefined) {
      whereClauses.push('datetime(t.updated_at) >= datetime(@updated_after)');
      params['updated_after'] = filters.updated_after;
    }

    if (filters.tags !== undefined && filters.tags.length > 0) {
      const tagPlaceholders = filters.tags.map((_, i) => `@tag${i}`).join(', ');
      whereClauses.push(
        `EXISTS (SELECT 1 FROM task_tags tt WHERE tt.task_id = t.id AND tt.tag IN (${tagPlaceholders}))`,
      );
      filters.tags.forEach((tag, i) => {
        params[`tag${i}`] = tag;
      });
    }

    if (filters.search !== undefined) {
      whereClauses.push('t.id IN (SELECT rowid FROM tasks_fts WHERE tasks_fts MATCH @search)');
      params['search'] = filters.search;
    }

    // Wave 1.4 (#312): mirror the verified-state predicate from findByFilters
    // so paginated callers get a `total` that matches the visible result set.
    if (filters.verified === true) {
      whereClauses.push(
        "json_extract(t.verification_evidence, '$.verdict') IN ('PASS', 'PARTIAL')",
      );
    } else if (filters.verified === false) {
      whereClauses.push(
        "(t.verification_evidence IS NULL OR json_extract(t.verification_evidence, '$.verdict') IN ('NOT_VERIFIED', 'FAIL'))",
      );
    }

    const whereClause = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

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

  findCompletedInRange(filters: CompletionRangeFilters): Array<Task & { tags: string[] }> {
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
      params['project_id'] = filters.project_id;
    }

    if (filters.assignee !== undefined) {
      whereClauses.push('t.assignee = @assignee');
      params['assignee'] = filters.assignee;
    }

    const query = `
      SELECT
        t.*,
        p.name as project_name,
        GROUP_CONCAT(tt.tag, ',') as tags_csv
      FROM tasks t
      INNER JOIN projects p ON p.id = t.project_id
      LEFT JOIN task_tags tt ON tt.task_id = t.id
      WHERE ${whereClauses.join(' AND ')}
      GROUP BY t.id
      ORDER BY t.completed_at ASC
    `;

    const rows = mapRows<Task & { tags_csv: string | null }>(this.db.prepare(query), params);

    return rows.map((row) => {
      const { tags_csv, ...task } = row;
      const tags = tags_csv ? tags_csv.split(',').sort() : [];
      return normalizeTaskTimestamps(inflateWsjf(inflateVerificationEvidence({ ...task, tags })));
    });
  }
}
