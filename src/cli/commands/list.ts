import { Command } from 'commander';
import { listTasks, withApiSpinner } from '../api/client.js';
import { formatTaskTable, colorError, colorWarn, colorInfo } from '../output/formatters.js';
import { handleError } from '../output/error-handler.js';
import { jsonOutput, messageOutput } from '../output/json-output.js';
import type { TaskFilters } from '../api/types.js';

const VALID_STATUSES = ['open', 'in_progress', 'done', 'closed', 'blocked'];
const MAX_LIMIT = 500;

export const listCommand = new Command('list')
  .description('List tasks with optional filters')
  .option('-p, --project <id>', 'Filter by project ID', parseInt)
  .option('-s, --status <status>', 'Filter by status')
  .option('-a, --assignee <name>', 'Filter by assignee')
  .option('--search <query>', 'Search tasks by title/description')
  .option('--tags <tags>', 'Filter by tags (comma-separated)')
  .option('--due-before <date>', 'Tasks due before date (ISO8601)')
  .option('--due-after <date>', 'Tasks due after date (ISO8601)')
  .option('--limit <n>', `Max rows to return (default 50, max ${MAX_LIMIT})`, (v) =>
    parseInt(v, 10),
  )
  .option('--offset <n>', 'Zero-based offset for pagination (default 0)', (v) => parseInt(v, 10))
  .action(async (options) => {
    try {
      // Validate status if provided
      if (options.status && !VALID_STATUSES.includes(options.status)) {
        console.error(
          colorError(
            `Invalid status: ${options.status}. Valid options: ${VALID_STATUSES.join(', ')}`,
          ),
        );
        process.exitCode = 1;
        return;
      }

      // Validate project ID if provided
      if (options.project !== undefined && isNaN(options.project)) {
        console.error(colorError('Invalid project ID: must be a number'));
        process.exitCode = 1;
        return;
      }

      // Validate pagination — fail fast with a clear message before hitting the API.
      if (options.limit !== undefined) {
        if (!Number.isInteger(options.limit) || options.limit <= 0 || options.limit > MAX_LIMIT) {
          console.error(
            colorError(`Invalid --limit: must be an integer between 1 and ${MAX_LIMIT}`),
          );
          process.exitCode = 1;
          return;
        }
      }
      if (options.offset !== undefined) {
        if (!Number.isInteger(options.offset) || options.offset < 0) {
          console.error(colorError('Invalid --offset: must be a non-negative integer'));
          process.exitCode = 1;
          return;
        }
      }

      // Build filters object - only include properties that were actually provided
      const filters: TaskFilters = {};

      if (options.project !== undefined) {
        filters.project_id = options.project;
      }
      if (options.status) {
        filters.status = options.status;
      }
      if (options.assignee) {
        filters.assignee = options.assignee;
      }
      if (options.search) {
        filters.search = options.search;
      }
      if (options.tags) {
        // API expects tags as comma-separated string in query param
        filters.tags = options.tags;
      }
      if (options.dueBefore) {
        filters.due_before = options.dueBefore;
      }
      if (options.dueAfter) {
        filters.due_after = options.dueAfter;
      }
      if (options.limit !== undefined) {
        filters.limit = options.limit;
      }
      if (options.offset !== undefined) {
        filters.offset = options.offset;
      }

      // Call API
      const tasks = await withApiSpinner('Fetching tasks...', () =>
        listTasks(Object.keys(filters).length > 0 ? filters : undefined),
      );

      // Check if JSON mode (global flag from program)
      const program = listCommand.parent;
      const globalOpts = program?.optsWithGlobals() || {};
      const isJsonMode = globalOpts['json'] || false;

      // Display results
      if (isJsonMode) {
        // JSON mode: output envelope to stdout
        jsonOutput(tasks, { count: tasks.length });
      } else {
        // Terminal mode: formatted output
        if (tasks.length === 0) {
          console.log(colorWarn('No tasks found'));
          return;
        }

        console.log(formatTaskTable(tasks));
        console.log(colorInfo(`\n${tasks.length} task(s) found`));
      }
    } catch (error) {
      handleError(error);
    }
  });
