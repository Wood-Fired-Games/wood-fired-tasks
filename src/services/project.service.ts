import { IProjectRepository } from '../repositories/interfaces.js';
import {
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
import { CreateProjectSchema, UpdateProjectSchema } from '../schemas/project.schema.js';
import { ValidationError, BusinessError, NotFoundError } from './errors.js';
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
 */
export interface ProjectServiceDeps {
  charterHistory?: IProjectCharterHistoryRepository;
  db?: Database;
}

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

  constructor(
    private readonly projectRepo: IProjectRepository,
    deps: ProjectServiceDeps = {},
  ) {
    this.charterHistory = deps.charterHistory;
    this.db = deps.db;
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

    // Create project. `description` / `value_charter` / `model_policy` are
    // omitted when absent so the optional columns stay untouched; explicit
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
   * Internal callers that don't need the envelope use this.
   */
  listProjects(pagination?: { limit?: number; offset?: number }): Project[] {
    return this.projectRepo.findAll(pagination);
  }

  /**
   * Paginated list-projects: returns `{ data, total, limit, offset }`.
   * Used by the REST list endpoint and the MCP list_projects tool.
   */
  listProjectsPaginated(pagination?: {
    limit?: number;
    offset?: number;
  }): PaginatedResponse<Project> {
    const limit = pagination?.limit ?? DEFAULT_PAGE_LIMIT;
    const offset = pagination?.offset ?? DEFAULT_PAGE_OFFSET;
    const data = this.projectRepo.findAll({ limit, offset });
    const total = this.projectRepo.count();
    return { data, total, limit, offset };
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
