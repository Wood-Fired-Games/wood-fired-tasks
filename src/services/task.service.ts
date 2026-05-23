import { ITaskRepository, IProjectRepository } from '../repositories/interfaces.js';
import {
  Task,
  VALID_STATUS_TRANSITIONS,
  TaskPriority,
  PaginatedResponse,
  DEFAULT_PAGE_LIMIT,
  DEFAULT_PAGE_OFFSET,
} from '../types/task.js';
import { CreateTaskSchema, UpdateTaskSchema, TaskFiltersSchema, CompletionReportSchema } from '../schemas/task.schema.js';
import { ValidationError, BusinessError, NotFoundError } from './errors.js';
import { FtsSyntaxError } from '../repositories/errors.js';
import { eventBus } from '../events/event-bus.js';

/**
 * Sanitized message surfaced to clients when the FTS5 search expression
 * fails to parse. The raw SQLite error text is intentionally NOT included —
 * see `FtsSyntaxError.originalMessage` for the value preserved for logging.
 */
const FTS_SYNTAX_ERROR_MESSAGE =
  'Invalid search syntax. The search query must be a valid SQLite FTS5 expression.';

function ftsValidationError(): ValidationError {
  return new ValidationError({ search: [FTS_SYNTAX_ERROR_MESSAGE] });
}

/**
 * Inputs for {@link TaskService.getCompletionReport}.
 *
 * One of `days` or both `start`/`end` must be provided. `start`/`end` are
 * inclusive ISO8601 timestamps; `days` is a count of trailing days ending now.
 */
export interface CompletionReportInput {
  days?: number;
  start?: string;
  end?: string;
  project_id?: number;
  assignee?: string;
}

export interface CompletionReportRow {
  id: number;
  title: string;
  project_id: number;
  project_name: string;
  assignee: string | null;
  priority: TaskPriority;
  created_at: string;
  completed_at: string;
  time_to_complete_seconds: number;
}

export interface CompletionReport {
  range: { start: string; end: string };
  total: number;
  rows: CompletionReportRow[];
  by_project: Array<{ project_id: number; count: number }>;
  by_assignee: Array<{ assignee: string; count: number }>;
  by_priority: Array<{ priority: TaskPriority; count: number }>;
  daily_throughput: Array<{ date: string; count: number }>;
}

/**
 * TaskService - handles task business logic, validation, and status lifecycle
 */
export class TaskService {
  constructor(
    private readonly taskRepo: ITaskRepository,
    private readonly projectRepo: IProjectRepository
  ) {}

  /**
   * Create a new task with validation
   * Tasks always start with status 'open' regardless of input
   */
  createTask(input: unknown): Task & { tags: string[] } {
    // Validate input
    const result = CreateTaskSchema.safeParse(input);
    if (!result.success) {
      const fieldErrors: Record<string, string[]> = {};
      result.error.issues.forEach((err) => {
        const field = err.path.join('.');
        if (!fieldErrors[field]) {
          fieldErrors[field] = [];
        }
        fieldErrors[field].push(err.message);
      });
      throw new ValidationError(fieldErrors);
    }

    // Verify project exists
    const project = this.projectRepo.findById(result.data.project_id);
    if (!project) {
      throw new BusinessError(`Project with id ${result.data.project_id} does not exist`);
    }

    // Validate parent_task_id if provided
    if (result.data.parent_task_id) {
      const parentTask = this.taskRepo.findById(result.data.parent_task_id);
      if (!parentTask) {
        throw new BusinessError(
          `Parent task with id ${result.data.parent_task_id} does not exist`
        );
      }

      // Ensure parent task is in the same project
      if (parentTask.project_id !== result.data.project_id) {
        throw new BusinessError('Parent task must be in the same project');
      }
    }

    // Create task with status forced to 'open'
    const task = this.taskRepo.create(
      { ...result.data, status: 'open' },
      result.data.tags
    );

    // Emit task.created event after successful database operation
    eventBus.emit('task.created', {
      eventType: 'task.created',
      timestamp: new Date().toISOString(),
      data: task,
      metadata: { source: 'user' }
    });

    return task;
  }

  /**
   * Get task by ID
   */
  getTask(id: number): Task & { tags: string[] } {
    const task = this.taskRepo.findById(id);
    if (!task) {
      throw new NotFoundError('Task', id);
    }
    return task;
  }

  /**
   * List tasks with optional filtering.
   *
   * Returns a plain array of the current page — callers who need the
   * paginated envelope (with `total` for client-side pagination UIs) should
   * use {@link listTasksPaginated} instead. This shape is preserved for the
   * many internal callers (workflow engine, MCP tools) that don't need the
   * envelope and only care about the rows.
   */
  listTasks(filters?: unknown): Array<Task & { tags: string[] }> {
    const parsed = this.parseFilters(filters);
    try {
      return this.taskRepo.findByFilters(parsed);
    } catch (err) {
      if (err instanceof FtsSyntaxError) {
        throw ftsValidationError();
      }
      throw err;
    }
  }

  /**
   * Paginated list-tasks: returns `{ data, total, limit, offset }`.
   *
   * `total` is the unbounded match count for the same filter set so clients
   * can render "page X of Y" navigation without re-issuing the query without
   * filters. Used by the REST list endpoint and the MCP list_tasks tool.
   */
  listTasksPaginated(
    filters?: unknown
  ): PaginatedResponse<Task & { tags: string[] }> {
    const parsed = this.parseFilters(filters);
    const limit = parsed.limit ?? DEFAULT_PAGE_LIMIT;
    const offset = parsed.offset ?? DEFAULT_PAGE_OFFSET;
    try {
      const data = this.taskRepo.findByFilters({ ...parsed, limit, offset });
      // `count` deliberately runs WITHOUT limit/offset so `total` reflects
      // the full match set.
      const { limit: _l, offset: _o, ...filtersForCount } = parsed;
      const total = this.taskRepo.count(filtersForCount);
      return { data, total, limit, offset };
    } catch (err) {
      if (err instanceof FtsSyntaxError) {
        throw ftsValidationError();
      }
      throw err;
    }
  }

  private parseFilters(filters?: unknown) {
    if (filters === undefined) return {};
    const result = TaskFiltersSchema.safeParse(filters);
    if (!result.success) {
      const fieldErrors: Record<string, string[]> = {};
      result.error.issues.forEach((err) => {
        const field = err.path.join('.');
        if (!fieldErrors[field]) {
          fieldErrors[field] = [];
        }
        fieldErrors[field].push(err.message);
      });
      throw new ValidationError(fieldErrors);
    }
    return result.data;
  }

  /**
   * Update task with status lifecycle validation
   */
  updateTask(id: number, input: unknown, source: 'user' | 'workflow' = 'user'): Task & { tags: string[] } {
    // Validate input
    const result = UpdateTaskSchema.safeParse(input);
    if (!result.success) {
      const fieldErrors: Record<string, string[]> = {};
      result.error.issues.forEach((err) => {
        const field = err.path.join('.');
        if (!fieldErrors[field]) {
          fieldErrors[field] = [];
        }
        fieldErrors[field].push(err.message);
      });
      throw new ValidationError(fieldErrors);
    }

    // Fetch existing task
    const existing = this.taskRepo.findById(id);
    if (!existing) {
      throw new NotFoundError('Task', id);
    }

    // Validate status transition if status is being changed
    const statusChanged = result.data.status && result.data.status !== existing.status;
    if (statusChanged) {
      const validTargets = VALID_STATUS_TRANSITIONS[existing.status];
      if (!validTargets.includes(result.data.status!)) {
        throw new BusinessError(
          `Invalid status transition from '${existing.status}' to '${result.data.status}'. Valid transitions: ${validTargets.join(', ')}`
        );
      }
    }

    // Wave 1.4 (#312): when a task transitions to a closing status (done or
    // closed) AND the caller did not supply explicit verification_evidence
    // AND the row currently has no evidence, materialize the explicit
    // "no one verified this" marker so the column carries intent rather
    // than NULL ambiguity.
    //
    // Why only on the close transitions:
    //  - Other transitions (in_progress, blocked, backlogged, open) do not
    //    represent a verification opportunity. Stamping NOT_VERIFIED there
    //    would falsely imply a verifier looked at the task.
    //  - `existing.verification_evidence === null` guards against clobbering
    //    a real previous verdict if the task is reopened and re-closed; the
    //    historical PASS/FAIL stays put.
    //
    // We deliberately set ONLY the verdict — no verified_at timestamp, no
    // verifier_session_id — so the row reflects truthfully that nothing
    // was checked.
    const updatesForRepo = { ...result.data };
    const isClosingTransition =
      statusChanged &&
      (result.data.status === 'done' || result.data.status === 'closed');
    if (
      isClosingTransition &&
      result.data.verification_evidence === undefined &&
      existing.verification_evidence === null
    ) {
      updatesForRepo.verification_evidence = { verdict: 'NOT_VERIFIED' };
    }

    // Update task
    const updatedTask = this.taskRepo.update(id, updatesForRepo);

    // Emit task.updated event after successful database operation
    eventBus.emit('task.updated', {
      eventType: 'task.updated',
      timestamp: new Date().toISOString(),
      data: updatedTask,
      metadata: { source }
    });

    // If status changed, also emit task.status_changed event
    if (statusChanged) {
      eventBus.emit('task.status_changed', {
        eventType: 'task.status_changed',
        timestamp: new Date().toISOString(),
        data: updatedTask,
        metadata: {
          source,
          from: existing.status,
          to: result.data.status!
        } as any // Metadata can include additional fields beyond the base type
      });
    }

    return updatedTask;
  }

  /**
   * Delete task
   */
  deleteTask(id: number): void {
    // Verify task exists
    const existing = this.taskRepo.findById(id);
    if (!existing) {
      throw new NotFoundError('Task', id);
    }

    // Emit task.deleted event BEFORE deletion so consumers can still query related entities
    eventBus.emit('task.deleted', {
      eventType: 'task.deleted',
      timestamp: new Date().toISOString(),
      data: existing,
      metadata: { source: 'user' }
    });

    this.taskRepo.delete(id);
  }

  /**
   * Count tasks with optional filtering
   */
  countTasks(filters?: unknown): number {
    // If filters provided, validate them
    if (filters !== undefined) {
      const result = TaskFiltersSchema.safeParse(filters);
      if (!result.success) {
        const fieldErrors: Record<string, string[]> = {};
        result.error.issues.forEach((err) => {
          const field = err.path.join('.');
          if (!fieldErrors[field]) {
            fieldErrors[field] = [];
          }
          fieldErrors[field].push(err.message);
        });
        throw new ValidationError(fieldErrors);
      }
      try {
        return this.taskRepo.count(result.data);
      } catch (err) {
        if (err instanceof FtsSyntaxError) {
          throw ftsValidationError();
        }
        throw err;
      }
    }

    return this.taskRepo.count();
  }

  /**
   * Search tasks by text (convenience method)
   */
  searchTasks(query: string): Array<Task & { tags: string[] }> {
    return this.listTasks({ search: query });
  }

  /**
   * Claim a task atomically for an agent
   * Uses CAS (Compare-And-Swap) pattern with BEGIN IMMEDIATE for SQLite concurrency safety
   */
  claimTask(
    taskId: number,
    assignee: string,
    source: 'user' | 'workflow' = 'user',
    assigneeUserId?: number | null,
  ): Task & { tags: string[] } {
    // Phase 31 (Plan 31-01): the trailing `assigneeUserId` mirrors the
    // additive-positional precedent set by `source`. All existing 3-arg
    // callers continue to work; the repository binds NULL when undefined.
    // Validate task exists
    const existing = this.taskRepo.findById(taskId);
    if (!existing) {
      throw new NotFoundError('Task', taskId);
    }

    // Validate task is in claimable state
    if (existing.status !== 'open') {
      throw new BusinessError(`Task ${taskId} cannot be claimed: status is '${existing.status}', must be 'open'`);
    }

    if (existing.assignee) {
      throw new BusinessError(`Task ${taskId} is already claimed by '${existing.assignee}'`);
    }

    // Attempt atomic claim via repository
    const claimed = this.taskRepo.claimTask(taskId, assignee, assigneeUserId ?? null);
    if (!claimed) {
      // CAS failed - another agent claimed it between our check and the update
      throw new BusinessError(`Task ${taskId} is already claimed (concurrent claim detected)`);
    }

    // Emit task.claimed event after successful claim
    eventBus.emit('task.claimed', {
      eventType: 'task.claimed',
      timestamp: new Date().toISOString(),
      data: claimed,
      metadata: { source }
    });

    return claimed;
  }

  /**
   * Get a completion report for tasks transitioned to 'done' inside a range.
   *
   * Accepts either `days` (trailing N days from now) or explicit `start`/`end`
   * ISO8601 bounds. Both bounds are inclusive.
   */
  getCompletionReport(input: unknown): CompletionReport {
    const parsed = CompletionReportSchema.safeParse(input);
    if (!parsed.success) {
      const fieldErrors: Record<string, string[]> = {};
      parsed.error.issues.forEach((err) => {
        const field = err.path.join('.') || '_';
        if (!fieldErrors[field]) fieldErrors[field] = [];
        fieldErrors[field].push(err.message);
      });
      throw new ValidationError(fieldErrors);
    }

    const { start, end } = resolveRange(parsed.data);
    const tasks = this.taskRepo.findCompletedInRange({
      start,
      end,
      project_id: parsed.data.project_id,
      assignee: parsed.data.assignee,
    });

    const rows: CompletionReportRow[] = tasks.map((t) => {
      const completedAt = t.completed_at ?? t.updated_at;
      const startMs = Date.parse(t.created_at);
      const endMs = Date.parse(completedAt);
      const seconds = Number.isFinite(startMs) && Number.isFinite(endMs)
        ? Math.max(0, Math.round((endMs - startMs) / 1000))
        : 0;
      return {
        id: t.id,
        title: t.title,
        project_id: t.project_id,
        project_name: t.project_name,
        assignee: t.assignee,
        priority: t.priority,
        created_at: t.created_at,
        completed_at: completedAt,
        time_to_complete_seconds: seconds,
      };
    });

    return {
      range: { start, end },
      total: rows.length,
      rows,
      by_project: aggregate(rows, (r) => r.project_id).map(([k, v]) => ({
        project_id: k as number,
        count: v,
      })),
      by_assignee: aggregate(rows, (r) => r.assignee ?? '(unassigned)').map(
        ([k, v]) => ({ assignee: k as string, count: v })
      ),
      by_priority: aggregate(rows, (r) => r.priority).map(([k, v]) => ({
        priority: k as TaskPriority,
        count: v,
      })),
      daily_throughput: aggregate(rows, (r) =>
        r.completed_at.slice(0, 10)
      ).map(([k, v]) => ({ date: k as string, count: v })),
    };
  }

  /**
   * Get subtasks (children) of a parent task — current page only.
   *
   * Internal callers that need the array directly use this. The REST/MCP
   * surfaces should use {@link getSubtasksPaginated} so clients get the
   * envelope with `total` and can iterate pages.
   */
  getSubtasks(
    taskId: number,
    pagination?: { limit?: number; offset?: number }
  ): Array<Task & { tags: string[] }> {
    // Verify parent task exists
    const parentTask = this.taskRepo.findById(taskId);
    if (!parentTask) {
      throw new NotFoundError('Task', taskId);
    }

    return this.taskRepo.findChildren(taskId, pagination);
  }

  /**
   * Paginated subtasks: `{ data, total, limit, offset }`. Same envelope as
   * the rest of the list endpoints.
   */
  getSubtasksPaginated(
    taskId: number,
    pagination?: { limit?: number; offset?: number }
  ): PaginatedResponse<Task & { tags: string[] }> {
    const parentTask = this.taskRepo.findById(taskId);
    if (!parentTask) {
      throw new NotFoundError('Task', taskId);
    }
    const limit = pagination?.limit ?? DEFAULT_PAGE_LIMIT;
    const offset = pagination?.offset ?? DEFAULT_PAGE_OFFSET;
    const data = this.taskRepo.findChildren(taskId, { limit, offset });
    const total = this.taskRepo.countChildren(taskId);
    return { data, total, limit, offset };
  }
}

/**
 * Resolve a CompletionReport request into concrete inclusive ISO8601 bounds.
 *
 * `days` -> [now - days, now]. Otherwise uses the provided start/end.
 * The schema layer guarantees one form is present and bounds are well-formed.
 */
function resolveRange(input: CompletionReportInput): { start: string; end: string } {
  if (input.days !== undefined) {
    const end = new Date();
    const start = new Date(end.getTime() - input.days * 24 * 60 * 60 * 1000);
    return { start: start.toISOString(), end: end.toISOString() };
  }
  return { start: input.start!, end: input.end! };
}

function aggregate<T, K extends string | number>(
  rows: T[],
  key: (row: T) => K
): Array<[K, number]> {
  const counts = new Map<K, number>();
  for (const row of rows) {
    const k = key(row);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) =>
    b[1] !== a[1] ? b[1] - a[1] : String(a[0]).localeCompare(String(b[0]))
  );
}
