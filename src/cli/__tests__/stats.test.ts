/**
 * In-process tests for src/cli/commands/stats.ts (task #249).
 *
 * Boots a real Wood Fired Tasks database via createApp(':memory:'), but writes
 * to a temp file so the command's own better-sqlite3 constructor can open it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createApp } from '../../index.js';
import type { App } from '../../index.js';

vi.mock('../config/env.js', () => ({}));

describe('stats command', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let tmpDir: string;
  let dbPath: string;
  let app: App;
  let program: Command;
  const savedDbPath = process.env.DATABASE_PATH;

  async function setupProgram() {
    const { statsCommand } = await import('../commands/stats.js');
    const p = new Command();
    p.option('--json', 'Output as JSON');
    p.addCommand(statsCommand);
    return p;
  }

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'wft-stats-'));
    dbPath = join(tmpDir, 'tasks.db');
    app = await createApp(dbPath);

    process.env.DATABASE_PATH = dbPath;
    process.env.NO_COLOR = '1';

    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    program = await setupProgram();
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
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

  it('prints "No tasks found." when the database is empty', async () => {
    await program.parseAsync(['node', 'tasks', 'stats']);
    const logged = consoleLogSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('No tasks found.');
  });

  it('renders status counts, recent activity, and agent productivity', async () => {
    const project = app.projectService.createProject({ name: 'Alpha' });
    // Create a few tasks across statuses.
    const t1 = app.taskService.createTask({
      title: 't1',
      project_id: project.id,
      created_by: 'tester',
    });
    app.taskService.updateTask(t1.id, { status: 'in_progress', assignee: 'alice' });

    const t2 = app.taskService.createTask({
      title: 't2',
      project_id: project.id,
      created_by: 'tester',
    });
    app.taskService.updateTask(t2.id, { status: 'in_progress', assignee: 'alice' });
    app.taskService.updateTask(t2.id, { status: 'done' });

    await program.parseAsync(['node', 'tasks', 'stats']);
    const logged = consoleLogSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('Task Counts by Status:');
    expect(logged).toContain('Recent Activity (24h):');
    expect(logged).toContain('Agent Productivity (7 days):');
    expect(logged).toMatch(/Total\s+2/);
    expect(logged).toContain('alice');
  });

  it('outputs JSON when --json is set', async () => {
    const project = app.projectService.createProject({ name: 'Alpha' });
    app.taskService.createTask({
      title: 't1',
      project_id: project.id,
      created_by: 'tester',
    });

    await program.parseAsync(['node', 'tasks', '--json', 'stats']);
    const written = stdoutSpy.mock.calls[0][0] as string;
    const env = JSON.parse(written);
    expect(env.success).toBe(true);
    expect(Array.isArray(env.data.statusCounts)).toBe(true);
    expect(env.data.recentActivity).toEqual(
      expect.objectContaining({ created: expect.any(Number), updated: expect.any(Number) })
    );
    expect(Array.isArray(env.data.agentProductivity)).toBe(true);
  });

  it('shows "No agent activity" line when no assignees in last 7 days', async () => {
    const project = app.projectService.createProject({ name: 'Alpha' });
    // Create a task with no assignee → agent productivity table empty.
    app.taskService.createTask({
      title: 't1',
      project_id: project.id,
      created_by: 'tester',
    });

    await program.parseAsync(['node', 'tasks', 'stats']);
    const logged = consoleLogSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('No agent activity in the last 7 days.');
  });
});
