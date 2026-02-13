import { ITaskRepository, IProjectRepository } from '../repositories/interfaces.js';
import { Task, VALID_STATUS_TRANSITIONS } from '../types/task.js';
import { CreateTaskSchema, UpdateTaskSchema, TaskFiltersSchema } from '../schemas/task.schema.js';
import { ValidationError, BusinessError, NotFoundError } from './errors.js';

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
    return this.taskRepo.create(
      { ...result.data, status: 'open' },
      result.data.tags
    );
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
   * List tasks with optional filtering
   */
  listTasks(filters?: unknown): Array<Task & { tags: string[] }> {
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
      return this.taskRepo.findByFilters(result.data);
    }

    return this.taskRepo.findByFilters({});
  }

  /**
   * Update task with status lifecycle validation
   */
  updateTask(id: number, input: unknown): Task & { tags: string[] } {
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
    if (result.data.status && result.data.status !== existing.status) {
      const validTargets = VALID_STATUS_TRANSITIONS[existing.status];
      if (!validTargets.includes(result.data.status)) {
        throw new BusinessError(
          `Invalid status transition from '${existing.status}' to '${result.data.status}'. Valid transitions: ${validTargets.join(', ')}`
        );
      }
    }

    // Update task
    return this.taskRepo.update(id, result.data);
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
      return this.taskRepo.count(result.data);
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
   * Get all subtasks (children) of a parent task
   */
  getSubtasks(taskId: number): Array<Task & { tags: string[] }> {
    // Verify parent task exists
    const parentTask = this.taskRepo.findById(taskId);
    if (!parentTask) {
      throw new NotFoundError('Task', taskId);
    }

    return this.taskRepo.findChildren(taskId);
  }
}
