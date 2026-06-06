/**
 * WSJF 4.5 (task #645) — in-process tests for the WSJF CLI commands:
 *   wsjf-history <id>      (read score history, chronological)
 *   wsjf-set <id> [flags]  (set / lock components, manual gate)
 *   charter-history <id>   (read charter history, chronological)
 *
 * Mirrors topology.test.ts: real on-disk SQLite + migrations, seed via the
 * repositories / services, then drive the Commander subcommands with parseAsync.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import Database from '../../db/driver.js';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initDatabase } from '../../db/database.js';
import { runMigrations } from '../../db/migrate.js';
import { ProjectRepository } from '../../repositories/project.repository.js';
import { TaskRepository } from '../../repositories/task.repository.js';
import { WsjfHistoryRepository } from '../../repositories/wsjf-history.repository.js';
import { TaskService } from '../../services/task.service.js';
import type { ValueCharter } from '../../types/task.js';

vi.mock('../config/env.js', () => ({}));

function charter(version: number, mission: string): ValueCharter {
  return {
    mission,
    value_themes: [{ name: 'core', weight: 8, description: 'core' }],
    time_context: 'now',
    risk_posture: 'balanced',
    out_of_scope: [],
    interview_version: version,
    updated_at: new Date().toISOString(),
  };
}

describe('WSJF CLI commands', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let tmpDir: string;
  let dbPath: string;
  let program: Command;
  const savedDbPath = process.env.DATABASE_PATH;

  beforeEach(async () => {
    process.exitCode = 0;
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    tmpDir = mkdtempSync(join(tmpdir(), 'wft-wsjf-'));
    dbPath = join(tmpDir, 'tasks.db');
    const db = initDatabase(dbPath);
    await runMigrations(db);
    db.close();

    process.env.DATABASE_PATH = dbPath;
    process.env.NO_COLOR = '1';

    const { wsjfHistoryCommand, wsjfSetCommand, charterHistoryCommand } = await import(
      '../commands/wsjf.js'
    );
    program = new Command();
    program.addCommand(wsjfHistoryCommand);
    program.addCommand(wsjfSetCommand);
    program.addCommand(charterHistoryCommand);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    stdoutSpy.mockRestore();
    rmSync(tmpDir, { recursive: true, force: true });
    if (savedDbPath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = savedDbPath;
    delete process.env.NO_COLOR;
    process.exitCode = 0;
  });

  function stdout(): string {
    return stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
  }

  function seedTask(): number {
    const db = new Database(dbPath);
    const projectRepo = new ProjectRepository(db);
    const taskRepo = new TaskRepository(db);
    const project = projectRepo.create({ name: 'CLI WSJF' });
    const id = taskRepo.create({
      title: 'score me',
      status: 'open',
      priority: 'medium',
      project_id: project.id,
      created_by: 'seed',
    }).id;
    db.close();
    return id;
  }

  it('wsjf-set sets components + locks and round-trips via wsjf-history', async () => {
    const id = seedTask();
    await program.parseAsync([
      'node',
      'tasks',
      'wsjf-set',
      String(id),
      '--value',
      '8',
      '--time-criticality',
      '3',
      '--risk-opportunity',
      '5',
      '--job-size',
      '2',
      '--lock',
      'value,jobSize',
    ]);
    expect(process.exitCode).toBe(0);
    const setOut = JSON.parse(stdout());
    expect(setOut.components).toEqual({
      value: 8,
      timeCriticality: 3,
      riskOpportunity: 5,
      jobSize: 2,
    });
    expect(setOut.locked).toEqual({
      value: true,
      timeCriticality: false,
      riskOpportunity: false,
      jobSize: true,
    });

    // wsjf-history shows the manual write.
    stdoutSpy.mockClear();
    await program.parseAsync(['node', 'tasks', 'wsjf-history', String(id)]);
    const histOut = JSON.parse(stdout());
    expect(histOut.task_id).toBe(id);
    expect(histOut.total).toBe(1);
    expect(histOut.history[0].trigger).toBe('manual');
    expect(histOut.history[0].value).toBe(8);
  });

  it('wsjf-set rejects an off-scale Fibonacci tier', async () => {
    const id = seedTask();
    await program.parseAsync([
      'node',
      'tasks',
      'wsjf-set',
      String(id),
      '--value',
      '4',
      '--time-criticality',
      '3',
      '--risk-opportunity',
      '5',
      '--job-size',
      '2',
    ]);
    expect(process.exitCode).toBe(1);
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it('wsjf-set rejects the jobSize=1 ∧ value=13 contradiction (manual gate)', async () => {
    const id = seedTask();
    await program.parseAsync([
      'node',
      'tasks',
      'wsjf-set',
      String(id),
      '--value',
      '13',
      '--time-criticality',
      '3',
      '--risk-opportunity',
      '5',
      '--job-size',
      '1',
    ]);
    expect(process.exitCode).toBe(1);
  });

  it('wsjf-set rejects an unknown --lock key', async () => {
    const id = seedTask();
    await program.parseAsync([
      'node',
      'tasks',
      'wsjf-set',
      String(id),
      '--value',
      '8',
      '--time-criticality',
      '3',
      '--risk-opportunity',
      '5',
      '--job-size',
      '2',
      '--lock',
      'bogus',
    ]);
    expect(process.exitCode).toBe(1);
  });

  it('wsjf-history returns an empty timeline for an unscored task', async () => {
    const id = seedTask();
    await program.parseAsync(['node', 'tasks', 'wsjf-history', String(id)]);
    const out = JSON.parse(stdout());
    expect(out.total).toBe(0);
    expect(out.history).toEqual([]);
    expect(process.exitCode).toBe(0);
  });

  it('wsjf-history rejects a non-positive id', async () => {
    await program.parseAsync(['node', 'tasks', 'wsjf-history', '0']);
    expect(process.exitCode).toBe(1);
  });

  it('charter-history returns prior snapshots oldest-first', async () => {
    // Seed a project with two charter overwrites via an audit-enabled service.
    const db = new Database(dbPath);
    const projectRepo = new ProjectRepository(db);
    const project = projectRepo.create({
      name: 'Chartered',
      value_charter: charter(1, 'v1'),
    });
    const taskRepo = new TaskRepository(db);
    const historyRepo = new WsjfHistoryRepository(db);
    // ProjectService owns the charter-history snapshot on overwrite.
    const { ProjectService } = await import('../../services/project.service.js');
    const { ProjectCharterHistoryRepository } = await import(
      '../../repositories/project-charter-history.repository.js'
    );
    const projectService = new ProjectService(projectRepo, {
      charterHistory: new ProjectCharterHistoryRepository(db),
      db,
    });
    void new TaskService(taskRepo, projectRepo, db, historyRepo);
    projectService.updateProject(project.id, { value_charter: charter(2, 'v2') });
    projectService.updateProject(project.id, { value_charter: charter(3, 'v3') });
    db.close();

    await program.parseAsync(['node', 'tasks', 'charter-history', String(project.id)]);
    expect(process.exitCode).toBe(0);
    const out = JSON.parse(stdout());
    expect(out.project_id).toBe(project.id);
    expect(out.total).toBe(2);
    expect(out.history[0].charter.mission).toBe('v1');
    expect(out.history[1].charter.mission).toBe('v2');
    const times = out.history.map((r: { changed_at: string }) => r.changed_at);
    expect(times).toEqual([...times].sort());
  });

  it('charter-history rejects a non-positive id', async () => {
    await program.parseAsync(['node', 'tasks', 'charter-history', '-1']);
    expect(process.exitCode).toBe(1);
  });
});
