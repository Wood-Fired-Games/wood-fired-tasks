import type Database from '../db/driver.js';
import { eventBus } from '../events/event-bus.js';
import type { Task } from '../types/task.js';

/**
 * Default claim TTL in minutes. A claimed `in_progress` task with no
 * activity (no `updated_at` change AND no `claimed_at` refresh) for this
 * long is auto-released back to `open` by the sweep.
 *
 * Task #1003: exported so the task read path (TaskService.getTask) can
 * surface the TTL + remaining seconds to `get_task` consumers, and so the
 * holder knows the renewal cadence (re-claim with the same assignee before
 * this window elapses to extend the claim).
 */
export const DEFAULT_CLAIM_TTL_MINUTES = 30;

/**
 * ClaimReleaseService - auto-releases stale task claims after a configurable timeout.
 *
 * Tasks that have been claimed but show no activity (no updated_at changes)
 * for longer than the timeout are considered stale and are automatically
 * released back to 'open' status with no assignee.
 */
export class ClaimReleaseService {
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  constructor(
    private db: Database.Database,
    private timeoutMinutes: number = DEFAULT_CLAIM_TTL_MINUTES,
  ) {}

  /**
   * Find all claimed tasks with no activity past the timeout.
   * "No activity" = claimed_at is older than timeoutMinutes AND updated_at is also older.
   * This way, any update/comment activity resets the clock via updated_at.
   */
  findStaleClaims(): Array<{ id: number; assignee: string; claimed_at: string }> {
    const cutoff = `-${this.timeoutMinutes} minutes`;
    return this.db
      .prepare(
        `SELECT id, assignee, claimed_at FROM tasks
       WHERE assignee IS NOT NULL
         AND claimed_at IS NOT NULL
         AND status = 'in_progress'
         AND claimed_at <= datetime('now', ?)
         AND updated_at <= datetime('now', ?)`,
      )
      .all(cutoff, cutoff) as Array<{ id: number; assignee: string; claimed_at: string }>;
  }

  /**
   * Release a stale claim: set assignee to NULL, status to 'open',
   * clear claimed_at, increment version.
   */
  releaseClaim(taskId: number): boolean {
    const info = this.db
      .prepare(
        `UPDATE tasks
       SET assignee = NULL, status = 'open', claimed_at = NULL,
           version = version + 1, updated_at = datetime('now')
       WHERE id = ? AND assignee IS NOT NULL AND status = 'in_progress'`,
      )
      .run(taskId);
    return info.changes > 0;
  }

  /**
   * Sweep: find and release all stale claims.
   * Returns count of released claims.
   */
  sweep(): number {
    const stale = this.findStaleClaims();
    let released = 0;
    for (const claim of stale) {
      if (this.releaseClaim(claim.id)) {
        // Reload task for event payload
        const task = this.db
          .prepare(
            `SELECT t.*, GROUP_CONCAT(tt.tag, ',') as tags_csv
           FROM tasks t
           LEFT JOIN task_tags tt ON tt.task_id = t.id
           WHERE t.id = ?
           GROUP BY t.id`,
          )
          .get(claim.id) as (Task & { tags_csv: string | null }) | undefined;
        if (task) {
          const { tags_csv, ...taskData } = task;
          const tags = tags_csv ? tags_csv.split(',').sort() : [];
          const releasedAt = new Date().toISOString();
          eventBus.emit('task.updated', {
            eventType: 'task.updated',
            timestamp: releasedAt,
            data: { ...taskData, tags },
            metadata: { source: 'workflow' },
          });
          // Task #1003: dedicated TTL-expiry event so the former holder and
          // wft-router rules can distinguish "my claim lapsed" from a generic
          // update. SSE-visible via the same eventBus → SSEManager relay as
          // task.status_changed (see src/api/server.ts) and filterable with
          // `event_types=task.claim_released`.
          eventBus.emit('task.claim_released', {
            eventType: 'task.claim_released',
            timestamp: releasedAt,
            data: {
              ...taskData,
              tags,
              previous_assignee: claim.assignee,
              expired_claimed_at: claim.claimed_at,
              released_at: releasedAt,
            },
            metadata: { source: 'workflow' },
          });
        }
        released++;
      }
    }
    return released;
  }

  /**
   * Start periodic sweep (default: every 5 minutes).
   */
  start(intervalMs: number = 5 * 60 * 1000): void {
    if (this.intervalHandle) return;
    this.intervalHandle = setInterval(() => this.sweep(), intervalMs);
  }

  /**
   * Stop periodic sweep.
   */
  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }
}
