import { Command } from 'commander';
import Database from '../../db/driver.js';
import { colorBold } from '../output/formatters.js';
import { jsonOutput } from '../output/json-output.js';
import '../config/env.js';

interface StatusRow {
  status: string;
  count: number;
}

interface CountRow {
  count: number;
}

interface AgentRow {
  assignee: string;
  task_count: number;
  completed: number;
  in_progress: number;
}

export const statsCommand = new Command('stats')
  .description('Show task statistics: status counts, recent activity, and agent productivity')
  .action(() => {
    const dbPath = process.env.DATABASE_PATH || './data/tasks.db';

    const program = statsCommand.parent;
    const isJsonMode = program?.optsWithGlobals()?.json || false;

    const db = new Database(dbPath, { readonly: true });

    try {
      // Query 1: Task counts by status
      const statusRows = db
        .prepare<[], StatusRow>(
          'SELECT status, COUNT(*) as count FROM tasks GROUP BY status ORDER BY status',
        )
        .all();

      const total = statusRows.reduce((sum, row) => sum + row.count, 0);

      // Query 2a: Created in last 24h
      const createdRow = db
        .prepare<[], CountRow>(
          "SELECT COUNT(*) as count FROM tasks WHERE created_at >= datetime('now', '-24 hours')",
        )
        .get();

      // Query 2b: Updated in last 24h
      const updatedRow = db
        .prepare<[], CountRow>(
          "SELECT COUNT(*) as count FROM tasks WHERE updated_at >= datetime('now', '-24 hours')",
        )
        .get();

      const created = createdRow?.count ?? 0;
      const updated = updatedRow?.count ?? 0;

      // Query 3: Agent productivity (last 7 days)
      const agentRows = db
        .prepare<[], AgentRow>(
          `SELECT assignee,
                  COUNT(*) as task_count,
                  SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as completed,
                  SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress
           FROM tasks
           WHERE assignee IS NOT NULL
             AND updated_at >= datetime('now', '-7 days')
           GROUP BY assignee
           ORDER BY task_count DESC`,
        )
        .all();

      if (isJsonMode) {
        jsonOutput({
          statusCounts: statusRows,
          recentActivity: { created, updated },
          agentProductivity: agentRows,
        });
        return;
      }

      // --- Normal text output ---
      if (total === 0) {
        console.log('No tasks found.');
        return;
      }

      // Right-align counts: find widest count for padding
      const maxCountWidth = Math.max(
        ...statusRows.map((r) => String(r.count).length),
        String(total).length,
      );

      console.log(colorBold('Task Counts by Status:'));
      for (const row of statusRows) {
        const paddedCount = String(row.count).padStart(maxCountWidth);
        console.log(`  ${row.status.padEnd(12)} ${paddedCount}`);
      }
      console.log(`  ${'Total'.padEnd(12)} ${String(total).padStart(maxCountWidth)}`);

      console.log('');
      console.log(colorBold('Recent Activity (24h):'));
      console.log(`  Created:  ${created}`);
      console.log(`  Updated:  ${updated}`);

      console.log('');
      console.log(colorBold('Agent Productivity (7 days):'));
      if (agentRows.length === 0) {
        console.log('  No agent activity in the last 7 days.');
      } else {
        for (const row of agentRows) {
          console.log(
            `  ${row.assignee.padEnd(12)} ${row.task_count} tasks (${row.completed} done, ${row.in_progress} in progress)`,
          );
        }
      }
    } finally {
      db.close();
    }
  });
