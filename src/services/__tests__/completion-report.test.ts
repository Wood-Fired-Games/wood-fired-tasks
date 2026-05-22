import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestApp } from '../../index.js';
import { ValidationError } from '../errors.js';
import type { App } from '../../index.js';

describe('TaskService.getCompletionReport', () => {
  let app: App;
  let projectAId: number;
  let projectBId: number;

  beforeEach(async () => {
    app = await createTestApp();
    projectAId = app.projectService.createProject({ name: 'Alpha' }).id;
    projectBId = app.projectService.createProject({ name: 'Beta' }).id;
  });

  afterEach(() => {
    // task #257: release WorkflowEngine's EventBus subscription between tests.
    app.dispose();
  });

  /**
   * Helper: create a task and walk it through statuses ending at 'done'.
   * Returns the final task. The repository sets completed_at on transition
   * into 'done', so this is the canonical fixture builder.
   */
  function completeTask(
    projectId: number,
    title: string,
    opts: { assignee?: string; priority?: 'low' | 'medium' | 'high' | 'urgent' } = {}
  ): { id: number; completed_at: string | null } {
    const task = app.taskService.createTask({
      title,
      project_id: projectId,
      created_by: 'tester',
      priority: opts.priority ?? 'medium',
    });
    app.taskService.updateTask(task.id, { status: 'in_progress', assignee: opts.assignee ?? null });
    const done = app.taskService.updateTask(task.id, { status: 'done' });
    return { id: done.id, completed_at: done.completed_at };
  }

  it('rejects input that has neither days nor a full range', () => {
    expect(() => app.taskService.getCompletionReport({})).toThrow(ValidationError);
  });

  it('rejects ranges where end precedes start', () => {
    expect(() =>
      app.taskService.getCompletionReport({
        start: '2026-02-01T00:00:00Z',
        end: '2026-01-01T00:00:00Z',
      })
    ).toThrow(ValidationError);
  });

  it('returns an empty report when no tasks completed in the range', () => {
    const report = app.taskService.getCompletionReport({ days: 7 });
    expect(report.total).toBe(0);
    expect(report.rows).toHaveLength(0);
  });

  it('aggregates by project, assignee, and priority for the trailing window', () => {
    completeTask(projectAId, 'a1', { assignee: 'alice', priority: 'high' });
    completeTask(projectAId, 'a2', { assignee: 'bob', priority: 'high' });
    completeTask(projectBId, 'b1', { assignee: 'alice', priority: 'low' });

    const report = app.taskService.getCompletionReport({ days: 30 });

    expect(report.total).toBe(3);
    expect(report.by_project).toContainEqual({ project_id: projectAId, count: 2 });
    expect(report.by_project).toContainEqual({ project_id: projectBId, count: 1 });
    expect(report.by_assignee).toContainEqual({ assignee: 'alice', count: 2 });
    expect(report.by_assignee).toContainEqual({ assignee: 'bob', count: 1 });
    expect(report.by_priority).toContainEqual({ priority: 'high', count: 2 });
    expect(report.by_priority).toContainEqual({ priority: 'low', count: 1 });
  });

  it('respects project_id filter', () => {
    completeTask(projectAId, 'a1');
    completeTask(projectBId, 'b1');

    const report = app.taskService.getCompletionReport({
      days: 30,
      project_id: projectAId,
    });
    expect(report.total).toBe(1);
    expect(report.rows[0].project_id).toBe(projectAId);
  });

  it('respects assignee filter', () => {
    completeTask(projectAId, 'alice-task', { assignee: 'alice' });
    completeTask(projectAId, 'bob-task', { assignee: 'bob' });

    const report = app.taskService.getCompletionReport({
      days: 30,
      assignee: 'alice',
    });
    expect(report.total).toBe(1);
    expect(report.rows[0].assignee).toBe('alice');
  });

  it('groups daily_throughput by completion date', () => {
    completeTask(projectAId, 't1');
    completeTask(projectAId, 't2');
    const report = app.taskService.getCompletionReport({ days: 30 });

    const today = new Date().toISOString().slice(0, 10);
    const todayBucket = report.daily_throughput.find((r) => r.date === today);
    expect(todayBucket?.count).toBe(2);
  });

  it('clears completed_at when a task moves back out of done', () => {
    const { id } = completeTask(projectAId, 'flaky');
    const before = app.taskService.getCompletionReport({ days: 30 });
    expect(before.total).toBe(1);

    app.taskService.updateTask(id, { status: 'open' });

    const after = app.taskService.getCompletionReport({ days: 30 });
    expect(after.total).toBe(0);
  });

  it('honors explicit start/end bounds', () => {
    completeTask(projectAId, 'inside');

    // Range entirely in the past — should exclude the just-completed task
    const past = app.taskService.getCompletionReport({
      start: '2020-01-01T00:00:00Z',
      end: '2020-12-31T23:59:59Z',
    });
    expect(past.total).toBe(0);
  });
});
