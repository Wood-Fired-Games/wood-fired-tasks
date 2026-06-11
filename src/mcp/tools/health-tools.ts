import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toStructuredContent } from '../lib/structured-content.js';
import type { Database } from '../../db/driver.js';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { VERSION } from '../../utils/version.js';
import type { HealthFinding } from '../../services/wsjf-health.service.js';

/**
 * Task #1004: lint for the edge-less blocked dead end. A task in status
 * `blocked` with NO blocking dependency edge can never auto-unblock — the
 * workflow engine's blocked→open `source=workflow` transition only fires when
 * a blocking edge is satisfied/removed. The merge-queue-bounce incident left a
 * task in exactly that state (status flipped, defect task filed, edge never
 * added) until an operator hand-wired `dep-add`. Surface every such task as a
 * warning so operators see the dead end before it strands work.
 *
 * Finding shape reuses the {@link HealthFinding} style from the WSJF health
 * linter (`check` / `severity` / `message` / `suggestion` / `taskIds`).
 */
export function findBlockedWithoutEdge(db: Database): HealthFinding[] {
  const rows = db
    .prepare(
      `SELECT t.id FROM tasks t
       WHERE t.status = 'blocked'
         AND NOT EXISTS (
           SELECT 1 FROM task_dependencies d WHERE d.blocks_task_id = t.id
         )
       ORDER BY t.id`,
    )
    .all() as Array<{ id: number }>;
  if (rows.length === 0) return [];
  const taskIds = rows.map((r) => r.id);
  return [
    {
      check: 'blocked-without-edge',
      severity: 'warning',
      message:
        `${taskIds.length} task(s) are in status 'blocked' with NO blocking ` +
        `dependency edge. The blocked→open auto-unblock only fires off an edge, ` +
        `so these tasks are a dead end — nothing will ever unblock them.`,
      suggestion:
        'Add the missing edge(s) (`dep-add <blocker> <blocked>` / `add_dependency`), or ' +
        "re-block atomically via `update_task` with `status: 'blocked'` + " +
        '`blocked_by: [taskIds]` so the edge and the status commit together. ' +
        "If a task is not actually waiting on another task, move it back to 'open'.",
      taskIds,
    },
  ];
}

/**
 * Register health check MCP tool
 *
 * Provides service health monitoring capabilities:
 * - check_health: Check service health status, database connectivity, and version information
 */
export function registerHealthTools(server: McpServer, db: Database): void {
  // Tool: check_health
  server.registerTool(
    'check_health',
    {
      description: 'Check service health status, database connectivity, and version information',
      inputSchema: z.object({}),
    },
    async () => {
      const traceId = randomUUID();
      const timestamp = new Date().toISOString();
      const version = VERSION;
      console.error(
        JSON.stringify({ level: 'info', traceId, tool: 'check_health', event: 'start', timestamp }),
      );

      try {
        // Test database connectivity
        db.prepare('SELECT 1').get();

        // Fingerprint: which DB file this process opened + cheap counts, so a
        // wrong/stale DB is obvious at a glance (the signal that was missing
        // during the 2026-05-25 incident).
        const projectRow = db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number };
        const maxIdRow = db.prepare('SELECT MAX(id) AS m FROM tasks').get() as { m: number | null };
        const latestRow = db.prepare('SELECT MAX(updated_at) AS t FROM tasks').get() as {
          t: string | null;
        };
        const database = {
          path: db.name,
          projects: projectRow.n,
          maxTaskId: maxIdRow.m ?? null,
          latestActivity: latestRow.t ?? null,
        };

        // Task #1004: severity-tagged lint findings (currently one check —
        // blocked tasks with zero blocking edges). Empty array ⇔ no findings.
        const findings = findBlockedWithoutEdge(db);
        const findingsLine =
          findings.length === 0
            ? ''
            : `\nFindings: ${findings
                .map((f) => `[${f.severity}] ${f.check}: tasks ${f.taskIds.join(', ')}`)
                .join('; ')}`;

        console.error(
          JSON.stringify({ level: 'info', traceId, tool: 'check_health', event: 'success' }),
        );
        return {
          content: [
            {
              type: 'text',
              text: `Service Status: healthy\nVersion: ${version}\nDatabase: ok\nTimestamp: ${timestamp}\nDB Path: ${database.path}\nProjects: ${database.projects}, Max Task ID: ${database.maxTaskId ?? 'none'}, Latest Activity: ${database.latestActivity ?? 'none'}${findingsLine}`,
            },
          ],
          structuredContent: toStructuredContent({
            status: 'healthy',
            timestamp,
            version,
            database,
            checks: {
              database: 'ok',
            },
            findings,
          }),
        };
      } catch (error) {
        // Database check failed - log error but return unhealthy status
        console.error(
          JSON.stringify({
            level: 'error',
            traceId,
            tool: 'check_health',
            event: 'error',
            error: error instanceof Error ? error.message : String(error),
          }),
        );

        return {
          content: [
            {
              type: 'text',
              text: `Service Status: unhealthy\nVersion: ${version}\nDatabase: failed\nTimestamp: ${timestamp}`,
            },
          ],
          structuredContent: toStructuredContent({
            status: 'unhealthy',
            timestamp,
            version,
            database: {
              path: db.name,
              projects: 0,
              maxTaskId: null,
              latestActivity: null,
            },
            checks: {
              database: 'failed',
            },
            // Shape stability: the lint cannot run without the DB, so the
            // unhealthy payload carries an explicitly-empty findings list.
            findings: [],
          }),
        };
      }
    },
  );
}
