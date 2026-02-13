import type {
  IDependencyRepository,
  ITaskRepository,
} from '../repositories/interfaces.js';
import type { Dependency } from '../types/task.js';
import { CreateDependencySchema } from '../schemas/dependency.schema.js';
import { ValidationError, BusinessError, NotFoundError } from './errors.js';
import { CycleDetector } from '../utils/cycle-detector.js';

/**
 * DependencyService - handles task dependency business logic and cycle detection
 */
export class DependencyService {
  constructor(
    private readonly dependencyRepo: IDependencyRepository,
    private readonly taskRepo: ITaskRepository
  ) {}

  /**
   * Add a dependency between two tasks with cycle detection
   * @param input - { task_id: number, blocks_task_id: number }
   * @returns The created dependency
   * @throws ValidationError if input is invalid or self-dependency
   * @throws NotFoundError if either task doesn't exist
   * @throws BusinessError if adding dependency would create a cycle
   */
  addDependency(input: unknown): Dependency {
    // Validate input
    const result = CreateDependencySchema.safeParse(input);
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

    const { task_id, blocks_task_id } = result.data;

    // Verify both tasks exist
    const task = this.taskRepo.findById(task_id);
    if (!task) {
      throw new NotFoundError('Task', task_id);
    }

    const blockedTask = this.taskRepo.findById(blocks_task_id);
    if (!blockedTask) {
      throw new NotFoundError('Task', blocks_task_id);
    }

    // Load all existing dependencies for cycle detection
    const existingDeps = this.dependencyRepo.findAll();

    // Create cycle detector and check for cycles
    const detector = new CycleDetector(existingDeps);
    if (detector.wouldCreateCycle(task_id, blocks_task_id)) {
      throw new BusinessError(
        `Cannot add dependency: Task ${task_id} blocking Task ${blocks_task_id} would create a circular dependency`
      );
    }

    // Create the dependency
    return this.dependencyRepo.create({ task_id, blocks_task_id });
  }

  /**
   * Remove a dependency between two tasks
   * @throws NotFoundError if dependency doesn't exist
   */
  removeDependency(taskId: number, blocksTaskId: number): void {
    const deleted = this.dependencyRepo.delete(taskId, blocksTaskId);
    if (!deleted) {
      throw new NotFoundError(
        'Dependency',
        `${taskId}->${blocksTaskId}` as any
      );
    }
  }

  /**
   * Get all tasks blocked by this task (dependencies where this task is the blocker)
   */
  getBlockedBy(taskId: number): Dependency[] {
    return this.dependencyRepo.findByTaskId(taskId);
  }

  /**
   * Get all tasks that block this task (dependencies where this task is blocked)
   */
  getBlockers(taskId: number): Dependency[] {
    return this.dependencyRepo.findBlockingTask(taskId);
  }
}
