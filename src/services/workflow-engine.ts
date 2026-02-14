import { ITaskRepository } from '../repositories/interfaces.js';
import { TaskService } from './task.service.js';
import { EventBus } from '../events/event-bus.js';
import { VALID_STATUS_TRANSITIONS } from '../types/task.js';
import type { TaskEvent } from '../events/types.js';

/**
 * WorkflowEngine - automates parent task completion when all children are done.
 *
 * Subscribes to task.status_changed events and cascades parent completion
 * with depth tracking to prevent infinite recursion (max 5 levels).
 *
 * Key design:
 * - EventEmitter.emit() in Node.js is SYNCHRONOUS. When taskService.updateTask
 *   emits task.status_changed, this handler is called again WITHIN the same call
 *   stack. The cascadeDepth counter accurately tracks recursion depth.
 * - Workflow-triggered updates carry source: 'workflow' attribution.
 * - Parents in 'blocked' or 'closed' status are skipped (invalid transition to 'done').
 * - Cascade depth counts actual parent auto-completions, not intermediate transitions.
 */
export class WorkflowEngine {
  private cascadeDepth = 0;
  private static readonly MAX_CASCADE_DEPTH = 5;
  private unsubscribes: Array<() => void> = [];

  constructor(
    private readonly taskService: TaskService,
    private readonly taskRepo: ITaskRepository,
    private readonly eventBus: EventBus<any>
  ) {}

  /**
   * Start listening for task.status_changed events
   */
  start(): void {
    const unsub = this.eventBus.subscribe(
      'task.status_changed',
      (event: TaskEvent) => this.handleStatusChanged(event)
    );
    this.unsubscribes.push(unsub);
  }

  /**
   * Stop listening and clean up all subscriptions
   */
  stop(): void {
    for (const unsub of this.unsubscribes) {
      unsub();
    }
    this.unsubscribes = [];
  }

  /**
   * Handle a task.status_changed event.
   * If the task has a parent and the new status is 'done',
   * check if all siblings are done and auto-complete the parent.
   */
  private handleStatusChanged(event: TaskEvent): void {
    try {
      const task = event.data;

      // Only react to tasks transitioning TO 'done'
      if (task.status !== 'done') {
        return;
      }

      // Only react if the task has a parent
      if (!task.parent_task_id) {
        return;
      }

      // Enforce cascade depth limit -- only count actual parent completions
      if (this.cascadeDepth >= WorkflowEngine.MAX_CASCADE_DEPTH) {
        return;
      }

      const parentId = task.parent_task_id;

      // Check if ALL siblings (children of parent) are done
      const siblings = this.taskRepo.findChildren(parentId);
      const allDone = siblings.every((s) => s.status === 'done');

      if (!allDone) {
        return;
      }

      // Get parent to check valid transition
      const parent = this.taskRepo.findById(parentId);
      if (!parent) {
        return;
      }

      // Check if parent can transition to 'done'
      // Valid paths: open -> in_progress -> done, or in_progress -> done
      // Skip parents in 'blocked', 'closed', or already 'done'
      if (parent.status === 'done') {
        return;
      }

      // Increment cascade depth for this parent auto-completion
      this.cascadeDepth++;
      try {
        if (parent.status === 'open') {
          // Need two-step transition: open -> in_progress -> done
          const openTransitions = VALID_STATUS_TRANSITIONS['open'];
          if (!openTransitions.includes('in_progress')) {
            return;
          }
          // Transition to in_progress first
          this.taskService.updateTask(parentId, { status: 'in_progress' }, 'workflow');
        } else if (parent.status !== 'in_progress') {
          // Parent is in 'blocked' or 'closed' -- skip, invalid transition to done
          return;
        }

        // Now transition to done
        const doneTransitions = VALID_STATUS_TRANSITIONS['in_progress'];
        if (!doneTransitions.includes('done')) {
          return;
        }

        this.taskService.updateTask(parentId, { status: 'done' }, 'workflow');
      } finally {
        this.cascadeDepth--;
      }
    } catch (error) {
      // Log but don't throw -- workflow failures should not crash event handling
      console.error('WorkflowEngine error during handleStatusChanged:', error);
    }
  }
}
