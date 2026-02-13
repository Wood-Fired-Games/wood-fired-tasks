import Table from 'cli-table3';
import chalk from 'chalk';
import type { TaskResponse, ProjectResponse } from '../api/types.js';

/**
 * Detect if JSON output mode is enabled via --json flag.
 *
 * Checks process.argv to avoid circular dependencies with Commander.
 * This is safe for formatters since we only need to know output mode.
 */
export function isJsonMode(): boolean {
  return process.argv.includes('--json');
}

/**
 * Determines if ANSI color codes should be used in output.
 *
 * Respects NO_COLOR env var per https://no-color.org standard.
 * Returns false if:
 * - NO_COLOR environment variable is set (any value)
 * - --json flag is present (JSON mode implies no colors)
 *
 * @returns true if colors should be used, false otherwise
 */
export function shouldUseColor(): boolean {
  // NO_COLOR env var takes precedence (standard: any value = disable)
  if (process.env.NO_COLOR !== undefined) {
    return false;
  }

  // JSON mode should never have colors
  if (isJsonMode()) {
    return false;
  }

  return true;
}

/**
 * Strip ANSI color codes from text if in JSON mode.
 *
 * @param text - Text that may contain ANSI codes
 * @returns Plain text in JSON mode, original text otherwise
 */
export function stripAnsiIfJsonMode(text: string): string {
  if (!isJsonMode()) {
    return text;
  }

  // Remove ANSI escape sequences (color codes)
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[\d+m/g, '');
}

/**
 * Color-code task status values.
 *
 * Returns plain text in JSON mode or when NO_COLOR is set, colored text in terminal mode.
 */
export function formatStatus(status: string): string {
  if (!shouldUseColor()) {
    return status;
  }
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
 *
 * Returns plain text in JSON mode or when NO_COLOR is set, colored text in terminal mode.
 */
export function formatPriority(priority: string): string {
  if (!shouldUseColor()) {
    return priority;
  }
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
  const useColor = shouldUseColor();

  const table = new Table({
    head: [
      useColor ? chalk.bold('ID') : 'ID',
      useColor ? chalk.bold('Title') : 'Title',
      useColor ? chalk.bold('Status') : 'Status',
      useColor ? chalk.bold('Priority') : 'Priority',
      useColor ? chalk.bold('Assignee') : 'Assignee',
      useColor ? chalk.bold('Due Date') : 'Due Date',
    ],
    style: {
      head: [], // Disable cli-table3 default head colors (we use chalk instead)
      border: useColor ? ['gray'] : [],
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
  const useColor = shouldUseColor();
  const lines: string[] = [];

  const bold = (text: string) => (useColor ? chalk.bold(text) : text);

  lines.push(`${bold('ID:')}          ${task.id}`);
  lines.push(`${bold('Title:')}       ${task.title}`);
  lines.push(`${bold('Status:')}      ${formatStatus(task.status)}`);
  lines.push(`${bold('Priority:')}    ${formatPriority(task.priority)}`);
  lines.push(`${bold('Project:')}     ${task.project_id}`);
  lines.push(`${bold('Assignee:')}    ${task.assignee || '-'}`);
  lines.push(`${bold('Created by:')}  ${task.created_by}`);
  lines.push(
    `${bold('Due date:')}    ${task.due_date ? new Date(task.due_date).toLocaleString() : '-'}`
  );
  lines.push(`${bold('Tags:')}        ${task.tags.length > 0 ? task.tags.join(', ') : '-'}`);
  lines.push(`${bold('Created:')}     ${new Date(task.created_at).toLocaleString()}`);

  if (task.description) {
    lines.push('');
    lines.push(`${bold('Description:')}`);
    lines.push(task.description);
  }

  return lines.join('\n');
}

// ── Project formatters ──────────────────────────────────────

/**
 * Format a list of projects as a table.
 */
export function formatProjectTable(projects: ProjectResponse[]): string {
  const useColor = shouldUseColor();

  const table = new Table({
    head: [
      useColor ? chalk.bold('ID') : 'ID',
      useColor ? chalk.bold('Name') : 'Name',
      useColor ? chalk.bold('Description') : 'Description',
      useColor ? chalk.bold('Created') : 'Created',
    ],
    style: {
      head: [], // Disable cli-table3 default head colors (we use chalk instead)
      border: useColor ? ['gray'] : [],
    },
    wordWrap: true,
  });

  for (const project of projects) {
    // Truncate description to 50 chars with ellipsis if needed
    const desc = project.description
      ? project.description.length > 50
        ? project.description.slice(0, 47) + '...'
        : project.description
      : '-';

    table.push([
      project.id,
      project.name,
      desc,
      new Date(project.created_at).toLocaleDateString(),
    ]);
  }

  return table.toString();
}

/**
 * Format a single project for detailed display.
 */
export function formatProjectDetail(project: ProjectResponse): string {
  const useColor = shouldUseColor();
  const lines: string[] = [];

  const bold = (text: string) => (useColor ? chalk.bold(text) : text);

  lines.push(`${bold('ID:')}           ${project.id}`);
  lines.push(`${bold('Name:')}         ${project.name}`);
  lines.push(`${bold('Description:')}  ${project.description || '-'}`);
  lines.push(`${bold('Created:')}      ${new Date(project.created_at).toLocaleString()}`);
  lines.push(`${bold('Updated:')}      ${new Date(project.updated_at).toLocaleString()}`);

  return lines.join('\n');
}
