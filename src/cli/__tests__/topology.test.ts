/**
 * Wave 4.1 (task #318) — In-process tests for src/cli/commands/topology.ts.
 *
 * Mirrors db-check.test.ts: spin up a real on-disk SQLite, run migrations,
 * seed a handful of rows via the repositories, then drive the Commander
 * subcommand with parseAsync. The CLI command opens the DB read-only so we
 * verify it works even after seeding from a separate write handle.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initDatabase } from '../../db/database.js';
import { runMigrations } from '../../db/migrate.js';
import { ProjectRepository } from '../../repositories/project.repository.js';
import { TaskRepository } from '../../repositories/task.repository.js';
import { DependencyRepository } from '../../repositories/dependency.repository.js';

vi.mock('../config/env.js', () => ({}));

describe('topology command', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let tmpDir: string;
  let dbPath: string;
  let program: Command;
  const savedDbPath = process.env.DATABASE_PATH;

  beforeEach(async () => {
    process.exitCode = 0;
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    tmpDir = mkdtempSync(join(tmpdir(), 'wft-topology-'));
    dbPath = join(tmpDir, 'tasks.db');

    // Materialize a real schema so the command's read-only handle sees the
    // same tables the production server would.
    const db = initDatabase(dbPath);
    await runMigrations(db);
    db.close();

    process.env.DATABASE_PATH = dbPath;
    process.env.NO_COLOR = '1';

    const { topologyCommand } = await import('../commands/topology.js');
    program = new Command();
    program.option('--json', 'Output as JSON');
    program.addCommand(topologyCommand);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    stdoutSpy.mockRestore();
    rmSync(tmpDir, { recursive: true, force: true });
    if (savedDbPath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = savedDbPath;
    }
    delete process.env.NO_COLOR;
    process.exitCode = 0;
  });

  function seedFlatProject(taskCount: number): number {
    const db = new Database(dbPath);
    const projectRepo = new ProjectRepository(db);
    const taskRepo = new TaskRepository(db);
    const project = projectRepo.create({ name: 'Flat Project' });
    for (let i = 0; i < taskCount; i++) {
      taskRepo.create({
        title: `t${i}`,
        status: 'open',
        priority: 'medium',
        project_id: project.id,
        created_by: 'test-agent',
      });
    }
    db.close();
    return project.id;
  }

  function seedDiamondProject(): { projectId: number; ids: number[] } {
    const db = new Database(dbPath);
    const projectRepo = new ProjectRepository(db);
    const taskRepo = new TaskRepository(db);
    const depRepo = new DependencyRepository(db);
    const project = projectRepo.create({ name: 'Diamond' });
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(
        taskRepo.create({
          title: `n${i + 1}`,
          status: 'open',
          priority: 'medium',
          project_id: project.id,
          created_by: 'test-agent',
        }).id,
      );
    }
    const [n1, n2, n3, n4, n5] = ids;
    depRepo.create({ task_id: n1, blocks_task_id: n2 });
    depRepo.create({ task_id: n2, blocks_task_id: n3 });
    depRepo.create({ task_id: n2, blocks_task_id: n4 });
    depRepo.create({ task_id: n3, blocks_task_id: n5 });
    depRepo.create({ task_id: n4, blocks_task_id: n5 });
    db.close();
    return { projectId: project.id, ids };
  }

  it('fails with non-zero exit when --project is missing', async () => {
    // Commander throws on missing required option when exitOverride is set.
    // Without exitOverride it would call process.exit(1). The throw signals
    // a non-zero-exit outcome to the test runner.
    program.exitOverride();
    program.commands.forEach((c) => c.exitOverride());
    await expect(
      program.parseAsync(['node', 'tasks', 'topology']),
    ).rejects.toMatchObject({ exitCode: 1 });
  });

  it('fails with non-zero exit when --project is non-numeric', async () => {
    await program.parseAsync(['node', 'tasks', 'topology', '--project', 'abc']);
    expect(process.exitCode).toBe(1);
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it('fails with non-zero exit when --project is zero or negative', async () => {
    await program.parseAsync(['node', 'tasks', 'topology', '--project', '0']);
    expect(process.exitCode).toBe(1);
  });

  it('emits a FLAT JSON report for a 0-edge project', async () => {
    const projectId = seedFlatProject(3);
    await program.parseAsync([
      'node',
      'tasks',
      'topology',
      '--project',
      String(projectId),
    ]);
    expect(stdoutSpy).toHaveBeenCalled();
    const written = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
    const report = JSON.parse(written);
    expect(report.topology).toBe('FLAT');
    expect(report.advisory).toBe('/tasks:loop');
    expect(report.edges).toEqual([]);
    expect(report.roots).toHaveLength(3);
    expect(report.leaves).toHaveLength(3);
    expect(process.exitCode).toBe(0);
  });

  it('emits a DAG JSON report with deterministic edge ordering', async () => {
    const { projectId, ids } = seedDiamondProject();
    await program.parseAsync([
      'node',
      'tasks',
      'topology',
      '--project',
      String(projectId),
    ]);
    const written = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
    const report = JSON.parse(written);
    expect(report.topology).toBe('DAG');
    expect(report.advisory).toBe('/tasks:loop-dag');
    expect(report.edges).toHaveLength(5);
    expect(report.roots).toEqual([ids[0]]);
    expect(report.leaves).toEqual([ids[4]]);
    expect(process.exitCode).toBe(0);
  });
});
