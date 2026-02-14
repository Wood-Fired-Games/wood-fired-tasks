import type Database from 'better-sqlite3';
import { eventBus } from '../events/event-bus.js';
import type { Task } from '../types/task.js';

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
    private timeoutMinutes: number = 30
  ) {}

  /**
   * Find all claimed tasks with no activity past the timeout.
   * "No activity" = claimed_at is older than timeoutMinutes AND updated_at is also older.
   * This way, any update/comment activity resets the clock via updated_at.
   */
  findStaleClaims(): Array<{ id: number; assignee: string; claimed_at: string }> {
    const cutoff = `-${this.timeoutMinutes} minutes`;
    return this.db.prepare(
      `SELECT id, assignee, claimed_at FROM tasks
       WHERE assignee IS NOT NULL
         AND claimed_at IS NOT NULL
         AND claimed_at <= datetime('now', ?)
         AND updated_at <= datetime('now', ?)`
    ).all(cutoff, cutoff) as Array<{ id: number; assignee: string; claimed_at: string }>;
  }

  /**
   * Release a stale claim: set assignee to NULL, status to 'open',
   * clear claimed_at, increment version.
   */
  releaseClaim(taskId: number): boolean {
    const info = this.db.prepare(
      `UPDATE tasks
       SET assignee = NULL, status = 'open', claimed_at = NULL,
           version = version + 1, updated_at = datetime('now')
       WHERE id = ? AND assignee IS NOT NULL`
    ).run(taskId);
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
        const task = this.db.prepare(
          `SELECT t.*, GROUP_CONCAT(tt.tag, ',') as tags_csv
           FROM tasks t
           LEFT JOIN task_tags tt ON tt.task_id = t.id
           WHERE t.id = ?
           GROUP BY t.id`
        ).get(claim.id) as (Task & { tags_csv: string | null }) | undefined;
        if (task) {
          const { tags_csv, ...taskData } = task;
          const tags = tags_csv ? tags_csv.split(',').sort() : [];
          eventBus.emit('task.updated', {
            eventType: 'task.updated',
            timestamp: new Date().toISOString(),
            data: { ...taskData, tags },
            metadata: { source: 'workflow' }
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
