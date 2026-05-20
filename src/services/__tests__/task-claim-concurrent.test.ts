/**
 * Real-concurrency regression for atomic task claim.
 *
 * Source: reports/open-source-audit-2026-05-20/tests.md HIGH #2 (task 200).
 *
 * Why this exists in addition to `task-claim.test.ts` "concurrent claims (serial
 * simulation)":
 *   - The existing test claims twice on a single in-memory connection. SQLite
 *     `:memory:` databases use a single connection and skip WAL/file-lock paths,
 *     so the production `BEGIN IMMEDIATE` write-lock contention never fires.
 *   - This test opens an on-disk SQLite file shared by N (>= 20) independent
 *     `Database` connections (each with its own repo + service instances) and
 *     races them through `Promise.all`. That is the only configuration where
 *     the CAS + `BEGIN IMMEDIATE` + `busy_timeout = 5000` interplay is exercised
 *     end-to-end.
 *   - The invariant (exactly ONE claimant succeeds, the rest throw
 *     `BusinessError`) is wrapped in a `@fast-check/vitest` property over both
 *     N (claimants) and M (tasks) so a shrinker can find the smallest counter-
 *     example if the contract ever regresses.
 */

import { describe, expect, afterEach, beforeEach } from 'vitest';
import { test, fc } from '@fast-check/vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { initDatabase } from '../../db/database.js';
import { runMigrations } from '../../db/migrate.js';
import { ProjectRepository } from '../../repositories/project.repository.js';
import { TaskRepository } from '../../repositories/task.repository.js';
import { ProjectService } from '../project.service.js';
import { TaskService } from '../task.service.js';
import { BusinessError } from '../errors.js';

interface ClaimantHandle {
  db: Database.Database;
  taskService: TaskService;
}

/**
 * Build N independent claimants — each with its own `better-sqlite3`
 * connection to the same on-disk file. Each connection runs through
 * `initDatabase` so it inherits the same WAL + busy_timeout pragmas the
 * production code uses.
 */
function buildClaimants(dbPath: string, n: number): ClaimantHandle[] {
  const handles: ClaimantHandle[] = [];
  for (let i = 0; i < n; i++) {
    const db = initDatabase(dbPath);
    const projectRepo = new ProjectRepository(db);
    const taskRepo = new TaskRepository(db);
    const taskService = new TaskService(taskRepo, projectRepo);
    handles.push({ db, taskService });
  }
  return handles;
}

function closeClaimants(handles: ClaimantHandle[]): void {
  for (const h of handles) {
    try {
      h.db.close();
    } catch {
      // ignore — already closed or never opened
    }
  }
}

describe('TaskService - real-concurrency claim race (disk-backed SQLite)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'wfb-claim-race-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Property: for any N claimants (>= 20) racing for ONE task on a disk-backed
   * database, EXACTLY ONE wins and the rest fail with `BusinessError`. Repeated
   * for M independent tasks in the same database to amortize setup cost and
   * surface any cross-row interference.
   */
  test.prop(
    {
      // numRuns deliberately small — each property iteration spins up a fresh
      // on-disk SQLite file, N connections, and races them. Cost adds up fast.
      n: fc.integer({ min: 20, max: 32 }),
      taskCount: fc.integer({ min: 1, max: 3 }),
    },
    { numRuns: 5 }
  )(
    'exactly one of N parallel claimants wins per task (property)',
    async ({ n, taskCount }) => {
      const dbPath = join(tmpDir, `race-${n}-${taskCount}-${Date.now()}.db`);

      // ---- setup: seed a project + `taskCount` open tasks via a setup conn ----
      const setupDb = initDatabase(dbPath);
      try {
        await runMigrations(setupDb);
        const projectRepo = new ProjectRepository(setupDb);
        const taskRepo = new TaskRepository(setupDb);
        const projectService = new ProjectService(projectRepo);
        const taskService = new TaskService(taskRepo, projectRepo);

        const project = projectService.createProject({
          name: `race-${n}-${taskCount}`,
          description: 'parallel claim race',
        });

        const taskIds: number[] = [];
        for (let i = 0; i < taskCount; i++) {
          const t = taskService.createTask({
            title: `race-task-${i}`,
            project_id: project.id,
            created_by: 'race-test',
          });
          taskIds.push(t.id);
        }

        // ---- race: N claimants per task ----
        const claimants = buildClaimants(dbPath, n);
        try {
          for (const taskId of taskIds) {
            // Each claimant: own connection, own service, attempts the SAME task.
            // Wrapped in async so Promise.all dispatches them onto the
            // microtask queue together. With N separate connections to the
            // SAME on-disk file, the BEGIN IMMEDIATE write-lock and version
            // CAS path arbitrates the winner — NOT JS-level mutex.
            const attempts = claimants.map((c, idx) =>
              (async () => {
                // yield once so every claimant is scheduled before any runs
                await Promise.resolve();
                return c.taskService.claimTask(taskId, `agent-${idx}`);
              })()
            );

            const results = await Promise.allSettled(attempts);

            const successes = results.filter((r) => r.status === 'fulfilled');
            const failures = results.filter((r) => r.status === 'rejected');

            // Core invariant: EXACTLY ONE winner.
            expect(successes).toHaveLength(1);
            expect(failures).toHaveLength(n - 1);

            // Every failure must be a BusinessError — anything else (SQLITE_BUSY,
            // TypeError, etc.) indicates the lock/CAS contract leaked.
            for (const f of failures) {
              const reason = (f as PromiseRejectedResult).reason;
              expect(reason).toBeInstanceOf(BusinessError);
            }

            // Winner's row matches the post-condition: in_progress + assignee set.
            const winner = (successes[0] as PromiseFulfilledResult<any>).value;
            expect(winner.status).toBe('in_progress');
            expect(winner.assignee).toMatch(/^agent-\d+$/);
            expect(winner.version).toBe(2); // started at 1, CAS bumped to 2
          }
        } finally {
          closeClaimants(claimants);
        }
      } finally {
        setupDb.close();
      }
    }
  );

  /**
   * Deterministic spot-check at a fixed high fan-out, so the file always
   * exercises the >= 20 boundary even if a future shrinker run happens to
   * pick all minimums. Mirrors the property body but with N pinned.
   */
  test('deterministic: 25 parallel claimants → 1 success, 24 BusinessErrors', async () => {
    const dbPath = join(tmpDir, 'race-fixed-25.db');
    const setupDb = initDatabase(dbPath);
    try {
      await runMigrations(setupDb);
      const projectRepo = new ProjectRepository(setupDb);
      const taskRepo = new TaskRepository(setupDb);
      const projectService = new ProjectService(projectRepo);
      const taskService = new TaskService(taskRepo, projectRepo);

      const project = projectService.createProject({
        name: 'fixed-race',
        description: 'pinned fan-out race',
      });
      const task = taskService.createTask({
        title: 'pinned-race-task',
        project_id: project.id,
        created_by: 'race-test',
      });

      const N = 25;
      const claimants = buildClaimants(dbPath, N);
      try {
        const attempts = claimants.map((c, idx) =>
          (async () => {
            await Promise.resolve();
            return c.taskService.claimTask(task.id, `agent-${idx}`);
          })()
        );

        const results = await Promise.allSettled(attempts);
        const successes = results.filter((r) => r.status === 'fulfilled');
        const failures = results.filter((r) => r.status === 'rejected');

        expect(successes).toHaveLength(1);
        expect(failures).toHaveLength(N - 1);
        for (const f of failures) {
          expect((f as PromiseRejectedResult).reason).toBeInstanceOf(
            BusinessError
          );
        }
      } finally {
        closeClaimants(claimants);
      }
    } finally {
      setupDb.close();
    }
  });
});
