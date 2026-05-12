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

export interface IProjectRepository {
  create(dto: CreateProjectDTO): Project;
  findById(id: number): Project | null;
  findAll(): Project[];
  findByName(name: string): Project | null;
  update(id: number, updates: Partial<CreateProjectDTO>): Project;
  delete(id: number): void;
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
  findAll(): Array<Task & { tags: string[] }>;
  update(id: number, updates: UpdateTaskDTO): Task & { tags: string[] };
  delete(id: number): void;
  findByFilters(filters: TaskFilters): Array<Task & { tags: string[] }>;
  findChildren(parentId: number): Array<Task & { tags: string[] }>;
  count(filters?: TaskFilters): number;
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
  findByTaskId(taskId: number): Comment[];
  findById(id: number): Comment | null;
  delete(id: number): boolean;
  countByTaskId(taskId: number): number;
}
