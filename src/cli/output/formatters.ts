import Table from 'cli-table3';
import chalk from 'chalk';
import type { TaskResponse } from '../api/types.js';

/**
 * Color-code task status values.
 */
export function formatStatus(status: string): string {
  switch (status) {
    case 'open':
      return chalk.blue(status);
    case 'in_progress':
      return chalk.yellow(status);
    case 'done':
      return chalk.green(status);
    case 'closed':
      return chalk.gray(status);
    case 'blocked':
      return chalk.red(status);
    default:
      return chalk.white(status);
  }
}

/**
 * Color-code task priority values.
 */
export function formatPriority(priority: string): string {
  switch (priority) {
    case 'urgent':
      return chalk.red.bold(priority);
    case 'high':
      return chalk.red(priority);
    case 'medium':
      return chalk.yellow(priority);
    case 'low':
      return chalk.gray(priority);
    default:
      return chalk.white(priority);
  }
}

/**
 * Format a list of tasks as a table.
 */
export function formatTaskTable(tasks: TaskResponse[]): string {
  const table = new Table({
    head: [
      chalk.bold('ID'),
      chalk.bold('Title'),
      chalk.bold('Status'),
      chalk.bold('Priority'),
      chalk.bold('Assignee'),
      chalk.bold('Due Date'),
    ],
    style: {
      head: [], // Disable cli-table3 default head colors (we use chalk instead)
      border: ['gray'],
    },
    wordWrap: true,
  });

  for (const task of tasks) {
    // Truncate title to 45 chars with ellipsis if needed
    const title = task.title.length > 45 ? task.title.slice(0, 42) + '...' : task.title;

    table.push([
      task.id,
      title,
      formatStatus(task.status),
      formatPriority(task.priority),
      task.assignee || '-',
      task.due_date ? new Date(task.due_date).toLocaleDateString() : '-',
    ]);
  }

  return table.toString();
}

/**
 * Format a single task for detailed display.
 */
export function formatTaskDetail(task: TaskResponse): string {
  const lines: string[] = [];

  lines.push(`${chalk.bold('ID:')}          ${task.id}`);
  lines.push(`${chalk.bold('Title:')}       ${task.title}`);
  lines.push(`${chalk.bold('Status:')}      ${formatStatus(task.status)}`);
  lines.push(`${chalk.bold('Priority:')}    ${formatPriority(task.priority)}`);
  lines.push(`${chalk.bold('Project:')}     ${task.project_id}`);
  lines.push(`${chalk.bold('Assignee:')}    ${task.assignee || '-'}`);
  lines.push(`${chalk.bold('Created by:')}  ${task.created_by}`);
  lines.push(
    `${chalk.bold('Due date:')}    ${task.due_date ? new Date(task.due_date).toLocaleString() : '-'}`
  );
  lines.push(`${chalk.bold('Tags:')}        ${task.tags.length > 0 ? task.tags.join(', ') : '-'}`);
  lines.push(`${chalk.bold('Created:')}     ${new Date(task.created_at).toLocaleString()}`);

  if (task.description) {
    lines.push('');
    lines.push(`${chalk.bold('Description:')}`);
    lines.push(task.description);
  }

  return lines.join('\n');
}
