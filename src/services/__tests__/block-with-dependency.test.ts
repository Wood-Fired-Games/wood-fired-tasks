// Task #1004: atomic block-with-dependency.
//
// A merge-queue bounce once set a task to `blocked` and filed a defect task
// WITHOUT adding the dependency edge — leaving the task blocked forever (the
// blocked→open source=workflow auto-unblock only fires off an edge). These
// tests pin the affordance that makes that dead end impossible to create:
// `updateTask` with `status: 'blocked'` + `blocked_by: number[]` adds the
// edge(s) and flips the status in ONE transaction, all-or-nothing.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestApp } from '../../index.js';
import { ValidationError, BusinessError, NotFoundError } from '../errors.js';
import type { App } from '../../index.js';

describe('TaskService.updateTask blocked_by (atomic block-with-dependency, #1004)', () => {
  let app: App;
  let projectId: number;

  beforeEach(async () => {
    app = await createTestApp();
    projectId = app.projectService.createProject({ name: 'Block-with-dep' }).id;
  });

  afterEach(() => {
    app.dispose();
  });

  function createTask(title: string): number {
    return app.taskService.createTask({
      title,
      project_id: projectId,
      created_by: 'tester',
    }).id;
  }

  function blockerIdsOf(taskId: number): number[] {
    return app.dependencyService
      .getBlockers(taskId)
      .map((d) => d.task_id)
      .sort((a, b) => a - b);
  }

  it('sets status AND adds the blocking edges in one call', () => {
    const blocked = createTask('victim');
    const blockerA = createTask('defect A');
    const blockerB = createTask('defect B');

    const updated = app.taskService.updateTask(blocked, {
      status: 'blocked',
      blocked_by: [blockerA, blockerB],
    });

    expect(updated.status).toBe('blocked');
    expect(blockerIdsOf(blocked)).toEqual([blockerA, blockerB].sort((a, b) => a - b));
  });

  it('rolls back BOTH the status and any partial edge when a blocker does not exist', () => {
    const blocked = createTask('victim');
    const validBlocker = createTask('real blocker');

    // The valid edge is processed first; the nonexistent one throws — the
    // transaction must roll back the already-added edge AND the status write.
    expect(() =>
      app.taskService.updateTask(blocked, {
        status: 'blocked',
        blocked_by: [validBlocker, 999_999],
      }),
    ).toThrow(NotFoundError);

    expect(app.taskService.getTask(blocked).status).toBe('open');
    expect(blockerIdsOf(blocked)).toEqual([]);
  });

  it('rolls back everything when an edge would create a cycle', () => {
    const a = createTask('A');
    const b = createTask('B');
    // A blocks B (existing edge). Blocking A on B would close the cycle.
    app.dependencyService.addDependency({ task_id: a, blocks_task_id: b });

    expect(() => app.taskService.updateTask(a, { status: 'blocked', blocked_by: [b] })).toThrow(
      BusinessError,
    );

    expect(app.taskService.getTask(a).status).toBe('open');
    expect(blockerIdsOf(a)).toEqual([]);
  });

  it('rejects a self-referencing blocker and leaves the task untouched', () => {
    const t = createTask('self');

    expect(() => app.taskService.updateTask(t, { status: 'blocked', blocked_by: [t] })).toThrow(
      ValidationError,
    );

    expect(app.taskService.getTask(t).status).toBe('open');
    expect(blockerIdsOf(t)).toEqual([]);
  });

  it('rejects blocked_by without status (narrow semantics)', () => {
    const t = createTask('victim');
    const blocker = createTask('blocker');

    expect(() => app.taskService.updateTask(t, { blocked_by: [blocker] })).toThrow(ValidationError);
    expect(blockerIdsOf(t)).toEqual([]);
  });

  it('rejects blocked_by with a non-blocked status', () => {
    const t = createTask('victim');
    const blocker = createTask('blocker');

    expect(() =>
      app.taskService.updateTask(t, { status: 'in_progress', blocked_by: [blocker] }),
    ).toThrow(ValidationError);
    expect(app.taskService.getTask(t).status).toBe('open');
    expect(blockerIdsOf(t)).toEqual([]);
  });

  it('is idempotent for already-existing edges (re-block adds only the new blocker)', () => {
    const blocked = createTask('victim');
    const first = createTask('first blocker');
    const second = createTask('second blocker');

    app.taskService.updateTask(blocked, { status: 'blocked', blocked_by: [first] });
    // Already blocked + edge exists; appending a second blocker must neither
    // throw (duplicate edge) nor require an open→blocked transition.
    const updated = app.taskService.updateTask(blocked, {
      status: 'blocked',
      blocked_by: [first, second],
    });

    expect(updated.status).toBe('blocked');
    expect(blockerIdsOf(blocked)).toEqual([first, second].sort((a, b) => a - b));
  });
});
