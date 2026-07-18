import Table from 'cli-table3';
import chalk from 'chalk';
import type {
  TaskResponse,
  ProjectResponse,
  DependencyListResponse,
  CommentResponse,
  HealthResponse,
} from '../api/types.js';

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
  // NO_COLOR env var takes precedence (standard: a set value disables color)
  if (process.env['NO_COLOR'] !== undefined) {
    return false;
  }

  // JSON mode should never have colors
  if (isJsonMode()) {
    return false;
  }

  return true;
}

/**
 * Semantic color functions that respect NO_COLOR and --json mode.
 * Use these instead of direct chalk calls in command files.
 */

/** Format success messages (e.g., "Task created successfully") */
export function colorSuccess(text: string): string {
  return shouldUseColor() ? chalk.green(text) : text;
}

/** Format error messages (e.g., "Invalid task ID") */
export function colorError(text: string): string {
  return shouldUseColor() ? chalk.red(text) : text;
}

/** Format warning messages (e.g., "No updates specified") */
export function colorWarn(text: string): string {
  return shouldUseColor() ? chalk.yellow(text) : text;
}

/** Format informational/hint messages (e.g., "3 subtask(s) found") */
export function colorInfo(text: string): string {
  return shouldUseColor() ? chalk.gray(text) : text;
}

/** Format bold text (e.g., headers, labels) */
export function colorBold(text: string): string {
  return shouldUseColor() ? chalk.bold(text) : text;
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
    case 'backlogged':
      return chalk.magenta(status);
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
    `${bold('Due date:')}    ${task.due_date ? new Date(task.due_date).toLocaleString() : '-'}`,
  );
  lines.push(`${bold('Tags:')}        ${task.tags.length > 0 ? task.tags.join(', ') : '-'}`);
  lines.push(`${bold('Created:')}     ${new Date(task.created_at).toLocaleString()}`);

  if (task.description) {
    lines.push('');
    lines.push(`${bold('Description:')}`);
    lines.push(task.description);
  }

  // Wave 1.3 (#311): only render the acceptance block when a value is present —
  // existing NULL-acceptance tasks should look identical to pre-1.3 output.
  if (task.acceptance_criteria) {
    lines.push('');
    lines.push(`${bold('Acceptance criteria:')}`);
    lines.push(task.acceptance_criteria);
  }

  // Wave 1.4 (#312): verdict + compact evidence summary. Only render when
  // evidence is present so pre-1.4 (NULL-evidence) tasks look identical to
  // the old output. We surface the verdict + the number of checks + the
  // verified_at timestamp (when set) — the full check details are available
  // via the JSON API for callers that want them.
  if (task.verification_evidence) {
    const ve = task.verification_evidence;
    const checkCount = Array.isArray(ve.checks) ? ve.checks.length : 0;
    const verifiedAt = ve.verified_at ? new Date(ve.verified_at).toLocaleString() : '-';
    lines.push('');
    lines.push(`${bold('Verification:')}`);
    lines.push(`  ${bold('Verdict:')}     ${ve.verdict}`);
    lines.push(`  ${bold('Checks:')}      ${checkCount}`);
    lines.push(`  ${bold('Verified at:')} ${verifiedAt}`);
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

    table.push([project.id, project.name, desc, new Date(project.created_at).toLocaleDateString()]);
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

  // Configurable Task Models (Task 12): show the per-project model policy when
  // configured. Pretty-printed JSON, indented under the label. `null`/absent
  // means the project inherits the global default — show a dash.
  if (project.model_policy) {
    const json = JSON.stringify(project.model_policy, null, 2)
      .split('\n')
      .map((line, i) => (i === 0 ? line : `              ${line}`))
      .join('\n');
    lines.push(`${bold('Model Policy:')} ${json}`);
  } else {
    lines.push(`${bold('Model Policy:')} - (inherits global default)`);
  }

  return lines.join('\n');
}

// ── Dependency formatters ───────────────────────────────────

// ── Comment formatters ──────────────────────────────────────

/**
 * Format a list of comments for chronological display.
 *
 * Shows each comment with timestamp, author, and indented content.
 * Returns "No comments" if the list is empty.
 */
export function formatCommentList(comments: CommentResponse[]): string {
  if (comments.length === 0) {
    return 'No comments';
  }

  const useColor = shouldUseColor();
  const parts: string[] = [];

  for (const comment of comments) {
    const timestamp = new Date(comment.created_at).toLocaleString();
    const header = useColor
      ? `${chalk.bold(`[${timestamp}]`)} ${chalk.bold(comment.author)}:`
      : `[${timestamp}] ${comment.author}:`;

    // Indent each line of content by 2 spaces
    const indentedContent = comment.content
      .split('\n')
      .map((line) => `  ${line}`)
      .join('\n');

    parts.push(`${header}\n${indentedContent}`);
  }

  return parts.join('\n\n');
}

// ── Health formatters ───────────────────────────────────────

/**
 * Format uptime in seconds to human-readable string.
 */
function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  const parts = [];
  if (days > 0) parts.push(`${days} day${days !== 1 ? 's' : ''}`);
  if (hours > 0) parts.push(`${hours} hour${hours !== 1 ? 's' : ''}`);
  if (minutes > 0) parts.push(`${minutes} minute${minutes !== 1 ? 's' : ''}`);

  return parts.join(', ') || '0 minutes';
}

/**
 * Format health check response for terminal display.
 *
 * Shows service status, database connectivity, uptime, and version
 * with color-coded indicators (green checkmark / red cross).
 */
export function formatHealthStatus(health: HealthResponse): string {
  const useColor = shouldUseColor();
  const lines: string[] = [];

  const bold = (text: string) => (useColor ? chalk.bold(text) : text);

  // Service status
  const statusText =
    health.status === 'healthy'
      ? useColor
        ? chalk.green('OK') + ' ' + chalk.green('\u2713')
        : 'OK \u2713'
      : useColor
        ? chalk.red('ERROR') + ' ' + chalk.red('\u2717')
        : 'ERROR \u2717';
  lines.push(`${bold('Service Status:')} ${statusText}`);

  // Database status \u2014 only present on the authenticated /health/detailed
  // response. `checkHealth()` calls the basic `/health`, which omits `checks`,
  // so guard before reading it (a bare `health.checks.database` crashed the
  // command with "Cannot read properties of undefined (reading 'database')").
  if (health.checks?.database !== undefined) {
    const dbStatus = health.checks.database === 'ok';
    const dbText = dbStatus
      ? useColor
        ? chalk.green('Connected') + ' ' + chalk.green('\u2713')
        : 'Connected \u2713'
      : useColor
        ? chalk.red('Disconnected') + ' ' + chalk.red('\u2717')
        : 'Disconnected \u2717';
    lines.push(`${bold('Database:')} ${dbText}`);
  }

  // Version
  if (health.version) {
    lines.push(`${bold('Version:')} ${health.version}`);
  }

  // Timestamp
  lines.push(`${bold('Last checked:')} ${new Date(health.timestamp).toLocaleString()}`);

  return lines.join('\n');
}

/**
 * Format a dependency list showing blocks and blocked_by sections.
 */
export function formatDependencyList(deps: DependencyListResponse): string {
  const useColor = shouldUseColor();
  const lines: string[] = [];

  const bold = (text: string) => (useColor ? chalk.bold(text) : text);

  lines.push(bold('Blocks (this task blocks):'));
  if (deps.blocks.length > 0) {
    for (const dep of deps.blocks) {
      lines.push(`  - Task #${dep.blocks_task_id}`);
    }
  } else {
    lines.push('  None');
  }

  lines.push('');

  lines.push(bold('Blocked by (blocked by these tasks):'));
  if (deps.blocked_by.length > 0) {
    for (const dep of deps.blocked_by) {
      lines.push(`  - Task #${dep.task_id}`);
    }
  } else {
    lines.push('  None');
  }

  return lines.join('\n');
}
