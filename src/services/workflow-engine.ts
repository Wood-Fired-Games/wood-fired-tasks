import type Database from '../db/driver.js';
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
 *
 * Transaction atomicity (SC-5):
 * - The entire cascade chain is wrapped in a single SQLite transaction at depth 0.
 * - If any cascade operation fails, all changes roll back (crash safety).
 * - Nested db.transaction() calls from TaskRepository.update become savepoints.
 * - Cascade errors are tracked internally and re-thrown to trigger rollback,
 *   since EventBus wraps handlers in try/catch (error isolation).
 *
 * Phantom-event suppression (task #244):
 * - The cascade transaction is also wrapped in `eventBus.runInTransaction(...)`
 *   so every `task.updated` / `task.status_changed` emit fired by
 *   `taskService.updateTask` during the cascade is BUFFERED. The buffer flushes
 *   to SSE/Slack/MCP subscribers only on successful commit. On rollback the
 *   buffer is discarded, so no phantom events leak for work the DB never
 *   persisted.
 * - The engine's own subscription is registered with `ignoreTransaction: true`
 *   so cascade recursion still drives synchronously inside the transaction —
 *   only external subscribers are deferred to commit time.
 */
export class WorkflowEngine {
  private cascadeDepth = 0;
  private static readonly MAX_CASCADE_DEPTH = 5;
  private unsubscribes: Array<() => void> = [];
  private cascadeError: Error | null = null;

  constructor(
    private readonly taskService: TaskService,
    private readonly taskRepo: ITaskRepository,
    private readonly dependencyRepo: IDependencyRepository,
    private readonly eventBus: EventBus<any>,
    private readonly db: Database.Database,
  ) {}

  /**
   * Start listening for task.status_changed events.
   *
   * Subscribes with `ignoreTransaction: true` so the engine still receives
   * status_changed emits synchronously while a transactional emit buffer is
   * active. Cascade recursion depends on synchronous redelivery during the
   * transaction — see processCascade and the class doc comment for the
   * phantom-event suppression contract (task #244).
   */
  start(): void {
    const unsub = this.eventBus.subscribe(
      'task.status_changed',
      (event: TaskEvent) => this.handleStatusChanged(event),
      { ignoreTransaction: true },
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
   *
   * At depth 0 (entry point), the entire cascade is wrapped in a single SQLite
   * transaction for atomicity. Nested calls (depth > 0) run inside the same
   * transaction via savepoints.
   */
  private handleStatusChanged(event: TaskEvent): void {
    if (this.cascadeDepth === 0) {
      // Entry point — wrap entire cascade in one DB transaction AND one
      // EventBus transactional buffer so external subscribers (SSE / Slack /
      // MCP) only see events for state the DB actually committed (task #244).
      // The engine's own subscription bypasses the buffer so cascade recursion
      // still drives synchronously inside the transaction.
      try {
        this.eventBus.runInTransaction(() => {
          const cascadeTx = this.db.transaction(() => {
            this.processCascade(event);
            // If any nested cascade operation set an error, throw to trigger rollback
            if (this.cascadeError) {
              const err = this.cascadeError;
              this.cascadeError = null;
              throw err;
            }
          });
          cascadeTx();
        });
      } catch (error) {
        // Transaction rolled back AND event buffer discarded — log but don't
        // throw (this handler is called from EventBus which has its own
        // try/catch).
        this.cascadeError = null;
        console.error('WorkflowEngine: cascade rolled back due to error:', error);
      }
    } else {
      // Already inside a transaction (recursive call from EventBus)
      this.processCascade(event);
    }
  }

  /**
   * Process cascade logic for a status change event.
   * Called within a transaction context (either outer or nested).
   */
  private processCascade(event: TaskEvent): void {
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

      // If a previous cascade operation failed, skip further processing
      if (this.cascadeError) {
        return;
      }

      // --- Parent auto-complete ---
      this.handleParentAutoComplete(task);

      // --- Dependency auto-unblock ---
      this.handleDependencyAutoUnblock(task);
    } catch (error) {
      // Track cascade error for outer transaction rollback
      this.cascadeError = error as Error;
      console.error('WorkflowEngine error during processCascade:', error);
    }
  }

  /**
   * Auto-complete parent when ALL children are done.
   * Parents in 'blocked' or 'closed' status are skipped (invalid transition to 'done').
   */
  private handleParentAutoComplete(task: {
    id: number;
    parent_task_id: number | null;
    status: string;
  }): void {
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
