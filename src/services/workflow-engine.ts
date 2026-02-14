import { ITaskRepository, IDependencyRepository } from '../repositories/interfaces.js';
import { TaskService } from './task.service.js';
import { EventBus } from '../events/event-bus.js';
import { VALID_STATUS_TRANSITIONS } from '../types/task.js';
import type { TaskEvent } from '../events/types.js';

/**
 * WorkflowEngine - automates parent task completion and dependency auto-unblock.
 *
 * Subscribes to task.status_changed events and:
 * 1. Cascades parent completion when all children are done
 * 2. Auto-unblocks tasks when all their blockers are done
 *
 * With depth tracking to prevent infinite recursion (max 5 levels).
 *
 * Key design:
 * - EventEmitter.emit() in Node.js is SYNCHRONOUS. When taskService.updateTask
 *   emits task.status_changed, this handler is called again WITHIN the same call
 *   stack. The cascadeDepth counter accurately tracks recursion depth.
 * - Workflow-triggered updates carry source: 'workflow' attribution.
 * - Parents in 'blocked' or 'closed' status are skipped (invalid transition to 'done').
 * - Cascade depth counts actual auto-completions and auto-unblocks, not intermediate transitions.
 */
export class WorkflowEngine {
  private cascadeDepth = 0;
  private static readonly MAX_CASCADE_DEPTH = 5;
  private unsubscribes: Array<() => void> = [];

  constructor(
    private readonly taskService: TaskService,
    private readonly taskRepo: ITaskRepository,
    private readonly dependencyRepo: IDependencyRepository,
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
   * Two workflow automations:
   * 1. Parent auto-complete: when all children are done, auto-complete the parent
   * 2. Dependency auto-unblock: when a blocker completes, unblock dependent tasks
   */
  private handleStatusChanged(event: TaskEvent): void {
    try {
      const task = event.data;

      // Only react to tasks transitioning TO 'done'
      if (task.status !== 'done') {
        return;
      }

      // Enforce cascade depth limit
      if (this.cascadeDepth >= WorkflowEngine.MAX_CASCADE_DEPTH) {
        return;
      }

      // --- Parent auto-complete ---
      this.handleParentAutoComplete(task);

      // --- Dependency auto-unblock ---
      this.handleDependencyAutoUnblock(task);
    } catch (error) {
      // Log but don't throw -- workflow failures should not crash event handling
      console.error('WorkflowEngine error during handleStatusChanged:', error);
    }
  }

  /**
   * Auto-complete parent when ALL children are done.
   * Parents in 'blocked' or 'closed' status are skipped (invalid transition to 'done').
   */
  private handleParentAutoComplete(task: { id: number; parent_task_id: number | null; status: string }): void {
    // Only react if the task has a parent
    if (!task.parent_task_id) {
      return;
    }

    // Re-check cascade depth (may have been consumed by unblock)
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

    // Skip parents already done
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
  }

  /**
   * Auto-unblock tasks when all their blockers are done.
   * When a task transitions to 'done', find all tasks it blocks and check
   * if ALL blockers of each blocked task are now done. If so, transition
   * the blocked task from 'blocked' to 'open'.
   */
  private handleDependencyAutoUnblock(task: { id: number; status: string }): void {
    // Re-check cascade depth
    if (this.cascadeDepth >= WorkflowEngine.MAX_CASCADE_DEPTH) {
      return;
    }

    // Find all tasks that this completed task blocks
    const dependenciesWhereThisBlocks = this.dependencyRepo.findByTaskId(task.id);

    for (const dep of dependenciesWhereThisBlocks) {
      const blockedTaskId = dep.blocks_task_id;

      // Get the blocked task to check its current status
      const blockedTask = this.taskRepo.findById(blockedTaskId);
      if (!blockedTask) {
        continue;
      }

      // Only unblock tasks that are currently 'blocked'
      if (blockedTask.status !== 'blocked') {
        continue;
      }

      // Check if ALL blockers of this task are done
      const allBlockers = this.dependencyRepo.findBlockingTask(blockedTaskId);
      const allBlockersDone = allBlockers.every((blocker) => {
        const blockerTask = this.taskRepo.findById(blocker.task_id);
        return blockerTask && blockerTask.status === 'done';
      });

      if (!allBlockersDone) {
        continue;
      }

      // All blockers are done -- unblock the task (blocked -> open)
      this.cascadeDepth++;
      try {
        this.taskService.updateTask(blockedTaskId, { status: 'open' }, 'workflow');
      } finally {
        this.cascadeDepth--;
      }
    }
  }
}
