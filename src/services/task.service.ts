import { ITaskRepository, IProjectRepository } from '../repositories/interfaces.js';
import { Task, VALID_STATUS_TRANSITIONS } from '../types/task.js';
import { CreateTaskSchema, UpdateTaskSchema, TaskFiltersSchema } from '../schemas/task.schema.js';
import { ValidationError, BusinessError, NotFoundError } from './errors.js';
import { eventBus } from '../events/event-bus.js';

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

    // Update task
    const updatedTask = this.taskRepo.update(id, result.data);

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
   * Claim a task atomically for an agent
   * Uses CAS (Compare-And-Swap) pattern with BEGIN IMMEDIATE for SQLite concurrency safety
   */
  claimTask(taskId: number, assignee: string, source: 'user' | 'workflow' = 'user'): Task & { tags: string[] } {
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
    const claimed = this.taskRepo.claimTask(taskId, assignee);
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
