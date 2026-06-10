import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDatabase } from '../../db/database.js';
import { runMigrations } from '../../db/migrate.js';
import { ProjectRepository } from '../../repositories/project.repository.js';
import { TaskRepository } from '../../repositories/task.repository.js';
import { WsjfHistoryRepository } from '../../repositories/wsjf-history.repository.js';
import { createApp, type App } from '../../index.js';
import { backfillJobSizes } from '../../services/job-size-backfill.js';
import type { TaskStatus } from '../../types/task.js';

/**
 * Guaranteed-task-sizing (#992, design spec §5) — idempotent boot sweep.
 *
 * The sweep is wired into `createApp` immediately after `seedIdentities`. It
 * backfills `wsjf_job_size` for every non-done/non-closed task left sizeless
 * by the migration era, via `TaskService.autoSizeTask({trigger:'boot_sweep'})`
 * — ONE db.transaction per row, so a mid-sweep failure on one row cannot roll
 * back rows already committed.
 *
 * Acceptance criteria:
 *   1. Seeded NULL-size open tasks all gain wsjf_job_size + source.jobSize='auto'
 *      + a boot_sweep history row after createApp.
 *   2. A second createApp on the SAME db writes zero rows and zero history
 *      entries (idempotence).
 *   3. done/closed tasks with NULL size are skipped.
 *   4. A forced mid-sweep failure on one row leaves previously committed rows
 *      intact (per-row transaction).
 *
 * Test-seeding note (#989 may land in the same wave): NULL-size fixtures are
 * seeded via the DIRECT repository insert path (`TaskRepository.create` with no
 * `wsjf` payload — the migration-era shape) rather than via
 * `TaskService.createTask`, which may soon auto-size on create. This keeps the
 * fixtures sizeless regardless of #989.
 */
describe('boot sweep — idempotent NULL job-size backfill (#992)', () => {
  let tmpDir: string;
  let dbPath: string;
  let apps: App[];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'wft-boot-sweep-'));
    dbPath = join(tmpDir, 'tasks.db');
    apps = [];
  });

  afterEach(() => {
    for (const app of apps) app.dispose();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // Helper: seed a project + a mix of sizeless tasks via direct repository
  // inserts, then close the seeding handle. Returns the seeded ids.
  async function seed(): Promise<{
    projectId: number;
    openIds: number[];
    doneId: number;
    closedId: number;
  }> {
    // Seed NULL-size fixtures directly through the repository layer (NOT
    // TaskService.createTask) so they keep the migration-era sizeless shape
    // even once #989 auto-sizes on create.
    const db = initDatabase(dbPath);
    await runMigrations(db);
    const projectRepo = new ProjectRepository(db);
    const taskRepo = new TaskRepository(db);
    const projectId = projectRepo.create({ name: 'Sweep Project' }).id;

    const mk = (title: string, status: TaskStatus, estimated_minutes: number | null) =>
      taskRepo.create({
        title,
        status,
        priority: 'medium',
        project_id: projectId,
        created_by: 'seed',
        estimated_minutes,
        // no `wsjf` → every wsjf_* column NULL (migration-era sizeless shape)
      }).id;

    const openIds = [
      mk('open small', 'open', 10), // ≤15 → tier 1
      mk('open medium', 'open', 45), // ≤60 → tier 3
      mk('open large', 'open', 200), // ≤240 → tier 5
      mk('open no-estimate', 'open', null), // null → tier 3 residual
      mk('in_progress', 'in_progress', 900), // ≤960 → tier 8 (non-terminal)
    ];
    const doneId = mk('done sizeless', 'done', 30);
    const closedId = mk('closed sizeless', 'closed', 30);

    db.close();
    return { projectId, openIds, doneId, closedId };
  }

  it('AC1+summary: happy-path summary line reports swept/skipped/failed=0 after all rows succeed', async () => {
    const { openIds } = await seed();

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = initDatabase(dbPath);
    await runMigrations(db);
    const projectRepo = new ProjectRepository(db);
    const taskRepo = new TaskRepository(db);
    const historyRepo = new WsjfHistoryRepository(db);
    const { TaskService } = await import('../../services/task.service.js');
    const service = new TaskService(taskRepo, projectRepo, db, historyRepo);

    const result = backfillJobSizes(service, taskRepo);

    expect(result.swept).toBe(openIds.length);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);

    // Exactly one summary log line with the expected shape.
    const summaryLines = errorSpy.mock.calls
      .map((args) => {
        try {
          return JSON.parse(args[0] as string);
        } catch {
          return null;
        }
      })
      .filter((obj) => obj !== null && obj.msg === 'job_size_backfill.complete');
    expect(summaryLines).toHaveLength(1);
    expect(summaryLines[0]).toMatchObject({
      level: 'info',
      msg: 'job_size_backfill.complete',
      swept: openIds.length,
      skipped: 0,
      failed: 0,
    });

    errorSpy.mockRestore();
    db.close();
  });

  it('AC1: backfills NULL-size non-terminal tasks with size + source.jobSize=auto + boot_sweep history', async () => {
    const { openIds } = await seed();

    const app = await createApp(dbPath);
    apps.push(app);

    const history = new WsjfHistoryRepository(app.db);

    // Expected deterministic tiers from minutesToTier.
    const expectedTier: Record<number, number> = {
      [openIds[0]]: 1,
      [openIds[1]]: 3,
      [openIds[2]]: 5,
      [openIds[3]]: 3,
      [openIds[4]]: 8,
    };

    for (const id of openIds) {
      const task = app.taskService.getTask(id);
      expect(task.wsjf_job_size).toBe(expectedTier[id]);
      expect(task.wsjf_source?.jobSize).toBe('auto');

      const rows = history.findByTaskId(id);
      const sweepRows = rows.filter((r) => r.trigger === 'boot_sweep');
      expect(sweepRows).toHaveLength(1);
      expect(sweepRows[0].job_size).toBe(expectedTier[id]);
      // Size-only row: the three CoD components stay NULL.
      expect(sweepRows[0].value).toBeNull();
      expect(sweepRows[0].time_criticality).toBeNull();
      expect(sweepRows[0].risk_opportunity).toBeNull();
    }
  });

  it('AC2: a second createApp on the same db writes zero rows and zero history (idempotent)', async () => {
    const { openIds } = await seed();

    const first = await createApp(dbPath);
    apps.push(first);
    const historyAfterFirst = new WsjfHistoryRepository(first.db);
    const counts1 = openIds.map((id) => historyAfterFirst.findByTaskId(id).length);
    const sizes1 = openIds.map((id) => first.taskService.getTask(id).wsjf_job_size);
    first.dispose();
    apps.pop();

    const second = await createApp(dbPath);
    apps.push(second);
    const historyAfterSecond = new WsjfHistoryRepository(second.db);
    const counts2 = openIds.map((id) => historyAfterSecond.findByTaskId(id).length);
    const sizes2 = openIds.map((id) => second.taskService.getTask(id).wsjf_job_size);

    // Idempotence: no NEW history rows and identical sizes after the 2nd boot.
    expect(counts2).toEqual(counts1);
    expect(sizes2).toEqual(sizes1);
  });

  it('AC3: done/closed tasks with NULL size are skipped', async () => {
    const { doneId, closedId } = await seed();

    const app = await createApp(dbPath);
    apps.push(app);

    const done = app.taskService.getTask(doneId);
    const closed = app.taskService.getTask(closedId);
    expect(done.wsjf_job_size).toBeNull();
    expect(closed.wsjf_job_size).toBeNull();

    const history = new WsjfHistoryRepository(app.db);
    expect(history.findByTaskId(doneId)).toHaveLength(0);
    expect(history.findByTaskId(closedId)).toHaveLength(0);
  });

  it('AC4: a forced mid-sweep failure on one row leaves previously committed rows intact', async () => {
    const { openIds } = await seed();

    // Re-open the seeded db and drive the sweep helper directly with a
    // TaskService stub whose autoSizeTask throws on the SECOND row only. The
    // helper's per-row try/catch + the per-row transaction inside the real
    // autoSizeTask guarantee rows committed BEFORE the failure survive.
    const db = initDatabase(dbPath);
    await runMigrations(db);
    const projectRepo = new ProjectRepository(db);
    const taskRepo = new TaskRepository(db);
    const historyRepo = new WsjfHistoryRepository(db);

    // Real service for the commit machinery; we wrap autoSizeTask to inject a
    // failure on the boomId so the surrounding rows still commit for real.
    const { TaskService } = await import('../../services/task.service.js');
    const service = new TaskService(taskRepo, projectRepo, db, historyRepo);
    const boomId = openIds[2];
    const original = service.autoSizeTask.bind(service);
    service.autoSizeTask = ((args: Parameters<typeof original>[0]) => {
      if (args.taskId === boomId) {
        throw new Error('forced mid-sweep failure');
      }
      return original(args);
    }) as typeof service.autoSizeTask;

    // Spy on console.error — both per-row failures and the summary use stderr.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = backfillJobSizes(service, taskRepo);

    expect(result.failed).toBe(1);
    expect(result.swept).toBe(openIds.length - 1);
    expect(result.skipped).toBe(0);

    // Parse all JSON lines captured on stderr.
    const parsedLines = errorSpy.mock.calls
      .map((args) => {
        try {
          return JSON.parse(args[0] as string);
        } catch {
          return null;
        }
      })
      .filter((obj) => obj !== null);

    // (a) The failing row's task id + error message were logged via console.error.
    const errorLines = parsedLines.filter((obj) => obj.msg === 'job_size_backfill.row_failed');
    expect(errorLines).toHaveLength(1);
    expect(errorLines[0]).toMatchObject({
      level: 'error',
      msg: 'job_size_backfill.row_failed',
      taskId: boomId,
      err: 'forced mid-sweep failure',
    });

    // (b) The sweep continued — other rows were swept (asserted via return value
    //     and db state below).

    // (c) Summary line reports correct swept/skipped/failed counts.
    const summaryLines = parsedLines.filter((obj) => obj.msg === 'job_size_backfill.complete');
    expect(summaryLines).toHaveLength(1);
    expect(summaryLines[0]).toMatchObject({
      level: 'info',
      msg: 'job_size_backfill.complete',
      swept: openIds.length - 1,
      skipped: 0,
      failed: 1,
    });

    errorSpy.mockRestore();

    // The non-failing rows committed; the failing row is still NULL — and the
    // commits did NOT roll back (per-row transaction).
    for (const id of openIds) {
      const task = taskRepo.findById(id);
      if (id === boomId) {
        expect(task?.wsjf_job_size).toBeNull();
        expect(historyRepo.findByTaskId(id)).toHaveLength(0);
      } else {
        expect(task?.wsjf_job_size).not.toBeNull();
        expect(historyRepo.findByTaskId(id)).toHaveLength(1);
      }
    }

    db.close();
  });
});
