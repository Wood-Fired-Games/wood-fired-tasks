import type {
  Project,
  CreateProjectDTO,
  Task,
  CreateTaskDTO,
  UpdateTaskDTO,
  TaskFilters,
  Dependency,
  CreateDependencyDTO,
} from '../types/task.js';

export interface IProjectRepository {
  create(dto: CreateProjectDTO): Project;
  findById(id: number): Project | null;
  findAll(): Project[];
  findByName(name: string): Project | null;
  update(id: number, updates: Partial<CreateProjectDTO>): Project;
  delete(id: number): void;
}

export interface ITaskRepository {
  create(dto: CreateTaskDTO, tags?: string[]): Task & { tags: string[] };
  findById(id: number): (Task & { tags: string[] }) | null;
  findAll(): Array<Task & { tags: string[] }>;
  update(id: number, updates: UpdateTaskDTO): Task & { tags: string[] };
  delete(id: number): void;
  findByFilters(filters: TaskFilters): Array<Task & { tags: string[] }>;
  count(filters?: TaskFilters): number;
}

export interface IDependencyRepository {
  create(dto: CreateDependencyDTO): Dependency;
  findAll(): Dependency[];
  findByTaskId(taskId: number): Dependency[];
  findBlockingTask(taskId: number): Dependency[];
  delete(taskId: number, blocksTaskId: number): boolean;
  deleteByTaskId(taskId: number): void;
}
