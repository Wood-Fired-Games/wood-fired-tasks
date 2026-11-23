import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestApp } from '../../index.js';
import { eventBus } from '../../events/event-bus.js';
import { DependencyRepository } from '../../repositories/dependency.repository.js';
import { TaskRepository } from '../../repositories/task.repository.js';
import { WorkflowEngine } from '../workflow-engine.js';
import type { App } from '../../index.js';
import type { Task } from '../../types/task.js';
import type { TaskEvent } from '../../events/types.js';

/**
 * Archived project state × workflow cascade.
 *
 * `TaskService.updateTask` refuses every write in an archived project,
 * whatever the `source`. The cascade runs as ONE transaction that rolls back
 * as a unit on any error, so the engine must not attempt a write it knows
 * will be refused: a target in an archived project is skipped, and the rest
 * of the cascade (other unblocks, parent auto-complete) still commits.
 *
 * These tests run against the app's own, production-wired engine.
 */
describe('WorkflowEngine: cascade that reaches into an archived project', () => {
  let app: App;
  let liveProjectId: number;
  let archivedProjectId: number;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    app = await createTestApp();
    liveProjectId = app.projectService.createProject({ name: 'Live' }).id;
    archivedProjectId = app.projectService.createProject({ name: 'To be archived' }).id;
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    app.dispose();
  });

  function createTask(title: string, projectId: number, parentId?: number): Task {
    return app.taskService.createTask({
      title,
      project_id: projectId,
      created_by: 'test-user',
      ...(parentId !== undefined ? { parent_task_id: parentId } : {}),
    });
  }

  function block(blockerId: number, blockedId: number): void {
    app.dependencyService.addDependency({ task_id: blockerId, blocks_task_id: blockedId });
    app.taskService.updateTask(blockedId, { status: 'blocked' });
  }

  function forceArchive(projectId: number): void {
    app.projectService.archiveProject(
      projectId,
      { force: true, reason: 'shelved with work outstanding' },
      'tester',
    );
  }

  function status(taskId: number): string {
    return app.taskService.getTask(taskId).status;
  }

  it('unblocks the live dependent and auto-completes the parent; the archived dependent is skipped, not an error', () => {
    // Live project: parent -> blocker (its only child). The blocker blocks one
    // task in the live project and one in a project that is then force-archived.
    const parent = createTask('Parent', liveProjectId);
    const blocker = createTask('Blocker', liveProjectId, parent.id);
    const liveDependent = createTask('Live dependent', liveProjectId);
    const archivedDependent = createTask('Archived dependent', archivedProjectId);
    block(blocker.id, liveDependent.id);
    block(blocker.id, archivedDependent.id);
    forceArchive(archivedProjectId);

    const before = app.taskService.getTask(archivedDependent.id);
    expect(before.status).toBe('blocked');
    expect(status(liveDependent.id)).toBe('blocked');
    expect(status(parent.id)).toBe('open');

    const events: TaskEvent[] = [];
    const unsub = eventBus.subscribe('task.status_changed', (e: TaskEvent) => {
      events.push(e);
    });

    app.taskService.updateTask(blocker.id, { status: 'in_progress' });
    app.taskService.updateTask(blocker.id, { status: 'done' });
    unsub();

    expect(status(blocker.id)).toBe('done');
    // The rest of the cascade commits.
    expect(status(liveDependent.id)).toBe('open');
    expect(status(parent.id)).toBe('done');
    // The archived project stays frozen: same row, same version.
    expect(app.taskService.getTask(archivedDependent.id)).toEqual(before);
    expect(app.projectService.getProject(archivedProjectId).archived).toBe(true);

    // A skipped target is not a failed cascade.
    expect(errorSpy).not.toHaveBeenCalled();

    // External subscribers saw the committed cascade and nothing for the
    // archived dependent.
    const seen = events.map((e) => `${e.data.id}:${e.data.status}`);
    expect(seen).toContain(`${liveDependent.id}:open`);
    expect(seen).toContain(`${parent.id}:done`);
    expect(events.some((e) => e.data.id === archivedDependent.id)).toBe(false);
  });

  it('a cascade whose only dependent is in an archived project commits cleanly with nothing to do', () => {
    const blocker = createTask('Blocker', liveProjectId);
    const archivedDependent = createTask('Archived dependent', archivedProjectId);
    block(blocker.id, archivedDependent.id);
    forceArchive(archivedProjectId);

    app.taskService.updateTask(blocker.id, { status: 'in_progress' });
    app.taskService.updateTask(blocker.id, { status: 'done' });

    expect(status(blocker.id)).toBe('done');
    expect(status(archivedDependent.id)).toBe('blocked');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('a parent in an archived project is not auto-completed, and the live unblock in the same cascade still commits', () => {
    // A subtask is created in its parent's project, but an update can re-parent
    // a task across projects — the one way a parent write crosses projects.
    const archivedParent = createTask('Parent in the other project', archivedProjectId);
    const child = createTask('Child', liveProjectId);
    app.taskService.updateTask(child.id, { parent_task_id: archivedParent.id });
    const liveDependent = createTask('Live dependent', liveProjectId);
    block(child.id, liveDependent.id);
    forceArchive(archivedProjectId);
    const before = app.taskService.getTask(archivedParent.id);

    app.taskService.updateTask(child.id, { status: 'in_progress' });
    app.taskService.updateTask(child.id, { status: 'done' });

    expect(status(child.id)).toBe('done');
    expect(status(liveDependent.id)).toBe('open');
    expect(app.taskService.getTask(archivedParent.id)).toEqual(before);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('a cascade target skipped as archived emits neither task.status_changed nor task.updated (WFT #2523)', () => {
    // One blocker reaches two frozen targets: a dependent to unblock and a
    // parent to auto-complete, both in the archived project.
    const archivedParent = createTask('Parent in the other project', archivedProjectId);
    const blocker = createTask('Blocker', liveProjectId);
    app.taskService.updateTask(blocker.id, { parent_task_id: archivedParent.id });
    const archivedDependent = createTask('Archived dependent', archivedProjectId);
    block(blocker.id, archivedDependent.id);
    forceArchive(archivedProjectId);

    const seen: string[] = [];
    const unsubs = (['task.status_changed', 'task.updated'] as const).map((type) =>
      eventBus.subscribe(type, (e: TaskEvent) => {
        seen.push(`${type}:${e.data.id}`);
      }),
    );
    app.taskService.updateTask(blocker.id, { status: 'in_progress' });
    app.taskService.updateTask(blocker.id, { status: 'done' });
    for (const unsub of unsubs) unsub();

    // The blocker's own events are there, so both subscriptions are live.
    expect(seen).toContain(`task.status_changed:${blocker.id}`);
    expect(seen).toContain(`task.updated:${blocker.id}`);
    for (const skipped of [archivedDependent.id, archivedParent.id]) {
      expect(seen).not.toContain(`task.status_changed:${skipped}`);
      expect(seen).not.toContain(`task.updated:${skipped}`);
    }
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

/**
 * Unarchive leaves the project in the state it would have had (WFT #2522).
 *
 * While a project is archived the cascade skips its tasks. On
 * `project.unarchived` the engine re-evaluates that project once: blocked
 * tasks whose blockers are all done are opened, and parents whose children
 * are all done are auto-completed, with the normal workflow events.
 */
describe('WorkflowEngine: unarchive re-evaluates the project', () => {
  let app: App;
  let liveProjectId: number;
  let archivedProjectId: number;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    app = await createTestApp();
    liveProjectId = app.projectService.createProject({ name: 'Live' }).id;
    archivedProjectId = app.projectService.createProject({ name: 'To be archived' }).id;
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    app.dispose();
  });

  function createTask(title: string, projectId: number): Task {
    return app.taskService.createTask({ title, project_id: projectId, created_by: 'test-user' });
  }

  function block(blockerId: number, blockedId: number): void {
    app.dependencyService.addDependency({ task_id: blockerId, blocks_task_id: blockedId });
    app.taskService.updateTask(blockedId, { status: 'blocked' });
  }

  function forceArchive(): void {
    app.projectService.archiveProject(
      archivedProjectId,
      { force: true, reason: 'shelved with work outstanding' },
      'tester',
    );
  }

  function finish(taskId: number): void {
    app.taskService.updateTask(taskId, { status: 'in_progress' });
    app.taskService.updateTask(taskId, { status: 'done' });
  }

  function status(taskId: number): string {
    return app.taskService.getTask(taskId).status;
  }

  /** Records every task event emitted while `fn` runs. */
  function taskEventsDuring(fn: () => void): Array<{ type: string; event: TaskEvent }> {
    const seen: Array<{ type: string; event: TaskEvent }> = [];
    const unsubs = (['task.status_changed', 'task.updated'] as const).map((type) =>
      eventBus.subscribe(type, (event: TaskEvent) => {
        seen.push({ type, event });
      }),
    );
    try {
      fn();
    } finally {
      for (const unsub of unsubs) unsub();
    }
    return seen;
  }

  it('opens a task whose only blockers finished while archived, with one workflow status_changed event', () => {
    const blockerA = createTask('Blocker A', liveProjectId);
    const blockerB = createTask('Blocker B', liveProjectId);
    const dependent = createTask('Dependent', archivedProjectId);
    block(blockerA.id, dependent.id);
    app.dependencyService.addDependency({ task_id: blockerB.id, blocks_task_id: dependent.id });
    forceArchive();
    finish(blockerA.id);
    finish(blockerB.id);
    expect(status(dependent.id)).toBe('blocked');

    const seen = taskEventsDuring(() => {
      app.projectService.unarchiveProject(archivedProjectId, 'tester');
    });

    expect(status(dependent.id)).toBe('open');
    const statusChanges = seen.filter((s) => s.type === 'task.status_changed');
    expect(statusChanges).toHaveLength(1);
    expect(statusChanges[0].event.data.id).toBe(dependent.id);
    expect(statusChanges[0].event.metadata).toMatchObject({
      source: 'workflow',
      from: 'blocked',
      to: 'open',
    });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('auto-completes a parent in the unarchived project whose children are all done', () => {
    // The child lives in a live project (re-parented across projects), so it
    // can finish while the parent's project is archived.
    const openParent = createTask('Open parent', archivedProjectId);
    const startedParent = createTask('Started parent', archivedProjectId);
    app.taskService.updateTask(startedParent.id, { status: 'in_progress' });
    const childOne = createTask('Child one', liveProjectId);
    const childTwo = createTask('Child two', liveProjectId);
    app.taskService.updateTask(childOne.id, { parent_task_id: openParent.id });
    app.taskService.updateTask(childTwo.id, { parent_task_id: startedParent.id });
    // Completing the parent must run the normal cascade from there on.
    const downstream = createTask('Blocked by the open parent', archivedProjectId);
    block(openParent.id, downstream.id);
    forceArchive();
    finish(childOne.id);
    finish(childTwo.id);
    expect(status(openParent.id)).toBe('open');
    expect(status(startedParent.id)).toBe('in_progress');

    const seen = taskEventsDuring(() => {
      app.projectService.unarchiveProject(archivedProjectId, 'tester');
    });

    expect(status(openParent.id)).toBe('done');
    expect(status(startedParent.id)).toBe('done');
    expect(status(downstream.id)).toBe('open');
    expect(seen.every((s) => s.event.metadata.source === 'workflow')).toBe(true);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('leaves a task blocked while any blocker is unfinished, and a parent with an unfinished child alone', () => {
    const doneBlocker = createTask('Done blocker', liveProjectId);
    const openBlocker = createTask('Open blocker', liveProjectId);
    const dependent = createTask('Dependent', archivedProjectId);
    block(doneBlocker.id, dependent.id);
    app.dependencyService.addDependency({ task_id: openBlocker.id, blocks_task_id: dependent.id });
    const parent = createTask('Parent', archivedProjectId);
    const doneChild = createTask('Done child', liveProjectId);
    const openChild = createTask('Open child', liveProjectId);
    app.taskService.updateTask(doneChild.id, { parent_task_id: parent.id });
    app.taskService.updateTask(openChild.id, { parent_task_id: parent.id });
    forceArchive();
    finish(doneBlocker.id);
    finish(doneChild.id);
    const dependentBefore = app.taskService.getTask(dependent.id);
    const parentBefore = app.taskService.getTask(parent.id);

    const seen = taskEventsDuring(() => {
      app.projectService.unarchiveProject(archivedProjectId, 'tester');
    });

    expect(app.taskService.getTask(dependent.id)).toEqual(dependentBefore);
    expect(app.taskService.getTask(parent.id)).toEqual(parentBefore);
    expect(seen).toEqual([]);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('changes no task and emits no task event when there is nothing to re-evaluate', () => {
    // A task blocked by hand (no dependency edge), a blocked parent with every
    // child done, and a plain open task: none of them is a candidate.
    const blockedByHand = createTask('Blocked by hand', archivedProjectId);
    app.taskService.updateTask(blockedByHand.id, { status: 'blocked' });
    const blockedParent = createTask('Blocked parent', archivedProjectId);
    app.taskService.updateTask(blockedParent.id, { status: 'blocked' });
    const child = createTask('Child', liveProjectId);
    app.taskService.updateTask(child.id, { parent_task_id: blockedParent.id });
    const plain = createTask('Plain', archivedProjectId);
    forceArchive();
    finish(child.id);
    const ids = [blockedByHand.id, blockedParent.id, plain.id];
    const before = ids.map((id) => app.taskService.getTask(id));

    const seen = taskEventsDuring(() => {
      app.projectService.unarchiveProject(archivedProjectId, 'tester');
    });

    expect(ids.map((id) => app.taskService.getTask(id))).toEqual(before);
    expect(seen).toEqual([]);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('is idempotent: a second unarchive, and a second re-evaluation, change nothing', () => {
    const blocker = createTask('Blocker', liveProjectId);
    const dependent = createTask('Dependent', archivedProjectId);
    block(blocker.id, dependent.id);
    forceArchive();
    finish(blocker.id);
    app.projectService.unarchiveProject(archivedProjectId, 'tester');
    const after = app.taskService.getTask(dependent.id);
    expect(after.status).toBe('open');

    const seen = taskEventsDuring(() => {
      // A repeated unarchive emits no event; it retries only remembered
      // failures (WFT #2543), and there are none...
      app.projectService.unarchiveProject(archivedProjectId, 'tester');
      // ...and a second full pass finds nothing left to do. (WFT #2552
      // point 5: this used to emit `project.unarchived`, which the engine
      // does not subscribe to, so it could not fail. A stale event for a
      // project archived again was the same; "re-evaluating a project that
      // is archived right now changes nothing" covers that case.)
      expect(app.workflowEngine.reevaluateProject(archivedProjectId)).toEqual({
        failedTaskIds: [],
      });
    });

    expect(app.taskService.getTask(dependent.id)).toEqual(after);
    expect(seen).toEqual([]);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  describe('isolation and retry (WFT #2532)', () => {
    /** Makes every `updateTask` on `taskId` throw until the spy is restored. */
    function failUpdatesOf(taskId: number): ReturnType<typeof vi.spyOn> {
      const original = app.taskService.updateTask.bind(app.taskService);
      return vi
        .spyOn(app.taskService, 'updateTask')
        .mockImplementation((id: number, ...rest: unknown[]) => {
          if (id === taskId) {
            throw new Error(`simulated write failure on task ${id}`);
          }
          return (original as (...args: unknown[]) => Task)(id, ...rest);
        });
    }

    function loggedLines(): string[] {
      return errorSpy.mock.calls.map((call) => String(call[0]));
    }

    it('one task whose update throws does not stop the others; the failure is logged with its task id', () => {
      const blocker = createTask('Blocker', liveProjectId);
      const failing = createTask('Failing dependent', archivedProjectId);
      const healthy = createTask('Healthy dependent', archivedProjectId);
      const parent = createTask('Parent', archivedProjectId);
      const child = app.taskService.createTask({
        title: 'Only child',
        project_id: archivedProjectId,
        created_by: 'test-user',
        parent_task_id: parent.id,
      });
      // `failing` is created first, so it is re-evaluated before `healthy`.
      block(blocker.id, failing.id);
      block(blocker.id, healthy.id);
      finish(child.id);
      // The only child finishing completed the parent; reopen it so the
      // re-evaluation has a parent to complete as well.
      app.taskService.updateTask(parent.id, { status: 'open' });
      forceArchive();
      finish(blocker.id);
      expect(status(failing.id)).toBe('blocked');
      expect(status(healthy.id)).toBe('blocked');
      expect(status(parent.id)).toBe('open');

      const spy = failUpdatesOf(failing.id);
      const seen = taskEventsDuring(() => {
        app.projectService.unarchiveProject(archivedProjectId, 'tester');
      });
      spy.mockRestore();

      expect(status(failing.id)).toBe('blocked');
      expect(status(healthy.id)).toBe('open');
      expect(status(parent.id)).toBe('done');
      // No phantom event for the task whose transaction rolled back.
      expect(seen.some((s) => s.event.data.id === failing.id)).toBe(false);
      const lines = loggedLines().filter((line) => line.includes('re-evaluation of task'));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(`task ${failing.id}`);
      expect(lines[0]).toContain(`project ${archivedProjectId}`);
      expect(app.projectService.getProject(archivedProjectId).archived).toBe(false);
    });

    it('a repeated unarchive retries the task that failed, so it is opened on the retry; no project event is emitted', () => {
      const blocker = createTask('Blocker', liveProjectId);
      const failing = createTask('Failing dependent', archivedProjectId);
      block(blocker.id, failing.id);
      forceArchive();
      finish(blocker.id);

      const spy = failUpdatesOf(failing.id);
      app.projectService.unarchiveProject(archivedProjectId, 'tester');
      spy.mockRestore();
      expect(status(failing.id)).toBe('blocked');

      const projectEvents: string[] = [];
      const unsub = eventBus.subscribe('project.unarchived', () => {
        projectEvents.push('project.unarchived');
      });
      let returned;
      const seen = taskEventsDuring(() => {
        returned = app.projectService.unarchiveProject(archivedProjectId, 'tester');
      });
      unsub();

      expect(status(failing.id)).toBe('open');
      expect(projectEvents).toEqual([]);
      expect(returned).toMatchObject({
        project: { id: archivedProjectId, archived: false },
        reevaluationFailedTaskIds: [],
      });
      const statusChanges = seen.filter((s) => s.type === 'task.status_changed');
      expect(statusChanges).toHaveLength(1);
      expect(statusChanges[0].event.metadata).toMatchObject({
        source: 'workflow',
        from: 'blocked',
        to: 'open',
      });
    });

    it('unarchiveProject returns the task ids whose re-evaluation failed, on the real unarchive and on the retry (WFT #2542)', () => {
      const blocker = createTask('Blocker', liveProjectId);
      const failing = createTask('Failing dependent', archivedProjectId);
      const healthy = createTask('Healthy dependent', archivedProjectId);
      block(blocker.id, failing.id);
      block(blocker.id, healthy.id);
      forceArchive();
      finish(blocker.id);

      const spy = failUpdatesOf(failing.id);
      const first = app.projectService.unarchiveProject(archivedProjectId, 'tester');
      expect(first.project).toMatchObject({ id: archivedProjectId, archived: false });
      expect(first.reevaluationFailedTaskIds).toEqual([failing.id]);
      expect(status(healthy.id)).toBe('open');

      // Still failing: the repeated (no-op) unarchive reports it again.
      const stillFailing = app.projectService.unarchiveProject(archivedProjectId, 'tester');
      expect(stillFailing.reevaluationFailedTaskIds).toEqual([failing.id]);
      spy.mockRestore();

      const retried = app.projectService.unarchiveProject(archivedProjectId, 'tester');
      expect(retried.reevaluationFailedTaskIds).toEqual([]);
      expect(status(failing.id)).toBe('open');
    });

    it('a project.unarchived event on its own does not run the pass: the unarchive call runs it, once (WFT #2542)', () => {
      const blocker = createTask('Blocker', liveProjectId);
      const dependent = createTask('Dependent', archivedProjectId);
      block(blocker.id, dependent.id);
      forceArchive();
      finish(blocker.id);
      const passes = vi.spyOn(app.workflowEngine, 'reevaluateProject');

      app.projectService.unarchiveProject(archivedProjectId, 'tester');
      expect(passes).toHaveBeenCalledTimes(1);
      expect(status(dependent.id)).toBe('open');

      eventBus.emit('project.unarchived', {
        eventType: 'project.unarchived',
        timestamp: new Date().toISOString(),
        data: app.projectService.getProject(archivedProjectId),
        metadata: { source: 'user', actor: 'tester' },
      });
      expect(passes).toHaveBeenCalledTimes(1);
      // A repeated unarchive does not run the pass either (WFT #2543).
      app.projectService.unarchiveProject(archivedProjectId, 'tester');
      expect(passes).toHaveBeenCalledTimes(1);
      passes.mockRestore();
    });

    it('reevaluateProject reports the task ids that failed, and none on a clean pass', () => {
      const blocker = createTask('Blocker', liveProjectId);
      const failing = createTask('Failing dependent', archivedProjectId);
      block(blocker.id, failing.id);
      forceArchive();
      finish(blocker.id);
      const spy = failUpdatesOf(failing.id);
      app.projectService.unarchiveProject(archivedProjectId, 'tester');

      expect(app.workflowEngine.reevaluateProject(archivedProjectId)).toEqual({
        failedTaskIds: [failing.id],
      });
      spy.mockRestore();
      expect(app.workflowEngine.reevaluateProject(archivedProjectId)).toEqual({
        failedTaskIds: [],
      });
      expect(status(failing.id)).toBe('open');
    });

    it('re-evaluating a project that is archived right now changes nothing', () => {
      const blocker = createTask('Blocker', liveProjectId);
      const dependent = createTask('Dependent', archivedProjectId);
      block(blocker.id, dependent.id);
      forceArchive();
      finish(blocker.id);

      expect(app.workflowEngine.reevaluateProject(archivedProjectId)).toEqual({
        failedTaskIds: [],
      });
      expect(status(dependent.id)).toBe('blocked');
    });

    it('a task blocked by hand on top of blockers that are all done is opened too (the two cases cannot be told apart)', () => {
      const blocker = createTask('Blocker', liveProjectId);
      const handBlocked = createTask('Blocked by hand', archivedProjectId);
      const noEdge = createTask('Blocked by hand, no dependency', archivedProjectId);
      app.dependencyService.addDependency({ task_id: blocker.id, blocks_task_id: handBlocked.id });
      finish(blocker.id);
      // Every blocker was already done when a person set these to blocked.
      app.taskService.updateTask(handBlocked.id, { status: 'blocked' });
      app.taskService.updateTask(noEdge.id, { status: 'blocked' });
      forceArchive();

      app.projectService.unarchiveProject(archivedProjectId, 'tester');

      expect(status(handBlocked.id)).toBe('open');
      expect(status(noEdge.id)).toBe('blocked');
    });
  });

  /**
   * WFT #2543, option B: a repeated (no-op) unarchive retries only the task
   * ids whose re-evaluation failed earlier in this process for that project.
   * It never runs the general pass, so it does not open a task blocked by
   * hand, and on a project with nothing remembered it changes nothing.
   */
  describe('a repeated unarchive retries only remembered failures (WFT #2543)', () => {
    function failUpdatesOf(taskId: number): ReturnType<typeof vi.spyOn> {
      const original = app.taskService.updateTask.bind(app.taskService);
      return vi
        .spyOn(app.taskService, 'updateTask')
        .mockImplementation((id: number, ...rest: unknown[]) => {
          if (id === taskId) {
            throw new Error(`simulated write failure on task ${id}`);
          }
          return (original as (...args: unknown[]) => Task)(id, ...rest);
        });
    }

    /** Hand-blocks a task whose dependency edges all point at done tasks. */
    function handBlockOverDoneBlocker(projectId: number, title: string): Task {
      const blocker = createTask(`${title} blocker`, liveProjectId);
      const task = createTask(title, projectId);
      app.dependencyService.addDependency({ task_id: blocker.id, blocks_task_id: task.id });
      finish(blocker.id);
      app.taskService.updateTask(task.id, { status: 'blocked' });
      return task;
    }

    /** Real unarchive while `failing`'s writes throw; returns with them restored. */
    function realUnarchiveWithFailure(failingId: number): void {
      const spy = failUpdatesOf(failingId);
      try {
        const result = app.projectService.unarchiveProject(archivedProjectId, 'tester');
        expect(result.reevaluationFailedTaskIds).toEqual([failingId]);
      } finally {
        spy.mockRestore();
      }
      expect(status(failingId)).toBe('blocked');
    }

    /**
     * A task in the project to be archived, blocked on a live task; the
     * project is force-archived and then the blocker finishes, so the
     * cascade skips the dependent and the real unarchive must open it.
     */
    function heldBackByArchive(title: string): Task {
      const blocker = createTask(`${title} blocker`, liveProjectId);
      const task = createTask(title, archivedProjectId);
      block(blocker.id, task.id);
      forceArchive();
      finish(blocker.id);
      return task;
    }

    it('(a) a no-op unarchive of a never-archived project leaves a hand-blocked task over done blockers blocked', () => {
      const handBlocked = handBlockOverDoneBlocker(liveProjectId, 'Hand blocked');
      const before = app.taskService.getTask(handBlocked.id);

      let result;
      const seen = taskEventsDuring(() => {
        result = app.projectService.unarchiveProject(liveProjectId, 'tester');
      });

      expect(app.taskService.getTask(handBlocked.id)).toEqual(before);
      expect(seen).toEqual([]);
      expect(result).toMatchObject({ reevaluationFailedTaskIds: [] });
    });

    it('(b) after a real unarchive with one failure, a no-op unarchive retries only that task and forgets it', () => {
      const failing = heldBackByArchive('Failing dependent');
      realUnarchiveWithFailure(failing.id);
      expect(app.workflowEngine.rememberedFailures(archivedProjectId)).toEqual([failing.id]);
      // Blocked by hand after the unarchive, over blockers that are all done:
      // not a failure, so the retry must leave it alone.
      const handBlocked = handBlockOverDoneBlocker(archivedProjectId, 'Hand blocked later');

      const retried = app.projectService.unarchiveProject(archivedProjectId, 'tester');

      expect(retried.reevaluationFailedTaskIds).toEqual([]);
      expect(status(failing.id)).toBe('open');
      expect(status(handBlocked.id)).toBe('blocked');
      expect(app.workflowEngine.rememberedFailures(archivedProjectId)).toEqual([]);

      // Nothing left to retry: a further no-op unarchive changes nothing.
      const seen = taskEventsDuring(() => {
        app.projectService.unarchiveProject(archivedProjectId, 'tester');
      });
      expect(seen).toEqual([]);
      expect(status(handBlocked.id)).toBe('blocked');
    });

    it('(c) after a restart (a new engine) a no-op unarchive retries nothing and reports nothing failed', () => {
      const failing = heldBackByArchive('Failing dependent');
      realUnarchiveWithFailure(failing.id);

      const restarted = new WorkflowEngine(
        app.taskService,
        new TaskRepository(app.db),
        new DependencyRepository(app.db),
        eventBus,
        app.db,
      );
      app.workflowEngine.stop();
      restarted.start();
      app.projectService.setUnarchiveReevaluator(restarted);
      try {
        const result = app.projectService.unarchiveProject(archivedProjectId, 'tester');

        expect(result.reevaluationFailedTaskIds).toEqual([]);
        expect(status(failing.id)).toBe('blocked');
        expect(restarted.rememberedFailures(archivedProjectId)).toEqual([]);
      } finally {
        restarted.stop();
      }
    });

    it('(d) archiving the project again forgets its remembered failures', () => {
      const failing = heldBackByArchive('Failing dependent');
      realUnarchiveWithFailure(failing.id);
      expect(app.workflowEngine.rememberedFailures(archivedProjectId)).toEqual([failing.id]);

      forceArchive();

      expect(app.workflowEngine.rememberedFailures(archivedProjectId)).toEqual([]);
    });

    it('deleting a remembered task forgets it', () => {
      const failing = heldBackByArchive('Failing dependent');
      realUnarchiveWithFailure(failing.id);
      expect(app.workflowEngine.rememberedFailures(archivedProjectId)).toEqual([failing.id]);

      app.taskService.deleteTask(failing.id);

      expect(app.workflowEngine.rememberedFailures(archivedProjectId)).toEqual([]);
    });

    it('a candidate query that throws surfaces the error, and a repeated unarchive then runs the full pass (WFT #2552 point 3)', () => {
      const held = heldBackByArchive('Held back');
      const taskRepo = new TaskRepository(app.db);
      const engine = new WorkflowEngine(
        app.taskService,
        taskRepo,
        new DependencyRepository(app.db),
        eventBus,
        app.db,
      );
      app.workflowEngine.stop();
      engine.start();
      app.projectService.setUnarchiveReevaluator(engine);
      try {
        const query = vi.spyOn(taskRepo, 'findUnblockableIds').mockImplementationOnce(() => {
          throw new Error('simulated query failure');
        });
        expect(() => app.projectService.unarchiveProject(archivedProjectId, 'tester')).toThrow(
          'simulated query failure',
        );
        // The unarchive itself had committed; the pass did not finish.
        expect(app.projectService.getProject(archivedProjectId).archived).toBe(false);
        expect(status(held.id)).toBe('blocked');

        const retried = app.projectService.unarchiveProject(archivedProjectId, 'tester');

        expect(retried.reevaluationFailedTaskIds).toEqual([]);
        expect(status(held.id)).toBe('open');
        expect(query).toHaveBeenCalledTimes(2);

        // The pass finished, so a further repeated unarchive is a plain retry again.
        app.projectService.unarchiveProject(archivedProjectId, 'tester');
        expect(query).toHaveBeenCalledTimes(2);
      } finally {
        engine.stop();
      }
    });

    it('a real unarchive replaces the remembered failures with its own result', () => {
      const failing = heldBackByArchive('Failing dependent');
      realUnarchiveWithFailure(failing.id);
      // While the project is live again, a second task comes to depend on a
      // live blocker; the project is archived and the blocker finishes.
      const otherBlocker = createTask('Other blocker', liveProjectId);
      const other = createTask('Other failing dependent', archivedProjectId);
      block(otherBlocker.id, other.id);
      forceArchive();
      finish(otherBlocker.id);

      const spy = failUpdatesOf(other.id);
      let result;
      try {
        result = app.projectService.unarchiveProject(archivedProjectId, 'tester');
      } finally {
        spy.mockRestore();
      }

      expect(result).toMatchObject({ reevaluationFailedTaskIds: [other.id] });
      expect(status(failing.id)).toBe('open');
      expect(app.workflowEngine.rememberedFailures(archivedProjectId)).toEqual([other.id]);
    });
  });
});
