import type {
  Project,
  CreateProjectDTO,
  Task,
  CreateTaskDTO,
  UpdateTaskDTO,
  TaskFilters,
  Dependency,
  CreateDependencyDTO,
  Comment,
  CreateCommentDTO,
} from '../types/task.js';

/**
 * Bounded pagination options accepted by every list-style repository call.
 * Both fields are optional at the type level; repositories apply sensible
 * defaults when callers omit them (typically: limit=50, offset=0).
 */
export interface PaginationOptions {
  limit?: number;
  offset?: number;
}

export interface IProjectRepository {
  create(dto: CreateProjectDTO): Project;
  findById(id: number): Project | null;
  findAll(pagination?: PaginationOptions): Project[];
  findByName(name: string): Project | null;
  update(id: number, updates: Partial<CreateProjectDTO>): Project;
  delete(id: number): void;
  /** Total project count, ignoring pagination. Used to build list envelopes. */
  count(): number;
}

export interface CompletionRangeFilters {
  start: string; // ISO8601 inclusive
  end: string; // ISO8601 inclusive
  project_id?: number;
  assignee?: string;
}

export interface ITaskRepository {
  create(dto: CreateTaskDTO, tags?: string[]): Task & { tags: string[] };
  findById(id: number): (Task & { tags: string[] }) | null;
  findAll(pagination?: PaginationOptions): Array<Task & { tags: string[] }>;
  update(id: number, updates: UpdateTaskDTO): Task & { tags: string[] };
  delete(id: number): void;
  /**
   * Filter + paginate tasks. `filters.limit`/`filters.offset` ride along on
   * the TaskFilters object so callers (CLI, MCP, REST) all share one shape.
   */
  findByFilters(filters: TaskFilters): Array<Task & { tags: string[] }>;
  findChildren(
    parentId: number,
    pagination?: PaginationOptions
  ): Array<Task & { tags: string[] }>;
  /**
   * Total match count for the same filter set, ignoring pagination.
   * Powers the `total` field in the {data,total,limit,offset} envelope.
   */
  count(filters?: TaskFilters): number;
  /** Total children count for a parent task, ignoring pagination. */
  countChildren(parentId: number): number;
  claimTask(id: number, assignee: string): (Task & { tags: string[] }) | null;
  findCompletedInRange(
    filters: CompletionRangeFilters
  ): Array<Task & { tags: string[] }>;
}

export interface IDependencyRepository {
  create(dto: CreateDependencyDTO): Dependency;
  findAll(): Dependency[];
  findByTaskId(taskId: number): Dependency[];
  findBlockingTask(taskId: number): Dependency[];
  delete(taskId: number, blocksTaskId: number): boolean;
  deleteByTaskId(taskId: number): void;
}

export interface ICommentRepository {
  create(dto: CreateCommentDTO): Comment;
  findByTaskId(taskId: number, pagination?: PaginationOptions): Comment[];
  findById(id: number): Comment | null;
  delete(id: number): boolean;
  countByTaskId(taskId: number): number;
}
