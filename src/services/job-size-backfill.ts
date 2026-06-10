import type { ITaskRepository } from '../repositories/interfaces.js';
import type { TaskService } from './task.service.js';
import { minutesToTier } from './wsjf.service.js';

/**
 * Guaranteed-task-sizing (#992, design spec §5): the idempotent boot sweep.
 *
 * Runs once at server boot (wired into `createApp` immediately after
 * `seedIdentities`) and backfills `wsjf_job_size` for every task the model
 * router cares about that the migration era left sizeless. For each task with
 * a NULL `wsjf_job_size` whose status is NOT terminal ({done,closed} excluded),
 * it computes the tier deterministically — `minutesToTier(estimated_minutes)`,
 * which already maps a missing estimate to the §3 residual tier 3 — and writes
 * it through `TaskService.autoSizeTask` with `trigger:'boot_sweep'`. The first
 * boot after deploy backfills the live production backlog that is mis-routing
 * models today; subsequent boots catch rows written by older binaries or
 * direct-SQLite writers.
 *
 * Invariants:
 *   - ONE `db.transaction` per row (the `autoSizeTask` helper already wraps the
 *     column write + the `boot_sweep` history append in a single transaction),
 *     so a mid-sweep failure on one row NEVER rolls back rows already committed.
 *   - Idempotent: after a successful sweep every candidate now carries a size,
 *     so `findIdsWithNullJobSize()` returns `[]` on the next boot and the sweep
 *     writes zero rows and zero history entries.
 *   - Per-row errors are log-and-continue: a single bad row must not block the
 *     server from coming up, nor abort the remaining backfill.
 *   - A single summary log line emitted after the loop reports swept/skipped/
 *     failed counts for operator observability (task #998).
 *
 * @param taskService the size-only writer (`autoSizeTask`) and its wired audit
 *                     hook. The boot wiring passes the same instance the app
 *                     exposes, so the `boot_sweep` history rows are appended.
 * @param taskRepo    the candidate scanner (`findIdsWithNullJobSize`). Shares
 *                     the same `db` handle as `taskService`.
 * @returns `{ swept, skipped, failed }` counts — `swept` is rows successfully
 *          sized, `skipped` is always 0 (done/closed are pre-filtered by the
 *          repository query), `failed` is rows whose per-row write threw and
 *          was logged-and-continued.
 */
export function backfillJobSizes(
  taskService: TaskService,
  taskRepo: ITaskRepository,
): { swept: number; skipped: number; failed: number } {
  const candidates = taskRepo.findIdsWithNullJobSize();
  let swept = 0;
  const skipped = 0;
  let failed = 0;

  for (const candidate of candidates) {
    try {
      taskService.autoSizeTask({
        taskId: candidate.id,
        jobSize: minutesToTier(candidate.estimated_minutes),
        trigger: 'boot_sweep',
      });
      swept += 1;
    } catch (err) {
      // Per-row log-and-continue. The single-row transaction in autoSizeTask
      // already committed (or rolled back) only THIS row, so previously swept
      // rows are intact. We surface the failure on stderr in the boot-log JSON
      // shape (level/msg) so an operator can find the offending id, then move
      // on — one bad row must never block serve.
      failed += 1;
      console.error(
        JSON.stringify({
          level: 'error',
          msg: 'job_size_backfill.row_failed',
          taskId: candidate.id,
          err: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  // Summary line — one entry per boot sweep so operators can gauge backlog debt
  // and catch repeated failures without trawling per-row entries (#998).
  // Uses console.error (stderr) so it lands in the same boot-log stream as the
  // per-row failure entries above; `level` differentiates the two in log
  // aggregators. (biome noConsole only allows error/warn in services/.)
  console.error(
    JSON.stringify({
      level: 'info',
      msg: 'job_size_backfill.complete',
      swept,
      skipped,
      failed,
    }),
  );

  return { swept, skipped, failed };
}
