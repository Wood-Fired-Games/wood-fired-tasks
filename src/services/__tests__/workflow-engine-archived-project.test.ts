import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestApp } from '../../index.js';
import { eventBus } from '../../events/event-bus.js';
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
      // No event on a repeated unarchive, so nothing re-runs...
      app.projectService.unarchiveProject(archivedProjectId, 'tester');
      // ...and a redelivered event finds nothing left to do.
      eventBus.emit('project.unarchived', {
        eventType: 'project.unarchived',
        timestamp: new Date().toISOString(),
        data: app.projectService.getProject(archivedProjectId),
        metadata: { source: 'user', actor: 'tester' },
      });
    });

    expect(app.taskService.getTask(dependent.id)).toEqual(after);
    expect(seen).toEqual([]);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('does nothing if the project is archived again before the event is handled', () => {
    const blocker = createTask('Blocker', liveProjectId);
    const dependent = createTask('Dependent', archivedProjectId);
    block(blocker.id, dependent.id);
    forceArchive();
    finish(blocker.id);
    const before = app.taskService.getTask(dependent.id);

    // A stale `project.unarchived` for a project that is archived right now.
    eventBus.emit('project.unarchived', {
      eventType: 'project.unarchived',
      timestamp: new Date().toISOString(),
      data: { ...app.projectService.getProject(archivedProjectId), archived: false },
      metadata: { source: 'user', actor: 'tester' },
    });

    expect(app.taskService.getTask(dependent.id)).toEqual(before);
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
