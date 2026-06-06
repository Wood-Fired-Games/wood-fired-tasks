import { Command } from 'commander';
import Database from '../../db/driver.js';
import Table from 'cli-table3';
import chalk from 'chalk';
import { TaskRepository } from '../../repositories/task.repository.js';
import { ProjectRepository } from '../../repositories/project.repository.js';
import { TaskService } from '../../services/task.service.js';
import {
  colorBold,
  colorInfo,
  colorWarn,
  formatPriority,
  shouldUseColor,
} from '../output/formatters.js';
import { jsonOutput } from '../output/json-output.js';
import { handleError } from '../output/error-handler.js';
import '../config/env.js';

interface CommandOptions {
  days?: string;
  since?: string;
  until?: string;
  project?: string;
  assignee?: string;
}

/**
 * Dashboard view of tasks completed inside a user-specified interval.
 *
 * Resolves task 97: lists tasks that transitioned to status='done' within
 * the requested range, with aggregates by project, assignee, priority, and
 * daily throughput.
 */
export const completedCommand = new Command('completed')
  .description('Dashboard: tasks completed within a time interval')
  .option('-d, --days <n>', 'Trailing N days from now (default: 7 if no range supplied)')
  .option('--since <date>', 'Range start (ISO8601, inclusive)')
  .option('--until <date>', 'Range end (ISO8601, inclusive)')
  .option('-p, --project <id>', 'Filter by project ID')
  .option('-a, --assignee <name>', 'Filter by assignee')
  .action((options: CommandOptions) => {
    const dbPath = process.env.DATABASE_PATH || './data/tasks.db';

    const program = completedCommand.parent;
    const isJsonMode = program?.optsWithGlobals()?.json || false;

    const db = new Database(dbPath, { readonly: true });
    try {
      const reportInput = buildReportInput(options);

      const taskRepo = new TaskRepository(db);
      const projectRepo = new ProjectRepository(db);
      const taskService = new TaskService(taskRepo, projectRepo);

      const report = taskService.getCompletionReport(reportInput);

      if (isJsonMode) {
        jsonOutput(report, {
          count: report.total,
        });
        return;
      }

      renderReport(report, projectRepo);
    } catch (error) {
      handleError(error);
    } finally {
      db.close();
    }
  });

function buildReportInput(options: CommandOptions): Record<string, unknown> {
  const hasExplicitRange = options.since !== undefined && options.until !== undefined;
  const hasPartialRange = !hasExplicitRange && (options.since || options.until);

  if (hasPartialRange) {
    throw new Error(
      'Provide both --since and --until together, or use --days for a trailing window',
    );
  }

  const input: Record<string, unknown> = {};

  if (hasExplicitRange) {
    input.start = options.since!;
    input.end = options.until!;
  } else if (options.days !== undefined) {
    const days = Number(options.days);
    if (!Number.isFinite(days) || days < 1) {
      throw new Error('--days must be a positive integer');
    }
    input.days = days;
  } else {
    input.days = 7;
  }

  if (options.project !== undefined) {
    const projectId = Number(options.project);
    if (!Number.isInteger(projectId) || projectId <= 0) {
      throw new Error('--project must be a positive integer');
    }
    input.project_id = projectId;
  }

  if (options.assignee !== undefined) {
    input.assignee = options.assignee;
  }

  return input;
}

function renderReport(
  report: ReturnType<TaskService['getCompletionReport']>,
  projectRepo: ProjectRepository,
): void {
  const useColor = shouldUseColor();
  const bold = (s: string) => (useColor ? chalk.bold(s) : s);

  console.log(colorBold('Completion Report'));
  console.log(colorInfo(`  Range:  ${report.range.start}  ->  ${report.range.end}`));
  console.log(colorInfo(`  Total:  ${report.total} task(s) completed`));
  console.log('');

  if (report.total === 0) {
    console.log(colorWarn('No completed tasks in this interval.'));
    return;
  }

  // Resolve project names once for table display.
  const projectNames = new Map<number, string>();
  for (const row of report.by_project) {
    const proj = projectRepo.findById(row.project_id);
    if (proj) projectNames.set(row.project_id, proj.name);
  }

  // Per-task table.
  const taskTable = new Table({
    head: [
      bold('ID'),
      bold('Title'),
      bold('Project'),
      bold('Assignee'),
      bold('Priority'),
      bold('Completed'),
      bold('Time to complete'),
    ],
    style: { head: [], border: useColor ? ['gray'] : [] },
    wordWrap: true,
  });

  for (const row of report.rows) {
    const title = row.title.length > 40 ? row.title.slice(0, 37) + '...' : row.title;
    taskTable.push([
      row.id,
      title,
      projectNames.get(row.project_id) ?? String(row.project_id),
      row.assignee ?? '-',
      formatPriority(row.priority),
      new Date(row.completed_at).toLocaleString(),
      formatDuration(row.time_to_complete_seconds),
    ]);
  }
  console.log(taskTable.toString());
  console.log('');

  console.log(bold('By project:'));
  for (const row of report.by_project) {
    const name = projectNames.get(row.project_id) ?? `project ${row.project_id}`;
    console.log(`  ${name.padEnd(30)} ${row.count}`);
  }
  console.log('');

  console.log(bold('By assignee:'));
  for (const row of report.by_assignee) {
    console.log(`  ${row.assignee.padEnd(30)} ${row.count}`);
  }
  console.log('');

  console.log(bold('By priority:'));
  for (const row of report.by_priority) {
    console.log(`  ${formatPriority(row.priority).padEnd(30)} ${row.count}`);
  }
  console.log('');

  console.log(bold('Daily throughput:'));
  for (const row of report.daily_throughput) {
    const bar = '#'.repeat(Math.min(row.count, 40));
    console.log(`  ${row.date}  ${String(row.count).padStart(3)}  ${bar}`);
  }
}

function formatDuration(seconds: number): string {
  if (seconds <= 0) return '-';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 && days === 0) parts.push(`${minutes}m`);
  return parts.join(' ') || '<1m';
}
