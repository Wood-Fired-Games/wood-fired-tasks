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

  it('the skipped dependent is not unblocked retroactively by an unarchive, but can be opened by hand', () => {
    const blocker = createTask('Blocker', liveProjectId);
    const archivedDependent = createTask('Archived dependent', archivedProjectId);
    block(blocker.id, archivedDependent.id);
    forceArchive(archivedProjectId);
    app.taskService.updateTask(blocker.id, { status: 'in_progress' });
    app.taskService.updateTask(blocker.id, { status: 'done' });

    app.projectService.unarchiveProject(archivedProjectId, 'tester');

    expect(status(archivedDependent.id)).toBe('blocked');
    app.taskService.updateTask(archivedDependent.id, { status: 'open' });
    expect(status(archivedDependent.id)).toBe('open');
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
