/**
 * In-process tests for src/cli/commands/completed.ts (task #249).
 *
 * Exercises argument-parsing branches plus the report render path against a
 * real on-disk DB so the command's better-sqlite3 open call succeeds.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createApp } from '../../index.js';
import type { App } from '../../index.js';

vi.mock('../config/env.js', () => ({}));

describe('completed command', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let tmpDir: string;
  let dbPath: string;
  let app: App;
  let program: Command;
  const savedDbPath = process.env.DATABASE_PATH;

  function buildProgram(cmd: Command): Command {
    const p = new Command();
    p.option('--json', 'Output as JSON');
    p.addCommand(cmd);
    return p;
  }

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'wft-completed-'));
    dbPath = join(tmpDir, 'tasks.db');
    app = await createApp(dbPath);

    process.env.DATABASE_PATH = dbPath;
    process.env.NO_COLOR = '1';

    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    stdoutSpy.mockRestore();
    try {
      app.dispose();
    } catch {
      /* ignored */
    }
    rmSync(tmpDir, { recursive: true, force: true });
    if (savedDbPath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = savedDbPath;
    }
    delete process.env.NO_COLOR;
    process.exitCode = 0;
  });

  function completeTask(
    projectId: number,
    title: string,
    opts: { assignee?: string; priority?: 'low' | 'medium' | 'high' | 'urgent' } = {},
  ): void {
    const task = app.taskService.createTask({
      title,
      project_id: projectId,
      created_by: 'tester',
      priority: opts.priority ?? 'medium',
    });
    app.taskService.updateTask(task.id, {
      status: 'in_progress',
      assignee: opts.assignee ?? null,
    });
    app.taskService.updateTask(task.id, { status: 'done' });
  }

  it('renders empty report with no completed tasks (default 7-day window)', async () => {
    const { completedCommand } = await import('../commands/completed.js');
    const program = buildProgram(completedCommand);
    await program.parseAsync(['node', 'tasks', 'completed']);
    const logged = consoleLogSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('Completion Report');
    expect(logged).toContain('No completed tasks in this interval.');
  });

  it('renders full report with per-task table and aggregates', async () => {
    const proj = app.projectService.createProject({ name: 'Alpha' });
    completeTask(proj.id, 'a1', { assignee: 'alice', priority: 'high' });
    completeTask(proj.id, 'a2', { assignee: 'bob' });

    const { completedCommand } = await import('../commands/completed.js');
    const program = buildProgram(completedCommand);
    await program.parseAsync(['node', 'tasks', 'completed', '-d', '30']);
    const logged = consoleLogSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('2 task(s) completed');
    expect(logged).toContain('By project:');
    expect(logged).toContain('Alpha');
    expect(logged).toContain('By assignee:');
    expect(logged).toContain('alice');
    expect(logged).toContain('bob');
    expect(logged).toContain('By priority:');
    expect(logged).toContain('Daily throughput:');
  });

  it('respects --project filter', async () => {
    const alpha = app.projectService.createProject({ name: 'Alpha' });
    const beta = app.projectService.createProject({ name: 'Beta' });
    completeTask(alpha.id, 'a1', { assignee: 'alice' });
    completeTask(beta.id, 'b1', { assignee: 'bob' });

    program = buildProgram((await import('../commands/completed.js')).completedCommand);
    program = program; // satisfy ts no-op
    await program.parseAsync(['node', 'tasks', 'completed', '-d', '30', '-p', String(alpha.id)]);
    const logged = consoleLogSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('1 task(s) completed');
    expect(logged).toContain('Alpha');
    expect(logged).not.toContain('Beta');
  });

  it('respects --assignee filter', async () => {
    const alpha = app.projectService.createProject({ name: 'Alpha' });
    completeTask(alpha.id, 'a1', { assignee: 'alice' });
    completeTask(alpha.id, 'a2', { assignee: 'bob' });

    const { completedCommand } = await import('../commands/completed.js');
    program = buildProgram(completedCommand);
    await program.parseAsync(['node', 'tasks', 'completed', '-d', '30', '-a', 'alice']);
    const logged = consoleLogSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('1 task(s) completed');
    expect(logged).toContain('alice');
  });

  it('accepts explicit --since/--until range', async () => {
    const alpha = app.projectService.createProject({ name: 'Alpha' });
    completeTask(alpha.id, 'a1');

    const { completedCommand } = await import('../commands/completed.js');
    program = buildProgram(completedCommand);
    // A past range yields 0 results, but should NOT throw.
    await program.parseAsync([
      'node',
      'tasks',
      'completed',
      '--since',
      '2020-01-01T00:00:00Z',
      '--until',
      '2020-12-31T23:59:59Z',
    ]);
    const logged = consoleLogSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('0 task(s) completed');
  });

  it('rejects partial range (--since without --until)', async () => {
    const { completedCommand } = await import('../commands/completed.js');
    program = buildProgram(completedCommand);
    await program.parseAsync(['node', 'tasks', 'completed', '--since', '2026-01-01T00:00:00Z']);
    expect(process.exitCode).toBe(1);
    const errs = consoleErrorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(errs).toMatch(/Provide both --since and --until together/);
  });

  it('rejects non-positive --days value', async () => {
    const { completedCommand } = await import('../commands/completed.js');
    program = buildProgram(completedCommand);
    await program.parseAsync(['node', 'tasks', 'completed', '-d', '0']);
    expect(process.exitCode).toBe(1);
    const errs = consoleErrorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(errs).toMatch(/--days must be a positive integer/);
  });

  it('rejects non-numeric --project value', async () => {
    const { completedCommand } = await import('../commands/completed.js');
    program = buildProgram(completedCommand);
    await program.parseAsync(['node', 'tasks', 'completed', '-d', '7', '-p', 'abc']);
    expect(process.exitCode).toBe(1);
    const errs = consoleErrorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(errs).toMatch(/--project must be a positive integer/);
  });

  it('outputs JSON envelope when --json is set', async () => {
    const proj = app.projectService.createProject({ name: 'Alpha' });
    completeTask(proj.id, 'a1', { assignee: 'alice', priority: 'high' });

    const { completedCommand } = await import('../commands/completed.js');
    program = buildProgram(completedCommand);
    await program.parseAsync(['node', 'tasks', '--json', 'completed', '-d', '30']);
    const written = stdoutSpy.mock.calls[0][0] as string;
    const env = JSON.parse(written);
    expect(env.success).toBe(true);
    expect(env.data.total).toBe(1);
    expect(env.metadata.count).toBe(1);
  });

  it('renders long titles truncated in the per-task table', async () => {
    const proj = app.projectService.createProject({ name: 'Alpha' });
    completeTask(proj.id, 'x'.repeat(60), { assignee: 'alice' });

    const { completedCommand } = await import('../commands/completed.js');
    program = buildProgram(completedCommand);
    await program.parseAsync(['node', 'tasks', 'completed', '-d', '30']);
    const logged = consoleLogSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('...');
  });
});
