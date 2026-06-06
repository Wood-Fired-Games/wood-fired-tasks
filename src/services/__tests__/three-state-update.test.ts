import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestApp } from '../../index.js';
import type { App } from '../../index.js';
import { TaskService } from '../task.service.js';
import { ProjectService } from '../project.service.js';

/**
 * Guards the absent / null / value three-state convention through the
 * service → repository → SQLite boundary, which the exactOptionalPropertyTypes
 * remediation (#779) reshaped via the `omitUndefined` / `normalizeWsjfWrite` /
 * `normalizeVerificationEvidence` call-site helpers.
 *
 *   - key ABSENT  → leave the column untouched
 *   - explicit NULL → clear the column
 *   - a VALUE       → set the column
 *
 * If a helper accidentally collapsed "absent" into "explicit undefined" (or
 * dropped an explicit null), these assertions would fail.
 */
describe('three-state update semantics (#779 eopt remediation)', () => {
  let app: App;
  let taskService: TaskService;
  let projectService: ProjectService;
  let projectId: number;

  beforeEach(async () => {
    app = await createTestApp();
    taskService = app.taskService;
    projectService = app.projectService;
    const project = projectService.createProject({ name: 'eopt-three-state' });
    projectId = project.id;
  });

  afterEach(() => {
    app.dispose();
  });

  function makeTask() {
    return taskService.createTask({
      title: 'seed',
      project_id: projectId,
      created_by: 'creator',
      description: 'initial description',
      assignee: 'alice',
      acceptance_criteria: 'must pass',
    });
  }

  it('ABSENT key leaves the column untouched (description survives a title-only patch)', () => {
    const created = makeTask();
    const updated = taskService.updateTask(created.id, { title: 'renamed' });
    expect(updated.title).toBe('renamed');
    // description was NOT in the patch → must be preserved, not nulled.
    expect(updated.description).toBe('initial description');
    expect(updated.assignee).toBe('alice');
    expect(updated.acceptance_criteria).toBe('must pass');
  });

  it('explicit NULL clears the column', () => {
    const created = makeTask();
    const updated = taskService.updateTask(created.id, {
      description: null,
      assignee: null,
      acceptance_criteria: null,
    });
    expect(updated.description).toBeNull();
    expect(updated.assignee).toBeNull();
    expect(updated.acceptance_criteria).toBeNull();
  });

  it('a VALUE sets the column', () => {
    const created = makeTask();
    const updated = taskService.updateTask(created.id, {
      description: 'changed',
      assignee: 'bob',
    });
    expect(updated.description).toBe('changed');
    expect(updated.assignee).toBe('bob');
    // untouched key still preserved
    expect(updated.acceptance_criteria).toBe('must pass');
  });

  it('mixed patch: null clears one column while another value sets a second and a third stays untouched', () => {
    const created = makeTask();
    const updated = taskService.updateTask(created.id, {
      description: null, // clear
      assignee: 'carol', // set
      // acceptance_criteria absent → untouched
    });
    expect(updated.description).toBeNull();
    expect(updated.assignee).toBe('carol');
    expect(updated.acceptance_criteria).toBe('must pass');
  });

  it('create omits absent optional columns (NULL in DB) and keeps supplied values', () => {
    const minimal = taskService.createTask({
      title: 'minimal',
      project_id: projectId,
      created_by: 'creator',
      // description, assignee, due_date all absent
    });
    expect(minimal.description).toBeNull();
    expect(minimal.assignee).toBeNull();
    expect(minimal.due_date).toBeNull();
  });

  it('explicit null on create clears the column (distinct from a value)', () => {
    const t = taskService.createTask({
      title: 'with-null',
      project_id: projectId,
      created_by: 'creator',
      description: null,
    });
    expect(t.description).toBeNull();
  });
});
