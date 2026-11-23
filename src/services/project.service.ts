import { IProjectRepository, ITaskRepository } from '../repositories/interfaces.js';
import {
  ArchivedFilter,
  NON_TERMINAL_TASK_STATUSES,
  Project,
  PaginatedResponse,
  DEFAULT_PAGE_LIMIT,
  DEFAULT_PAGE_OFFSET,
  CreateProjectDTO,
} from '../types/task.js';
import { omitUndefined } from '../utils/omit-undefined.js';
// WSJF (Phase 3.2): validate against the charter-aware project schemas
// (added by task 637) so an optional `value_charter` survives the service
// boundary and reaches the repository instead of being stripped by the
// charter-less schema in task.schema.ts. `ValueCharterSchema` rejects
// non-Fibonacci theme weights here as a structured ValidationError.
import {
  ArchiveProjectSchema,
  ArchivedFilterValueSchema,
  CreateProjectSchema,
  UpdateProjectSchema,
} from '../schemas/project.schema.js';
import {
  ValidationError,
  BusinessError,
  NotFoundError,
  projectArchivedError,
  validationErrorFromIssues,
} from './errors.js';
import { eventBus } from '../events/event-bus.js';
import type { Database } from '../db/driver.js';
import type { IProjectCharterHistoryRepository } from '../repositories/project-charter-history.repository.js';

/**
 * Optional collaborators that wire the WSJF 4.2 charter-history snapshot into
 * the project update path. Both are optional so the dozens of existing
 * `new ProjectService(projectRepo)` callers (and every service-layer unit
 * test) keep working unchanged — when omitted, `updateProject` behaves exactly
 * as before and writes no snapshot.
 *
 * - `charterHistory` is the append-only `project_charter_history` writer.
 * - `db` is the SAME better-sqlite3 handle the project repo writes through, so
 *   the prior-charter snapshot and the charter overwrite commit atomically.
 * - `taskRepo` backs the archive precondition (no unfinished tasks). Without
 *   it `archiveProject` can only run with `force` — it fails closed otherwise.
 */
export interface ProjectServiceDeps {
  charterHistory?: IProjectCharterHistoryRepository;
  db?: Database;
  taskRepo?: Pick<ITaskRepository, 'countNonTerminalByStatus'>;
}

/** Re-evaluates one unarchived project (implemented by the WorkflowEngine). */
export interface UnarchiveReevaluator {
  /** The full pass, run by a real unarchive (WFT #2532). */
  reevaluateProject(projectId: number): { failedTaskIds: number[] };
  /** Only the ids that failed earlier in this process, run by a no-op unarchive (WFT #2543). */
  retryFailedTasks(projectId: number): { failedTaskIds: number[] };
}

/**
 * What an unarchive returns (WFT #2542): the project, and the tasks whose
 * re-evaluation rolled back. Empty when the pass was clean or no re-evaluator
 * is bound. A non-empty list means the unarchive itself succeeded but those
 * tasks kept their old state; unarchiving again (before a server restart)
 * retries them.
 */
export interface UnarchiveResult {
  project: Project;
  reevaluationFailedTaskIds: number[];
}

/** Pagination plus the `archived` listing filter (default `exclude`). */
export interface ProjectListOptions {
  limit?: number;
  offset?: number;
  archived?: ArchivedFilter;
}

/**
 * Stable code that starts the message of the BusinessError thrown when a
 * project cannot be archived because it still has unfinished tasks.
 */
export const PROJECT_HAS_UNFINISHED_TASKS_CODE = 'project_has_unfinished_tasks';

/** Actor attribution for a charter overwrite, recorded on the snapshot row. */
export interface ProjectUpdateActor {
  actorType?: string | null;
  actorId?: string | null;
}

/**
 * ProjectService - handles project business logic and validation
 */
export class ProjectService {
  // Declared `| undefined` (not `?:`) because the constructor assigns the
  // possibly-undefined `deps.*` unconditionally; under exactOptionalPropertyTypes
  // an exact-optional field cannot receive an explicit `undefined`. These are
  // internal collaborators, not part of any absent/null/value DTO convention.
  private readonly charterHistory: IProjectCharterHistoryRepository | undefined;
  private readonly db: Database | undefined;
  private readonly taskRepo: Pick<ITaskRepository, 'countNonTerminalByStatus'> | undefined;

  constructor(
    private readonly projectRepo: IProjectRepository,
    deps: ProjectServiceDeps = {},
  ) {
    this.charterHistory = deps.charterHistory;
    this.db = deps.db;
    this.taskRepo = deps.taskRepo;
  }

  /**
   * The unarchive re-evaluation (WFT #2532). A real unarchive runs the full
   * pass after it has committed; a repeated (no-op) unarchive only retries
   * the tasks whose re-evaluation failed earlier in this process (WFT #2543).
   * Either way the failed task ids go back to the caller (WFT #2542). Bound
   * late because the workflow engine is built after this service; `null`
   * unbinds it.
   */
  private unarchiveReevaluator: UnarchiveReevaluator | null = null;

  setUnarchiveReevaluator(reevaluator: UnarchiveReevaluator | null): void {
    this.unarchiveReevaluator = reevaluator;
  }

  /**
   * Create a new project with validation
   */
  createProject(input: unknown): Project {
    // Validate input
    const result = CreateProjectSchema.safeParse(input);
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

    // Check for duplicate name
    const existing = this.projectRepo.findByName(result.data.name);
    if (existing) {
      throw new BusinessError('Project with this name already exists');
    }

    // Create project. `description` / `value_charter` / `model_policy` / `scm`
    // are omitted when absent so the optional columns stay untouched; explicit
    // `null` is preserved (the absent / null / value three-state convention).
    // `name` stays required.
    const createDto: CreateProjectDTO = {
      name: result.data.name,
      ...(result.data.description !== undefined && { description: result.data.description }),
      ...(result.data.value_charter !== undefined && {
        value_charter: result.data.value_charter,
      }),
      ...(result.data.model_policy !== undefined && {
        model_policy: result.data.model_policy,
      }),
      ...(result.data.scm !== undefined && {
        scm: result.data.scm,
      }),
    };
    const project = this.projectRepo.create(createDto);

    // Emit project.created event after successful database operation
    eventBus.emit('project.created', {
      eventType: 'project.created',
      timestamp: new Date().toISOString(),
      data: project,
      metadata: { source: 'user' },
    });

    return project;
  }

  /**
   * Get project by ID
   */
  getProject(id: number): Project {
    const project = this.projectRepo.findById(id);
    if (!project) {
      throw new NotFoundError('Project', id);
    }
    return project;
  }

  /**
   * List projects — returns just the current page as a plain array.
   * Internal callers that don't need the envelope use this. Archived projects
   * are omitted unless `options.archived` is `include` or `only`.
   */
  listProjects(options?: ProjectListOptions): Project[] {
    const archived = this.parseArchivedFilter(options?.archived);
    return this.projectRepo.findAll(
      omitUndefined({ limit: options?.limit, offset: options?.offset }),
      archived,
    );
  }

  /**
   * Paginated list-projects: returns `{ data, total, limit, offset }`.
   * Used by the REST list endpoint and the MCP list_projects tool. `total`
   * counts the same `archived`-filtered set as `data`.
   */
  listProjectsPaginated(options?: ProjectListOptions): PaginatedResponse<Project> {
    const limit = options?.limit ?? DEFAULT_PAGE_LIMIT;
    const offset = options?.offset ?? DEFAULT_PAGE_OFFSET;
    const archived = this.parseArchivedFilter(options?.archived);
    const data = this.projectRepo.findAll({ limit, offset }, archived);
    const total = this.projectRepo.count(archived);
    return { data, total, limit, offset };
  }

  /** Absent → `exclude`; anything outside the enum is a ValidationError. */
  private parseArchivedFilter(value: unknown): ArchivedFilter {
    if (value === undefined) {
      return 'exclude';
    }
    const result = ArchivedFilterValueSchema.safeParse(value);
    if (!result.success) {
      throw new ValidationError({ archived: result.error.issues.map((issue) => issue.message) });
    }
    return result.data;
  }

  /**
   * Archive a project (docs/design/project-archived-state.md §2.2).
   *
   * - Refused with a BusinessError (422) carrying the count per status while
   *   any task is `open`, `in_progress`, `blocked` or `backlogged`, unless
   *   `force: true` — which requires a `reason`. A forced archive does not
   *   change any task's status.
   * - `actor` is the authenticated caller and becomes `archived_by`; nothing
   *   in `input` can set it.
   * - Archiving an already archived project is a no-op: the project is
   *   returned as it is and no event is emitted.
   * - Emits `project.archived` exactly once per real transition, decided by
   *   the repository's `changed` flag, and never `project.updated`.
   */
  archiveProject(id: number, input: unknown, actor: string): Project {
    const result = ArchiveProjectSchema.safeParse(input ?? {});
    if (!result.success) {
      throw validationErrorFromIssues(result.error.issues);
    }

    const existing = this.projectRepo.findById(id);
    if (!existing) {
      throw new NotFoundError('Project', id);
    }
    if (existing.archived) {
      return existing;
    }

    if (result.data.force !== true) {
      this.assertNoUnfinishedTasks(id);
    }

    const { project, changed } = this.projectRepo.archive(id, actor, result.data.reason ?? null);
    if (changed) {
      eventBus.emit('project.archived', {
        eventType: 'project.archived',
        timestamp: new Date().toISOString(),
        data: project,
        metadata: { source: 'user', actor },
      });
    }
    return project;
  }

  /**
   * Unarchive a project: clears `archived_at`, `archived_by` and
   * `archive_reason`. A no-op that emits nothing when the project is not
   * archived; otherwise emits `project.unarchived` exactly once (never
   * `project.updated`) and runs the full re-evaluation; a no-op only retries
   * the tasks that failed before (see `setUnarchiveReevaluator`). Either way
   * it returns the ids that failed. `actor` is the authenticated caller.
   */
  unarchiveProject(id: number, actor: string): UnarchiveResult {
    if (!this.projectRepo.findById(id)) {
      throw new NotFoundError('Project', id);
    }

    const { project, changed } = this.projectRepo.unarchive(id);
    if (changed) {
      eventBus.emit('project.unarchived', {
        eventType: 'project.unarchived',
        timestamp: new Date().toISOString(),
        data: project,
        metadata: { source: 'user', actor },
      });
    }
    // The unarchive has committed. A real one runs the full pass (WFT #2532);
    // a repeated one retries only what failed before, so it never opens a
    // task blocked by hand (WFT #2543). Failures go back to the caller
    // (WFT #2542).
    const outcome = changed
      ? this.unarchiveReevaluator?.reevaluateProject(id)
      : this.unarchiveReevaluator?.retryFailedTasks(id);
    return { project, reevaluationFailedTaskIds: outcome?.failedTaskIds ?? [] };
  }

  private assertNoUnfinishedTasks(projectId: number): void {
    if (!this.taskRepo) {
      // Fail closed: without the task repository the precondition cannot be
      // checked, and archiving unchecked would silently skip it.
      throw new Error('ProjectService.archiveProject requires a task repository (deps.taskRepo)');
    }
    const counts = this.taskRepo.countNonTerminalByStatus(projectId);
    const total = NON_TERMINAL_TASK_STATUSES.reduce((sum, status) => sum + counts[status], 0);
    if (total === 0) {
      return;
    }
    const perStatus = NON_TERMINAL_TASK_STATUSES.map((status) => `${status}: ${counts[status]}`);
    throw new BusinessError(
      `${PROJECT_HAS_UNFINISHED_TASKS_CODE}: project ${projectId} has ${total} unfinished ` +
        `task${total === 1 ? '' : 's'} (${perStatus.join(', ')}); finish or close them, ` +
        'or archive with force: true and a reason',
      // WFT #2530: the same counts, machine-readable.
      {
        code: PROJECT_HAS_UNFINISHED_TASKS_CODE,
        total,
        counts: Object.fromEntries(
          NON_TERMINAL_TASK_STATUSES.map((status) => [status, counts[status]]),
        ),
      },
    );
  }

  /**
   * Update a project.
   *
   * WSJF 4.2 (task #642): when the update REPLACES an existing (non-null)
   * `value_charter` with a new (non-null) charter — i.e. the charter interview
   * was re-run — the PRIOR charter is snapshotted to `project_charter_history`
   * BEFORE the overwrite lands, tagged with the NEW charter's
   * `interview_version` (which the skill bumps). The snapshot + the projects
   * UPDATE commit atomically when a `db` handle was injected. The snapshot is
   * only ever taken on this project code path; nothing here touches task
   * scoring. Clearing a charter (`value_charter: null`) or setting a charter on
   * a project that had none takes NO snapshot — there is no prior charter to
   * preserve.
   */
  updateProject(id: number, input: unknown, actor: ProjectUpdateActor = {}): Project {
    // Validate input with partial schema
    const result = UpdateProjectSchema.safeParse(input);
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
    const existing = this.projectRepo.findById(id);
    if (!existing) {
      throw new NotFoundError('Project', id);
    }

    // Archived project state: an archived project is frozen — unarchive first.
    if (existing.archived) {
      throw projectArchivedError(id);
    }

    // If name is being changed, check uniqueness
    if (result.data.name && result.data.name !== existing.name) {
      const duplicate = this.projectRepo.findByName(result.data.name);
      if (duplicate) {
        throw new BusinessError('Project with this name already exists');
      }
    }

    // WSJF 4.2: detect a charter OVERWRITE — a new non-null charter replacing a
    // pre-existing non-null charter. Only then is there a prior charter worth
    // snapshotting.
    const newCharter = result.data.value_charter;
    const priorCharter = existing.value_charter;
    const isCharterOverwrite =
      this.charterHistory != null && newCharter != null && priorCharter != null;

    // Update project (snapshotting the prior charter first, atomically when a
    // db handle is available).
    const doUpdate = (): Project => {
      if (isCharterOverwrite) {
        this.charterHistory!.append({
          projectId: id,
          interviewVersion: newCharter!.interview_version,
          charter: priorCharter!,
          changeKind: 'overwrite',
          actorType: actor.actorType ?? null,
          actorId: actor.actorId ?? null,
        });
      }
      // Strip undefined-valued keys so omitted props leave their columns
      // untouched while explicit `null` (clear) and values survive — the
      // absent / null / value three-state convention the repo update builder
      // relies on.
      return this.projectRepo.update(id, omitUndefined(result.data));
    };

    const updatedProject =
      isCharterOverwrite && this.db ? this.db.transaction(doUpdate)() : doUpdate();

    // Emit project.updated event after successful database operation
    eventBus.emit('project.updated', {
      eventType: 'project.updated',
      timestamp: new Date().toISOString(),
      data: updatedProject,
      metadata: { source: 'user' },
    });

    return updatedProject;
  }

  /**
   * Delete a project
   */
  deleteProject(id: number): void {
    // Verify project exists
    const existing = this.projectRepo.findById(id);
    if (!existing) {
      throw new NotFoundError('Project', id);
    }

    // Emit project.deleted event BEFORE deletion so consumers can still query related entities
    eventBus.emit('project.deleted', {
      eventType: 'project.deleted',
      timestamp: new Date().toISOString(),
      data: existing,
      metadata: { source: 'user' },
    });

    this.projectRepo.delete(id);
  }
}
