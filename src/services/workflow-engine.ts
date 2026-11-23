import type Database from '../db/driver.js';
import { ITaskRepository, IDependencyRepository } from '../repositories/interfaces.js';
import { TaskService } from './task.service.js';
import { EventBus } from '../events/event-bus.js';
import { VALID_STATUS_TRANSITIONS } from '../types/task.js';
import type { ProjectEvent, TaskEvent } from '../events/types.js';

/** Outcome of one unarchive re-evaluation pass or retry (WFT #2532). */
export interface ReevaluationResult {
  /** Candidates whose own cascade rolled back; empty on a clean pass. */
  failedTaskIds: number[];
}

/** Which re-evaluation step a remembered failure retries (WFT #2543). */
type RetryKind = 'unblock' | 'complete';

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
 * - Archived project state: a cascade target (a task to unblock, a parent to
 *   complete) whose project is archived is SKIPPED before any write. The
 *   service refuses writes in an archived project, and a refusal thrown
 *   mid-cascade would roll back the whole transaction — losing the unblocks
 *   and completions in live projects too. A skipped target is not an error.
 * - Unarchive re-evaluation (WFT #2522): the skip above means a project can
 *   come back from the archive with a task still `blocked` although every
 *   blocker finished meanwhile, or a parent still open although every child is
 *   done. `ProjectService.unarchiveProject` therefore calls `reevaluateProject`
 *   AFTER the unarchive has committed, and it re-evaluates that one project:
 *   each blocked task whose blockers are all done is opened, and each parent
 *   whose children are all done is auto-completed, with the normal
 *   `source: 'workflow'` events. Each candidate runs in its own cascade
 *   transaction, so one failing task does not undo the others (WFT #2532),
 *   and the ids that failed are returned to the unarchive's caller
 *   (WFT #2542). It is idempotent — a second run finds no candidate — and
 *   does nothing if the project is archived.
 * - Retry (WFT #2543, option B): the ids that failed are remembered in
 *   memory per project. A repeated (no-op) unarchive calls
 *   `retryFailedTasks`, which re-attempts only those ids and never runs the
 *   general pass, so it does not open a task blocked by hand and does
 *   nothing on a project with nothing remembered. A real unarchive replaces
 *   the remembered ids with its own result; a deleted task, and every id of
 *   a project archived again, is forgotten. Nothing survives a restart.
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
  /**
   * WFT #2543: per project, the tasks whose unarchive re-evaluation rolled
   * back in this process, and which step to retry. In memory only.
   */
  private readonly failedByProject = new Map<number, Map<number, RetryKind>>();

  constructor(
    private readonly taskService: TaskService,
    private readonly taskRepo: ITaskRepository,
    private readonly dependencyRepo: IDependencyRepository,
    private readonly eventBus: EventBus<any>,
    private readonly db: Database.Database,
  ) {}

  /**
   * Start listening for task.status_changed and project.unarchived events.
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
    // WFT #2543: a remembered failure is dropped when its task is deleted or
    // its project is archived again (the next real unarchive runs the full
    // pass anyway). Delivered on commit, like any external subscriber.
    this.unsubscribes.push(
      this.eventBus.subscribe('task.deleted', (event: TaskEvent) => this.forgetTask(event.data.id)),
      this.eventBus.subscribe('project.archived', (event: ProjectEvent) => {
        this.failedByProject.delete(event.data.id);
      }),
    );
    // The unarchive re-evaluation is NOT driven by `project.unarchived`:
    // `ProjectService.unarchiveProject` calls `reevaluateProject` itself after
    // the unarchive has committed, so it can return `failedTaskIds` to the
    // caller (WFT #2542). An event subscriber's result has nowhere to go.
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
      this.runCascade(() => this.processCascade(event));
    } else {
      // Already inside a transaction (recursive call from EventBus)
      this.processCascade(event);
    }
  }

  /**
   * Run `work` as one cascade entry point: one DB transaction AND one EventBus
   * transactional buffer, so external subscribers (SSE / Slack / MCP) only see
   * events for state the DB actually committed (task #244). The engine's own
   * task.status_changed subscription bypasses the buffer so cascade recursion
   * still drives synchronously inside the transaction.
   *
   * Returns false when the cascade rolled back; the error is logged with
   * `label` (defaults to the generic cascade message).
   */
  private runCascade(work: () => void, label?: string): boolean {
    try {
      this.eventBus.runInTransaction(() => {
        const cascadeTx = this.db.transaction(() => {
          work();
          // If any nested cascade operation set an error, throw to trigger rollback
          if (this.cascadeError) {
            const err = this.cascadeError;
            this.cascadeError = null;
            throw err;
          }
        });
        cascadeTx();
      });
      return true;
    } catch (error) {
      // Transaction rolled back AND event buffer discarded — log but don't
      // throw (this handler is called from EventBus which has its own
      // try/catch).
      this.cascadeError = null;
      console.error(label ?? 'WorkflowEngine: cascade rolled back due to error:', error);
      return false;
    }
  }

  /**
   * Bring one unarchived project to the state it would have had: open every
   * blocked task whose blockers are all done, then auto-complete every parent
   * whose children are all done. Each write goes through the same checks as
   * the normal cascade, and a completed parent drives the normal cascade from
   * there (its own parent, its dependents).
   *
   * WFT #2532: each candidate is its own cascade (one transaction, one event
   * buffer), so a task whose write fails rolls back only its own cascade; the
   * other candidates still commit. A failure is logged with the task and
   * project ids and reported in `failedTaskIds`, which
   * `ProjectService.unarchiveProject` hands back to its caller (WFT #2542).
   * The pass is idempotent, so it is safe to run again. Its failures replace
   * the ones remembered for the project, for `retryFailedTasks` (WFT #2543).
   *
   * Does nothing when the project is archived (again) or gone.
   */
  reevaluateProject(projectId: number): ReevaluationResult {
    if (this.taskService.isProjectArchived(projectId)) {
      return { failedTaskIds: [] };
    }
    const failed = new Map<number, RetryKind>();
    // Replaced, not merged: this pass re-examines every candidate, so an id
    // remembered from an earlier pass that is no longer a candidate is gone.
    this.failedByProject.delete(projectId);
    for (const taskId of this.taskRepo.findUnblockableIds(projectId)) {
      this.attempt(projectId, taskId, 'unblock', failed);
    }
    for (const parentId of this.taskRepo.findCompletableParentIds(projectId)) {
      this.attempt(projectId, parentId, 'complete', failed);
    }
    this.remember(projectId, failed);
    return { failedTaskIds: [...failed.keys()] };
  }

  /**
   * The retry behind a repeated (no-op) unarchive (WFT #2543, option B):
   * re-attempts only the tasks whose re-evaluation failed earlier in this
   * process for `projectId`. It never runs the general pass, so a task
   * blocked by hand is left alone, and a project with nothing remembered is
   * not touched. An id whose retry succeeds (including one that is no longer
   * a candidate, or no longer in the project) is forgotten; one that fails
   * again stays and is reported again.
   *
   * The ids live in memory only: after a restart nothing is remembered, and
   * the way out is to archive and unarchive the project again (design §2.4;
   * WFT #2553 replaces this with a table).
   */
  retryFailedTasks(projectId: number): ReevaluationResult {
    const remembered = this.failedByProject.get(projectId);
    if (!remembered || this.taskService.isProjectArchived(projectId)) {
      return { failedTaskIds: [] };
    }
    const failed = new Map<number, RetryKind>();
    for (const [taskId, kind] of remembered) {
      const task = this.taskRepo.findById(taskId);
      if (!task || task.project_id !== projectId) {
        continue;
      }
      this.attempt(projectId, taskId, kind, failed);
    }
    this.remember(projectId, failed);
    return { failedTaskIds: [...failed.keys()] };
  }

  /** The task ids remembered as failed for `projectId`, in the order they failed. */
  rememberedFailures(projectId: number): number[] {
    return [...(this.failedByProject.get(projectId)?.keys() ?? [])];
  }

  /** Runs one candidate as its own cascade; records it in `failed` if it rolls back. */
  private attempt(
    projectId: number,
    taskId: number,
    kind: RetryKind,
    failed: Map<number, RetryKind>,
  ): void {
    const work =
      kind === 'unblock'
        ? () => this.unblockIfAllBlockersDone(taskId)
        : () => this.completeParentIfAllChildrenDone(taskId);
    const ok = this.runCascade(
      work,
      `WorkflowEngine: unarchive re-evaluation of task ${taskId} in project ${projectId} rolled back:`,
    );
    if (!ok) {
      failed.set(taskId, kind);
    }
  }

  private remember(projectId: number, failed: Map<number, RetryKind>): void {
    if (failed.size === 0) {
      this.failedByProject.delete(projectId);
    } else {
      this.failedByProject.set(projectId, failed);
    }
  }

  /** A deleted task is forgotten, wherever it was remembered. */
  private forgetTask(taskId: number): void {
    for (const [projectId, failed] of this.failedByProject) {
      if (failed.delete(taskId) && failed.size === 0) {
        this.failedByProject.delete(projectId);
      }
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

    this.completeParentIfAllChildrenDone(task.parent_task_id);
  }

  /**
   * Auto-complete one parent if ALL its children are done and it can legally
   * reach 'done'. Shared by the status-change cascade and the unarchive
   * re-evaluation.
   */
  private completeParentIfAllChildrenDone(parentId: number): void {
    // Check if ALL siblings (children of parent) are done
    const siblings = this.taskRepo.findChildren(parentId);
    const allDone = siblings.length > 0 && siblings.every((s) => s.status === 'done');

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

    // Skip a parent in an archived project (frozen; see class doc).
    if (this.taskService.isProjectArchived(parent.project_id)) {
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
      this.unblockIfAllBlockersDone(dep.blocks_task_id);
    }
  }

  /**
   * Transition one task from 'blocked' to 'open' if it has blockers and ALL
   * of them are done. Shared by the status-change cascade and the unarchive
   * re-evaluation.
   */
  private unblockIfAllBlockersDone(blockedTaskId: number): void {
    // Get the blocked task to check its current status
    const blockedTask = this.taskRepo.findById(blockedTaskId);
    if (!blockedTask) {
      return;
    }

    // Only unblock tasks that are currently 'blocked'
    if (blockedTask.status !== 'blocked') {
      return;
    }

    // Skip a dependent in an archived project: it stays blocked and the
    // rest of the cascade carries on (frozen; see class doc).
    if (this.taskService.isProjectArchived(blockedTask.project_id)) {
      return;
    }

    // Check if ALL blockers of this task are done
    const allBlockers = this.dependencyRepo.findBlockingTask(blockedTaskId);
    const allBlockersDone =
      allBlockers.length > 0 &&
      allBlockers.every((blocker) => {
        const blockerTask = this.taskRepo.findById(blocker.task_id);
        return blockerTask && blockerTask.status === 'done';
      });

    if (!allBlockersDone) {
      return;
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
