import { ITaskRepository } from '../repositories/interfaces.js';
import { TaskService } from './task.service.js';
import { EventBus } from '../events/event-bus.js';

/**
 * WorkflowEngine - automates parent task completion when all children are done.
 *
 * Subscribes to task.status_changed events and cascades parent completion
 * with depth tracking to prevent infinite recursion (max 5 levels).
 *
 * Stub implementation for TDD RED phase.
 */
export class WorkflowEngine {
  constructor(
    private readonly taskService: TaskService,
    private readonly taskRepo: ITaskRepository,
    private readonly eventBus: EventBus<any>
  ) {}

  start(): void {}

  stop(): void {}
}
